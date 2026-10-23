import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MODELS, loadImages, loadEvidence } from '../lib/facts.ts';
import { createCatalog } from '../lib/catalog.ts';

const newProducts = [
  { id: 'fold-ultimate', name: 'HUAWEI MateBook Fold 非凡大师', dir: 'P1-产品参数库/01-鸿蒙电脑/HUAWEI MateBook Fold 非凡大师/', ready: true },
  { id: 'pro-harmony', name: 'HUAWEI MateBook Pro', dir: 'P1-产品参数库/01-鸿蒙电脑/HUAWEI MateBook Pro/', ready: true },
  { id: 'd16-se', name: 'HUAWEI MateBook D 16 SE 版 2024', dir: 'P1-产品参数库/02-MateBook-Windows/MateBook D 16 SE 版/', ready: false },
  { id: 'gt14', name: 'HUAWEI MateBook GT 14', dir: 'P1-产品参数库/02-MateBook-Windows/MateBook GT 系列/', ready: true },
  { id: 'xpro-ultra-premium', name: 'HUAWEI MateBook X Pro 酷睿 Ultra 微绒典藏版', dir: 'P1-产品参数库/02-MateBook-Windows/MateBook X系列/', ready: false },
];

test('固定原五款ID顺序，新增五款按真实缺口登记ready，不把全绿作为目标', () => {
  assert.deepEqual(MODELS.slice(0, 5).map(m => m.id), ['pro-s', 'mb14-harmony', 'mb14-ultra', 'd14', 'd16']);
  for (const p of newProducts) {
    const m = MODELS.find(m => m.id === p.id);
    assert.ok(m, p.id);
    assert.equal(m.dir, p.dir);
    assert.equal(m.name, p.name);
    assert.equal(m.ready, p.ready);
    if (!p.ready) assert.match(m.note!, /待|暂|未/);
  }
});

for (const p of newProducts.filter(p => p.ready)) {
  test(`离线边界 ${p.id}：只取本型号清单，空图注/错误型号/无效尺寸不补画面，IMG序号保留`, async t => {
    const header = '文件名,产品型号,来源页面,原始图片URL,官网图片说明,宽度,高度';
    const csv = `${header}\nempty.jpg,${p.name},https://source.invalid,https://image.invalid, ,800,600\nvalid.jpg,${p.name},https://source.invalid,https://image.invalid,原清单图注（未看图）,800,600\nwrong.jpg,相近错误型号,https://source.invalid,https://image.invalid,错误型号,800,600\nzero.jpg,${p.name},https://source.invalid,https://image.invalid,无效尺寸,0,600`;
    const entries = [
      { id: 'shared', path: `P6-营销素材库/${p.dir}图片索引.csv`, content: `${header}\nmall.jpg,${p.name},,,共享商城不应借用,800,600` },
      { id: 'index', path: `${p.dir}图片索引.csv`, content: csv },
      ...['empty.jpg', 'valid.jpg', 'wrong.jpg', 'zero.jpg'].map(filename => ({ id: filename, path: `${p.dir}images/${filename}`, content: 'offline image placeholder' })),
    ];
    // Shared entry deliberately cannot match suffix root: no nested fake P1 root accepted.
    entries[0].path = `P6-营销素材库/商城/${p.name}/图片索引.csv`;
    const docs = entries.map(e => ({ ...e, sha256: createHash('sha256').update(e.content).digest('hex'), bytes: Buffer.byteLength(e.content), title: e.id }));
    const reads: string[] = [];
    t.mock.method(globalThis, 'fetch', async input => {
      const url = new URL(String(input));
      if (url.pathname === '/documents') return Response.json({ items: docs });
      const id = url.searchParams.get('id')!; reads.push(id);
      const d = docs.find(d => d.id === id); assert.ok(d);
      return new Response(d.content);
    });
    const images = await loadImages(p.id);
    assert.equal(images.length, 1);
    assert.equal(images[0].id, 'IMG2');
    assert.equal(images[0].docId, 'valid.jpg');
    assert.equal(images[0].modelId, p.id);
    assert.equal(images[0].caption, '原清单图注（未看图）');
    assert.equal(images[0].visuallyReviewed, false);
    assert.doesNotMatch(images[0].purpose, /valid|jpg|看过|已核对原图/);
    assert.deepEqual(reads, ['index']);
  });
}

