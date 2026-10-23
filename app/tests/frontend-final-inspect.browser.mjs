// Inspect an existing live session; does not send messages or make model calls.
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FRONTEND_PLAYWRIGHT_PATH || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => localStorage.setItem('zhixuan.studio.sid.v1', 's-596e9a33-e215-4b42-bd1b-01d1f4a4aadf'));
  const page = await context.newPage();
  await page.goto('http://localhost:3100/');
  await page.locator('.ms-body').waitFor();
  await page.locator('.ms-body').scrollIntoViewIfNeeded();
  console.log(JSON.stringify(await page.locator('.ms-body').evaluate(node => {
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    return { text: node.innerText, color: style.color, background: style.backgroundColor, opacity: style.opacity,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, display: style.display, visibility: style.visibility };
  })));
  const screenshot = path.join(tmpdir(), 'zhixuan-live-final-readable.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(screenshot);
  await context.close();
} finally { await browser.close(); }
