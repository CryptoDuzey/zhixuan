// API calls are all mocked. FRONTEND_OFFLINE=0 uses existing Next pages only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { offlinePage } from './frontend-offline.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FRONTEND_PLAYWRIGHT_PATH || 'playwright');
const base = process.env.FRONTEND_BASE_URL || 'http://localhost:3117';
const offline = process.env.FRONTEND_OFFLINE !== '0';
const html = offlinePage('../app/consult/page.tsx', ['../app/globals.css', '../app/consult/consult.css']);
const screenshots = process.env.FRONTEND_SCREENSHOTS || '../artifacts/frontend-consult-stream';
mkdirSync(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.FRONTEND_BROWSER_PATH ? { executablePath: process.env.FRONTEND_BROWSER_PATH } : {}) });
const key = 'zhixuan.consult.sid.v1';
const legacyKey = 'zhixuan.consult.v1';
const run = { id: 'r-consult', status: 'running', phase: '检索产品资料', cancelRequested: false };
const answer = { reply: '先核实常用软件，再考虑移动办公。', recommendations: [{ modelId: 'pro-s', modelName: 'HUAWEI MateBook Pro S',
  system: '鸿蒙', reason: '移动办公', tradeoff: '核实软件', evidenceIds: [], creativeModelId: 'pro-s' }], evidence: [],
  retrieval: { status: 'ready', source: '本地已下载知识库', scope: 'all-indexed-documents', query: '移动办公', returned: 1,
    maximumResults: 50, exhaustive: false, message: '非穷尽结果', items: [{ id: 'a'.repeat(24), title: '移动办公资料',
      path: '资料/移动办公.md', preview: '核实软件版本', documentUrl: `/api/knowledge/document?id=${'a'.repeat(24)}` }] } };
