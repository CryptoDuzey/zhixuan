import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog } from '../lib/catalog.ts';
import type { LocalDoc, ReadResult } from '../lib/ima.ts';
import type { ModelEntry } from '../lib/facts.ts';

function fixture(models: ModelEntry[] = [], beforeRead?: (doc: LocalDoc) => Promise<void>) {
  const index: LocalDoc[] = [];
  const texts = new Map<string, string>();
  const reads: string[] = [];
  const add = (id: string, path: string, text = '# 说明\n不应读取') => {
    index.push({ id, path, title: path.replaceAll('\\', '/').split('/').at(-1)!, bytes: 1, sha256: '' });
    texts.set(id, text);
  };
  const catalog = createCatalog({
    models, loadLocalIndex: async () => index,
    readLocalText: async (doc): Promise<ReadResult> => {
      reads.push(doc.id);
      await beforeRead?.(doc);
      return { ok: texts.has(doc.id), text: texts.get(doc.id), source: '本地已下载知识库', readAt: '2026-10-18T00:00:00Z' };
    },
  });
  return { ...catalog, add, reads, texts };
}

const root = 'P1-产品参数库/';
const cardPath = (name: string, number = 1) => `${root}07-扩展产品目录/消费级 PC/${number}-${name}.md`;
const fullPath = (name: string, harmony = true) => `${root}${harmony ? '01-鸿蒙电脑' : '02-MateBook-Windows'}/${name}/`;
function full(f: ReturnType<typeof fixture>, id: string, name: string, harmony = true) {
  const path = fullPath(name, harmony);
  f.add(`${id}-fact`, `${path}产品事实.md`, `# ${name} - 产品事实\n## 操作系统\n${harmony ? 'HarmonyOS 6' : 'Windows 11 家庭版\nLinux V20 版'}\n\n## 屏幕\n屏幕仅属于 ${name}\n`);
  f.add(`${id}-limit`, `${path}卖点与限制.md`, `# 限制\n必须确认 ${name} 的具体配置`);
}

test('动态纳入未注册的新产品，仅编号发现卡；排除索引及受限路径且不读正文', async () => {
  const f = fixture();
  f.add('new', cardPath('未来新品', 99), '# 未来新品\n- 产品类别：显示器\n## 建库状态\n只能发现');
  for (const [id, path] of [
    ['index', cardPath('扩展产品索引', 2)],
    ['zero', cardPath('目录说明', 0)],
    ['readme', `${root}07-扩展产品目录/消费级 PC/README.md`],
    ['csv', `${root}07-扩展产品目录/扩展产品索引.csv`],
    ['p4', `P4-机密/${cardPath('机密型号', 3)}`],
    ['review', `待审核/${cardPath('待审型号', 4)}`],
    ['archive', `归档/${cardPath('归档型号', 5)}`],
    ['traversal', `../${cardPath('非法型号', 6)}`],
    ['nested', `${root}07-扩展产品目录/消费级 PC/其他/08-非直接目录.md`],
  ]) f.add(id, path);
  const entries = await f.loadCatalog();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, '未来新品');
  assert.equal(entries[0].creativeModelId, undefined);
  assert.equal(entries[0].specsAvailable, false);
  assert.deepEqual(f.reads, ['new']);
});

test('完整事实优先合并：读取该款事实及限制，保留行号、来源、系统限定', async () => {
  const name = 'HUAWEI MateBook 新型号';
  const f = fixture([{ id: 'future', name, system: 'Windows', ready: true, dir: fullPath(name, false) }]);
  full(f, 'full', name, false);
  f.add('card', cardPath(name), `# ${name}\n- 产品类别：笔记本电脑`);
  const entries = await f.loadCatalog();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'catalog:card');
  assert.equal(entries[0].level, 'full');
  assert.equal(entries[0].creativeModelId, 'future');
  assert.match(entries[0].system!, /Windows.*Linux/);
  assert.equal(entries[0].evidencePaths.length, 2);
  const evidence = await f.loadCatalogEvidence(entries[0].id);
  assert.deepEqual(new Set(evidence.map((e) => e.docId)), new Set(['full-fact', 'full-limit']));
  assert.ok(evidence.some((e) => e.kind === 'limit'));
  assert.ok(evidence.every((e) => e.line > 0 && e.readAt && e.source === '本地已下载知识库'));
  assert.ok(evidence.some((e) => /屏幕/.test(e.section) && /仅属于/.test(e.text)));
});

