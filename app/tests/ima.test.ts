import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLocalIndex, findLocal, readLocalText, getCallLog } from '../lib/ima.ts';

test('本地索引：路径已规范为正斜杠，且能区分同名产品事实', async () => {
  const idx = await loadLocalIndex();
  assert.ok(idx.length > 1000);
  assert.ok(idx.every((d) => !d.path.includes('\\')));
  const facts = idx.filter((d) => d.path.endsWith('产品事实.md'));
  assert.ok(facts.length >= 10);
});

test('findLocal 定位 Pro S 产品事实并读取正文', async () => {
  const doc = await findLocal('MateBook Pro S', '产品事实.md');
  assert.ok(doc, '应找到 Pro S 产品事实');
  const r = await readLocalText(doc!);
  assert.equal(r.ok, true);
  assert.equal(r.source, '本地已下载知识库');
  assert.ok(r.text!.includes('HarmonyOS'));
});

test('调用日志留痕', () => {
  assert.ok(getCallLog().some((l) => l.op === 'read' && l.ok));
});
