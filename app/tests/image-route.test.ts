import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GET } from '../app/api/image/route.ts';

test('图片更新和移除后接口刷新目录，不用浏览器一小时缓存保留旧图', async t => {
  let version = 'first';
  let removed = false;
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(String(input));
    if (url.pathname === '/documents') return Response.json({ items: removed ? [] : [{
      id: 'image-route-refresh', path: '图片/测试.png', title: '测试.png', bytes: 3, sha256: createHash('sha256').update(version).digest('hex'),
    }] });
    assert.equal(url.pathname, '/document');
    reads++;
    return new Response(version);
  });
  const request = () => new Request('http://localhost/api/image?id=image-route-refresh');
  assert.equal(await (await GET(request())).text(), 'first');
  version = 'second';
  const updated = await GET(request());
  assert.equal(await updated.text(), 'second');
  assert.equal(updated.headers.get('cache-control'), 'private, no-store');
  assert.equal(updated.headers.get('content-type'), 'image/png');
  assert.equal(reads, 2);
  const oldVersion = createHash('sha256').update('first').digest('hex');
  const pinned = await GET(new Request(`${request().url}&version=${oldVersion}`));
  assert.equal(pinned.status, 409, '旧稿绑定的图片版本已变时不能静默替换为新图');
  assert.equal(reads, 2, '版本不匹配时不读取新图片');
  removed = true;
  assert.equal((await GET(request())).status, 404);
});

test('图片目录失败时返回安全错误，不使用旧图或泄露上游内容', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ secret: 'private-upstream-message' }, { status: 503 }));
  const response = await GET(new Request('http://localhost/api/image?id=image-route-refresh'));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.doesNotMatch(await response.text(), /private-upstream/);
});

test('图片返回内容与目录指纹不符时拒绝，恢复后可重新读取', async t => {
  let content = 'unexpected-image';
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(String(input));
    if (url.pathname === '/documents') return Response.json({ items: [{ id: 'image-route-integrity',
      path: '图片/已核对.png', title: '已核对.png', bytes: 10,
      sha256: createHash('sha256').update('expected-image').digest('hex'),
    }] });
    return new Response(content);
  });
  const request = () => new Request('http://localhost/api/image?id=image-route-integrity');
  const rejected = await GET(request());
  assert.equal(rejected.status, 502);
  assert.equal(rejected.headers.get('cache-control'), 'private, no-store');
  assert.doesNotMatch(await rejected.text(), /unexpected-image/);
  content = 'expected-image';
  const recovered = await GET(request());
  assert.equal(recovered.status, 200);
  assert.equal(await recovered.text(), content);
});