test('同名的鸿蒙和Windows分别保留，不把Fold企业版当作非凡大师', async () => {
  const f = fixture();
  const name = 'HUAWEI MateBook 14';
  full(f, 'harmony', name);
  full(f, 'windows', name, false);
  f.add('hcard', cardPath(name, 1), `# ${name}（鸿蒙版）\n- 产品类别：鸿蒙电脑`);
  f.add('wcard', cardPath(name, 2), `# ${name}（Windows）\n- 产品类别：笔记本电脑`);
  full(f, 'ultimate', 'HUAWEI MateBook Fold 非凡大师');
  f.add('enterprise', cardPath('Fold 企业版', 11), '# HUAWEI MateBook Fold 企业版\n- 产品类别：商用鸿蒙折叠电脑');
  const entries = await f.loadCatalog();
  assert.equal(entries.filter((e) => e.name === name).length, 2);
  assert.equal(entries.find((e) => e.id === 'catalog:hcard')?.system, 'HarmonyOS 6');
  assert.match(entries.find((e) => e.id === 'catalog:wcard')!.system!, /Windows/);
  const enterprise = entries.find((e) => e.id === 'catalog:enterprise')!;
  assert.equal(enterprise.level, 'discovery');
  assert.equal(enterprise.creativeModelId, undefined);
  const evidence = await f.loadCatalogEvidence(enterprise.id);
  assert.ok(evidence.length > 0);
  assert.ok(evidence.every((e) => e.docId === 'enterprise' && e.kind === 'limit' && /仅供产品发现/.test(e.text)));
});

test('共享URL不同款式不合并，兼容性文字不能被当成操作系统', async () => {
  const f = fixture();
  for (const [n, name] of [[53, 'HUAWEI MateDock 2'], [54, 'HUAWEI MateDock 3']] as const) {
    f.add(String(n), cardPath(name, n), `# ${name}\n- 产品类别：扩展坞\n- 官方页面：https://example.invalid/shared/\n## 补抓建议\n应确认鸿蒙电脑兼容性`);
  }
  const entries = await f.loadCatalog();
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.system === undefined && e.level === 'discovery'));
  const evidence = await f.loadCatalogEvidence('catalog:53');
  assert.ok(evidence.every((e) => e.docId === '53' && /不能据此断言规格/.test(e.text)));
});

test('创作映射必须ready且目录完全匹配，完整事实不等于已接入创作', async () => {
  const a = 'HUAWEI MateBook Pro';
  const b = 'HUAWEI MateBook Pro S';
  const f = fixture([
    { id: 'wrong', name: a, system: 'HarmonyOS', ready: true, dir: fullPath(`${a} 错误`) },
    { id: 'disabled', name: b, system: 'HarmonyOS', ready: false, dir: fullPath(b) },
  ]);
  full(f, 'pro', a);
  full(f, 'pros', b);
  assert.ok((await f.loadCatalog()).every((e) => e.level === 'full' && !e.creativeModelId));
});

test('反斜杠和根前缀可用，外部修改返回值不污染缓存', async () => {
  const f = fixture();
  f.add('a', `本地知识库/${cardPath('新品')}`.replaceAll('/', '\\'), '# 新品\n- 产品类别：显示器');
  const entries = await f.loadCatalog();
  assert.equal(entries.length, 1);
  entries[0].name = '被修改';
  entries[0].evidencePaths.length = 0;
  const again = await f.loadCatalog();
  assert.equal(again[0].name, '新品');
  assert.equal(again[0].evidencePaths.length, 1);
});

test('明确刷新证据时重新读取正文，失败不退回旧缓存', async () => {
  const f = fixture();
  f.add('a', cardPath('新品'), '# 新品\n旧正文');
  await f.loadCatalog();
  f.texts.set('a', '# 新品\n新正文');
  const updated = await f.loadCatalogEvidence('catalog:a', { refresh: true });
  assert.ok(updated.some(item => item.text.includes('新正文')));
  assert.ok(!updated.some(item => item.text.includes('旧正文')));
  f.texts.delete('a');
  await assert.rejects(f.loadCatalogEvidence('catalog:a', { refresh: true }), /读取目录资料失败/);
});

test('未知ID拒绝，不允许传入任意资料路径', async () => {
  const f = fixture();
  f.add('a', cardPath('新品'), '# 新品\n- 产品类别：显示器');
  await assert.rejects(f.loadCatalogEvidence('P4-机密/资料.md'), /未知产品目录/);
  assert.deepEqual(f.reads, ['a']);
});