test('离线边界：同名图缺少本产品原文件，不从共享目录借图', async t => {
  const p = newProducts[0];
  const text = `文件名,产品型号,来源页面,URL,图注,宽,高\nshared.jpg,${p.name},,,原图说明,800,600`;
  const docs = [
    { id: 'index', path: `${p.dir}图片索引.csv`, sha256: createHash('sha256').update(text).digest('hex') },
    { id: 'wrong-image', path: 'P6-营销素材库/images/shared.jpg', sha256: 'a'.repeat(64) },
  ];
  t.mock.method(globalThis, 'fetch', async input => new URL(String(input)).pathname === '/documents' ? Response.json({ items: docs }) : new Response(text));
  assert.deepEqual(await loadImages(p.id), []);
});

test('离线边界：重复精确清单路径不能任取第一份', async t => {
  const p = newProducts[0];
  const docs = ['a', 'b'].map(id => ({ id, path: `${p.dir}图片索引.csv`, sha256: 'a'.repeat(64) }));
  let sourceReads = 0;
  t.mock.method(globalThis, 'fetch', async input => {
    assert.equal(new URL(String(input)).pathname, '/documents'); sourceReads++;
    return Response.json({ items: docs });
  });
  await assert.rejects(loadImages(p.id), /图片索引|不唯一/);
  assert.equal(sourceReads, 1);
});

test('离线边界：不ready型号不读取证据或图片，不默认套普通D16/X Pro', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Disabled models must not read'); });
  for (const p of newProducts.filter(p => !p.ready)) {
    assert.deepEqual(await loadImages(p.id), []);
    await assert.rejects(loadEvidence(p.id), /尚未接入/);
  }
});

test('离线目录：完整目录+ready精确路径映射，近名/企业版/不ready不得借用', async () => {
  const p = newProducts[0];
  const text = `# ${p.name} - 产品事实\n## 操作系统\nHarmonyOS 6.1\n## 规格\n只属于非凡大师`;
  const docs = [
    { id: 'fact', path: `${p.dir}产品事实.md`, title: '产品事实', text },
    { id: 'limit', path: `${p.dir}卖点与限制.md`, title: '限制', text: '# 限制\n保留具体配置条件' },
    { id: 'enterprise', path: 'P1-产品参数库/07-扩展产品目录/商用电脑/11-Fold 企业版.md', title: '企业版', text: '# HUAWEI MateBook Fold 企业版\n- 产品类别：商用鸿蒙电脑' },
  ];
  const source = {
    loadLocalIndex: async () => docs.map(d => ({ ...d, bytes: d.text.length, sha256: createHash('sha256').update(d.text).digest('hex') })),
    readLocalText: async (doc: { id: string }) => ({ ok: true, text: docs.find(d => d.id === doc.id)!.text, source: '本地已下载知识库' as const, readAt: '2026-10-22T00:00:00Z' }),
  };
  const entries = await createCatalog(source).loadCatalog();
  assert.equal(entries.find(e => e.id === 'catalog:fact')?.creativeModelId, p.id);
  assert.equal(entries.find(e => e.id === 'catalog:enterprise')?.creativeModelId, undefined);
  const model = MODELS.find(m => m.id === p.id)!;
  const duplicate = await createCatalog({ ...source, models: [model, { ...model, id: 'duplicate-same-directory' }] }).loadCatalog();
  assert.equal(duplicate.find(e => e.id === 'catalog:fact')?.creativeModelId, undefined, 'Ambiguous registry paths fail closed');
  const disabled = await createCatalog({ ...source, models: [{ ...model, ready: false }] }).loadCatalog();
  assert.equal(disabled.find(e => e.id === 'catalog:fact')?.creativeModelId, undefined);
});
