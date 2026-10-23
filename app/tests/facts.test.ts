import { after, before, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadEvidence, loadImages } from '../lib/facts.ts';

// Independent fixture paths: do not derive expected directories from MODELS.
const products = [
  {
    id: 'pro-s', name: 'HUAWEI MateBook Pro S',
    directory: 'P1-产品参数库/01-鸿蒙电脑/HUAWEI MateBook Pro S/',
    sceneDirectory: 'HUAWEI MateBook Pro S/',
    priceTitle: 'HUAWEI MateBook Pro S-价格卡.md',
  },
  {
    id: 'mb14-harmony', name: 'HUAWEI MateBook 14（鸿蒙电脑）',
    directory: 'P1-产品参数库/01-鸿蒙电脑/HUAWEI MateBook 14/',
    sceneDirectory: 'HUAWEI MateBook 14/',
    priceTitle: 'HUAWEI MateBook 14（鸿蒙版）-价格卡.md',
  },
  {
    id: 'mb14-ultra', name: 'MateBook 14 酷睿 Ultra（Windows）',
    directory: 'P1-产品参数库/02-MateBook-Windows/MateBook 14 酷睿 Ultra/',
    sceneDirectory: 'MateBook 14 酷睿 Ultra/',
    priceTitle: 'HUAWEI MateBook 14 酷睿 Ultra-价格卡.md',
  },
  {
    id: 'd14', name: 'HUAWEI MateBook D 14 2024',
    directory: 'P1-产品参数库/02-MateBook-Windows/MateBook D 14/',
    sceneDirectory: 'MateBook D 14/',
    priceTitle: 'HUAWEI MateBook D 14 2024-价格卡.md',
  },
  {
    id: 'd16', name: 'HUAWEI MateBook D 16 2024',
    directory: 'P1-产品参数库/02-MateBook-Windows/MateBook D 16/',
    sceneDirectory: 'MateBook D 16/',
    priceTitle: 'HUAWEI MateBook D 16 2024-价格卡.md',
  },
] as const;

const sharedFilename = 'sample_shared_01_abcdef.jpg';
const csvHeader = 'filename,modelName,category,url,caption,width,height';
const contents = new Map<string, string>();
const documents: { id: string; title: string; path: string; bytes: number; sha256: string }[] = [];
const requests: { pathname: string; id: string | null }[] = [];

function addDocument(id: string, path: string, text?: string) {
  documents.push({
    id, title: path.split('/').at(-1)!, path: `模拟知识库/${path}`.replaceAll('/', '\\'),
    bytes: text === undefined ? 1 : Buffer.byteLength(text), sha256: createHash('sha256').update(text ?? '').digest('hex'),
  });
  if (text !== undefined) contents.set(id, text);
}

// Put the mall's identically named index first: loose model-name matching would select it.
addDocument('mall-image-index', 'P1-产品参数库/03-官方商城/HUAWEI MateBook 14/图片索引.csv',
  `${csvHeader}\n${sharedFilename},商城错误型号,商城,https://images.invalid/mall.jpg,错误的商城图注,1,1`);
addDocument('mall-image', `P1-产品参数库/03-官方商城/HUAWEI MateBook 14/images/${sharedFilename}`);

for (const product of products) {
  const scene = `P2-卖点话术库/07-按型号角色/${product.sceneDirectory}`;
  for (const [role, path] of [
    ['fact', `${product.directory}产品事实.md`],
    ['limit', `${product.directory}卖点与限制.md`],
    ['price', `P2-卖点话术库/08-官方公开价格快照/${product.priceTitle}`],
    ['business', `${scene}商务差旅用户沟通卡.md`],
    ['student', `${scene}学生用户沟通卡.md`],
  ]) {
    addDocument(`${product.id}-${role}`, path, `# 模拟资料\n证据标记：${product.id}/${role}，只属于这个型号。`);
  }
  addDocument(`${product.id}-image-index`, `${product.directory}图片索引.csv`,
    `${csvHeader}\n${sharedFilename},${product.name},外观,https://images.invalid/${product.id}.jpg,${product.id} 专属图注,1200,800`);
  // All five models intentionally use the same filename under different directories.
  addDocument(`${product.id}-image`, `${product.directory}images/${sharedFilename}`);
}

