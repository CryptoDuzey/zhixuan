import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog } from '../lib/catalog.ts';
import type { LocalDoc, ReadResult } from '../lib/ima.ts';
import type { ModelEntry } from '../lib/facts.ts';

function fixture(models: ModelEntry[] = []) {
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
