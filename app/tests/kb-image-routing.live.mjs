// Real dynamic catalog -> real creative adapter -> exact local KB images, no model.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { products } from './kb-image-mapping.fixtures.mjs';
const out = path.resolve(import.meta.dirname, '../../output/iterations/kb-image-mapping-20261022');
const report = { protocol: 'real local KB through createConversationSources, no browser/LLM/restart', startedAt: new Date().toISOString(), products: [], failures: [] };
const target = path.join(out, 'after-routing-live.json');
await fs.writeFile(target, JSON.stringify(report), { flag: 'wx' });
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.origin, 'http://127.0.0.1:8765');
  assert.ok(['/documents', '/document'].includes(url.pathname));
  assert.equal(init?.method ?? 'GET', 'GET');
  return original(input, init);
};
try {
  const { withCatalogSnapshot, loadCatalog } = await import('../lib/catalog.ts');
  const { createConversationSources } = await import('../lib/agent-conversation.ts');
  const entries = await withCatalogSnapshot(loadCatalog);
  const sources = createConversationSources(entries);
  for (const product of products) {
    const entry = entries.find(e => e.docPath === `${product.dir}产品事实.md`);
    const images = await sources.loadImages(entry.id);
    const row = { id: product.id, catalogId: entry.id, creativeModelId: entry.creativeModelId, imageCount: images.length, images, allCatalogModelIds: images.every(i => i.modelId === entry.id), noSharedSourcePaths: images.every(i => i.source === '本地已下载知识库'), expected: product.count };
    report.products.push(row);
    if (images.length !== product.count || !row.allCatalogModelIds || images.some(i => !i.docId || !i.sha256)) report.failures.push(product.id);
    if (!product.original && images.some(i => i.visuallyReviewed)) report.failures.push(`${product.id}: unexpected visual approval`);
  }
} catch (error) { report.failures.push(error.message); }
finally { globalThis.fetch = original; }
report.endedAt = new Date().toISOString();
await fs.writeFile(target, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ products: report.products.map(({ images, ...row }) => row), failures: report.failures }, null, 2));
if (report.failures.length) process.exitCode = 1;