test('读取失败或缺少限制明确报错，恢复后可重试，不能伪称完整', async () => {
  const f = fixture();
  full(f, 'a', '新品');
  f.texts.delete('a-limit');
  await assert.rejects(f.loadCatalog(), /读取目录资料失败/);
  f.texts.set('a-limit', '# 限制\n配置需确认');
  assert.equal((await f.loadCatalog())[0].level, 'full');
  const missing = fixture();
  missing.add('fact', `${fullPath('新品')}产品事实.md`, '# 新品 - 产品事实\n真实正文');
  await assert.rejects(missing.loadCatalog(), /缺少完整型号限制/);
});

test('55张发现卡及完整资料按最多4个并发读取，同时请求目录复用同一次构建', async () => {
  let active = 0;
  let peak = 0;
  const phasePeaks = { fact: 0, limit: 0, card: 0 };
  const f = fixture([], async (doc) => {
    const phase = doc.id.endsWith('-fact') ? 'fact' : doc.id.endsWith('-limit') ? 'limit' : 'card';
    active++;
    peak = Math.max(peak, active);
    phasePeaks[phase] = Math.max(phasePeaks[phase], active);
    try {
      // Yield while the read is in flight, so an unbounded Promise.all would
      // reproduce the knowledge service's eight-connection failure.
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(active <= 8, 'the knowledge service rejects more than eight active reads');
    } finally {
      active--;
    }
  });
  for (let i = 0; i < 11; i++) full(f, `full-${i}`, `完整型号${i}款`);
  for (let i = 1; i <= 55; i++) f.add(`card-${i}`, cardPath(`发现设备${i}款`, i), `# 发现设备${i}款\n- 产品类别：显示器`);
  const [first, second, third] = await Promise.all([f.loadCatalog(), f.loadCatalog(), f.loadCatalog()]);
  assert.equal(first.length, 66);
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.equal(first.filter((entry) => entry.level === 'discovery').length, 55);
  assert.equal(first.filter((entry) => entry.level === 'full').length, 11);
  assert.equal(active, 0);
  assert.equal(peak, 4);
  assert.deepEqual(phasePeaks, { fact: 4, limit: 4, card: 4 });
  assert.equal(f.reads.length, 77);
  assert.equal(new Set(f.reads).size, 77);
  const evidence = await f.loadCatalogEvidence('catalog:card-55');
  assert.ok(evidence.length > 0);
  assert.ok(evidence.every((e) => e.docId === 'card-55' && e.kind === 'limit'));
  assert.equal(f.reads.length, 77, 'cached evidence must not start another document read');
});

const pricePath = (name: string) => `${root}08-官方公开价格快照/01-消费级PC/${name}-价格卡.md`;
const priceText = (name: string) => `---\nproduct_name: ${name}\n---\n# ${name}｜官方公开价格卡\n## 官方价格与销售状态记录\n| 核验时间 | 精确款式 | 价格类型 | 页面金额 | 参考/划线金额 | 库存或销售状态 | 条件摘要 | 来源 |\n|---|---|---|---|---|---|---|---|\n| 2026-10-17T14:51:00-05:00 | 24GB/512GB/柔光版/仲夏紫/HarmonyOS/麒麟XE90 | 官方商城页面价 | ¥9,999 | — | 现货 | 未核验结算价 | [官方页](https://item.vmall.com/product/1) |`;

test('价格按产品全名绑定，无创作映射也可读取，原事实编号和正文不变', async () => {
  const f = fixture();
  const name = '华为无线鼠标 3';
  f.add('mouse', cardPath(name), `# ${name}\n- 产品类别：鼠标`);
  const before = await f.loadCatalogEvidence('catalog:mouse');
  const g = fixture();
  g.add('mouse', cardPath(name), `# ${name}\n- 产品类别：鼠标`);
  g.add('price', pricePath(name), priceText(name));
  const entry = (await g.loadCatalog())[0];
  assert.ok(entry.evidencePaths.includes(pricePath(name)));
  assert.deepEqual(await g.loadCatalogEvidence(entry.id), before);
  assert.ok(!g.reads.includes('price'), '默认非询价不读价格正文');
  const withPrice = await g.loadCatalogEvidence(entry.id, { wantPrice: true });
  assert.deepEqual(withPrice.slice(0, before.length), before);
  assert.ok(withPrice.slice(before.length).every(e => e.kind === 'price' && !e.text.includes('仅供产品发现')));
  assert.ok(withPrice.some(e => e.docId === 'price' && e.kind === 'price'));
  assert.equal(new Set(withPrice.map(e => e.id)).size, withPrice.length);
});

