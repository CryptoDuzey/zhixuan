// Run against an isolated dev server, with every API response mocked (no keys).
// FRONTEND_BASE_URL=http://localhost:3117 FRONTEND_PLAYWRIGHT_PATH=<bundled playwright>
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { offlinePage } from './frontend-offline.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FRONTEND_PLAYWRIGHT_PATH || 'playwright');
const base = process.env.FRONTEND_BASE_URL || 'http://localhost:3117';
const offline = process.env.FRONTEND_OFFLINE === '1';
const studioHtml = offline ? offlinePage('../app/components/Studio.tsx', ['../app/globals.css', '../app/canvas.css']) : '';
const consultHtml = offline ? offlinePage('../app/consult/page.tsx', ['../app/globals.css', '../app/consult/consult.css']) : '';
const browser = await chromium.launch({
  headless: true,
  ...(process.env.FRONTEND_BROWSER_PATH ? { executablePath: process.env.FRONTEND_BROWSER_PATH } : {}),
});
const SID_KEY = 'zhixuan.studio.sid.v1';
const CONSULT_KEY = 'zhixuan.consult.v1';
const oldSid = 's-browser-restore';
const draft = {
  version: 2, platform: '小红书', modelId: 'pro-s', modelName: 'HUAWEI MateBook Pro S',
  title: '已保存的稿件', lead: '已保存导语', body: '已保存正文', cta: '', tags: [], images: [], claims: [],
};
const view = { draft, evidence: [], images: [] };
const snapshot = (overrides = {}) => ({
  view, messages: [{ role: 'user', text: '之前的需求' }, { role: 'assistant', text: '保存的回答', kind: 'agent' }],
  busy: false, interrupted: false, updatedAt: '2026-10-19T01:00:00Z', ...overrides,
});
const answer = (reply = '已保存推荐') => ({
  reply, recommendations: [{
    modelId: 'pro-s', modelName: 'HUAWEI MateBook Pro S', system: '鸿蒙',
    reason: '移动办公', tradeoff: '核实软件', evidenceIds: [], creativeModelId: 'pro-s',
  }], evidence: [],
});
const errors = [];
let count = 0;
let consultSnapshots = new Map();
async function scenario(name, run, { seed = { [SID_KEY]: oldSid }, mobile = false, disabled = false } = {}) {
  consultSnapshots = new Map();
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
  await context.addInitScript(({ seed, disabled }) => {
    if (disabled) {
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('disabled', 'SecurityError'); } });
    } else if (!localStorage.getItem('frontend-test-seeded')) {
      for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
      localStorage.setItem('frontend-test-seeded', '1');
    }
  }, { seed, disabled });
  if (offline) await context.route(`${base}/**`, (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: new URL(route.request().url()).pathname === '/consult' ? consultHtml : studioHtml,
  }));
  await page.route('**/api/**', (route) => route.fulfill({ status: 500, json: { error: 'Unexpected API call' } }));
  await page.route('**/api/consult?**', (route) => {
    const saved = consultSnapshots.get(new URL(route.request().url()).searchParams.get('sessionId'));
    return route.fulfill({ status: saved ? 200 : 404, json: saved || {} });
  });
  try {
    await run(page, context);
    assert.deepEqual(errors, []);
    console.log(`PASS ${++count}: ${name}`);
  } finally { await context.close(); }
}
const contains = async (page, text) => {
  await page.getByText(text, { exact: false }).first().waitFor();
};
const json = (route, data, status = 200) => {
  if (route.request().url().endsWith('/api/consult') && status === 200 && data.reply) {
    const request = route.request().postDataJSON();
    consultSnapshots.set(request.sessionId, { turns: [{ question: request.message, answer: data }], busy: false, interrupted: false, updatedAt: '' });
  }
  return route.fulfill({ status, json: data });
};

