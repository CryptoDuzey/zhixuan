// Real localhost SSE smoke test. No product is selected, so greeting only clarifies.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FRONTEND_PLAYWRIGHT_PATH || 'playwright');
const base = process.env.FRONTEND_BASE_URL || 'http://localhost:3100';
const screenshots = process.env.FRONTEND_SCREENSHOTS || '../artifacts/frontend-agent';
mkdirSync(screenshots, { recursive: true });
const browser = await chromium.launch({
  headless: true, ...(process.env.FRONTEND_BROWSER_PATH ? { executablePath: process.env.FRONTEND_BROWSER_PATH } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (url, options) => {
      const response = await original(url, options);
      if (url === '/api/agent' && options?.method === 'POST') {
        void response.clone().text().then((body) => { window.__agentTrace = body; });
      }
      return response;
    };
  });
  await page.goto(base);
  await page.getByRole('textbox').fill('你好');
  const responsePromise = page.waitForResponse((response) => response.url() === `${base}/api/agent` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 200);
  assert.match(response.headers()['content-type'], /text\/event-stream/);
  await page.waitForFunction(() => typeof window.__agentTrace === 'string');
  const body = await page.evaluate(() => window.__agentTrace);
  const events = body.split(/\r?\n\r?\n/).flatMap((frame) => {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
    return data ? [JSON.parse(data)] : [];
  });
  assert.ok(events.some((event) => event.type === 'run'));
  const clarify = events.find((event) => event.type === 'clarify');
  assert.ok(clarify);
  assert.equal(events.some((event) => event.type === 'tool' && event.tool === 'model'), false);
  assert.equal(events.some((event) => event.type === 'draft'), false);
  const done = events.find((event) => event.type === 'done');
  assert.equal(done?.run.status, 'completed');
  assert.ok(events.every((event) => typeof event.runId === 'string' && Number.isInteger(event.seq) && typeof event.at === 'string'));
  await page.screenshot({ path: `${screenshots}/real-sse-greeting.png`, fullPage: true });
  await page.getByText(clarify.question, { exact: false }).first().waitFor();
  await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);
  assert.equal(await page.getByRole('button', { name: '核验后导出' }).count(), 0);
  const sid = await page.evaluate(() => localStorage.getItem('zhixuan.studio.sid.v1'));
  const snapshot = await (await page.request.get(`${base}/api/agent?sessionId=${encodeURIComponent(sid)}`)).json();
  assert.equal(snapshot.busy, false);
  assert.equal(snapshot.run.id, done.run.id);
  assert.equal(snapshot.run.status, 'completed');
  await page.reload();
  await page.getByText(clarify.question, { exact: false }).first().waitFor();
  await page.screenshot({ path: `${screenshots}/real-sse-greeting.png`, fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: real SSE greeting + GET run state + refresh restoration; zero model tool calls and no draft generated.');
} finally { await browser.close(); }
