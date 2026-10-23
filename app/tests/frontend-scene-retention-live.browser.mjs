// Manual live edit flow, using an isolated fixture session and an existing real image.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FRONTEND_PLAYWRIGHT_PATH || 'playwright');
const sid = process.env.FRONTEND_SCENE_SESSION_ID;
if (!sid) throw new Error('Set FRONTEND_SCENE_SESSION_ID to your isolated fixture session.');
const base = process.env.FRONTEND_BASE_URL || 'http://localhost:3100';
const browser = await chromium.launch({ headless: true, executablePath: process.env.FRONTEND_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(120000);
  const before = await (await page.request.get(`${base}/api/agent?sessionId=${sid}`)).json();
  assert.equal(before.view.supplementaryImages.length, 1);
  const image = before.view.supplementaryImages[0];
  await page.addInitScript(sid => localStorage.setItem('zhixuan.studio.sid.v1', sid), sid);
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (url, options) => {
      if (url === '/api/agent' && options?.method === 'POST') window.__sceneWire = null;
      const response = await original(url, options);
      if (url === '/api/agent' && options?.method === 'POST') void response.clone().text().then(body => { window.__sceneWire = body; });
      return response;
    };
  });
  const readWire = async () => {
    await page.waitForFunction(() => typeof window.__sceneWire === 'string');
    return page.evaluate(() => window.__sceneWire);
  };
  await page.goto(base);
  await page.locator('.scene-figs img').waitFor();
  await page.locator('textarea:not([disabled])').fill('只把这篇的语气改得更口语、句子短一点，仍然是出差收拾电脑包的场景。保留原有产品图和场景插画，不增加图片，不重新生图。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const wire = await readWire();
  assert.doesNotMatch(wire, /"type":"error"|"label":"补充场景配图"/);
  const after = await (await page.request.get(`${base}/api/agent?sessionId=${sid}`)).json();
  assert.equal(after.view.draft.version, before.view.draft.version + 1);
  assert.equal(after.view.supplementaryImages?.length ?? 0, 1, 'wording-only edits must not silently remove the selected scene');
  assert.equal(after.view.supplementaryImages[0].sha256, image.sha256);
  assert.equal(after.view.supplementaryImages[0].id, image.id);
  assert.deepEqual(after.view.draft.images.map(item => item.imageId), before.view.draft.images.map(item => item.imageId));
  const exported = await (await page.request.get(`${base}/api/export?sessionId=${sid}`)).json();
  assert.equal(exported.supplementaryImages[0].sha256, image.sha256);
  assert.equal(exported.supplementaryImages[0].draftVersion, after.view.draft.version);
  await page.reload();
  await page.locator('.scene-figs img').waitFor();
  const editedBody = `${after.view.draft.body}\n先把当天会用到的东西放进包里。`;
  await page.locator('.ms-body[contenteditable="true"]').fill(editedBody);
  await page.locator('.ms-body').press('Tab');
  assert.doesNotMatch(await readWire(), /"type":"error"|"label":"补充场景配图"/);
  const edited = await (await page.request.get(`${base}/api/agent?sessionId=${sid}`)).json();
  assert.equal(edited.view.draft.body, editedBody);
  assert.equal(edited.view.supplementaryImages[0].sha256, image.sha256);
  assert.equal(edited.view.draft.version, after.view.draft.version + 1);
  await page.locator('textarea:not([disabled])').fill('把场景改成长期固定在家里书桌办公，不再出差，也不使用行李和收拾包的场景。不要重新生图。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  assert.doesNotMatch(await readWire(), /"type":"error"|"label":"补充场景配图"/);
  const changed = await (await page.request.get(`${base}/api/agent?sessionId=${sid}`)).json();
  assert.equal(changed.view.draft.version, edited.view.draft.version + 1);
  assert.equal(changed.view.supplementaryImages?.length ?? 0, 0, 'a travel scene must not follow a change to fixed home-office work');
  assert.equal((await page.request.get(`${base}${image.src}`)).status(), 404);
  console.log(JSON.stringify({ session: sid, version: changed.view.draft.version, wordingEditKeepsScene: true,
    directEditKeepsScene: true, changedScenarioDropsOldScene: true, exportAndReloadMatch: true, passed: true }));
} finally { await browser.close(); }
