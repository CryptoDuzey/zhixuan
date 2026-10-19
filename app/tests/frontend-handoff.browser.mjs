// Real React components offline by default; FRONTEND_OFFLINE=0 uses existing Next pages.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { offlinePage } from './frontend-offline.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FRONTEND_PLAYWRIGHT_PATH || 'playwright');
const base = process.env.FRONTEND_BASE_URL || 'http://localhost:3100';
const offline = process.env.FRONTEND_OFFLINE !== '0';
const studioHtml = offline ? offlinePage('../app/components/Studio.tsx', ['../app/globals.css', '../app/canvas.css']) : '';
const consultHtml = offline ? offlinePage('../app/consult/page.tsx', ['../app/globals.css', '../app/canvas.css', '../app/consult/consult.css']) : '';
const screenshots = `../artifacts/frontend-handoff${offline ? '-offline' : ''}`;
mkdirSync(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.FRONTEND_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const key = 'zhixuan.handoff.v1';
const recommendation = { modelId: 'pro-s', creativeModelId: 'pro-s', modelName: 'HUAWEI MateBook Pro S', system: '鸿蒙',
  reason: '助手理由不得进入事实', tradeoff: '核实插件', evidenceIds: [] };
const answer = { reply: '推荐前请核实软件。', recommendations: [recommendation], evidence: [] };
const question = '预算 8000，经常出差，必须运行特定插件。' + '需要核实办公软件版本。'.repeat(30);
const snapshot = { turns: [{ question: '之前给家人买显示器' }, { question, answer }],
  busy: false, interrupted: false, updatedAt: '' };
let count = 0;
async function scenario(name, fn, mobile = false) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (offline) await context.route(`${base}/**`, (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: new URL(route.request().url()).pathname === '/consult' ? consultHtml : studioHtml,
  }));
  await page.route('**/api/**', (route) => route.fulfill({ status: 500, json: { error: 'Unexpected API request' } }));
  try { await fn(page, context); assert.deepEqual(errors, []); console.log(`PASS ${++count}: ${name}`); }
  finally { await context.close(); }
}
async function open(page) {
  await page.addInitScript(() => localStorage.setItem('zhixuan.consult.sid.v1', 's-consult-handoff'));
  await page.route('**/api/consult?**', (route) => route.fulfill({ json: snapshot }));
  await page.goto(`${base}/consult`);
  await page.getByRole('button', { name: /HUAWEI MateBook Pro S/ }).click();
  await page.getByRole('button', { name: '确认创作需求' }).click();
}
const sse = (...events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
try {
  for (const mobile of [false, true]) await scenario(`consultation opens shared settings, saves and returns without losing input (${mobile ? 'phone' : 'desktop'})`, async (page) => {
    let saves = 0;
    await page.route('**/api/settings', (route) => {
      if (route.request().method() === 'POST') {
        assert.deepEqual(route.request().postDataJSON(), { action: 'save', baseUrl: 'https://example.invalid/v1', model: 'mock-model-updated' });
        saves++;
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: { configured: true, baseUrl: 'https://example.invalid/v1', model: 'mock-model' } });
    });
    await page.goto(`${base}/consult`);
    await page.locator('#consult-input:not([disabled])').waitFor();
    await page.locator('#consult-input').fill('尚未发送的咨询需求');
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '模型设置' });
    await settings.getByLabel('模型', { exact: true }).waitFor();
    await page.getByText('已有本机密钥，可直接测试连接。').waitFor();
    assert.equal(await settings.getByLabel('API Key').inputValue(), '');
    await settings.getByLabel('模型', { exact: true }).fill('mock-model-updated');
    await settings.getByRole('button', { name: '保存设置' }).click();
    await settings.getByText('已保存在本机，下次创作会使用这个模型。').waitFor();
    assert.equal(saves, 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${screenshots}/${mobile ? 'phone' : 'desktop'}-consult-settings.png` });
    await settings.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(await page.getByRole('dialog', { name: '模型设置' }).count(), 0);
    assert.equal(await page.locator('#consult-input').inputValue(), '尚未发送的咨询需求');
    assert.equal(new URL(page.url()).pathname, '/consult');
  }, mobile);
  await scenario('consultation disables shared settings entry while processing', async (page) => {
    await page.addInitScript(() => localStorage.setItem('zhixuan.consult.sid.v1', 's-busy-settings'));
    await page.route('**/api/consult?**', (route) => route.fulfill({ json: { ...snapshot, busy: true,
      run: { id: 'r-busy-settings', status: 'running', phase: '处理咨询', cancelRequested: false } } }));
    await page.goto(`${base}/consult`);
    await page.getByRole('button', { name: '停止咨询' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '模型设置', exact: true }).isDisabled(), true);
  });
  for (const mobile of [false, true]) await scenario(`editable private handoff, independent session, platform and free send (${mobile ? 'phone' : 'desktop'})`, async (page) => {
    let payload;
    await open(page);
    const dialog = page.getByRole('dialog');
    assert.equal(await dialog.getByLabel('发布平台').inputValue(), '');
    assert.equal(await dialog.getByRole('button', { name: '确认并开启独立创作' }).isDisabled(), true);
    assert.equal(await dialog.getByRole('checkbox').nth(0).isChecked(), false);
    assert.equal(await dialog.getByRole('checkbox').nth(1).isChecked(), true);
    assert.equal(await dialog.getByLabel('任务与使用需求').inputValue(), question);
    await dialog.getByLabel('任务与使用需求').fill(`${question}\n写成我的出差经验分享`);
    await dialog.getByLabel('目标受众').fill('经常出差的职场新人');
    await dialog.getByLabel('硬约束').fill('只用核实过的兼容信息，不保证运行插件');
    await dialog.getByLabel('发布平台').selectOption(mobile ? '朋友圈' : '公众号');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await dialog.evaluate((node) => { node.scrollTop = 0; });
    await page.screenshot({ path: `${screenshots}/${mobile ? 'phone' : 'desktop'}-confirm.png` });
    await dialog.getByRole('button', { name: '确认并开启独立创作' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${screenshots}/${mobile ? 'phone' : 'desktop'}-confirm-bottom.png` });
    await page.route('**/api/agent', (route) => {
      payload = route.request().postDataJSON();
      return route.fulfill({ contentType: 'text/event-stream', body: sse({ type: 'clarify', question: '还可以自由补充你的表达方式。', options: [] }, { type: 'done', view: { evidence: [], images: [] } }) });
    });
    await dialog.getByRole('button', { name: '确认并开启独立创作' }).click();
    await page.waitForURL((url) => url.pathname === '/' && !url.search);
    const box = page.locator('textarea').first();
    await box.waitFor();
    const text = await box.inputValue();
    assert.ok(text.includes(question));
    assert.ok(text.includes(mobile ? '朋友圈' : '公众号'));
    assert.ok(text.includes('经常出差的职场新人'));
    assert.ok(!text.includes('助手理由不得进入事实'));
    assert.ok(!text.includes('之前给家人买显示器'));
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), key), null);
    assert.equal(await page.getByRole('combobox', { name: '创作产品' }).inputValue(), 'pro-s');
    await box.fill(`${text}\n请用自然语言写，不套模板。`);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByText('还可以自由补充你的表达方式。', { exact: true }).waitFor();
    assert.ok(payload.message.includes(question));
    assert.ok(payload.message.includes('不套模板'));
    assert.notEqual(payload.sessionId, 's-consult-handoff');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${screenshots}/${mobile ? 'phone' : 'desktop'}-creation.png`, fullPage: true });
  }, mobile);
  await scenario('storage denied leaves editable needs and manual fallback without navigation', async (page) => {
    await page.addInitScript(() => { Object.defineProperty(window, 'sessionStorage', { get() { throw Error('denied'); } }); });
    await open(page);
    await page.getByLabel('发布平台').selectOption('小红书');
    await page.getByRole('button', { name: '确认并开启独立创作' }).click();
    await page.getByRole('alert').getByText('浏览器未能暂存需求', { exact: false }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/consult');
    assert.ok((await page.getByLabel('可复制的创作需求').inputValue()).includes(question));
    assert.equal(await page.getByRole('link', { name: '进入创作，手动粘贴需求' }).getAttribute('href'), '/?product=pro-s');
  });
  await scenario('new unrelated question clears old selection', async (page) => {
    await open(page);
    await page.getByRole('button', { name: '返回咨询' }).click();
    await page.route('**/api/consult', (route) => route.fulfill({ json: { reply: '显示器需要另行确认。', recommendations: [], evidence: [] } }));
    await page.locator('#consult-input').fill('现在改为给家人买显示器');
    await page.locator('#consult-input').press('Enter');
    await page.getByText('显示器需要另行确认。').waitFor();
    assert.equal(await page.getByRole('button', { name: '确认创作需求' }).count(), 0);
  });
  await scenario('old product/scene URL stays compatible without forcing platform', async (page) => {
    await page.goto(`${base}/?product=d14&scene=${encodeURIComponent('老链接的办公用途')}`);
    await page.waitForURL((url) => !url.search);
    await page.locator('textarea:not([disabled])').waitFor();
    assert.equal(await page.getByRole('combobox', { name: '创作产品' }).inputValue(), 'd14');
    const text = await page.locator('textarea').inputValue();
    assert.ok(text.includes('老链接的办公用途'));
    assert.ok(!text.includes('小红书'));
  });
  await scenario('expired transfer opens a safe empty independent creation', async (page) => {
    await page.goto(`${base}/?handoff=s-expired-token`);
    await page.getByText('交接需求已过期或无法读取', { exact: false }).waitFor();
    assert.equal(await page.locator('textarea').inputValue(), '');
  });
  for (const endpoint of ['/consult', '/']) await scenario(`model progress only shows counts, resets attempt and clears on new session ${endpoint}`, async (page) => {
    await page.addInitScript((endpoint) => {
      const original = window.fetch.bind(window);
      window.fetch = async (url, options) => {
        if (url === (endpoint === '/' ? '/api/agent' : '/api/consult') && options?.method === 'POST') {
          return new Response(new ReadableStream({ start(controller) {
            window.__emitProgress = (event) => controller.enqueue(new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
          } }), { headers: { 'content-type': 'text/event-stream' } });
        }
        return original(url, options);
      };
    }, endpoint);
    await page.goto(`${base}${endpoint}`);
    await page.locator('textarea:not([disabled])').waitFor();
    await page.locator('textarea').fill('自由描述任务');
    await page.locator('textarea').press('Enter');
    await page.waitForFunction(() => typeof window.__emitProgress === 'function');
    const emit = (item) => page.evaluate((item) => window.__emitProgress(item), item);
    await emit({ type: 'model_progress', callId: 'first', label: '生成', characters: 123, attempt: 1, mode: 'stream' });
    await page.getByText('正在生成 · 已接收 123 字（尚未完成）', { exact: true }).waitFor();
    await emit({ type: 'model_progress', callId: 'retry', label: '生成', characters: 5, attempt: 2, mode: 'stream' });
    await page.getByText('正在生成 · 已接收 5 字（尚未完成）', { exact: true }).waitFor();
    assert.equal(await page.getByText('正在生成 · 已接收 123 字（尚未完成）', { exact: true }).count(), 0);
    await emit({ type: 'model_progress', callId: 'buffer', label: '生成', characters: 0, attempt: 3, mode: 'buffered' });
    await page.getByText('正在等待完整模型回复（尚未完成）', { exact: true }).waitFor();
    await page.getByRole('button', { name: endpoint === '/' ? '新创作' : '新咨询', exact: true }).click();
    assert.equal(await page.getByText('正在等待完整模型回复（尚未完成）', { exact: true }).count(), 0);
  });
  for (const endpoint of ['/consult', '/']) for (const quota of [false, true]) await scenario(`${quota ? 'quota' : 'knowledge'} failure stays visible without automatic retry ${endpoint}`, async (page) => {
    const run = { id: 'r-failed', status: 'running', phase: '检索资料', cancelRequested: false };
    const failure = quota ? '模型服务额度不足，请补充额度或在模型设置中更换密钥后重试。' : '知识库暂不可用，请稍后重试。';
    let posts = 0;
    await page.route(endpoint === '/' ? '**/api/agent' : '**/api/consult', (route) => { posts++; return route.fulfill({
      contentType: 'text/event-stream', body: sse(
        { type: 'run', run },
        { type: 'model_progress', callId: 'r-one', label: '生成', characters: 28, attempt: 1, mode: 'stream' },
        { type: 'tool', tool: quota ? 'model' : 'knowledge', status: 'failed', label: quota ? '生成回复' : '检索产品目录' },
        { type: 'error', text: failure },
        { type: 'done', run: { ...run, status: 'failed' }, view: { evidence: [], images: [] } }),
    }); });
    await page.route('**/api/consult?**', (route) => route.fulfill({ json: {
      turns: [{ question: '请列出完整知识库产品范围' }], error: failure, busy: false,
      interrupted: false, updatedAt: '', run: { ...run, status: 'failed' },
    } }));
    await page.goto(`${base}${endpoint}`);
    await page.locator('textarea:not([disabled])').waitFor();
    await page.locator('textarea').fill('请列出完整知识库产品范围');
    await page.locator('textarea').press('Enter');
    await page.getByRole('alert').getByText(failure, { exact: true }).waitFor().catch(async () => {
      // Studio's existing error box is visible text without alert semantics.
      await page.getByText(failure, { exact: true }).waitFor();
    });
    await page.getByText('调用失败', { exact: true }).waitFor();
    assert.equal(await page.getByText('正在生成 · 已接收 28 字（尚未完成）', { exact: true }).count(), 0);
    await page.locator('textarea:not([disabled])').waitFor();
    assert.equal(posts, 1);
    await page.screenshot({ path: `${screenshots}/${endpoint === '/' ? 'studio' : 'consult'}-${quota ? 'quota-' : ''}failure.png`, fullPage: true });
  });
  await scenario('request length rejection preserves complete editable handoff', async (page) => {
    await open(page);
    const full = '完整需求不截断。'.repeat(400);
    await page.getByLabel('任务与使用需求').fill(full);
    await page.getByLabel('发布平台').selectOption('公众号');
    await page.getByRole('button', { name: '确认并开启独立创作' }).click();
    await page.waitForURL((url) => url.pathname === '/' && !url.search);
    await page.locator('textarea:not([disabled])').waitFor();
    await page.route('**/api/agent', (route) => route.fulfill({ status: 413, json: { error: '消息超过 2000 字，请精简后重试。内容未被保存或截断。' } }));
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByText('消息超过 2000 字，请精简后重试。内容未被保存或截断。', { exact: true }).waitFor();
    assert.ok((await page.locator('textarea').inputValue()).includes(full));
  });
  console.log(`All ${count} handoff/progress browser scenarios passed; ${offline ? 'offline React components' : 'existing Next pages'}; APIs mocked.`);
} finally { await browser.close(); }
