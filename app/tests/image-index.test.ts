import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadImages, MODELS } from '../lib/facts.ts';

test('图片清单按本型号精确路径绑定，更新索引后不继续使用旧文件', async t => {
  const model = MODELS.find(item => item.id === 'pro-s')!;
  let filename = 'a.jpg';
  let fingerprint = '';
  let indexes = 0;
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(String(input));
    if (url.pathname === '/documents') {
      indexes++;
      return Response.json({ items: [
        { id: 'image-csv', path: `${model.dir}图片索引.csv`, sha256: createHash('sha256').update(`文件名,型号,用途,链接,说明,宽,高\n${filename},${model.name},配图,,索引说明,800,600`).digest('hex'), bytes: 1 },
        { id: 'wrong-thumbnail', path: `${model.dir}images/thumb-${filename}`, sha256: 'thumb', bytes: 1 },
        { id: `correct-${filename}`, path: `${model.dir}images/${filename}`, sha256: fingerprint || filename, bytes: 1 },
      ] });
    }
    assert.equal(url.pathname, '/document');
    assert.equal(url.searchParams.get('id'), 'image-csv', '这里只读取索引，不取图片字节');
    reads++;
    return new Response(`文件名,型号,用途,链接,说明,宽,高\n${filename},${model.name},配图,,索引说明,800,600`);
  });
  const first = await loadImages(model.id);
  assert.equal(first[0].docId, 'correct-a.jpg');
  filename = 'b.jpg';
  const second = await loadImages(model.id);
  assert.equal(second[0].filename, 'b.jpg');
  assert.equal(second[0].docId, 'correct-b.jpg');
  assert.equal(second[0].visuallyReviewed, false);
  assert.equal(indexes, 2, '每次读取配图清单只取得一份新目录');
  assert.equal(reads, 2, '索引正文也须刷新');
  filename = 'hwpc_matebook-pro-s_多彩配色外观_05_0f907e31.jpg';
  fingerprint = 'changed-image-content';
  const changed = await loadImages(model.id);
  assert.equal(changed[0].visuallyReviewed, false, '同名文件内容改变后不能继承人工看图结论');
  assert.equal(changed[0].caption, '索引说明');
  fingerprint = '88477e9fb10790da1068abd21fafb341cb79cbd415bb0cc4129bdca3e3ed9c16';
  const reviewed = await loadImages(model.id);
  assert.equal(reviewed[0].visuallyReviewed, true);
  assert.equal(reviewed[0].sha256, fingerprint);
  assert.match(reviewed[0].caption, /紫色机身/);
});
