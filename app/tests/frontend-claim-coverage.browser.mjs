// Real React UI with deterministic saved-session transport; no running service/model.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { offlinePage } from './frontend-offline.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FRONTEND_PLAYWRIGHT_PATH || 'playwright');
const html = offlinePage('../app/components/Studio.tsx', ['../app/globals.css', '../app/canvas.css']);
const browser = await chromium.launch({ headless: true, executablePath: process.env.FRONTEND_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  for (const width of [1360, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript(() => localStorage.setItem('zhixuan.studio.sid.v1', 'coverage-browser-session'));
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let complete = false;
    await page.route('**/api/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/settings') return route.fulfill({ json: { configured: true } });
      if (pathname !== '/api/agent') return route.fulfill({ status: 500, json: { error: 'unexpected test request' } });
      return route.fulfill({ json: { view: {
        draft: { version: 1, platform: '朋友圈', modelId: 'pro-s', modelName: 'HUAWEI MateBook Pro S', title: '保存的稿件', lead: '', body: '保留这段正文', cta: '', tags: [], images: [], claims: [{ id: 'C1', text: '标准屏版798 g', factIds: ['E1'] }] },
        report: { draftVersion: 1, status: 'pass', issues: [], verifiedClaimIds: ['C1'], verifiedImageIds: [], checkedAt: '', ...(complete ? { reviewedClaimIds: ['C1'] } : {}) }, evidence: [], images: [],
      }, messages: [], busy: false, interrupted: false, updatedAt: '' } });
    });
    await page.route('http://coverage.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://coverage.test/');
    await page.locator('.ms-body').waitFor();
    assert.match(await page.locator('.badge').innerText(), /草稿/);
    assert.equal(await page.getByRole('button', { name: '导出内容', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('.ms-body').innerText(), '保留这段正文');
    complete = true;
    await page.reload();
    await page.locator('.badge.pass').waitFor();
    assert.equal(await page.getByRole('button', { name: '导出内容', exact: true }).isDisabled(), false);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${width}px: legacy pass is a draft; complete coverage enables export`);
  }
} finally { await browser.close(); }