test('价格保留鸿蒙/Windows、企业/消费款、代际款式边界，不用相似名称或共享URL兜底', async () => {
  const f = fixture();
  full(f, 'h', 'HUAWEI MateBook 14');
  full(f, 'w', 'HUAWEI MateBook 14', false);
  f.add('hc', cardPath('鸿蒙款', 1), '# HUAWEI MateBook 14（鸿蒙版）\n- 产品类别：鸿蒙电脑');
  f.add('wc', cardPath('Windows款', 2), '# HUAWEI MateBook 14（Windows）\n- 产品类别：笔记本电脑');
  for (const [i, name] of ['HUAWEI MateBook Fold 企业版', 'HUAWEI MateBook Fold 非凡大师', '华为无线鼠标 3 轻音版'].entries()) {
    f.add(`extra${i}`, cardPath(name, i + 3), `# ${name}\n- 官方页面：https://example.invalid/shared`);
  }
  const names = ['HUAWEI MateBook 14（鸿蒙版）', 'HUAWEI MateBook 14（Windows）', 'HUAWEI MateBook Fold 企业版', 'HUAWEI MateBook Fold 非凡大师', '华为无线鼠标 3'];
  for (const [i, name] of names.entries()) f.add(`p${i}`, pricePath(name), priceText(name));
  for (const [id, expected] of [['hc', 'p0'], ['wc', 'p1'], ['extra0', 'p2'], ['extra1', 'p3']] as const) {
    const evidence = await f.loadCatalogEvidence(`catalog:${id}`, { wantPrice: true });
    assert.deepEqual([...new Set(evidence.filter(e => e.kind === 'price').map(e => e.docId))], [expected]);
  }
  assert.ok(!(await f.loadCatalogEvidence('catalog:extra2', { wantPrice: true })).some(e => e.kind === 'price'));
});

test('受限、归档价格永不绑定，歧义重名不取第一份，正文错名拒绝', async () => {
  const f = fixture();
  f.add('a', cardPath('新品'), '# 新品\n- 产品类别：鼠标');
  for (const [i, p] of [`归档/${pricePath('新品')}`, `P4-机密/${pricePath('新品')}`, `${root}08-官方公开价格快照/归档/新品-价格卡.md`].entries()) f.add(`bad${i}`, p, priceText('新品'));
  await f.loadCatalogEvidence('catalog:a', { wantPrice: true });
  assert.deepEqual(f.reads, ['a']);
  const g = fixture();
  g.add('a', cardPath('新品'), '# 新品\n- 产品类别：鼠标');
  g.add('p1', pricePath('新品'), priceText('新品'));
  g.add('p2', `${root}08-官方公开价格快照/02-商用电脑/新品-价格卡.md`, priceText('新品'));
  assert.ok(!(await g.loadCatalogEvidence('catalog:a', { wantPrice: true })).some(e => e.kind === 'price'));
  const h = fixture();
  h.add('a', cardPath('新品'), '# 新品\n- 产品类别：鼠标');
  h.add('p', pricePath('新品'), priceText('其他型号'));
  await assert.rejects(h.loadCatalogEvidence('catalog:a', { wantPrice: true }), /价格卡.*身份/);
});

test('价格正文缺失不影响普通问答，显式询价刷新失败不返回旧价格', async () => {
  const f = fixture();
  f.add('a', cardPath('新品'), '# 新品\n产品资料');
  f.add('p', pricePath('新品'), priceText('新品'));
  await f.loadCatalog();
  f.texts.delete('p');
  assert.ok((await f.loadCatalogEvidence('catalog:a')).length);
  await assert.rejects(f.loadCatalogEvidence('catalog:a', { wantPrice: true }), /读取目录资料失败/);
  f.texts.set('p', priceText('新品'));
  assert.ok((await f.loadCatalogEvidence('catalog:a', { wantPrice: true })).some(e => e.kind === 'price'));
  f.texts.delete('p');
  await assert.rejects(f.loadCatalogEvidence('catalog:a', { refresh: true, wantPrice: true }), /读取目录资料失败/);
});
