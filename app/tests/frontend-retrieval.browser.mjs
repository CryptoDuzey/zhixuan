// Isolated frontend checks: every API is mocked; no model, keys, or real documents.
// FRONTEND_BASE_URL=http://localhost:3117 FRONTEND_PLAYWRIGHT_PATH=<bundled playwright>
// FRONTEND_OFFLINE=1 renders the actual page component in Chromium without any server.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FRONTEND_PLAYWRIGHT_PATH || 'playwright');
const base = process.env.FRONTEND_BASE_URL || 'http://localhost:3117';
const offline = process.env.FRONTEND_OFFLINE === '1';

function offlinePage() {
  const ts = require('typescript');
  const modules = [];
  const ids = new Map();
  function collect(filename) {
    if (ids.has(filename)) return ids.get(filename);
    const index = modules.length;
    ids.set(filename, index);
    const entry = { code: '', imports: {} };
    modules.push(entry);
    if (filename.endsWith('.css')) return index;
    const source = readFileSync(filename, 'utf8');
    entry.code = /\.tsx?$/.test(filename) ? ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText : source;
    const resolve = createRequire(filename);
    for (const match of entry.code.matchAll(/\brequire\((['"])([^'"]+)\1\)/g)) {
      entry.imports[match[2]] = collect(resolve.resolve(match[2]));
    }
    return index;
  }
  const component = collect(fileURLToPath(new URL('../app/consult/page.tsx', import.meta.url)));
  const react = collect(require.resolve('react'));
  const client = collect(require.resolve('react-dom/client'));
  const script = `const modules=${JSON.stringify(modules)}, cache={};
    function load(id) {
      if (cache[id]) return cache[id].exports;
      const module = cache[id] = {exports:{}}, entry = modules[id];
      new Function('module','exports','require','process',entry.code)(
        module,module.exports,(name)=>load(entry.imports[name]),{env:{NODE_ENV:'production'}});
      return module.exports;
    }
    const React=load(${react});
    load(${client}).createRoot(document.getElementById('root')).render(
      React.createElement(React.StrictMode,null,React.createElement(load(${component}).default)));
  `.replace(/<\/script/gi, '<\\/script');
  const css = ['../app/globals.css', '../app/consult/consult.css']
    .map((name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>${script}</script></body></html>`;
}
const html = offline ? offlinePage() : undefined;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.FRONTEND_BROWSER_PATH ? { executablePath: process.env.FRONTEND_BROWSER_PATH } : {}),
});
const storageKey = 'zhixuan.consult.v1';
const id = '0123456789abcdef01234567';
const retrieval = {
  status: 'ready', source: '本地已下载知识库', scope: 'all-indexed-documents',
  query: '移动办公', scannedFiles: 312, returned: 1, maximumResults: 50, exhaustive: false,
  message: '按相关性返回，非穷尽结果。',
  items: [{
    id, title: '移动办公选购指南', path: '知识库/选购指南.md',
    preview: '先核实所需的软件与版本。<img src=x onerror=alert(1)>',
    documentUrl: `/api/knowledge/document?id=${id}`, score: 0.8,
  }],
};
const answer = (summary = retrieval) => ({
  reply: '先核实软件，再根据移动办公需求选择。',
  recommendations: [], evidence: [],
  ...(summary === undefined ? {} : { retrieval: summary }),
});
const saved = (response) => JSON.stringify({ version: 1, turns: [{ question: '移动办公怎么选', answer: response }] });
let passed = 0;

async function scenario(name, run, { seed, mobile = false } = {}) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  const errors = [];
  const unexpected = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await context.addInitScript(({ seed, storageKey }) => {
    if (location.pathname !== '/consult') return;
    if (!localStorage.getItem('frontend-retrieval-seeded')) {
      localStorage.clear();
      if (seed) localStorage.setItem(storageKey, seed);
      localStorage.setItem('frontend-retrieval-seeded', '1');
    }
  }, { seed, storageKey });
  if (offline) {
    await context.route(`${base}/**`, (route) => {
      if (new URL(route.request().url()).pathname === '/consult') {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
      }
      return route.abort();
    });
  }
  await context.route('**/api/**', (route) => {
    unexpected.push(route.request().url());
    return route.fulfill({ status: 500, json: { error: 'Unexpected API call' } });
  });
  const page = await context.newPage();
  const snapshots = new Map();
  page.on('response', async (response) => {
    if (response.url().endsWith('/api/consult') && response.ok()) {
      const request = response.request().postDataJSON();
      const answer = await response.json().catch(() => null);
      if (answer?.reply) snapshots.set(request.sessionId, { turns: [{ question: request.message, answer }], busy: false, interrupted: false, updatedAt: '' });
    }
  });
  await page.route('**/api/consult?**', (route) => {
    const saved = snapshots.get(new URL(route.request().url()).searchParams.get('sessionId'));
    return route.fulfill({ status: saved ? 200 : 404, json: saved || {} });
  });
  page.setDefaultTimeout(15_000);
  try {
    await run(page, context);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    console.log(`PASS ${++passed}: ${name}`);
  } finally { await context.close(); }
}
async function send(page, question = '移动办公怎么选') {
  await page.getByRole('textbox').fill(question);
  await page.getByRole('button', { name: '发送咨询', exact: true }).click();
  await page.getByText('先核实软件，再根据移动办公需求选择。', { exact: true }).first().waitFor();
}
async function openRetrieval(page) {
  const panel = page.locator('details.consult-retrieval').first();
  await panel.locator('summary').click();
  assert.equal(await panel.getAttribute('open'), '');
  return panel;
}

try {
  await scenario('live results fold, link to local original, refresh and retain safe history', async (page, context) => {
    let posts = 0;
    const payloads = [];
    await page.route('**/api/consult', (route) => {
      posts++;
      payloads.push(route.request().postDataJSON());
      return route.fulfill({ json: answer({
        ...retrieval, settings: { key: 'NEVER-PERSIST' },
        items: [{ ...retrieval.items[0], fullDocument: 'NEVER-PERSIST' }],
      }) });
    });
    await context.route('**/api/knowledge/document?**', (route) => route.fulfill({
      contentType: 'text/plain; charset=utf-8', body: 'MOCK-ORIGINAL-DOCUMENT',
    }));
    await page.goto(`${base}/consult`);
    await send(page);
    const panel = page.locator('details.consult-retrieval');
    assert.equal(await panel.getAttribute('open'), null);
    await panel.locator('summary').focus();
    await page.keyboard.press('Enter');
    await panel.getByText('来源：本地已下载知识库', { exact: true }).waitFor();
    assert.ok((await panel.innerText()).includes('全部已索引文档 · 扫描 312 份文件'));
    assert.ok((await panel.innerText()).includes('返回 1 条 · 最多 50 条'));
    assert.ok((await panel.innerText()).includes('非穷尽结果，不代表知识库完整目录'));
    assert.equal(await panel.locator('img').count(), 0);
    assert.ok((await panel.innerText()).includes('<img src=x onerror=alert(1)>'));
    const link = panel.getByRole('link', { name: '查看原文：移动办公选购指南', exact: true });
    assert.equal(await link.getAttribute('href'), retrieval.items[0].documentUrl);
    const popupPromise = page.waitForEvent('popup');
    await link.click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.equal(popup.url(), `${base}${retrieval.items[0].documentUrl}`);
    assert.ok((await popup.locator('body').innerText()).includes('MOCK-ORIGINAL-DOCUMENT'));
    await popup.close();
    const raw = await page.evaluate((key) => localStorage.getItem(key), storageKey);
    assert.equal(raw, null); // New sessions store only their ID in the browser.
    assert.ok(!(await page.locator('body').innerText()).includes('NEVER-PERSIST'));
    await page.reload();
    await page.locator('details.consult-retrieval').waitFor();
    assert.equal(posts, 1);
    await openRetrieval(page);
    assert.equal(await page.getByRole('link', { name: '查看原文：移动办公选购指南', exact: true }).count(), 1);
    await send(page, '还要关注什么');
    assert.equal(posts, 2);
    assert.deepEqual(payloads[1], { sessionId: payloads[0].sessionId, message: '还要关注什么' });
    await page.getByRole('button', { name: '新咨询', exact: true }).click();
    assert.equal(await page.locator('details.consult-retrieval').count(), 0);
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), storageKey), null);
  });

  await scenario('unavailable source never appears as successful or offers document links', async (page) => {
    await page.route('**/api/consult', (route) => route.fulfill({ json: answer({
      ...retrieval, status: 'unavailable', returned: 0, items: [],
      message: '本地检索服务暂不可用，请稍后再试。',
    }) }));
    await page.goto(`${base}/consult`);
    await send(page);
    const panel = await openRetrieval(page);
    assert.ok((await panel.locator('summary').innerText()).includes('暂不可用'));
    assert.ok((await panel.innerText()).includes('来源：本地已下载知识库（暂不可用）'));
    assert.ok((await panel.innerText()).includes('本地检索服务暂不可用'));
    assert.equal(await panel.getByRole('link').count(), 0);
    assert.ok(!(await panel.innerText()).includes('返回 0 条'));
    await page.reload();
    const restored = await openRetrieval(page);
    assert.ok((await restored.locator('summary').innerText()).includes('暂不可用'));
  });

  await scenario('empty successful retrieval explains no matches and its incomplete scope', async (page) => {
    await page.goto(`${base}/consult`);
    const panel = await openRetrieval(page);
    assert.ok((await panel.locator('summary').innerText()).includes('0 条结果'));
    assert.ok((await panel.innerText()).includes('没有找到匹配资料'));
    assert.ok((await panel.innerText()).includes('非穷尽'));
    assert.equal(await panel.getByRole('link').count(), 0);
  }, { seed: saved(answer({ ...retrieval, returned: 0, items: [] })) });

  await scenario('unsafe links received live become unavailable while preserving the answer', async (page) => {
    await page.route('**/api/consult', (route) => route.fulfill({ json: answer({
      ...retrieval, items: [{ ...retrieval.items[0], documentUrl: 'javascript:alert(1)' }],
    }) }));
    await page.goto(`${base}/consult`);
    await send(page);
    const panel = await openRetrieval(page);
    assert.ok((await panel.innerText()).includes('未通过校验'));
    assert.ok((await panel.locator('summary').innerText()).includes('暂不可用'));
    assert.equal(await panel.getByRole('link').count(), 0);
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), storageKey), null);
  });

  await scenario('tampered saved retrieval is contained and legacy answers still restore', async (page) => {
    await page.goto(`${base}/consult`);
    const panel = await openRetrieval(page);
    assert.ok((await panel.locator('summary').innerText()).includes('暂不可用'));
    assert.equal(await panel.getByRole('link').count(), 0);
    await page.getByText('旧版答复正文', { exact: true }).waitFor();
    assert.equal(await page.locator('details.consult-retrieval').count(), 1);
  }, { seed: JSON.stringify({ version: 1, turns: [
    { question: '已有资料', answer: answer({ ...retrieval, items: [{ ...retrieval.items[0], documentUrl: `https://example.com/${id}` }] }) },
    { question: '旧问题', answer: { reply: '旧版答复正文', recommendations: [], evidence: [] } },
  ] }) });

  await scenario('50 long results remain folded and fit an iPhone viewport when expanded', async (page) => {
    await page.goto(`${base}/consult`);
    const panel = page.locator('details.consult-retrieval');
    assert.equal(await panel.getAttribute('open'), null);
    await openRetrieval(page);
    assert.equal(await panel.getByRole('link').count(), 50);
    assert.ok((await panel.innerText()).includes('返回 50 条 · 最多 50 条'));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    if (process.env.FRONTEND_SCREENSHOT_PATH) {
      await panel.locator('summary').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.resolve(process.env.FRONTEND_SCREENSHOT_PATH) });
    }
    await panel.locator('summary').click();
    assert.equal(await panel.getAttribute('open'), null);
    assert.equal(await page.getByRole('textbox').isEnabled(), false); // Legacy saved records are read-only.
  }, { mobile: true, seed: saved(answer({
    ...retrieval, returned: 50, items: Array.from({ length: 50 }, (_, index) => {
      const documentId = index.toString(16).padStart(24, '0');
      return {
        id: documentId, title: `文档${index} ${'长标题'.repeat(50)}`, path: `资料/${'longpath'.repeat(20)}.md`,
        preview: '适用软件和实际使用场景。'.repeat(30),
        documentUrl: `/api/knowledge/document?id=${documentId}`,
      };
    }),
  })) });
  console.log(`All ${passed} retrieval browser scenarios passed; all APIs mocked; ${offline ? 'offline component rendering (no server)' : 'existing Next server'}.`);
} finally { await browser.close(); }