const snap = (extra = {}) => ({ turns: [], busy: false, interrupted: false, updatedAt: '', ...extra });
const events = (...items) => items.map((item) => `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join('');
let count = 0;
async function scenario(name, execute, { seed = {}, mobile = false, liveStream = false } = {}) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [], unexpected = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await context.addInitScript(({ seed, liveStream }) => {
    if (!localStorage.getItem('seeded')) {
      for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
      localStorage.setItem('seeded', '1');
    }
    if (liveStream) {
      const original = fetch.bind(window);
      window.fetch = async (url, options) => {
        if (url === '/api/consult' && options?.method === 'POST') {
          window.__payloads ??= [];
          window.__payloads.push(JSON.parse(options.body));
          return new Response(new ReadableStream({ start(controller) {
            window.__emit = (event, close = false) => {
              controller.enqueue(new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
              if (close) controller.close();
            };
          } }), { headers: { 'content-type': 'text/event-stream' } });
        }
        return original(url, options);
      };
    }
  }, { seed, liveStream });
  if (offline) await context.route(`${base}/**`, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.route('**/api/**', (route) => { unexpected.push(route.request().url()); return route.fulfill({ status: 500, json: {} }); });
  try { await execute(page); assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); console.log(`PASS ${++count}: ${name}`); }
  finally { await context.close(); }
}
const send = async (page, text = '出差怎么选') => {
  await page.getByRole('textbox').fill(text);
  await page.getByRole('button', { name: '发送咨询', exact: true }).click();
};
const emit = (page, event, close = false) => page.evaluate(({ event, close }) => window.__emit(event, close), { event, close });
try {
  await scenario('SSE answer, safe retrieval, handoff and server-authoritative refresh', async (page) => {
    let posts = 0, gets = 0, payload;
    await page.route('**/api/consult', (route) => {
      posts++; payload = route.request().postDataJSON();
      assert.equal(route.request().headers().accept, 'text/event-stream');
      return route.fulfill({ contentType: 'text/event-stream', body: events({ type: 'run', run }, { type: 'answer', answer }, { type: 'done', run: { ...run, status: 'completed' } }) });
    });
    await page.route('**/api/consult?**', (route) => { gets++; return route.fulfill({ json: snap({ turns: [{ question: '出差怎么选', answer }], run: { ...run, status: 'completed' } }) }); });
    await page.goto(`${base}/consult`); await send(page);
    await page.getByText('本次咨询已结束', { exact: true }).waitFor();
    assert.deepEqual(Object.keys(payload).sort(), ['message', 'sessionId']);
    await page.reload(); await page.getByText(answer.reply, { exact: true }).waitFor();
    assert.equal(posts, 1); assert.ok(gets >= 2);
    await page.locator('details.consult-retrieval summary').click();
    assert.equal(await page.getByRole('link', { name: '查看原文：移动办公资料' }).getAttribute('href'), answer.retrieval.items[0].documentUrl);
    await page.getByRole('button', { name: /HUAWEI MateBook Pro S/ }).click();
    assert.match(await page.getByRole('link', { name: '开启新创作' }).getAttribute('href'), /product=pro-s/);
    await page.screenshot({ path: `${screenshots}/desktop-answer.png`, fullPage: true });
  });
  await scenario('restored busy task polls without POST and confirms cancellation only after GET', async (page) => {
    let confirmed = false, requested = false, posts = 0, cancels = 0;
    await page.route('**/api/consult', (route) => { posts++; return route.fulfill({ json: answer }); });
    await page.route('**/api/consult?**', (route) => route.fulfill({ json: snap({ turns: [{ question: '出差怎么选' }], busy: !confirmed,
      run: { ...run, status: confirmed ? 'cancelled' : 'running', cancelRequested: requested } }) }));
    await page.route('**/api/consult/cancel', (route) => {
      cancels++; requested = true; assert.deepEqual(route.request().postDataJSON(), { sessionId: 's-existing', runId: run.id });
      return route.fulfill({ status: 202, json: {} });
    });
    await page.goto(`${base}/consult`);
    await page.getByRole('button', { name: '停止咨询' }).click();
    await page.getByText('正在停止咨询，请等待确认', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox').isDisabled(), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${screenshots}/mobile-stopping.png`, fullPage: true });
    confirmed = true;
    await page.getByText('咨询已停止，已保留收到的回复').waitFor();
    assert.equal(posts, 0); assert.equal(cancels, 1); assert.equal(await page.getByRole('textbox').isEnabled(), true);
  }, { seed: { [key]: 's-existing' }, mobile: true });
  await scenario('interrupted stream recovers without duplicate generation and retains error', async (page) => {
    let posts = 0;
    await page.route('**/api/consult', (route) => { posts++; return route.fulfill({ contentType: 'text/event-stream', body: events({ type: 'run', run }) }); });
    await page.route('**/api/consult?**', (route) => route.fulfill({ json: snap({ turns: [{ question: '出差怎么选' }], interrupted: true,
      error: '知识库服务不可用，启动被审批策略阻止。', run: { ...run, status: 'failed' } }) }));
    await page.goto(`${base}/consult`); await send(page);
    await page.getByRole('alert').getByText('知识库服务不可用，启动被审批策略阻止。').waitFor();
    assert.equal(posts, 1); assert.equal(await page.getByRole('button', { name: '重试这条' }).isEnabled(), true);
  });
  await scenario('recovery failures block sending and retry reads instead of regenerating', async (page) => {
    let fails = true;
    await page.route('**/api/consult?**', (route) => route.fulfill({ status: fails ? 503 : 200, json: fails ? {} : snap() }));
    await page.goto(`${base}/consult`);
    await page.getByRole('button', { name: '重试恢复' }).waitFor();
    assert.equal(await page.getByRole('textbox').isDisabled(), true);
    fails = false; await page.getByRole('button', { name: '重试恢复' }).click();
    await page.getByText('已恢复最近的咨询和推荐', { exact: false }).waitFor();
    assert.equal(await page.getByRole('textbox').isEnabled(), true);
  }, { seed: { [key]: 's-existing' } });
  await scenario('404 means unestablished session, no automatic POST', async (page) => {
    await page.route('**/api/consult?**', (route) => route.fulfill({ status: 404, json: {} }));
    await page.goto(`${base}/consult`);
    await page.getByText('尚未建立咨询记录，可以发送问题开始。').waitFor();
    assert.equal(await page.getByRole('textbox').isEnabled(), true);
  }, { seed: { [key]: 's-missing' } });
  await scenario('legacy history read-only; new ID excludes old assistant messages', async (page) => {
    let payload;
    await page.route('**/api/consult', (route) => { payload = route.request().postDataJSON(); return route.fulfill({ json: answer }); });
    await page.goto(`${base}/consult`); await page.getByText('旧回答', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox').isDisabled(), true);
    await page.getByRole('button', { name: '开启新咨询', exact: true }).click();
    await send(page, '新问题'); await page.getByText(answer.reply, { exact: true }).waitFor();
    assert.deepEqual(Object.keys(payload).sort(), ['message', 'sessionId']);
    assert.equal(payload.message, '新问题'); assert.equal(JSON.stringify(payload).includes('旧回答'), false);
    assert.equal(await page.evaluate((k) => localStorage.getItem(k), legacyKey), null);
  }, { seed: { [legacyKey]: JSON.stringify({ version: 1, turns: [{ question: '旧问题', answer: { ...answer, reply: '旧回答' } }] }) } });
  await scenario('true stage and safe tool summary display while stream remains open', async (page) => {
    await page.goto(`${base}/consult`); await send(page); await page.waitForFunction(() => !!window.__emit);
    await emit(page, { type: 'run', run });
    await emit(page, { type: 'step', label: '比较候选方案', run: { ...run, phase: '比较候选方案' } });
    await emit(page, { type: 'tool', tool: 'knowledge', status: 'completed', label: '检索移动办公资料', cacheHit: true });
    await page.getByText('比较候选方案', { exact: true }).waitFor();
    await page.getByText('已返回 · 使用缓存').waitFor();
    assert.equal(await page.getByRole('button', { name: '停止咨询' }).isEnabled(), true);
    await page.screenshot({ path: `${screenshots}/desktop-progress.png`, fullPage: true });
  }, { liveStream: true });
  await scenario('new session rejects late response from old request', async (page) => {
    let release;
    await page.route('**/api/consult', async (route) => {
      if (route.request().postDataJSON().message === '旧问题') await new Promise((resolve) => { release = resolve; });
      await route.fulfill({ json: { ...answer, reply: route.request().postDataJSON().message === '旧问题' ? '迟到回复' : '新回复' } }).catch(() => {});
    });
    await page.goto(`${base}/consult`); await send(page, '旧问题');
    await page.getByText('正在核对资料', { exact: false }).waitFor();
    const oldId = await page.evaluate((k) => localStorage.getItem(k), key);
    await page.getByRole('button', { name: '新咨询', exact: true }).click();
    await send(page, '新问题'); await page.getByText('新回复', { exact: true }).waitFor();
    release();
    assert.notEqual(await page.evaluate((k) => localStorage.getItem(k), key), oldId);
    assert.equal(await page.getByText('迟到回复', { exact: true }).count(), 0);
  });
  await scenario('409 cancellation queries latest state instead of claiming stopped', async (page) => {
    let ended = false;
    await page.route('**/api/consult?**', (route) => route.fulfill({ json: snap({ turns: [{ question: '问题', ...(ended ? { answer } : {}) }], busy: !ended,
      run: { ...run, status: ended ? 'completed' : 'running' } }) }));
    await page.route('**/api/consult/cancel', (route) => { ended = true; return route.fulfill({ status: 409, json: {} }); });
    await page.goto(`${base}/consult`); await page.getByRole('button', { name: '停止咨询' }).click();
    await page.getByText('本次咨询已结束', { exact: true }).waitFor();
    assert.equal(await page.getByText('咨询已停止', { exact: false }).count(), 0);
    await page.getByText(answer.reply, { exact: true }).waitFor();
  }, { seed: { [key]: 's-existing' } });
  console.log(`All ${count} consultation stream scenarios passed; APIs mocked; ${offline ? 'offline' : 'existing 3100 pages'}.`);
} finally { await browser.close(); }
