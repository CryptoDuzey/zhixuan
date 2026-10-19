// Real local consultation SSE; a greeting requires neither a model nor product data.
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
  const errors = [];
  let posts = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url() === `${base}/api/consult` && request.method() === 'POST') posts++;
  });
  await page.goto(`${base}/consult`);
  await page.getByRole('textbox').fill('你好');
  const received = page.waitForResponse((response) =>
    response.url() === `${base}/api/consult` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '发送咨询', exact: true }).click();
  const response = await received;
  assert.equal(response.status(), 200);
  assert.match(response.headers()['content-type'], /text\/event-stream/);
  const frames = (await response.text()).split(/\r?\n\r?\n/).flatMap((frame) => {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
    return data ? [JSON.parse(data)] : [];
  });
  const answer = frames.find((event) => event.type === 'answer')?.answer;
  const run = frames.find((event) => event.type === 'done')?.run;
  assert.ok(answer?.reply);
  assert.equal(run?.status, 'completed');
  assert.deepEqual(answer.recommendations, []);
  assert.equal(frames.some((event) => event.type === 'tool'), false);
  assert.ok(frames.every((event) => typeof event.runId === 'string'
    && Number.isInteger(event.seq) && typeof event.at === 'string'));
  await page.getByText(answer.reply, { exact: true }).waitFor();
  await page.getByText('本次咨询已结束', { exact: true }).waitFor();
  const id = await page.evaluate(() => localStorage.getItem('zhixuan.consult.sid.v1'));
  assert.ok(id);
  const snapshot = await (await page.request.get(`${base}/api/consult?sessionId=${encodeURIComponent(id)}`)).json();
  assert.equal(snapshot.busy, false);
  assert.equal(snapshot.run.id, run.id);
  assert.equal(snapshot.turns[0].answer.reply, answer.reply);
  assert.equal(snapshot.calls, undefined);
  await page.reload();
  await page.getByText(answer.reply, { exact: true }).waitFor();
  assert.equal(posts, 1);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${screenshots}/real-consult-sse.png`, fullPage: true });
  console.log('PASS: real consultation SSE + server snapshot + refresh; one POST, no model or knowledge calls.');
} finally { await browser.close(); }
