// Actual Next pages by default, all /api requests mocked. No model/KB calls.
// FRONTEND_OFFLINE=1 also exercises the same React components with offlinePage.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { offlinePage } from './frontend-offline.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FRONTEND_PLAYWRIGHT_PATH || 'playwright');
const base = process.env.FRONTEND_BASE_URL || 'http://localhost:3100';
const offline = process.env.FRONTEND_OFFLINE === '1';
const screenshots = process.env.FRONTEND_SCREENSHOTS || path.join(tmpdir(), 'zhixuan-frontend-model-preview');
mkdirSync(screenshots, { recursive: true });
const html = offline ? {
  '/': offlinePage('../app/components/Studio.tsx', ['../app/globals.css', '../app/canvas.css']),
  '/consult': offlinePage('../app/consult/page.tsx', ['../app/globals.css', '../app/canvas.css', '../app/consult/consult.css']),
} : {};
const browser = await chromium.launch({
  headless: true, executablePath: process.env.FRONTEND_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
});
const draft = {
  version: 2, platform: '小红书', modelId: 'pro-s', modelName: 'HUAWEI MateBook Pro S',
  title: '原稿标题', lead: '原稿导语', body: '保留的原稿正文', cta: '', tags: [], images: [], claims: [],
};
const view = { draft, evidence: [], images: [] };
const answer = { reply: '正式完整的选购回答', recommendations: [], evidence: [] };
const question = '请按我的实际用途整理建议';
const run = { id: 'run-preview-one', status: 'running', phase: '整理回复', cancelRequested: false };
let count = 0;

