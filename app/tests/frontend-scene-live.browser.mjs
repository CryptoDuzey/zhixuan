// Manual live smoke; use an isolated smoke-test session with room for one extra image.
// FRONTEND_SCENE_SESSION_ID must identify your own test session, never a user's active chat.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FRONTEND_PLAYWRIGHT_PATH || 'playwright');
const sid = process.env.FRONTEND_SCENE_SESSION_ID;
if (!sid) throw new Error('Set FRONTEND_SCENE_SESSION_ID to an isolated smoke-test session.');
const base = process.env.FRONTEND_BASE_URL || 'http://localhost:3100';
const browser = await chromium.launch({ headless: true, executablePath: process.env.FRONTEND_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
async function removeScenes(page) {
  const previous = await (await page.request.get(`${base}/api/agent?sessionId=${encodeURIComponent(sid)}`)).json();
  assert.ok(previous.view.supplementaryImages?.length);
  await page.locator('.scene-figs').scrollIntoViewIfNeeded();
  for (const button of await page.locator('.canvas > .strip button').all()) {
    const rect = await button.boundingBox();
    assert.ok(rect.x >= 0 && rect.x + rect.width <= 390, 'toolbar actions must not be clipped on a phone');
  }
  await page.screenshot({ path: path.join(tmpdir(), 'zhixuan-scene-live-phone.png'), fullPage: true });
  const pending = page.waitForResponse(response => response.url() === `${base}/api/agent` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '移除场景配图', exact: true }).click();
  const wire = await (await pending).text();
  assert.doesNotMatch(wire, /"type":"error"/);
  await page.locator('textarea:not([disabled])').waitFor();
  const after = await (await page.request.get(`${base}/api/agent?sessionId=${encodeURIComponent(sid)}`)).json();
  assert.equal(after.view.draft.version, previous.view.draft.version + 1);
  assert.equal(after.view.draft.body, previous.view.draft.body);
  assert.deepEqual(after.view.draft.images, previous.view.draft.images);
  assert.equal(after.view.supplementaryImages, undefined);
  assert.equal(await page.locator('.scene-figs').count(), 0);
  assert.equal((await page.request.get(`${base}${previous.view.supplementaryImages[0].src}`)).status(), 404);
  return after.view.draft.version;
}
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(180000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(id => localStorage.setItem('zhixuan.studio.sid.v1', id), sid);
  const before = await (await page.request.get(`${base}/api/agent?sessionId=${encodeURIComponent(sid)}`)).json();
  assert.ok(before.view.draft && !before.busy);
  assert.ok(before.view.draft.images.length < 3);
  await page.goto(base);
  if (process.env.FRONTEND_SCENE_ONLY_REMOVE === '1') {
    await page.locator('textarea:not([disabled])').waitFor();
    console.log(JSON.stringify({ session: sid, removedAtVersion: await removeScenes(page), originalPhotosAndTextPreserved: true, passed: true }));
  } else {
  await page.locator('textarea:not([disabled])').fill('给当前这篇加一张出差前收拾行李的背景插画：只有打开的旅行包、衣服、纸质笔记本和笔，没有人、电脑、手机、品牌或文字。先找图库，图库里没有这种画面时再生成。不要改正文。');
  const pending = page.waitForResponse(response => response.url() === `${base}/api/agent` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const response = await pending;
  assert.equal(response.status(), 200);
  assert.match(response.headers()['content-type'], /text\/event-stream/);
  const wire = await response.text();
  const events = wire.split('\n\n').flatMap(frame => {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    return data ? [JSON.parse(data)] : [];
  });
  assert.equal(events.some(event => event.type === 'error'), false, JSON.stringify(events.filter(event => event.type === 'error')));
  assert.equal(events.at(-1).run.status, 'completed');
  const after = await (await page.request.get(`${base}/api/agent?sessionId=${encodeURIComponent(sid)}`)).json();
  assert.equal(after.view.draft.version, before.view.draft.version + 1);
  assert.equal(after.view.draft.body, before.view.draft.body);
  assert.deepEqual(after.view.draft.images, before.view.draft.images);
  assert.equal(after.view.report.draftVersion, after.view.draft.version);
  assert.equal(after.view.supplementaryImages.length, 1);
  const image = after.view.supplementaryImages[0];
  await page.locator('.scene-figs img').waitFor();
  await page.locator('.scene-figs').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => [...document.querySelectorAll('.scene-figs img')].every(image => image.complete && image.naturalWidth > 0));
  const downloadPending = page.waitForEvent('download');
  await page.getByRole('link', { name: '保存场景图', exact: true }).click();
  const download = await downloadPending;
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  assert.equal(createHash('sha256').update(Buffer.concat(chunks)).digest('hex'), image.sha256);
  assert.match(await page.locator('.scene-figs').innerText(), /AI 生成/);
  assert.equal(await page.locator('.tool-status,.activity').count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(tmpdir(), 'zhixuan-scene-live-phone.png'), fullPage: true });
  const exported = await (await page.request.get(`${base}/api/export?sessionId=${encodeURIComponent(sid)}`)).json();
  assert.equal(exported.supplementaryImages[0].sha256, image.sha256);
  assert.equal(exported.images.length, before.view.draft.images.length);
  await page.reload();
  await page.locator('.scene-figs img').waitFor();
  assert.equal(await page.locator('.scene-figs img').getAttribute('src'), image.src);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ session: sid, draftVersion: after.view.draft.version, assetId: image.id, sha256: image.sha256,
    officialImages: exported.images.length, generatedScenes: exported.supplementaryImages.length,
    downloadMatches: true, reloadMatches: true, passed: true }));
  }
} finally { await browser.close(); }