before(() => {
  // This replacement never delegates to the original fetch, including unexpected requests.
  mock.method(globalThis, 'fetch', async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const id = url.searchParams.get('id');
    requests.push({ pathname: url.pathname, id });
    if (url.pathname === '/documents' && !url.search) return Response.json({ items: documents });
    assert.equal(url.pathname, '/document', '只能读取模拟目录和模拟文本');
    assert.ok(id && contents.has(id), '只能读取已登记的模拟文本，不能读取真实文件或图片');
    return new Response(contents.get(id)!, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  });
});
beforeEach(() => { requests.length = 0; });
after(() => { mock.restoreAll(); });

test('未知型号：证据读取拒绝，图片列表为空，且不发起任何请求', async () => {
  for (const id of ['unknown-model', '', '__proto__']) {
    await assert.rejects(loadEvidence(id), /型号资料尚未接入/);
    assert.deepEqual(await loadImages(id), []);
  }
  assert.deepEqual(requests, []);
});

test('鸿蒙 14：同名商城索引在前，也必须读取产品目录中的图片索引', async () => {
  const images = await loadImages('mb14-harmony');
  assert.equal(images.length, 1);
  assert.equal(images[0].docId, 'mb14-harmony-image');
  assert.equal(images[0].caption, 'mb14-harmony 专属图注');
  assert.deepEqual(requests.filter((request) => request.pathname === '/document').map((request) => request.id),
    ['mb14-harmony-image-index']);
  assert.ok(!requests.some((request) => request.id?.startsWith('mall-')));
});

for (const product of products) {
  test(`${product.id}：loadEvidence 只读取该型号的事实、限制、价格和两张场景卡`, async () => {
    const evidence = await loadEvidence(product.id);
    const roles = ['fact', 'limit', 'price', 'business', 'student'];
    assert.equal(evidence.length, roles.length);
    assert.deepEqual(evidence.map((entry) => entry.docId), roles.map((role) => `${product.id}-${role}`));
    assert.deepEqual(evidence.map((entry) => entry.kind), ['fact', 'limit', 'price', 'scene', 'scene']);
    for (const [index, role] of roles.entries()) {
      const entry = evidence[index];
      assert.equal(entry.text, `证据标记：${product.id}/${role}，只属于这个型号。`);
      const expectedPath = documents.find((document) => document.id === `${product.id}-${role}`)!.path.replaceAll('\\', '/');
      assert.equal(entry.docPath, expectedPath);
    }
    assert.deepEqual(requests.filter((request) => request.pathname === '/document').map((request) => request.id),
      roles.map((role) => `${product.id}-${role}`));
  });

  test(`${product.id}：loadImages 在同名图片中只绑定该型号的文件和图注`, async () => {
    const images = await loadImages(product.id);
    assert.equal(images.length, 1);
    assert.deepEqual({
      filename: images[0].filename, docId: images[0].docId,
      modelId: images[0].modelId, modelName: images[0].modelName,
      caption: images[0].caption, url: images[0].url,
      width: images[0].width, height: images[0].height,
    }, {
      filename: sharedFilename, docId: `${product.id}-image`,
      modelId: product.id, modelName: product.name,
      caption: `${product.id} 专属图注`, url: `https://images.invalid/${product.id}.jpg`,
      width: 1200, height: 800,
    });
    // Harmony 14 may reuse its index cached by the dedicated mall regression above.
    assert.ok(requests.every((request) => request.pathname === '/documents' || request.id === `${product.id}-image-index`));
  });
}