try {
  await scenario('refresh restores draft and dialogue; no duplicate POST; new creation resets sid', async (page) => {
    let posts = 0;
    await page.route('**/api/agent?**', (route) => json(route, snapshot()));
    await page.route('**/api/agent', (route) => { posts++; return json(route, {}); });
    await page.goto(base);
    await contains(page, '已保存的稿件');
    await contains(page, '之前的需求');
    await page.reload();
    await contains(page, '保存的回答');
    assert.equal(posts, 0);
    await page.getByRole('button', { name: '新创作', exact: true }).click();
    await contains(page, '已开启新创作');
    assert.notEqual(await page.evaluate((key) => localStorage.getItem(key), SID_KEY), oldSid);
    assert.equal(await page.getByText('已保存的稿件').count(), 0);
  });
  await scenario('restoration blocks send until GET completes', async (page) => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route('**/api/agent?**', async (route) => {
      await held;
      await json(route, snapshot());
    });
    await page.goto(base);
    await contains(page, '正在恢复会话');
    assert.equal(await page.getByRole('button', { name: '发送', exact: true }).isDisabled(), true);
    release();
    await contains(page, '已保存的稿件');
  });
  await scenario('busy GET polls until complete and stays blocked', async (page) => {
    let gets = 0;
    await page.route('**/api/agent?**', (route) => json(route, snapshot({ busy: ++gets === 1 })));
    await page.goto(base);
    await contains(page, '正在恢复任务');
    assert.equal(await page.getByRole('textbox').isDisabled(), true);
    await contains(page, '已恢复稿件与对话');
    assert.ok(gets >= 2);
    assert.equal(await page.getByRole('textbox').isDisabled(), false);
  });
  await scenario('interrupted task is explicit and never shown as completed', async (page) => {
    await page.route('**/api/agent?**', (route) => json(route, snapshot({ interrupted: true })));
    await page.goto(base);
    await contains(page, '任务因服务重启而中断，尚未完成');
    assert.equal(await page.getByRole('textbox').isDisabled(), false);
  });
  await scenario('missing session opens a new clean creation', async (page) => {
    await page.route('**/api/agent?**', (route) => json(route, {}, 404));
    await page.goto(base);
    await contains(page, '此前会话不存在');
    assert.notEqual(await page.evaluate((key) => localStorage.getItem(key), SID_KEY), oldSid);
  });
  await scenario('failed recovery blocks edits and allows retry', async (page) => {
    let fails = true;
    await page.route('**/api/agent?**', (route) => json(route, fails ? {} : snapshot(), fails ? 503 : 200));
    await page.goto(base);
    await contains(page, '暂时无法恢复');
    assert.equal(await page.getByRole('textbox').isDisabled(), true);
    fails = false;
    await page.getByRole('button', { name: '重试恢复' }).click();
    await contains(page, '已保存的稿件');
  });
  await scenario('product handoff creates isolated task; StrictMode retains selection; mobile fits', async (page) => {
    let gets = 0, payload;
    await page.route('**/api/agent?**', (route) => { gets++; return json(route, snapshot()); });
    await page.route('**/api/agent', async (route) => {
      payload = route.request().postDataJSON();
      await route.fulfill({ body: `${JSON.stringify({ type: 'done', view: { evidence: [], images: [] } })}\n`, contentType: 'application/x-ndjson' });
    });
    await page.goto(`${base}/?product=d14&scene=学生学习`);
    await contains(page, '已从选购端开启新创作');
    assert.equal(await page.getByRole('combobox').inputValue(), 'd14');
    assert.equal(gets, 0);
    assert.equal(new URL(page.url()).search, '');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);
    assert.notEqual(payload.sessionId, oldSid);
    assert.ok(payload.message.includes('HUAWEI MateBook D 14 2024'));
    assert.ok(!payload.history.includes('之前的需求'));
  }, { mobile: true });
  await scenario('409 switches to GET polling rather than resending', async (page) => {
    let gets = 0, posts = 0;
    await page.route('**/api/agent?**', (route) => json(route, snapshot({ busy: ++gets === 1 })));
    await page.route('**/api/agent', (route) => { posts++; return json(route, { error: '忙' }, 409); });
    await page.goto(base);
    await page.getByRole('textbox').fill('开始');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await contains(page, '正在恢复任务');
    await contains(page, '已恢复稿件与对话');
    assert.equal(posts, 1);
    assert.ok(gets >= 2);
  }, { seed: {} });
  await scenario('incomplete stream confirms status using GET', async (page) => {
    await page.route('**/api/agent', (route) => route.fulfill({
      body: '{"type":"step","label":"核对资料"}\n', contentType: 'application/x-ndjson',
    }));
    await page.route('**/api/agent?**', (route) => json(route, snapshot({ interrupted: true })));
    await page.goto(base);
    await page.getByRole('textbox').fill('开始');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await contains(page, '任务因服务重启而中断');
  }, { seed: {} });
  await scenario('storage denied never crashes Studio or consultation', async (page) => {
    await page.goto(base);
    await contains(page, '浏览器未允许保存会话编号');
    await page.getByRole('textbox').fill('可继续');
    assert.equal(await page.getByRole('button', { name: '发送', exact: true }).isDisabled(), false);
    await page.goto(`${base}/consult`);
    await contains(page, '浏览器未允许保存记录');
    await page.getByRole('textbox').fill('可继续');
    assert.equal(await page.getByRole('button', { name: '发送咨询' }).isDisabled(), false);
  }, { disabled: true });
  await scenario('consultation reload restores answer and recommendations without request; new consultation clears', async (page) => {
    let posts = 0;
    await page.route('**/api/consult', (route) => { posts++; return json(route, answer()); });
    await page.goto(`${base}/consult`);
    await page.getByRole('textbox').fill('出差怎么选');
    await page.getByRole('button', { name: '发送咨询' }).click();
    await contains(page, '已保存推荐');
    await page.reload();
    await contains(page, '已保存推荐');
    assert.equal(posts, 1);
    await page.getByRole('button', { name: /HUAWEI MateBook Pro S/ }).click();
    await page.getByRole('link', { name: '开启新创作' }).click();
    await contains(page, '已从选购端开启新创作');
    await page.goto(`${base}/consult`);
    await contains(page, '已保存推荐');
    await page.getByRole('button', { name: '新咨询', exact: true }).click();
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), CONSULT_KEY), null);
    await page.reload();
    await contains(page, '先聊需求，再选产品');
    assert.equal(await page.getByText('已保存推荐').count(), 0);
  }, { seed: {} });
  await scenario('new consultation during pending response rejects late answer and preserves new answer', async (page) => {
    let release;
    await page.route('**/api/consult', async (route) => {
      const q = route.request().postDataJSON().message;
      if (q === '旧问题') {
        await new Promise((resolve) => { release = resolve; });
        await json(route, answer('迟到旧回复')).catch(() => {});
      } else await json(route, answer('新会话回复'));
    });
    await page.goto(`${base}/consult`);
    await page.getByRole('textbox').fill('旧问题');
    await page.getByRole('button', { name: '发送咨询' }).click();
    await contains(page, '正在核对资料');
    await page.getByRole('button', { name: '新咨询', exact: true }).click();
    await page.getByRole('textbox').fill('新问题');
    await page.getByRole('button', { name: '发送咨询' }).click();
    await contains(page, '新会话回复');
    release();
    await page.reload();
    await contains(page, '新会话回复');
    assert.equal(await page.getByText('迟到旧回复').count(), 0);
    assert.equal(await page.getByText('旧问题', { exact: true }).count(), 0);
  }, { seed: {} });
  await scenario('unanswered consultation reload offers explicit retry without automatic request', async (page) => {
    let posts = 0;
    await page.route('**/api/consult', (route) => { posts++; return json(route, answer('重试后的回复')); });
    consultSnapshots.set('s-unanswered', { turns: [{ question: '尚未回答的问题' }], busy: false, interrupted: true, updatedAt: '' });
    await page.goto(`${base}/consult`);
    await contains(page, '刷新不会重复发送');
    assert.equal(posts, 0);
    await page.getByRole('button', { name: '重试这条' }).click();
    await contains(page, '重试后的回复');
    assert.equal(posts, 1);
    assert.equal(await page.getByText('尚未回答的问题', { exact: true }).count(), 1);
  }, { seed: { 'zhixuan.consult.sid.v1': 's-unanswered' } });
  await scenario('corrupt consultation data opens cleanly', async (page) => {
    await page.goto(`${base}/consult`);
    await contains(page, '此前记录无法读取');
    assert.equal(await page.getByRole('textbox').isDisabled(), false);
  }, { seed: { [CONSULT_KEY]: '{"version":8,"turns":[null]}' } });
  console.log(`All ${count} browser scenarios passed; no uncaught page errors.`);
} finally { await browser.close(); }