async function scenario(endpoint, mobile, name, execute) {
  const studio = endpoint === '/';
  if (process.env.FRONTEND_PREVIEW_FILTER
    && !`${studio ? 'studio' : 'consult'} ${mobile ? 'phone' : 'desktop'} ${name}`.includes(process.env.FRONTEND_PREVIEW_FILTER)) return;
  const api = studio ? '/api/agent' : '/api/consult';
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [], unexpected = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await context.addInitScript(({ api, studio }) => {
    if (studio) localStorage.setItem('zhixuan.studio.sid.v1', 's-preview-existing');
    const original = window.fetch.bind(window);
    window.__streams = [];
    window.__payloads = [];
    window.fetch = async (url, options) => {
      if (url === api && options?.method === 'POST') {
        window.__payloads.push(JSON.parse(options.body));
        return new Response(new ReadableStream({
          start(controller) {
            // Deliberately ignore abort to simulate already-buffered late network events.
            window.__streams.push({
              emit(event) { controller.enqueue(new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)); },
              end() { controller.close(); },
              fail() { controller.error(new TypeError('controlled disconnect')); },
            });
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      return original(url, options);
    };
  }, { api, studio });
  if (offline) await context.route(`${base}/**`, (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8', body: html[new URL(route.request().url()).pathname] || html[endpoint],
  }));
  await page.route('**/api/**', (route) => {
    unexpected.push(`${route.request().method()} ${route.request().url()}`);
    return route.fulfill({ status: 500, json: { error: 'Unmocked API is blocked' } });
  });
  let recovery = studio
    ? { view, messages: [], busy: false, interrupted: false, updatedAt: '' }
    : { turns: [{ question }], busy: false, interrupted: true, updatedAt: '' };
  let reads = 0;
  await page.route(`**${api}?**`, (route) => { reads++; return route.fulfill({ json: recovery }); });
  let sequence = 0;
  const emit = async (event, index = 0) => {
    const item = { runId: run.id, seq: ++sequence, ...event };
    await page.evaluate(({ item, index }) => window.__streams[index].emit(item), { item, index });
  };
  const preview = (text, extra = {}) => emit({
    type: 'model_preview', callId: 'call-first', kind: studio ? 'draft' : 'answer', status: 'generating', text, ...extra,
  });
  const start = async () => {
    await page.locator('textarea:not([disabled])').first().waitFor();
    await page.locator('textarea').first().fill(question);
    await page.getByRole('button', { name: studio ? '发送' : '发送咨询', exact: true }).click();
    await page.waitForFunction(() => window.__streams.length > 0);
    await emit({ type: 'run', run });
  };
  const absent = async () => assert.equal(await page.locator('.model-preview').count(), 0);
  const content = page.getByRole('region', { name: '预览内容', exact: true });
  try {
    await page.goto(`${base}${endpoint}`);
    await start();
    await execute({ page, studio, api, emit, preview, content, absent, start,
      setRecovery: (value) => { recovery = value; }, reads: () => reads,
      end: () => page.evaluate(() => window.__streams[0].end()),
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    console.log(`PASS ${++count}: ${studio ? 'studio' : 'consult'} ${mobile ? 'phone' : 'desktop'}: ${name}`);
  } catch (error) {
    await page.screenshot({ path: path.join(screenshots, 'failure.png'), fullPage: true });
    console.error(await page.evaluate(() => Object.fromEntries(
      ['.chat', '.chat-log', '.model-preview', '.model-preview-text', '.chat .composer', '.canvas'].map((selector) => {
        const node = document.querySelector(selector);
        if (!node) return [selector, null];
        const rect = node.getBoundingClientRect();
        return [selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          scrollTop: node.scrollTop, scrollHeight: node.scrollHeight,
          hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.className }];
      }),
    )));
    throw error;
  } finally { await context.close(); }
}

try {
  for (const endpoint of ['/', '/consult']) for (const mobile of [false, true]) {
    await scenario(endpoint, mobile, 'visible snapshots, pure text, bounded scrolling and original retained', async ({ page, studio, emit, preview, content }) => {
      await emit({ type: 'tool', tool: 'model', label: 'internal-call-label', status: 'started' });
      await emit({ type: 'step', label: 'internal-step-label', detail: 'internal-detail' });
      await emit({ type: 'tool', tool: 'model', label: 'internal-call-label', status: 'completed', ms: 124, cacheHit: true });
      assert.equal(await page.locator('.tool-status,.activity,.consult-tools,.consult-retrieval').count(), 0);
      assert.doesNotMatch(await page.locator('body').innerText(), /internal-call-label|internal-step-label|internal-detail|已接收.*字|使用缓存/);
      if (studio) {
        await emit({ type: 'notice', text: '可以先从你每天要做的事情聊起。' });
        await page.getByText('可以先从你每天要做的事情聊起。', { exact: true }).waitFor();
      }
      const text = '<b>只显示文字</b>\n[不是链接](https://example.invalid)\n首段';
      await preview(text);
      await content.waitFor();
      assert.equal(await content.innerText(), text);
      assert.equal(await content.locator('b,a,img,script').count(), 0);
      await page.getByText('正在写…', { exact: true }).waitFor();
      if (studio) assert.equal(await page.locator('.ms-body').innerText(), draft.body);
      const long = Array.from({ length: 70 }, (_, i) => `第${i + 1}段：暂时生成的内容，还没有核验。`).join('\n');
      await preview(long);
      await page.waitForFunction((text) => document.querySelector('.model-preview-text')?.textContent === text, long);
      assert.equal(await content.innerText(), long); // snapshot, not concatenation
      const metrics = await content.evaluate((node) => ({
        height: node.clientHeight, max: node.scrollHeight, top: node.scrollTop,
      }));
      assert.ok(metrics.height <= 241 && metrics.max > metrics.height);
      await content.evaluate((node) => { node.scrollTop = 70; });
      await preview(`${long}\n新增尾段`);
      await page.waitForFunction(() => document.querySelector('.model-preview-text')?.textContent.endsWith('新增尾段'));
      assert.equal(await content.evaluate((node) => node.scrollTop), 70);
      // Visible must also mean reachable: the canvas must not cover the preview or composer.
      if (studio) {
        await page.waitForFunction(() => {
          const body = document.querySelector('.model-preview-text');
          const box = document.querySelector('.chat .composer');
          const canvas = document.querySelector('.canvas');
          if (!body || !box || !canvas) return false;
          const b = body.getBoundingClientRect(), c = box.getBoundingClientRect(), a = canvas.getBoundingClientRect();
          const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          return body.contains(hit) && b.bottom <= c.top && c.bottom <= innerHeight
            && (a.left >= c.right || a.top >= c.bottom);
        });
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).includes('新增尾段')), false);
      await page.screenshot({ path: path.join(screenshots, `${studio ? 'studio' : 'consult'}-${mobile ? 'phone' : 'desktop'}.png`), fullPage: true });
    });
    await scenario(endpoint, mobile, 'retry replaces, discarded/step clear, stale runs and malformed previews ignored', async ({ page, emit, preview, content, absent }) => {
      await preview('第一份临时内容');
      await content.waitFor();
      await emit({ type: 'model_progress', callId: 'call-next', characters: 5, mode: 'stream' });
      await absent();
      assert.equal(await page.getByText('正在生成 · 已接收 5 字（尚未完成）', { exact: true }).count(), 0);
      await preview('第二份完整快照', { callId: 'call-next' });
      await preview('迟到的旧调用');
      await preview('其他任务', { runId: 'old-run', seq: 999 });
      await preview('非法内容', { callId: 'call-next', kind: 'reasoning' });
      await preview('x'.repeat(12001), { callId: 'call-next' });
      assert.equal(await content.innerText(), '第二份完整快照');
      await preview('', { callId: 'call-next', status: 'discarded' });
      await absent();
      await preview('丢弃后迟到', { callId: 'call-next' });
      await absent();
      await preview('第三次内容', { callId: 'call-third' });
      await content.waitFor();
      await emit({ type: 'step', label: '开始下一步' });
      await absent();
      await preview('上一步迟到', { callId: 'call-third' });
      await absent();
      await emit({ type: 'model_progress', callId: 'call-buffer', characters: 0, mode: 'buffered' });
      assert.equal(await page.getByText('正在等待完整模型回复（尚未完成）', { exact: true }).count(), 0);
      await preview('新的公开回复', { callId: 'call-final' });
      await content.waitFor();
      assert.equal(await content.innerText(), '新的公开回复');
    });
    await scenario(endpoint, mobile, 'formal answer replaces preview, done clears and export/reload use formal content', async ({ page, studio, emit, preview, content, absent, end, setRecovery, api }) => {
      await preview('不可保存或导出的半段');
      await content.waitFor();
      const finalView = { ...view, draft: { ...draft, version: 3, body: '正式完整的创作正文' },
        report: { draftVersion: 3, status: 'pass', issues: [], verifiedClaimIds: [], verifiedImageIds: [], checkedAt: '' } };
      await emit(studio ? { type: 'draft', draft: finalView.draft } : { type: 'answer', answer });
      await absent();
      await page.getByText(studio ? finalView.draft.body : answer.reply, { exact: true }).waitFor();
      await preview('正式回答后的迟到内容', { callId: 'late-new-id' });
      await absent();
      setRecovery(studio
        ? { view: finalView, messages: [], busy: false, interrupted: false, updatedAt: '' }
        : { turns: [{ question, answer }], busy: false, interrupted: false, updatedAt: '' });
      await emit({ type: 'done', run: { ...run, status: 'completed' }, ...(studio ? { view: finalView } : {}) });
      await preview('done之后迟到', { callId: 'after-done' });
      await absent();
      await end();
      await page.locator('textarea:not([disabled])').first().waitFor();
      if (studio) {
        let exports = 0;
        await page.route('**/api/export?**', (route) => { exports++; return route.fulfill({ json: { version: finalView.draft.version, publishable: finalView.draft.body } }); });
        await page.getByRole('button', { name: /导出/ }).first().click();
        await page.getByText(finalView.draft.body, { exact: true }).last().waitFor();
        assert.equal(exports, 1);
      }
      assert.equal(await page.evaluate(() => window.__payloads.length), 1);
      assert.ok(!JSON.stringify(await page.evaluate(() => window.__payloads)).includes('不可保存或导出的半段'));
      await page.reload();
      await page.getByText(studio ? finalView.draft.body : answer.reply, { exact: true }).waitFor();
      await absent();
      assert.equal(await page.getByText('不可保存或导出的半段', { exact: true }).count(), 0);
    });
    await scenario(endpoint, mobile, 'disconnect restores authoritative state without promoting half a reply or duplicate POST', async ({ page, studio, preview, content, absent, reads, setRecovery }) => {
      await preview('断连前的半段内容');
      await content.waitFor();
      const before = reads();
      setRecovery(studio
        ? { view, messages: [], busy: false, interrupted: true, updatedAt: '', run: { ...run, status: 'interrupted' } }
        : { turns: [{ question }], busy: false, interrupted: true, updatedAt: '', run: { ...run, status: 'interrupted' } });
      await page.evaluate(() => window.__streams[0].fail());
      await page.locator('textarea:not([disabled])').first().waitFor();
      await absent();
      assert.ok(reads() > before);
      assert.equal(await page.evaluate(() => window.__payloads.length), 1);
      assert.equal(await page.getByText('断连前的半段内容', { exact: true }).count(), 0);
      if (studio) assert.equal(await page.locator('.ms-body').innerText(), draft.body);
      else assert.equal(await page.locator('.consult-answer').count(), 0);
    });
    await scenario(endpoint, mobile, 'cancel immediately clears; delayed preview/progress/formal events never revive', async ({ page, studio, api, emit, preview, content, absent, setRecovery }) => {
      let confirm;
      await page.route(`**${api}/cancel`, (route) => new Promise((resolve) => {
        confirm = async () => { await route.fulfill({ status: 202, json: {} }); resolve(); };
      }));
      await preview('停止前临时内容');
      await content.waitFor();
      await page.getByRole('button', { name: studio ? '停止任务' : '停止咨询', exact: true }).click();
      await absent();
      await emit({ type: 'model_progress', callId: 'late-count', characters: 800, mode: 'stream' });
      await preview('停止后迟到', { callId: 'late-cancel' });
      await emit(studio ? { type: 'draft', draft: { ...draft, body: '停止后迟到的正式事件' } }
        : { type: 'answer', answer: { ...answer, reply: '停止后迟到的正式事件' } });
      await absent();
      assert.equal(await page.getByText('停止后迟到的正式事件', { exact: true }).count(), 0);
      assert.equal(await page.getByText('正在生成 · 已接收 800 字（尚未完成）', { exact: true }).count(), 0);
      assert.equal(await page.locator('textarea').first().isDisabled(), true);
      setRecovery(studio
        ? { view, messages: [], busy: false, interrupted: false, updatedAt: '', run: { ...run, status: 'cancelled', cancelRequested: true } }
        : { turns: [{ question }], busy: false, interrupted: false, updatedAt: '', run: { ...run, status: 'cancelled', cancelRequested: true } });
      assert.ok(confirm);
      await confirm();
      await page.locator('textarea:not([disabled])').first().waitFor();
      await preview('恢复后旧流迟到', { callId: 'late-recovery' });
      await absent();
    });
    await scenario(endpoint, mobile, 'new session rejects old stream even while a new generation is active', async ({ page, studio, emit, preview, content, absent }) => {
      await preview('旧会话内容');
      await content.waitFor();
      await page.getByRole('button', { name: studio ? '新创作' : '新咨询', exact: true }).click();
      await absent();
      await preview('旧会话迟到', { callId: 'late-session' });
      await absent();
      await page.locator('textarea:not([disabled])').first().fill('新会话需求');
      await page.getByRole('button', { name: studio ? '发送' : '发送咨询', exact: true }).click();
      await page.waitForFunction(() => window.__streams.length === 2);
      const nextRun = { ...run, id: 'run-preview-two' };
      await emit({ type: 'run', run: nextRun, runId: nextRun.id }, 1);
      await emit({ type: 'model_preview', runId: nextRun.id, callId: 'call-new-session', kind: studio ? 'draft' : 'answer',
        status: 'generating', text: '新会话实时内容' }, 1);
      await content.waitFor();
      await preview('旧流再次迟到', { callId: 'late-again' });
      assert.equal(await content.innerText(), '新会话实时内容');
      const payloads = await page.evaluate(() => window.__payloads);
      assert.notEqual(payloads[0].sessionId, payloads[1].sessionId);
      assert.ok(!JSON.stringify(payloads[1]).includes('旧会话内容'));
    });
    await scenario(endpoint, mobile, 'error clears immediately and blocks subsequent previews', async ({ page, emit, preview, content, absent }) => {
      await preview('出错前临时文字');
      await content.waitFor();
      await emit({ type: 'error', text: '受控模拟失败，请稍后重试。' });
      await absent();
      await page.getByText('受控模拟失败，请稍后重试。', { exact: true }).waitFor();
      await preview('错误后迟到', { callId: 'late-error' });
      await emit({ type: 'model_progress', callId: 'late-error-progress', characters: 44, mode: 'stream' });
      await absent();
      assert.equal(await page.getByText('正在生成 · 已接收 44 字（尚未完成）', { exact: true }).count(), 0);
    });
    await scenario(endpoint, mobile, 'terminal run and done clear even before connection closes', async ({ emit, preview, content, absent }) => {
      await preview('结束前的临时文字');
      await content.waitFor();
      await emit({ type: 'run', run: { ...run, status: 'timed_out' } });
      await absent();
      await preview('超时后迟到', { callId: 'late-timeout' });
      await absent();
      await emit({ type: 'done', run: { ...run, status: 'timed_out' }, view });
      await preview('完成后迟到', { callId: 'late-done' });
      await absent();
    });
  }
  console.log(`All ${count} model preview browser scenarios passed; ${offline ? 'offline React' : 'real Next pages'}; all APIs mocked.`);
  console.log(`Screenshots: ${screenshots}`);
} finally { await browser.close(); }
