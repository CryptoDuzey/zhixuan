// Real source modules -> real localhost KB -> actual image bytes. No app restart/model calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { products } from './kb-image-mapping.fixtures.mjs';
const root = path.resolve(import.meta.dirname, '../..');
const out = path.join(root, 'output/iterations/kb-image-mapping-20261022');
const phase = process.argv[2];
if (!['before', 'after'].includes(phase)) throw new Error('Use before or after, never overwrite a phase');
await fs.mkdir(out, { recursive: true });
const target = path.join(out, `${phase}-live.json`);
const sha = x => createHash('sha256').update(x).digest('hex');
const report = { phase, startedAt: new Date().toISOString(), fixedProducts: products, inputHash: sha(JSON.stringify(products)), protocol: 'real source module loading and loopback KB HTTP, including full image bytes; no LLM/generation/web/browser; not proof deployed Next build refreshed', models: [], requests: [], failures: [] };
await fs.writeFile(target, JSON.stringify(report, null, 2), { flag: 'wx' });
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(u.origin, 'http://127.0.0.1:8765', 'Only local KB may be read');
  assert.ok(['/documents', '/document'].includes(u.pathname));
  assert.equal(init?.method ?? 'GET', 'GET');
  const response = await originalFetch(input, init);
  report.requests.push({ pathname: u.pathname, id: u.searchParams.get('id'), http: response.status });
  return response;
};
try {
  const facts = await import('../lib/facts.ts');
  const ima = await import('../lib/ima.ts');
  const catalog = await import('../lib/catalog.ts');
  const index = await ima.loadLocalIndex({ refresh: true });
  const entries = await catalog.withCatalogSnapshot(catalog.loadCatalog);
  for (const p of products) {
    const model = facts.MODELS.find(m => m.id === p.id);
    const entry = entries.find(e => e.docPath === `${p.dir}产品事实.md`);
    const result = { ...p, registered: !!model, actualReady: model?.ready, model, catalog: entry, images: [], imageBytes: [], evidence: [], catalogEvidence: [], errors: [] };
    report.models.push(result);
    result.images = await facts.loadImages(p.id);
    for (const image of result.images) {
      const doc = index.find(d => d.id === image.docId);
      assert.ok(doc?.path.endsWith(`${p.dir}images/${image.filename}`));
      const raw = await ima.readLocalImage(doc);
      const actualHash = raw.bytes ? sha(raw.bytes) : null;
      result.imageBytes.push({ id: image.id, filename: image.filename, ok: raw.ok, bytes: raw.bytes?.length, hash: actualHash, matches: actualHash === image.sha256 });
      assert.ok(raw.ok && raw.bytes?.length && actualHash === image.sha256, 'Read real image bytes with registered content hash');
    }
    if (model?.ready) result.evidence = await facts.loadEvidence(p.id);
    if (entry) result.catalogEvidence = await catalog.withCatalogSnapshot(() => catalog.loadCatalogEvidence(entry.id));
    if (phase === 'after') {
      try {
        assert.ok(model, `Missing registry: ${p.id}`);
        assert.equal(model.ready, p.ready);
        assert.equal(result.images.length, p.count);
        assert.equal(entry?.creativeModelId, p.ready ? p.id : undefined);
        if (!p.original) assert.ok(result.images.every(i => i.visuallyReviewed === false));
        if (p.ready) assert.ok(result.evidence.some(e => e.kind === 'fact') && result.evidence.some(e => e.kind === 'limit') && result.evidence.some(e => e.kind === 'scene'));
      } catch (error) { result.errors.push(error.message); report.failures.push({ model: p.id, error: error.message }); }
    }
  }
  if (phase === 'after') {
    const before = JSON.parse(await fs.readFile(path.join(out, 'before-live.json'), 'utf8'));
    assert.equal(before.inputHash, report.inputHash);
    const withoutTime = values => values.map(({ readAt, ...e }) => e);
    report.originalComparisons = products.filter(p => p.original).map(p => {
      const old = before.models.find(m => m.id === p.id); const now = report.models.find(m => m.id === p.id);
      const stableImage = ({ purpose, ...image }) => image; // Unreviewed purpose becomes neutral; identity/caption/review status stay fixed.
      const checks = { modelId: p.id, sameImages: JSON.stringify(old.images.map(stableImage)) === JSON.stringify(now.images.map(stableImage)), sameEvidence: JSON.stringify(withoutTime(old.evidence)) === JSON.stringify(withoutTime(now.evidence)), sameCatalogEvidence: JSON.stringify(withoutTime(old.catalogEvidence)) === JSON.stringify(withoutTime(now.catalogEvidence)), sameCatalogIdentity: old.catalog.id === now.catalog.id && old.catalog.creativeModelId === now.catalog.creativeModelId };
      if (Object.entries(checks).some(([k, v]) => k !== 'modelId' && !v)) report.failures.push(checks);
      return checks;
    });
  }
} catch (error) { report.failures.push({ fatal: error.message }); }
finally { globalThis.fetch = originalFetch; }
report.endedAt = new Date().toISOString();
await fs.writeFile(target, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ phase, models: report.models.map(m => ({ id: m.id, registered: m.registered, ready: m.actualReady, images: m.images.length, creative: m.catalog?.creativeModelId, errors: m.errors })), requests: report.requests.length, failures: report.failures, comparisons: report.originalComparisons }, null, 2));
if (report.failures.length) process.exitCode = 1;
