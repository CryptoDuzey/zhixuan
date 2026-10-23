import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { withCatalogSnapshot, loadCatalog, loadCatalogEvidence } from '../lib/catalog.ts';

test('任务独立刷新产品目录，并发任务与嵌套步骤不替换原任务名单', async t => {
  let current = 'old';
  let indexes = 0;
  const reads: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/documents') {
      indexes++;
      return Response.json({ items: [{ id: current, title: '发现卡',
        path: `P1-产品参数库/07-扩展产品目录/显示器/01-${current}.md`, bytes: 10,
        sha256: createHash('sha256').update(`# ${current}\n- 产品类别：显示器\n仅发现线索${current}`).digest('hex') }] });
    }
    assert.equal(url.pathname, '/document');
    const id = url.searchParams.get('id')!;
    reads.push(id);
    return new Response(`# ${id}\n- 产品类别：显示器\n仅发现线索${id}`);
  });
  let release!: () => void;
  let ready!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { ready = resolve; });
  const first = withCatalogSnapshot(async () => {
    const entries = await loadCatalog();
    ready();
    await waiting;
    assert.equal((await loadCatalog())[0].id, 'catalog:old');
    assert.equal((await withCatalogSnapshot(loadCatalog))[0].id, 'catalog:old');
    assert.ok((await loadCatalogEvidence(entries[0].id)).every(item => item.docId === 'old'));
  });
  try {
    await started;
    current = 'new';
    await withCatalogSnapshot(async () => {
      assert.equal((await loadCatalog())[0].id, 'catalog:new');
      await assert.rejects(loadCatalogEvidence('catalog:old'), /未知产品/);
    });
  } finally { release(); }
  await first;
  assert.equal(indexes, 2, '每个任务刷新一次目录，嵌套步骤复用本任务快照');
  assert.deepEqual(reads, ['old', 'new', 'old']);
});
