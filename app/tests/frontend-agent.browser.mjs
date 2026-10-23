// Actual React components in Chromium; every API and stream is replaced offline.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { offlinePage } from './frontend-offline.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FRONTEND_PLAYWRIGHT_PATH || 'playwright');
const browser = await chromium.launch({
  headless: true, executablePath: process.env.FRONTEND_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
});
const base = process.env.FRONTEND_BASE_URL || 'http://localhost:3100';
const offline = process.env.FRONTEND_OFFLINE !== '0';
const html = offlinePage('../app/components/Studio.tsx', ['../app/globals.css', '../app/canvas.css']);
const screenshots = process.env.FRONTEND_SCREENSHOTS || '../artifacts/frontend-agent';
mkdirSync(screenshots, { recursive: true });
const draft = {
  version: 1, platform: '小红书', modelId: 'pro-s', modelName: 'HUAWEI MateBook Pro S',
  title: '带着电脑轻装出发', lead: '先核实你的常用软件，再聊移动办公。',
  body: '频繁出差时，先列出会议、文档和连接外设的需求。\n资料中的适用范围需要逐项核对，不能把轻便当作全部兼容。', cta: '',
  tags: [], images: [], claims: [],
};
const view = { draft, evidence: [], images: [] };
const run = { id: 'r-browser', status: 'running', phase: '核验事实与图片', cancelRequested: false };
const report = { draftVersion: 1, status: 'pass', issues: [], verifiedClaimIds: [], verifiedImageIds: [], checkedAt: '' };
let passed = 0;
async function scenario(name, test, mobile = false) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1360, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (offline) await context.route(`${base}/**`, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.route('**/api/**', (route) => route.fulfill({ status: 500, json: { error: 'Unexpected API' } }));
  await context.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (url, options) => {
      if (url === '/api/agent' && options?.method === 'POST') {
        window.__request = { body: JSON.parse(options.body), accept: options.headers.accept };
        return new Response(new ReadableStream({
          start(controller) {
            window.__emit = (event, close = false) => {
              controller.enqueue(new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
              if (close) controller.close();
            };
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      return original(url, options);
    };
  });
  try {
    await page.goto(base);
    await page.getByRole('textbox').fill('为差旅场景写一篇小红书');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(() => !!window.__emit);
    assert.equal(await page.evaluate(() => window.__request.accept), 'text/event-stream');
    await test(page);
    assert.deepEqual(errors, []);
    console.log(`PASS ${++passed}: ${name}`);
  } finally { await context.close(); }
}
const emit = (page, event, close = false) => page.evaluate(({ event, close }) => window.__emit(event, close), { event, close });

try {
  await scenario('SSE stages and actual tool return; pending preview cannot export; verified result can', async (page) => {
    await emit(page, { type: 'run', run });
    await emit(page, { type: 'step', label: '核对产品资料' });
    await emit(page, { type: 'tool', tool: 'knowledge', label: '读取产品资料', status: 'started' });
    await emit(page, { type: 'tool', tool: 'knowledge', label: '读取产品资料', status: 'completed', cacheHit: true, ms: 90 });
    assert.equal(await page.locator('.tool-status,.activity').count(), 0);
    await emit(page, { type: 'draft', draft });
    await page.getByText('内容还在整理，稍后可以导出。').waitFor();
    assert.equal(await page.getByRole('button', { name: '导出内容' }).isDisabled(), true);
    await page.screenshot({ path: `${screenshots}/desktop-pending.png`, fullPage: true });
    await emit(page, { type: 'check', report });
    await emit(page, { type: 'done', view: { ...view, report }, run: { ...run, status: 'completed' } }, true);
    await page.getByText('写好了，看看这个版本。').waitFor();
    assert.equal(await page.getByRole('button', { name: '导出内容' }).isEnabled(), true);
  });
  await scenario('mobile unverified terminal draft stays pending; no success claim or overflow', async (page) => {
    await emit(page, { type: 'draft', draft });
    await emit(page, { type: 'done', view, run: { ...run, status: 'completed' } }, true);
    await page.getByText('草稿放好了，还需要稍作整理。').waitFor();
    assert.equal(await page.getByRole('button', { name: '导出内容' }).isDisabled(), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${screenshots}/mobile-pending.png`, fullPage: true });
  }, true);
  await scenario('202 stop waits for GET confirmation and preserves pending draft', async (page) => {
    let confirmed = false, cancelBody, gets = 0;
    await page.route('**/api/agent/cancel', (route) => {
      cancelBody = route.request().postDataJSON();
      return route.fulfill({ status: 202, json: { accepted: true } });
    });
    await page.route('**/api/agent?**', (route) => {
      gets++;
      return route.fulfill({ json: {
        view, messages: [], busy: !confirmed, interrupted: false, updatedAt: '',
        run: { ...run, status: confirmed ? 'cancelled' : 'running', cancelRequested: true },
      } });
    });
    await emit(page, { type: 'run', run });
    await emit(page, { type: 'draft', draft });
    await page.getByRole('button', { name: '停止任务' }).click();
    await page.getByText('正在停止，请等待确认').waitFor();
    assert.deepEqual(cancelBody, { sessionId: await page.evaluate(() => window.__request.body.sessionId), runId: run.id });
    assert.equal(await page.getByRole('button', { name: '发送', exact: true }).isDisabled(), true);
    confirmed = true;
    await page.getByText('任务已停止，已保留最近保存的内容').waitFor();
    assert.ok(gets >= 2);
    assert.equal(await page.getByRole('textbox').isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: '导出内容' }).isDisabled(), true);
    await page.screenshot({ path: `${screenshots}/desktop-cancelled.png`, fullPage: true });
  });
  await scenario('failed knowledge service remains explicit and cannot imply verified completion', async (page) => {
    await emit(page, { type: 'tool', tool: 'knowledge', label: '读取产品资料', status: 'failed' });
    await emit(page, { type: 'error', text: '知识库服务不可用，启动操作被审批策略阻止。' });
    await emit(page, { type: 'done', view: { evidence: [], images: [] }, run: { ...run, status: 'failed' } }, true);
    await page.getByRole('alert').getByText('知识库服务不可用，启动操作被审批策略阻止。').waitFor();
    await page.getByText('任务未完成，已保留最近保存的内容').waitFor();
    assert.equal(await page.getByText('核验通过', { exact: true }).count(), 0);
  });
  await scenario('nonpass report with zero issues never enables export or shows passed badge', async (page) => {
    const failed = { ...report, status: 'needs_fix' };
    await emit(page, { type: 'draft', draft });
    await emit(page, { type: 'done', view: { ...view, report: failed } }, true);
    await page.getByText('第 1 版 · 需要调整').waitFor();
    assert.equal(await page.getByRole('button', { name: '导出内容' }).isDisabled(), true);
    await page.getByRole('button', { name: '内容建议' }).click();
    await page.getByText('这版还需要调整，暂时不能导出。可以让知选重新整理一次。').waitFor();
    assert.equal(await page.getByText('没有发现问题。', { exact: false }).count(), 0);
  });
  await scenario('cancel conflict refreshes authoritative terminal state without generating again', async (page) => {
    let cancels = 0;
    await page.route('**/api/agent/cancel', (route) => {
      cancels++;
      return route.fulfill({ status: 409, json: { error: '任务已结束' } });
    });
    await page.route('**/api/agent?**', (route) => route.fulfill({ json: {
      view, messages: [], busy: false, interrupted: false, updatedAt: '',
      run: { ...run, status: 'timed_out' },
    } }));
    await emit(page, { type: 'run', run });
    await page.getByRole('button', { name: '停止任务' }).click();
    await page.getByText('任务等待超时，已保留最近保存的内容').waitFor();
    assert.equal(cancels, 1);
    assert.equal(await page.getByRole('textbox').isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: '导出内容' }).isDisabled(), true);
  });
  console.log(`All ${passed} agent browser scenarios passed. Screenshots: ${screenshots}`);
} finally { await browser.close(); }
