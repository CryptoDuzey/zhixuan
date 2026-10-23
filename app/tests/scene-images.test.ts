import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateScene, readSceneImage } from '../lib/scene-images.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=', 'base64');
function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'zx-scenes-'));
  t.mock.method(process, 'cwd', () => dir);
  mkdirSync(join(dir, 'data/private'), { recursive: true });
  writeFileSync(join(dir, 'data/private/image-settings.json'), JSON.stringify({ apiKey: 'offline-image-only', model: 'qwen-image-2.0-pro-2026-06-22' }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('scene generation uses its own credential, stores immutable bytes and verifies their hash', async t => {
  const dir = setup(t);
  let generated = 0;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    if (String(input).includes('/multimodal-generation/')) {
      generated++;
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer offline-image-only');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.parameters.n, 1);
      assert.equal(body.parameters.watermark, true);
      assert.match(body.input.messages[0].content[0].text, /不含.*电脑/);
      return Response.json({ output: { choices: [{ message: { content: [{ image: 'https://dashscope-test.oss-accelerate.aliyuncs.com/scene.png' }] } }] } });
    }
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  });
  const scene = await generateScene('出差时整理行李的环境插画');
  assert.equal(generated, 1);
  assert.equal(scene.width, 1);
  assert.equal(scene.height, 1);
  assert.equal(scene.provider, 'qwen');
  assert.deepEqual(readSceneImage(scene), png);
  assert.doesNotMatch(JSON.stringify(scene), /offline-image-only|https?:|apiKey/);
  const file = join(dir, 'data/private/scene-images', `${scene.id}.png`);
  assert.deepEqual(readFileSync(file), png);
  writeFileSync(file, Buffer.concat([png, Buffer.from('changed')]));
  assert.throws(() => readSceneImage(scene), /图片.*变化/);
});
test('provider failures are not retried and never expose upstream credential echoes', async t => {
  setup(t);
  const transport = t.mock.method(globalThis, 'fetch', async () => Response.json({ message: 'offline-image-only echoed' }, { status: 429 }));
  await assert.rejects(generateScene('环境插画'), error => {
    assert.doesNotMatch(String(error), /offline-image-only|echoed/);
    return true;
  });
  assert.equal(transport.mock.callCount(), 1);
});
test('untrusted result hosts and non-image bytes cannot enter the saved asset store', async t => {
  setup(t);
  const transport = t.mock.method(globalThis, 'fetch', async () => Response.json({ output: { choices: [{ message: { content: [{ image: 'http://127.0.0.1/private' }] } }] } }));
  await assert.rejects(generateScene('环境插画'));
  assert.equal(transport.mock.callCount(), 1);
  transport.mock.restore();
  for (const type of ['text/html', 'image/png']) {
    const malformed = t.mock.method(globalThis, 'fetch', async input => String(input).includes('/multimodal-generation/')
      ? Response.json({ output: { choices: [{ message: { content: [{ image: 'https://dashscope-test.oss-accelerate.aliyuncs.com/scene.png' }] } }] } })
      : new Response('not a PNG file', { headers: { 'content-type': type } }));
    await assert.rejects(generateScene('环境插画'));
    assert.equal(malformed.mock.callCount(), 2);
    malformed.mock.restore();
  }
});
test('late generation responses after cancellation are rejected before downloading or saving', async t => {
  setup(t);
  const stop = new AbortController();
  let release!: () => void;
  const transport = t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => {
    release = () => resolve(Response.json({ output: { choices: [{ message: { content: [{ image: 'https://dashscope-test.oss-accelerate.aliyuncs.com/scene.png' }] } }] } }));
  }));
  const result = generateScene('环境插画', stop.signal);
  stop.abort(new Error('controlled cancellation'));
  release();
  await assert.rejects(result, /controlled cancellation/);
  assert.equal(transport.mock.callCount(), 1);
});
