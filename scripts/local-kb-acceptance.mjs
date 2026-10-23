// Read-only KB/index audit. Six fixed hybrid search requests; never retries/rebuilds.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..');
const library = path.join(root, 'kb/华为PC全板块深度知识库_v7');
const output = path.join(root, 'output/iterations/local-kb-audit-20261022');
const store = path.join(root, 'app/data/private/rag');
const sha = data => createHash('sha256').update(data).digest('hex');
const save = (name, value) => fs.writeFile(path.join(output, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), { flag: 'wx' });
const queries = [
  { id: 'Q1-computer', q: 'MateBook Pro S 防窥版24GB 512GB 历史价格', mustPath: '08-官方公开价格快照/01-消费级PC/HUAWEI MateBook Pro S-价格卡.md', criterion: '目标原价格卡应进入50条窗口；金额与配置仍须原卡核对，不用召回替代报价。' },
  { id: 'Q2-display', q: 'MateView GT 27 英寸高刷版 价格', mustPath: '08-官方公开价格快照/03-显示器/HUAWEI MateView GT 27 英寸高刷版-价格卡.md', criterion: '精确高刷版价格卡应召回，不能以4K超清版代替。' },
  { id: 'Q3-mouse', q: '华为无线鼠标 3 价格', mustPath: '08-官方公开价格快照/05-电脑配件/华为无线鼠标 3-价格卡.md', criterion: '鼠标3精确价格卡应召回；轻音版、星闪版只算旁支。' },
  { id: 'Q4-near-model', q: 'MateBook Pro（鸿蒙版）价格，不是 MateBook Pro S', mustPath: '08-官方公开价格快照/01-消费级PC/HUAWEI MateBook Pro（鸿蒙版）-价格卡.md', criterion: '登记排除Pro S的相近型号样本；检查负向型号是否进入实体与首位，检索命中不等于可用事实。' },
  { id: 'Q5-negative-sku', q: 'MateBook Pro S 防窥版24GB 512GB价格，不要柔光版', mustPath: '08-官方公开价格快照/01-消费级PC/HUAWEI MateBook Pro S-价格卡.md', criterion: '整文档包含多种屏幕不自动算失败；首片段如仅柔光正价、不含目标防窥行，则不能据此答目标报价。' },
  { id: 'Q6-absent', q: 'ZXQVOID2099 幻影2099 不存在型号 售价', absentNeedle: 'ZXQVOID2099', criterion: '全量文本/路径字面无标记，应明确未确认型号；即使向量返回50条邻近结果也不能当真实型号命中。观察evidenceSufficient/unsupportedReasons是否误示充分。' },
];
await fs.mkdir(output, { recursive: true });
await save('registration.json', { startedAt: new Date().toISOString(), queries, inputHash: sha(JSON.stringify(queries)), queryBudget: 6, topK: 50, strategy: 'hybrid', protocol: 'GET only, no credentials/config/model reads, no retries, no /answer or remote web, health/catalog reads are not search queries; structural and semantic judgments separate' });
async function get(name, url) {
  const entry = { url, method: 'GET', startedAt: new Date().toISOString() };
  await save(`${name}.request.json`, entry);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
    const bytes = Buffer.from(await response.arrayBuffer());
    await save(`${name}.response.raw.json`, bytes.toString('utf8'));
    Object.assign(entry, { http: response.status, contentType: response.headers.get('content-type'), requestId: response.headers.get('x-request-id'), bytes: bytes.length, responseSHA256: sha(bytes), body: JSON.parse(bytes.toString('utf8')) });
  } catch (error) { entry.error = String(error.message); }
  entry.endedAt = new Date().toISOString();
  await save(`${name}.json`, entry);
  return entry;
}
const health = [];
for (const [name, url] of [
  ['adapter-health', 'http://127.0.0.1:8765/health'],
  ['adapter-rag-health', 'http://127.0.0.1:8765/rag/health'],
  ['query-health', 'http://127.0.0.1:8766/health'],
  ['secondary-health', 'http://127.0.0.1:8767/health'],
]) health.push(await get(name, url));
const listing = await get('adapter-documents', 'http://127.0.0.1:8765/documents');
const manifest = JSON.parse(await fs.readFile(path.join(store, 'manifest.json'), 'utf8'));
const docs = JSON.parse(await fs.readFile(path.join(store, 'documents.json'), 'utf8'));
const chunks = JSON.parse(await fs.readFile(path.join(store, 'chunks.json'), 'utf8'));
const liveDocs = new Map();
const skipped = [];
const permittedExtensions = new Set(['.md', '.markdown', '.csv', '.json', '.txt', '.png', '.jpg', '.jpeg', '.webp', '.gif']);
async function walk(folder) {
  for (const item of await fs.readdir(folder, { withFileTypes: true })) {
    const filename = path.join(folder, item.name);
    const relative = path.relative(library, filename).replaceAll('\\', '/');
    if (item.isSymbolicLink()) { skipped.push({ path: relative, reason: 'link, not read' }); continue; }
    if (item.isDirectory()) await walk(filename);
    else if (item.isFile()) {
      if (!permittedExtensions.has(path.extname(item.name).toLowerCase()) || /(?:^|\/)(?:\.env|credentials?|secrets?)(?:\.|$)/i.test(relative)) { skipped.push({ path: relative, reason: 'unrecognized/sensitive filename, not read' }); continue; }
      const bytes = await fs.readFile(filename);
      liveDocs.set(relative, { path: relative, id: sha(relative).slice(0, 24), sha256: sha(bytes), bytes: bytes.length, data: bytes });
    }
  }
}
await walk(library);
const sorted = [...liveDocs.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
// Python json.dumps(..., ensure_ascii=False) default separators have spaces.
const pythonPairs = '[' + sorted.map(d => '[' + JSON.stringify(d.path) + ', ' + JSON.stringify(d.sha256) + ']').join(', ') + ']';
const fingerprint = sha(pythonPairs);
const docById = new Map(docs.map((d, i) => [d.id, { ...d, index: i }]));
const mismatched = docs.flatMap(d => {
  const live = liveDocs.get(d.path);
  return !live || live.id !== d.id || live.sha256 !== d.sha256 || live.bytes !== d.bytes ? [{ path: d.path, missing: !live, indexedHash: d.sha256, actualHash: live?.sha256 }] : [];
});
const indexedPaths = new Set(docs.map(d => d.path));
const missingFromIndex = sorted.filter(d => !indexedPaths.has(d.path)).map(d => d.path);
const artifactChecks = [];
for (const [file, field] of [['documents.json', 'documentSHA256'], ['chunks.json', 'chunkSHA256'], ['vectors.npy', 'vectorSHA256']]) {
  const bytes = await fs.readFile(path.join(store, file));
  artifactChecks.push({ file, actualHash: sha(bytes), manifestHash: manifest[field], matches: sha(bytes) === manifest[field] });
}
const vectorBytes = await fs.readFile(path.join(store, 'vectors.npy'));
const headerLength = vectorBytes[6] === 1 ? vectorBytes.readUInt16LE(8) : vectorBytes.readUInt32LE(8);
const headerStart = vectorBytes[6] === 1 ? 10 : 12;
const vectorHeader = vectorBytes.subarray(headerStart, headerStart + headerLength).toString('latin1').trim();
const dimensions = vectorHeader.match(/'shape':\s*\((\d+),\s*(\d+)\)/)?.slice(1).map(Number);
const texts = docs.map(d => d.textIndexed && liveDocs.has(d.path) ? [...liveDocs.get(d.path).data.toString('utf8')] : null);
const chunkErrors = [];
const docChunks = docs.map(() => []);
for (let i = 0; i < chunks.length; i++) {
  const c = chunks[i]; const d = docs[c.doc];
  if (!d) { chunkErrors.push({ chunk: i, reason: 'invalid doc index' }); continue; }
  docChunks[c.doc].push({ ...c, index: i });
  const chars = texts[c.doc];
  if (d.textIndexed) {
    if (!chars || c.start < 0 || c.end > chars.length || c.end <= c.start || chars.slice(c.start, c.end).join('') !== c.text || c.image !== false) chunkErrors.push({ chunk: i, path: d.path, reason: 'text/offset mismatch' });
    else if (chars.slice(0, c.start).filter(v => v === '\n').length + 1 !== c.line || chars.slice(0, c.end).filter(v => v === '\n').length + 1 !== c.lineEnd) chunkErrors.push({ chunk: i, path: d.path, reason: 'line mismatch' });
  } else if (c.text !== d.path || c.start !== 0 || c.end !== 0 || c.image !== true) chunkErrors.push({ chunk: i, path: d.path, reason: 'binary-path metadata mismatch' });
}
const coverageErrors = [];
for (let di = 0; di < docs.length; di++) {
  if (!docChunks[di].length) { coverageErrors.push({ path: docs[di].path, reason: 'no chunks' }); continue; }
  if (!texts[di]) continue;
  let end = 0;
  for (const c of docChunks[di].sort((a, b) => a.start - b.start)) {
    if (c.start > end) coverageErrors.push({ path: docs[di].path, reason: 'coverage gap', start: end, end: c.start });
    end = Math.max(end, c.end);
  }
  if (end !== texts[di].length) coverageErrors.push({ path: docs[di].path, reason: 'tail mismatch', covered: end, source: texts[di].length });
}
const chunkByKey = new Map(chunks.map(c => [`${docs[c.doc]?.id}:${c.start}`, c]));
const adapterDocs = listing.body?.items ?? [];
const adapterMismatches = adapterDocs.filter(d => !liveDocs.has(d.path) || liveDocs.get(d.path).sha256 !== d.sha256 || liveDocs.get(d.path).id !== d.id).map(d => d.path);
const inventory = { files: liveDocs.size, expectedHistoricalFiles: 1522, textFiles: docs.filter(d => d.textIndexed).length, binaryFiles: docs.filter(d => !d.textIndexed).length, chunks: chunks.length, fingerprint, manifest, fingerprintMatches: fingerprint === manifest.fingerprint, missingFromIndex, indexedSourceMismatches: mismatched, skipped, artifactChecks, vectorHeader, vectorDimensions: dimensions, vectorStructureMatches: dimensions?.[0] === chunks.length && dimensions?.[1] === manifest.dimensions && /'descr':\s*'<f4'/.test(vectorHeader) && vectorBytes.length - headerStart - headerLength === chunks.length * manifest.dimensions * 4, chunkErrors, coverageErrors, adapterFiles: adapterDocs.length, adapterMismatches, adapterMissingPaths: sorted.filter(d => !adapterDocs.some(a => a.path === d.path)).map(d => d.path), healthBindings: health.map(e => ({ url: e.url, http: e.http, files: e.body?.files, chunks: e.body?.chunks, fingerprint: e.body?.fingerprint, adapterIndexFingerprint: e.body?.adapterIndexFingerprint, ready: e.body?.ready, service: e.body?.service, error: e.error })) };
await save('inventory.json', inventory);
await save('corpus-files.json', sorted.map(({ data, ...d }) => d));
const oldStore = path.join(root, 'work/rag-index');
const oldManifest = JSON.parse(await fs.readFile(path.join(oldStore, 'manifest.json'), 'utf8'));
const oldDocs = JSON.parse(await fs.readFile(path.join(oldStore, 'documents.json'), 'utf8'));
await save('historical-index.json', { path: 'work/rag-index', manifest: oldManifest, sourceHashMismatches: oldDocs.filter(d => liveDocs.get(d.path)?.sha256 !== d.sha256).map(d => d.path), note: 'A historical on-disk store is not evidence that the running query service uses it; compare health fingerprint.' });
const parseCsv = line => {
  const result = []; let cell = ''; let quote = false;
  for (let i = 0; i < line.length; i++) { const ch = line[i]; if (ch === '"' && line[i + 1] === '"' && quote) { cell += '"'; i++; } else if (ch === '"') quote = !quote; else if (ch === ',' && !quote) { result.push(cell); cell = ''; } else cell += ch; }
  result.push(cell); return result;
};
const factsSource = await fs.readFile(path.join(root, 'app/lib/facts.ts'), 'utf8');
const mappedDirs = [...factsSource.matchAll(/\{ id: '([^']+)', name: '([^']+)'[^\n]*ready: true, dir: '([^']+)'/g)].map(m => ({ modelId: m[1], name: m[2], directory: m[3] }));
const imageIndexes = sorted.filter(d => d.path.endsWith('/图片索引.csv')).map(d => {
  const dir = d.path.slice(0, -'图片索引.csv'.length);
  const rows = d.data.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).slice(1).map(parseCsv);
  const boundRows = rows.map(c => {
    const paths = [`${dir}images/${c[0]}`, `${dir}${c[0]}`].filter(p => liveDocs.has(p));
    return { filename: c[0], modelName: c[1], width: Number(c[5]), height: Number(c[6]), localPath: paths.length === 1 ? paths[0] : null, localCandidates: paths, exists: paths.length === 1, indexed: paths.length === 1 && indexedPaths.has(paths[0]), productionImagesSubdirBound: liveDocs.has(`${dir}images/${c[0]}`) };
  });
  return { indexPath: d.path, mappedModel: mappedDirs.find(m => m.directory === dir)?.modelId ?? null, rows: boundRows, totalRows: rows.length, locallyBound: boundRows.filter(r => r.exists).length, note: 'Accept exact adjacent-file and images-subfolder layouts separately. Local binding only; CSV dimensions/captions are not new visual verification.' };
});
const images = sorted.filter(d => /\.(png|jpe?g|webp|gif)$/i.test(d.path));
await save('image-coverage.json', { mappedModels: mappedDirs, allImageFiles: images.length, allImagePaths: images.map(d => d.path), imageIndexes, imageContentAnalyzed: false, note: 'Product images remain KB-local. Metadata vectors index paths, not pixels; no remote media, no generation.' });
const results = [];
for (const query of queries) {
  const url = `http://127.0.0.1:8765/rag/search?${new URLSearchParams({ q: query.q, strategy: 'hybrid', top_k: '50' })}`;
  const record = await get(query.id, url);
  const body = record.body;
  const checks = (body?.results ?? []).map((r, rank) => {
    const d = docById.get(r.id); const live = liveDocs.get(r.path); const c = chunkByKey.get(r.chunkId);
    return { rank: rank + 1, id: r.id, path: r.path, chunkId: r.chunkId, exists: !!live, hashMatches: !!live && r.sha256 === live.sha256, indexedIdentity: !!d && d.path === r.path, chunkMatches: !!c && !!d && c.doc === d.index && c.start === r.start && c.end === r.end && c.text === r.preview && c.line === r.line && c.lineEnd === r.lineEnd, bothChannelScores: Number.isFinite(r.denseScore) && Number.isFinite(r.lexicalScore), denseScore: r.denseScore, lexicalScore: r.lexicalScore, preview: r.preview };
  });
  const entry = { id: query.id, query: query.q, criterion: query.criterion, http: record.http, error: record.error, totalCandidates: body?.totalCandidates, returned: body?.returned, topK: 50, resultWindow: body?.resultWindow, indexFingerprintMatches: body?.indexFingerprint === fingerprint, strategy: body?.strategy, evidenceSufficient: body?.evidenceSufficient, analysis: body?.analysis, wantedCardRank: query.mustPath ? checks.find(c => c.path.endsWith(query.mustPath))?.rank ?? null : null, absentNeedleLiteralMatches: query.absentNeedle ? sorted.filter(d => `${d.path}\n${/\.(md|csv|json|txt)$/i.test(d.path) ? d.data.toString('utf8') : ''}`.includes(query.absentNeedle)).map(d => d.path) : undefined, structuralFailures: checks.filter(c => !c.exists || !c.hashMatches || !c.indexedIdentity || !c.chunkMatches || !c.bothChannelScores), top10: checks.slice(0, 10), hits: checks, semanticVerdict: 'requires independent manual review; never infer exhaustiveness from topK or success from HTTP' };
  results.push(entry);
  await save(`${query.id}.checks.json`, entry);
  console.log(JSON.stringify({ id: entry.id, http: entry.http, candidates: entry.totalCandidates, returned: entry.returned, wantedCardRank: entry.wantedCardRank, structuralFailures: entry.structuralFailures.length, evidenceSufficient: entry.evidenceSufficient, firstPath: checks[0]?.path, error: entry.error }));
}
await save('query-summary.json', results.map(({ hits, top10, ...e }) => e));
const after = await Promise.all(artifactChecks.map(async c => ({ file: c.file, unchanged: sha(await fs.readFile(path.join(store, c.file))) === c.actualHash })));
const endFiles = new Map();
for (const d of sorted) endFiles.set(d.path, sha(await fs.readFile(path.join(library, d.path))));
await save('read-stability.json', { artifacts: after, sourceChangesDuringAudit: sorted.filter(d => d.sha256 !== endFiles.get(d.path)).map(d => d.path), endedAt: new Date().toISOString(), note: 'This process writes only its own output directory; no index/model/service mutation.' });
console.log(JSON.stringify({ files: inventory.files, textFiles: inventory.textFiles, chunks: inventory.chunks, fingerprintMatches: inventory.fingerprintMatches, chunkErrors: chunkErrors.length, coverageErrors: coverageErrors.length, missingFromIndex: missingFromIndex.length, mappedModels: mappedDirs.length, imageFiles: images.length }));
