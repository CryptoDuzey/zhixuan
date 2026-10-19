// Opt-in real task acceptance: requires working knowledge services and a funded model key.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FRONTEND_PLAYWRIGHT_PATH || 'playwright');
const base = process.env.FRONTEND_BASE_URL || 'http://localhost:3100';
const screenshots = process.env.FRONTEND_SCREENSHOTS || '../artifacts/frontend-consult-live';
mkdirSync(screenshots, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.FRONTEND_BROWSER_PATH ? { executablePath: process.env.FRONTEND_BROWSER_PATH } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.setDefaultTimeout(200000);
  const errors = [];
  let posts = 0;
  // Read a cloned page stream; Chrome may discard the response body from its debugging protocol.
  await page.addInitScript(() => {
    window.__consultFrames = [];
    window.__consultStreamEnded = false;
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (new URL(response.url).pathname === '/api/consult'
        && response.headers.get('content-type')?.includes('text/event-stream')) {
        void (async () => {
          try {
            const reader = response.clone().body.getReader();
            const decoder = new TextDecoder();
            let pending = '';
            for (;;) {
              const part = await reader.read();
              pending += decoder.decode(part.value, { stream: !part.done });
              const frames = pending.split(/\r?\n\r?\n/);
              pending = frames.pop() || '';
              for (const frame of frames) {
                const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data: '))
                  .map((line) => line.slice(6)).join('\n');
                if (data) window.__consultFrames.push(JSON.parse(data));
              }
              if (part.done) break;
            }
          } finally { window.__consultStreamEnded = true; }
        })();
      }
      return response;
    };
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url() === `${base}/api/consult` && request.method() === 'POST') posts++;
  });
  await page.goto(`${base}/consult`);
  await page.locator('#consult-input:not([disabled])').waitFor();
  await page.getByRole('textbox').fill('孩子经常打印试卷，偶尔需要扫描。请根据知识库推荐打印机，说明依据和需要核实的地方。');
  const received = page.waitForResponse((response) =>
    response.url() === `${base}/api/consult` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '发送咨询', exact: true }).click();
  const response = await received;
  assert.equal(response.status(), 200);
  assert.match(response.headers()['content-type'], /text\/event-stream/);
  await page.waitForFunction(() => window.__consultStreamEnded);
  const frames = await page.evaluate(() => window.__consultFrames);
  assert.equal(frames.some((event) => event.type === 'error'), false,
    'A failed model or knowledge request is not a successful real task.');
  const answer = frames.find((event) => event.type === 'answer')?.answer;
  const run = frames.find((event) => event.type === 'done')?.run;
  assert.ok(answer?.reply);
  assert.equal(run?.status, 'completed');
  assert.ok(answer.recommendations.length > 0);
  assert.ok(answer.recommendations.every((item) => !/MateBook/i.test(item.modelName || item.modelId)));
  assert.match(answer.reply, /打印|试卷|扫描/);
  assert.ok(frames.some((event) => event.type === 'tool' && event.tool === 'model' && event.status === 'completed'));
  assert.equal(answer.retrieval?.status, 'ready');
  assert.ok(answer.retrieval.scannedFiles > 0);
  assert.ok(frames.every((event) => typeof event.runId === 'string'
    && Number.isInteger(event.seq) && typeof event.at === 'string'));
  await page.getByText(answer.reply, { exact: true }).first().waitFor();
  await page.getByText('本次咨询已结束', { exact: true }).waitFor();
  const id = await page.evaluate(() => localStorage.getItem('zhixuan.consult.sid.v1'));
  assert.ok(id);
  const snapshot = await (await page.request.get(`${base}/api/consult?sessionId=${encodeURIComponent(id)}`)).json();
  assert.equal(snapshot.busy, false);
  assert.equal(snapshot.run.id, run.id);
  assert.equal(snapshot.turns[0].answer.reply, answer.reply);
  assert.equal(snapshot.calls, undefined);
  await page.reload();
  await page.getByText(answer.reply, { exact: true }).first().waitFor();
  assert.equal(posts, 1);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${screenshots}/real-consult-sse.png`, fullPage: true });
  console.log('PASS: real printer task + model + knowledge + SSE + saved snapshot + refresh; one POST.');
} finally { await browser.close(); }
