// Explicit live smoke: real local pages, model, knowledge service and SSE; no mocks.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FRONTEND_PLAYWRIGHT_PATH || 'playwright');
const base = process.env.FRONTEND_BASE_URL || 'http://localhost:3100';
const output = path.join(tmpdir(), 'zhixuan-product-live');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.FRONTEND_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const cases = [
  { url: '/', message: '先不选产品，聊聊给父母挑电脑时，怎么问清他们每天实际需要做什么？用两三段自然的话说。', kind: 'chat' },
  { url: '/consult', message: '家里每个月只打印几页孩子的作业，附近就有打印店，家里地方也小，先不报价，你觉得有必要买打印机吗？', kind: 'consult' },
  { url: '/', message: '为 HUAWEI MateBook Pro S 写朋友圈，读者是刚上班、常带电脑出差的人。只用现有图库，不写价格优惠和亲测经历，写得自然一点。', kind: 'draft' },
];
try {
  for (const item of cases.filter(item => !process.env.FRONTEND_LIVE_FILTER || item.kind === process.env.FRONTEND_LIVE_FILTER)) {
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(120000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__wire = [];
      const original = window.fetch.bind(window);
      window.fetch = async (url, options) => {
        if ((url === '/api/agent' || url === '/api/consult') && options?.method === 'POST') window.__wire = [];
        const response = await original(url, options);
        if ((url === '/api/agent' || url === '/api/consult') && options?.method === 'POST') {
          window.__contentType = response.headers.get('content-type');
          void (async () => {
            const reader = response.clone().body.getReader();
            const decoder = new TextDecoder();
            let pending = '';
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              pending += decoder.decode(value, { stream: true });
              let boundary;
              while ((boundary = pending.indexOf('\n\n')) >= 0) {
                const frame = pending.slice(0, boundary);
                pending = pending.slice(boundary + 2);
                const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
                if (data) window.__wire.push({ ...JSON.parse(data), receivedAt: performance.now() });
              }
            }
          })();
        }
        return response;
      };
    });
    try {
      await page.goto(`${base}${item.url}`);
      await page.locator('textarea:not([disabled])').first().fill(item.message);
      await page.getByRole('button', { name: item.url === '/' ? '发送' : '发送咨询', exact: true }).click();
      await page.waitForFunction(() => window.__wire.some(event => event.type === 'done'));
      await page.locator('textarea:not([disabled])').first().waitFor();
      const events = await page.evaluate(() => window.__wire);
      assert.match(await page.evaluate(() => window.__contentType), /text\/event-stream/);
      assert.equal(events.at(-1).run.status, 'completed');
      assert.equal(events.some(event => event.type === 'error'), false);
      const snapshots = events.filter(event => event.type === 'model_preview' && event.status === 'generating');
      assert.ok(new Set(snapshots.map(event => event.text)).size > 1, 'must receive multiple actual growing SSE snapshots');
      assert.ok(snapshots[0].receivedAt < events.at(-1).receivedAt);
      assert.equal(await page.locator('.tool-status,.activity,.consult-tools,.consult-retrieval').count(), 0);
      const visible = await page.locator('body').innerText();
      assert.doesNotMatch(visible, /已核查|经核实|核验通过|已核验|已接收.*字|使用缓存/);
      const sid = await page.evaluate(studio => localStorage.getItem(studio ? 'zhixuan.studio.sid.v1' : 'zhixuan.consult.sid.v1'), item.url === '/');
      if (item.kind === 'draft') {
        assert.ok((await page.locator('.ms-body').innerText()).trim());
        assert.ok(await page.locator('.paper img').count() > 0);
        assert.match(await page.locator('.product-select option:checked').innerText(), /MateBook Pro S/);
        const exportButton = page.getByRole('button', { name: '导出内容', exact: true });
        assert.equal(await exportButton.isEnabled(), true);
        await exportButton.click();
        await page.getByRole('button', { name: '复制文本', exact: true }).waitFor();
        await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
        const originalBody = await page.locator('.ms-body').innerText();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('textarea:not([disabled])').first().fill('这篇还是像参数说明。改得像平时发朋友圈说话，围绕出差时收拾电脑包这件事，只保留一个必要参数。不写亲测，也别加优惠。');
        await page.getByRole('button', { name: '发送', exact: true }).click();
        await page.waitForFunction(() => window.__wire.some(event => event.type === 'done'));
        await page.locator('textarea:not([disabled])').first().waitFor();
        const revision = await page.evaluate(() => window.__wire.findLast(event => event.type === 'done'));
        assert.equal(revision.run.status, 'completed');
        assert.equal(revision.view.draft.version, 2);
        assert.notEqual(await page.locator('.ms-body').innerText(), originalBody);
        const weightValues = new Set([...revision.view.draft.body.matchAll(/\d+(?:\.\d+)?\s*(?:g|克)/g)].map(match => match[0].replace(/\s/g, '')));
        assert.ok(weightValues.size <= 1, 'the user requested one value, not a list of every screen version');
        assert.doesNotMatch(await page.locator('body').innerText(), /没有资料依据|已核验|核验通过|本次任务已结束/);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: path.join(output, 'revision-phone.png'), fullPage: true });
        const revisedBody = await page.locator('.ms-body').innerText();
        await page.locator('textarea:not([disabled])').first().fill('先不改稿了，只聊聊：你觉得这篇对刚上班的人有什么帮助？简短说说，不要修改正文。');
        await page.getByRole('button', { name: '发送', exact: true }).click();
        await page.waitForFunction(() => window.__wire.some(event => event.type === 'done'));
        await page.locator('textarea:not([disabled])').first().waitFor();
        assert.equal(await page.locator('.ms-body').innerText(), revisedBody);
        const saved = await (await page.request.get(`${base}/api/agent?sessionId=${encodeURIComponent(sid)}`)).json();
        assert.notEqual(saved.messages.at(-1).kind, 'agent', 'ordinary chat must not append a draft delivery message');
        assert.equal(saved.view.draft.version, 2);
      } else {
        assert.ok(await page.locator(item.url === '/' ? '.msg-agent .txt' : '.consult-reply').count() > 0);
      }
      await page.screenshot({ path: path.join(output, `${item.kind}.png`), fullPage: true });
      await page.reload();
      await page.locator('textarea:not([disabled])').first().waitFor();
      assert.doesNotMatch(await page.locator('body').innerText(), /已核查|已核验|核验通过/);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ case: item.kind, session: sid, sseSnapshots: snapshots.length, status: 'passed' }));
    } finally { await context.close(); }
  }
  console.log(`Screenshots: ${output}`);
} finally { await browser.close(); }
