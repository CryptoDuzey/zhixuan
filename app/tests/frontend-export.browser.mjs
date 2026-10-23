// Real Next pages; deterministic network delays reproduce an export/edit race.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FRONTEND_PLAYWRIGHT_PATH || 'playwright');
const base = process.env.FRONTEND_BASE_URL || 'http://localhost:3100';
const browser = await chromium.launch({ headless: true, executablePath: process.env.FRONTEND_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const draft = { version: 1, platform: '朋友圈', modelId: 'pro-s', modelName: 'HUAWEI MateBook Pro S', title: '第一版标题', lead: '', body: '第一版正文', cta: '', tags: [], images: [], claims: [] };
const report = { draftVersion: 1, status: 'pass', issues: [], verifiedClaimIds: [], verifiedImageIds: [], checkedAt: '' };
const view = { draft, report, evidence: [], images: [] };
let count = 0;
async function scenario(name, test, mobile) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1360, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await context.addInitScript(() => {
    localStorage.setItem('zhixuan.studio.sid.v1', 's-export-race');
    const original = window.fetch.bind(window);
    window.fetch = (url, options) => {
      // Model a transport that still delivers an already buffered response after abort.
      if (String(url).startsWith('/api/export?')) return new Promise(resolve => {
        window.__exportCount = (window.__exportCount || 0) + 1;
        window.__releaseExport = (data, status = 200) => resolve(Response.json(data, { status }));
      });
      return original(url, options);
    };
  });
  await page.route('**/api/**', route => route.fulfill({ status: 500, json: { error: 'Unexpected API' } }));
  await page.route('**/api/agent?**', route => route.fulfill({ json: { view, messages: [], busy: false, interrupted: false, updatedAt: '' } }));
  const next = { ...view, draft: { ...draft, version: 2, body: '第二版的正式正文' }, report: { ...report, draftVersion: 2 } };
  await page.route('**/api/agent', route => route.fulfill({ contentType: 'text/event-stream', body: [
    { type: 'draft', draft: next.draft }, { type: 'check', report: next.report }, { type: 'done', view: next },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') }));
  try {
    await page.goto(base);
    await page.getByRole('button', { name: '导出内容', exact: true }).waitFor();
    await test(page, next);
    assert.deepEqual(errors, []);
    console.log(`PASS ${++count}: ${mobile ? 'phone' : 'desktop'} ${name}`);
  } finally { await context.close(); }
}
try {
  for (const mobile of [false, true]) {
    await scenario('an export returning after an edit cannot supply old copy text', async page => {
      await page.getByRole('button', { name: '导出内容', exact: true }).click();
      await page.waitForFunction(() => !!window.__releaseExport);
      await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
      await page.locator('textarea:not([disabled])').fill('改写开头');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await page.getByText('第二版的正式正文', { exact: true }).waitFor();
      await page.evaluate(() => window.__releaseExport({ version: 1, publishable: '旧导出专用字样' }));
      await page.getByRole('button', { name: '内容建议', exact: true }).click();
      assert.equal(await page.getByText('旧导出专用字样', { exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: '复制文本', exact: true }).count(), 0);
    }, mobile);
    await scenario('export errors stay next to the retry action; mismatched versions cannot be copied', async page => {
      await page.getByRole('button', { name: '导出内容', exact: true }).click();
      await page.getByText('正在准备正文…', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '导出内容', exact: true }).isDisabled(), true);
      assert.equal(await page.evaluate(() => window.__exportCount), 1);
      await page.evaluate(() => window.__releaseExport({ error: '网络暂时不可用' }, 503));
      await page.getByRole('dialog').getByRole('alert').getByText('网络暂时不可用', { exact: false }).waitFor();
      await page.getByRole('button', { name: '重新导出', exact: true }).click();
      await page.waitForFunction(() => window.__exportCount === 2);
      await page.evaluate(() => window.__releaseExport({ version: 99, publishable: '其他版本正文' }));
      await page.getByText('稿件已更新或正文未准备好，请重新导出。', { exact: false }).waitFor();
      assert.equal(await page.getByRole('button', { name: '复制文本', exact: true }).count(), 0);
      assert.equal(await page.getByText('其他版本正文', { exact: true }).count(), 0);
    }, mobile);
    await scenario('the downloaded text is publishable content; optional sources contain no call logs', async page => {
      const publishable = '可以直接发布的标题\n\n第一段正文\n第二段正文\n\n#出差';
      await page.getByRole('button', { name: '导出内容', exact: true }).click();
      await page.waitForFunction(() => !!window.__releaseExport);
      await page.evaluate(publishable => window.__releaseExport({ version: 1, publishable, platform: '朋友圈', model: 'Pro S',
        images: [{ filename: 'product.jpg', sha256: 'a'.repeat(64) }], evidence: [{ text: '对应资料' }], imaCalls: [{ target: 'internal-log' }], report: { status: 'pass' } }), publishable);
      await page.getByRole('button', { name: '下载正文', exact: true }).waitFor();
      const readDownload = async (button, suffix) => {
        const pending = page.waitForEvent('download');
        await page.getByRole('button', { name: button, exact: true }).click();
        const download = await pending;
        assert.ok(download.suggestedFilename().endsWith(suffix));
        const chunks = [];
        for await (const chunk of await download.createReadStream()) chunks.push(chunk);
        return Buffer.concat(chunks).toString('utf8');
      };
      assert.equal(await readDownload('下载正文', '.txt'), publishable);
      const sources = JSON.parse(await readDownload('下载来源清单', '.json'));
      assert.equal(sources.version, 1);
      assert.equal(sources.images[0].sha256, 'a'.repeat(64));
      assert.equal(sources.imaCalls, undefined);
      assert.equal(sources.report, undefined);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }, mobile);
    await scenario('clicking export after typing in the manuscript saves the edit before any export', async page => {
      let release, patch;
      await page.route('**/api/agent', route => new Promise(resolve => {
        patch = route.request().postDataJSON().patch;
        release = async () => { await route.fulfill({ contentType: 'text/event-stream', body: [
          { type: 'draft', draft: { ...draft, version: 2, body: '直接修改后的正文' } },
          { type: 'done', view: { ...view, draft: { ...draft, version: 2, body: '直接修改后的正文' }, report: { ...report, draftVersion: 2 } } },
        ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') }); resolve(); };
      }));
      await page.locator('.ms-body').fill('直接修改后的正文');
      // A real pointer click fires blur before the toolbar's click handler.
      await page.getByRole('button', { name: '导出内容', exact: true }).click({ force: true });
      await page.waitForFunction(() => document.querySelector('textarea')?.disabled);
      assert.deepEqual(patch, { body: '直接修改后的正文' });
      assert.equal(await page.evaluate(() => window.__exportCount || 0), 0);
      assert.equal(await page.getByRole('button', { name: '导出内容', exact: true }).isDisabled(), true);
      assert.ok(release);
      await release();
      await page.getByRole('button', { name: '导出内容', exact: true }).waitFor({ state: 'visible' });
      await page.locator('textarea:not([disabled])').waitFor();
      await page.getByRole('button', { name: '导出内容', exact: true }).click();
      await page.waitForFunction(() => !!window.__releaseExport);
      await page.evaluate(() => window.__releaseExport({ version: 2, publishable: '直接修改后的正式导出' }));
      await page.getByText('直接修改后的正式导出', { exact: true }).waitFor();
    }, mobile);
    await scenario('a newer saved draft is restored before retrying its export', async (page, next) => {
      await page.getByRole('button', { name: '导出内容', exact: true }).click();
      await page.waitForFunction(() => !!window.__releaseExport);
      await page.route('**/api/agent?**', route => route.fulfill({ json: { view: next, messages: [], busy: false, interrupted: false, updatedAt: '' } }));
      await page.evaluate(() => window.__releaseExport({ version: 2, publishable: '另一个页面保存的第二版' }));
      await page.getByText('第二版的正式正文', { exact: true }).waitFor();
      await page.locator('textarea:not([disabled])').waitFor();
      assert.equal(await page.getByRole('button', { name: '复制文本', exact: true }).count(), 0);
      await page.getByRole('button', { name: '重新导出', exact: true }).click();
      await page.waitForFunction(() => window.__exportCount === 2);
      await page.evaluate(() => window.__releaseExport({ version: 2, publishable: '对应第二版的正式导出' }));
      await page.getByText('对应第二版的正式导出', { exact: true }).waitFor();
    }, mobile);
  }
} finally { await browser.close(); }
