// Read-only adapter for an independently obtained, authorized knowledge folder.
// No knowledge documents or credentials are distributed with this repository.
import http from 'node:http';
import { readdir, lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const SOURCE = '本地已下载知识库';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const normalize = (text) => text.normalize('NFC').toLowerCase();
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const types = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.pdf': 'application/pdf', '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.markdown': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};
const textExtensions = new Set(['.md', '.markdown', '.txt', '.csv', '.json']);
// A 1000-code-point query can occupy 12000 bytes after percent encoding.
const MAX_URL_BYTES = 16 * 1024;
const MAX_HEADER_BYTES = MAX_URL_BYTES + 8 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_HEALTH_BYTES = 64 * 1024;
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));

class KnowledgeError extends Error {
  constructor(status, code, message, kind = 'local') {
    super(message);
    this.status = status;
    this.code = code;
    this.kind = kind;
  }
}
const errorBody = (error) => ({ code: error.code, kind: error.kind, message: error.message });
function failure(error, requestId) {
  return {
    schemaVersion: 2, status: 'unavailable', reasonCode: error.code, message: error.message,
    error: errorBody(error), requestId, retryable: [429, 503, 504].includes(error.status),
    answer: '', claims: [], citations: [], items: [], results: [], abstained: true, evidenceSufficient: false,
  };
}
function json(res, status, body) {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  let data = JSON.stringify(body);
  if (Buffer.byteLength(data) > MAX_JSON_BYTES) {
    status = 413;
    data = JSON.stringify(failure(new KnowledgeError(413, 'RESPONSE_TOO_LARGE',
      '结果超过传输上限，请使用 limit 和 offset 分页，或缩小问题范围。'), res.getHeader('x-request-id')));
  }
  res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}
const badRequest = (message) => new KnowledgeError(400, 'INVALID_REQUEST', message, 'request');
const stale = () => new KnowledgeError(409, 'INDEX_STALE', '资料已变化或路径不安全，请核对资料并重启知识库服务。');
const rootUnavailable = () => new KnowledgeError(503, 'KNOWLEDGE_UNAVAILABLE', '知识库目录无法读取，请检查目录和权限。');
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const stableFile = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

function verifyPassage(result, bytes, universalNewlines) {
  const original = bytes.toString('utf8');
  // The existing engine reads answer/exact passages with Python universal
  // newlines; hybrid chunks retain the original bytes. Verify in the engine's
  // coordinate space, then return only offsets into the original document.
  // Walk to the requested span without allocating arrays for the whole source.
  if (!Number.isSafeInteger(result.start) || !Number.isSafeInteger(result.end)
    || result.start < 0 || result.end < result.start || result.end > original.length) throw stale();
  let position = 0;
  let originalPosition = 0;
  let offset = 0;
  let startOffset;
  let startPosition;
  while (position < result.end) {
    if (offset >= original.length) throw stale();
    if (position === result.start) {
      startOffset = offset;
      startPosition = originalPosition;
    }
    if (universalNewlines && original[offset] === '\r' && original[offset + 1] === '\n') {
      offset += 2;
      originalPosition += 2;
    } else {
      offset += original.codePointAt(offset) > 0xffff ? 2 : 1;
      originalPosition++;
    }
    position++;
  }
  if (result.start === result.end) { startOffset = offset; startPosition = originalPosition; }
  const preview = original.slice(startOffset, offset);
  if ((universalNewlines ? preview.replace(/\r\n|\r/g, '\n') : preview) !== result.preview) throw stale();
  result.start = startPosition;
  result.end = originalPosition;
  result.preview = preview;
  result.offsetEncoding = 'unicode-code-points';
  result.newlineMode = 'original';
}

function verifyExtractiveAnswer(body) {
  const citations = new Map();
  const labels = { source_fact: '', limitation: '限制：', to_verify: '待核验：' };
  const clean = (text) => text.replace(/^(?:[-*]|\d+[.、])\s+/u, '').trim();
  for (const citation of body.citations) {
    if (!Number.isSafeInteger(citation.number) || citation.number < 1
      || citation.citationId !== citation.number || citations.has(citation.number)
      || typeof citation.preview !== 'string') throw new Error('invalid citation');
    citations.set(citation.number, clean(citation.preview));
  }
  const matchesQuote = (claim) => Array.isArray(claim.citationIds) && claim.citationIds.length === 1
    && typeof claim.text === 'string' && claim.text === citations.get(claim.citationIds[0]);
  if (!body.claims.length || !body.claims.every((claim) => Object.hasOwn(labels, claim.kind) && matchesQuote(claim))
    || !Array.isArray(body.conditions) || !body.conditions.every(matchesQuote)) throw new Error('unsupported claim');
  const expected = body.claims.map((claim) => `${labels[claim.kind]}${claim.text}[${claim.citationIds[0]}]`).join('\n');
  if (body.answer !== expected) throw new Error('unsupported answer text');
}

function parameter(params, name, fallback) {
  if (params.getAll(name).length > 1) throw badRequest(`参数 ${name} 不能重复。`);
  return params.get(name) ?? fallback;
}
function integerParameter(params, name, fallback, max) {
  const value = parameter(params, name, String(fallback));
  if (!/^\d+$/.test(value)) throw badRequest(`参数 ${name} 必须是整数。`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (name === 'limit' ? 1 : 0) || number > max) {
    throw badRequest(`参数 ${name} 超出允许范围。`);
  }
  return number;
}
function setting(name, fallback, max) {
  const raw = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > max) {
    throw badRequest(`${name} 必须是 1 至 ${max} 的整数。`);
  }
  return Number(raw);
}
function allowedParameters(params, names) {
  for (const key of params.keys()) {
    if (!names.includes(key)) throw badRequest('请求包含不支持的参数。');
    parameter(params, key, '');
  }
}
function assertActive(signal) {
  signal?.throwIfAborted();
}
async function boundedJson(response, maxBytes, signal) {
  if (!response.body || !/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw new KnowledgeError(502, 'UPSTREAM_INVALID_RESPONSE', '混合检索返回了无效数据。', 'upstream');
  }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body.cancel();
    throw new KnowledgeError(502, 'UPSTREAM_RESPONSE_TOO_LARGE', '混合检索返回内容过大。', 'upstream');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      assertActive(signal);
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new KnowledgeError(502, 'UPSTREAM_RESPONSE_TOO_LARGE', '混合检索返回内容过大。', 'upstream');
      chunks.push(value);
    }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid object');
    return body;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof KnowledgeError || signal.aborted) throw error;
    throw new KnowledgeError(502, 'UPSTREAM_INVALID_RESPONSE', '混合检索返回了无效数据。', 'upstream');
  } finally { reader.releaseLock(); }
}

async function start() {
  const root = process.env.ZHIXUAN_KB_DIR;
  if (!root?.trim()) throw new KnowledgeError(400, 'ROOT_REQUIRED', '请设置 ZHIXUAN_KB_DIR，指向已获授权的知识库根目录。');
  const rawPort = process.env.IMA_LOCAL_PORT ?? '8765';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw badRequest('端口 IMA_LOCAL_PORT 必须是 1 至 65535 的整数。');
  }
  const port = Number(rawPort);
  const requestTimeoutMs = setting('ZHIXUAN_REQUEST_TIMEOUT_MS', 15000, 60000);
  const ragLimit = setting('ZHIXUAN_RAG_MAX_CONCURRENT', 8, 32);
  const localLimit = setting('ZHIXUAN_LOCAL_MAX_CONCURRENT', 8, 32);
  const upstreamMaxBytes = setting('ZHIXUAN_MAX_UPSTREAM_BYTES', MAX_JSON_BYTES, MAX_JSON_BYTES);
  let ragBase;
  if (process.env.ZHIXUAN_RAG_BASE) {
    try {
      const target = new URL(process.env.ZHIXUAN_RAG_BASE);
      if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1'
        || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw badRequest('');
      ragBase = target.origin;
    } catch { throw badRequest('ZHIXUAN_RAG_BASE 必须是本机地址，例如 http://127.0.0.1:8766。'); }
  }
  let base;
  let rootIdentity;
  try {
    base = await realpath(path.resolve(root));
    rootIdentity = await lstat(base);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new KnowledgeError(400, 'ROOT_MISSING', '知识库目录不存在，请检查 ZHIXUAN_KB_DIR。');
    throw rootUnavailable();
  }
  if (!rootIdentity.isDirectory()) throw new KnowledgeError(400, 'ROOT_NOT_DIRECTORY', '知识库路径不是文件夹。');
  const files = new Map();
  let skippedLinks = 0;
  let indexStale = false;

  async function checkRoot() {
    try {
      const current = await lstat(base);
      if (current.isSymbolicLink() || !current.isDirectory() || !sameFile(rootIdentity, current)
        || path.relative(base, await realpath(base)) !== '') throw rootUnavailable();
    } catch { throw rootUnavailable(); }
  }
  // Only indexed relative paths reach this function. Re-check every component
  // because a file or directory could have become a link after startup.
  async function checkedPath(relative) {
    const full = path.resolve(base, relative);
    const within = path.relative(base, full);
    if (!within || within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) throw stale();
    const parts = within.split(path.sep);
    let current = base;
    let info;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      info = await lstat(current);
      if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw stale();
    }
    if (path.relative(full, await realpath(full)) !== '') throw stale();
    return { full, info };
  }
  async function readChecked(relative, signal) {
    assertActive(signal);
    await checkRoot();
    let handle;
    try {
      const before = await checkedPath(relative);
      handle = await open(before.full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat();
      if (!opened.isFile() || !stableFile(before.info, opened)) throw stale();
      if (opened.size > MAX_DOCUMENT_BYTES) {
        throw new KnowledgeError(413, 'DOCUMENT_TOO_LARGE', '单份资料超过读取上限，请拆分资料后重新建立索引。');
      }
      const bytes = await handle.readFile({ signal });
      assertActive(signal);
      const after = await handle.stat();
      await checkRoot();
      const current = await checkedPath(relative);
      if (!stableFile(opened, after) || !stableFile(after, current.info) || bytes.length !== after.size) throw stale();
      return bytes;
    } catch (error) {
      assertActive(signal);
      if (error instanceof KnowledgeError) throw error;
      if (['EACCES', 'EPERM', 'EIO', 'EMFILE', 'ENFILE'].includes(error.code)) {
        throw new KnowledgeError(503, 'DOCUMENT_UNAVAILABLE', '资料暂时无法读取，请检查权限或稍后重试。');
      }
      throw stale();
    } finally {
      if (handle) await handle.close();
    }
  }

  async function index(folder) {
    const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name));
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) { skippedLinks++; continue; }
      // Verify directories before recursing; never intentionally index links.
      if (path.relative(full, await realpath(full)) !== '') throw stale();
      if (info.isDirectory()) { await index(full); continue; }
      if (!info.isFile()) continue;
      const relative = path.relative(base, full).split(path.sep).join('/');
      const bytes = await readChecked(relative);
      const id = digest(relative).slice(0, 24);
      if (files.has(id)) throw new KnowledgeError(500, 'ID_COLLISION', '资料编号冲突，无法安全建立目录。');
      let searchText = '';
      if (textExtensions.has(path.extname(full).toLowerCase())) {
        try { searchText = normalize(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { /* Non-UTF-8 files remain readable, but only their paths are searchable. */ }
      }
      files.set(id, {
        id, title: entry.name, path: relative, bytes: bytes.length, sha256: digest(bytes),
        source: SOURCE, searchPath: normalize(relative), searchText,
      });
    }
  }
  try { await index(base); }
  catch (error) {
    if (error instanceof KnowledgeError) throw error;
    throw new KnowledgeError(503, 'INDEX_FAILED', '知识库建立目录失败，请检查读取权限和资料是否稳定。');
  }
  const indexedAt = new Date().toISOString();
  // Match Python's ensure_ascii=False tuple serialization used by the existing
  // hybrid engine, binding both services to the same complete document set.
  const fingerprint = digest(`[${[...files.values()].sort((a, b) => compare(a.path, b.path))
    .map((doc) => `[${JSON.stringify(doc.path)}, ${JSON.stringify(doc.sha256)}]`).join(', ')}]`);
  const publicEntry = ({ id, title, path: relative, bytes, sha256, source }) => ({ id, title, path: relative, bytes, sha256, source });
  const snapshot = { source: SOURCE, indexedAt, indexMode: 'snapshot', indexFingerprint: fingerprint };
  async function verifiedBytes(doc, signal) {
    try {
      const bytes = await readChecked(doc.path, signal);
      if (digest(bytes) !== doc.sha256) throw stale();
      return bytes;
    } catch (error) {
      if (error.code === 'INDEX_STALE') indexStale = true;
      throw error;
    }
  }

  let ragActive = 0;
  let ragProbes = 0;
  let localActive = 0;
  const metrics = { completed: 0, failed: 0, timedOut: 0, cancelled: 0, busy: 0 };
  const ragObservation = {
    status: ragBase ? 'unverified' : 'disabled', checkedAt: null, reasonCode: null,
    scope: 'last-observation-only',
  };
  function observeRag(status, reasonCode = null) {
    Object.assign(ragObservation, { status, checkedAt: new Date().toISOString(), reasonCode });
  }
  async function upstream(route, signal, requestId, maxBytes) {
    // Redirects must not turn a configured loopback origin into arbitrary access.
    const response = await fetch(`${ragBase}${route}`, {
      signal, redirect: 'manual', headers: { 'x-request-id': requestId },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new KnowledgeError(502, 'UPSTREAM_REDIRECT', '混合检索地址发生跳转，请核对本机服务配置。', 'upstream');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 400) throw new KnowledgeError(400, 'INVALID_ARGUMENT', '检索参数无效，请核对问题、top_k 和 strategy。', 'request');
      if (response.status === 409) throw new KnowledgeError(409, 'RAG_INDEX_MISMATCH', '混合检索索引已变化，请更新索引。', 'upstream');
      if ([429, 503].includes(response.status)) throw new KnowledgeError(503, 'UPSTREAM_BUSY', '混合检索繁忙或未就绪，请稍后重试。', 'upstream');
      throw new KnowledgeError(503, 'UPSTREAM_UNAVAILABLE', '混合检索暂时不可用，请稍后重试。', 'upstream');
    }
    return boundedJson(response, maxBytes, signal);
  }
  async function proxyRag(res, url, signal, requestId) {
    const route = url.pathname.slice(4);
    if (!['/health', '/search', '/answer'].includes(route)) {
      throw new KnowledgeError(404, 'NOT_FOUND', '可用接口：/rag/health、/rag/search、/rag/answer。', 'request');
    }
    allowedParameters(url.searchParams, route === '/health' ? [] : route === '/answer' ? ['q', 'top_k'] : ['q', 'top_k', 'strategy']);
    const strategy = parameter(url.searchParams, 'strategy', 'hybrid');
    let topK;
    if (route !== '/health') {
      const query = parameter(url.searchParams, 'q', '');
      if (!query.trim() || Array.from(query).length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(query)) {
        throw badRequest('检索内容不能为空、不能超过 1000 个字符或包含无效控制字符。');
      }
      const rawK = parameter(url.searchParams, 'top_k', route === '/answer' ? '5' : '10');
      if (!/^\d{1,2}$/.test(rawK) || Number(rawK) < 1 || Number(rawK) > 50
        || !['exact', 'lexical', 'vector', 'hybrid'].includes(strategy)) throw badRequest('top_k 必须为 1 至 50，strategy 必须是受支持的检索方式。');
      topK = Number(rawK);
    }
    if (!ragBase) throw new KnowledgeError(503, 'RAG_NOT_CONFIGURED', '本地混合检索尚未配置。');
    const probeOnly = route === '/health';
    if (probeOnly ? ragProbes >= 1 : ragActive >= ragLimit) {
      metrics.busy++;
      throw new KnowledgeError(503, 'BUSY', '检索繁忙，请稍后重试。');
    }
    if (probeOnly) ragProbes++; else ragActive++;
    try {
      const health = await upstream('/health', signal, requestId, MAX_HEALTH_BYTES);
      if (health.service !== 'ima-local-rag') throw new KnowledgeError(502, 'UPSTREAM_INVALID_RESPONSE', '混合检索返回了无效健康信息。', 'upstream');
      if (health.files !== files.size || health.fingerprint !== fingerprint || health.indexStale || indexStale) {
        throw new KnowledgeError(409, 'RAG_INDEX_MISMATCH', '混合检索索引与当前资料不一致，请核对并更新索引。', 'upstream');
      }
      if (health.ready !== true) throw new KnowledgeError(503, 'RAG_NOT_READY', '混合检索尚未就绪，请稍后重试。', 'upstream');
      observeRag('ready');
      if (probeOnly) return json(res, 200, {
        ...pick(health, ['service', 'status', 'files', 'textFiles', 'chunks', 'fingerprint', 'ready', 'indexStale', 'apiVersion', 'uptimeSeconds']),
        requestId, adapterIndexFingerprint: fingerprint, semanticRecallGuaranteed: false, probeScope: 'snapshot-and-query-service',
      });
      const body = await upstream(`${route}${url.search}`, signal, requestId, upstreamMaxBytes);
      if (body.strategy !== strategy || body.indexFingerprint !== fingerprint
        || !Array.isArray(body.results) || body.onlineUsed !== false
        || body.results.length > (route === '/search' ? topK : 200)
        || body.returned !== body.results.length
        || !Number.isSafeInteger(body.totalCandidates) || body.totalCandidates < body.results.length
        || body.totalCandidates > files.size
        || (strategy !== 'exact' && body.totalCandidates !== files.size)) {
        throw new KnowledgeError(502, 'UPSTREAM_INVALID_RESPONSE', '混合检索返回范围与请求不一致。', 'upstream');
      }
      if (route === '/answer') {
        if (!['answered', 'clarify', 'insufficient_evidence'].includes(body.status) || !Array.isArray(body.citations)
          || body.citations.length > 200 || !Array.isArray(body.claims) || typeof body.answer !== 'string') throw new Error('invalid answer');
        if (body.status === 'answered' && (!body.citations.length || body.evidenceSufficient !== true
          || body.generationModelUsed !== false || body.answerType !== 'extractive')) throw new Error('unsupported answer');
        if (body.status === 'answered') verifyExtractiveAnswer(body);
        if (body.status !== 'answered' && (body.citations.length || body.claims.length || body.results.length
          || body.evidenceSufficient !== false || body.conditions?.length)) throw new Error('unverified answer');
      } else if (new Set(body.results.map((entry) => entry.id)).size !== body.results.length) {
        throw new KnowledgeError(502, 'UPSTREAM_INVALID_RESPONSE', '混合检索返回了重复资料。', 'upstream');
      }
      const verified = new Map();
      let verifiedSize = 0;
      async function verifyResult(result) {
        assertActive(signal);
        const doc = files.get(result?.id);
        if (!doc || doc.path !== result.path || doc.sha256 !== result.sha256) throw stale();
        const textual = textExtensions.has(path.extname(doc.path).toLowerCase());
        if (!textual && route === '/answer') {
          throw new KnowledgeError(502, 'UPSTREAM_INVALID_RESPONSE', '图片路径不能作为文字回答的事实依据。', 'upstream');
        }
        let bytes = verified.get(doc.id);
        if (!bytes) {
          if (verifiedSize + doc.bytes > MAX_DOCUMENT_BYTES) {
            throw new KnowledgeError(413, 'EVIDENCE_TOO_LARGE', '本次来源资料超过核验上限，请缩小问题范围。');
          }
          bytes = await verifiedBytes(doc, signal);
          verified.set(doc.id, bytes);
          verifiedSize += bytes.length;
        }
        if (textual) verifyPassage(result, bytes, route === '/answer' || strategy === 'exact');
        else if (result.start !== 0 || result.end !== 0 || result.preview !== (strategy === 'exact' ? '' : doc.path)) throw stale();
        return {
          ...pick(result, ['score', 'denseScore', 'lexicalScore', 'entities', 'preview', 'chunkId',
            'start', 'end', 'line', 'lineEnd', 'section', 'number', 'citationId', 'offsetEncoding', 'newlineMode']),
          ...publicEntry(doc), textIndexed: textual, imageContentAnalyzed: false, documentUrl: `/document?id=${doc.id}`,
        };
      }
      const results = [];
      const citations = [];
      for (const result of body.results) results.push(await verifyResult(result));
      for (const citation of body.citations ?? []) citations.push(await verifyResult(citation));
      assertActive(signal);
      observeRag('ready');
      return json(res, 200, {
        ...pick(body, ['query', 'strategy', 'analysis', 'totalCandidates', 'returned', 'latencyMs', 'model', 'indexFingerprint',
          'evidenceSufficient', 'schemaVersion', 'status', 'reasonCode', 'answerType', 'answer', 'abstained', 'claims',
          'conditions', 'dataAsOf', 'clarification', 'warnings', 'generationModelUsed', 'sourceKind', 'missingFields', 'applicableTo']),
        onlineUsed: false, semanticRecallGuaranteed: false, answerCorrectnessGuaranteed: false,
        results, ...(route === '/answer' ? { citations } : {}),
        requestId, source: SOURCE, retrievalScope: 'all-indexed-documents', scannedLocalFiles: files.size, items: results,
        ...(route === '/search' ? {
          resultWindow: { maximumTopK: 50, returned: results.length, paginationSupported: false, exhaustive: false },
        } : {}),
        proxy: { maxConcurrent: ragLimit, timeoutMs: requestTimeoutMs, maxUpstreamBytes: upstreamMaxBytes },
      });
    } catch (error) {
      const safe = signal.aborted ? signal.reason : error instanceof KnowledgeError ? error
        : new KnowledgeError(503, 'UPSTREAM_UNAVAILABLE', '本地混合检索暂时不可用，请稍后重试。', 'upstream');
      // A caller disconnect is not evidence that the upstream itself is broken.
      if (safe.code !== 'CLIENT_CANCELLED') observeRag(safe.status === 409 ? 'mismatch' : 'unavailable', safe.code);
      throw safe;
    } finally {
      if (probeOnly) ragProbes--; else ragActive--;
    }
  }

  const server = http.createServer({
    requestTimeout: requestTimeoutMs, headersTimeout: Math.min(10000, requestTimeoutMs),
    keepAliveTimeout: 5000, maxHeaderSize: MAX_HEADER_BYTES,
  }, async (req, res) => {
    const incoming = req.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', requestId);
    const cancel = new AbortController();
    const isRag = req.url?.startsWith('/rag/');
    const timer = setTimeout(() => {
      const error = new KnowledgeError(504, isRag ? 'UPSTREAM_TIMEOUT' : 'REQUEST_TIMEOUT', '读取或检索超时，请稍后重试。');
      metrics.timedOut++;
      cancel.abort(error);
      res.setHeader('retry-after', '1');
      json(res, 504, failure(error, requestId));
    }, requestTimeoutMs);
    const onClose = () => {
      if (!res.writableEnded && !cancel.signal.aborted) {
        metrics.cancelled++;
        cancel.abort(new KnowledgeError(499, 'CLIENT_CANCELLED', '请求已取消。', 'request'));
      }
    };
    res.once('close', onClose);
    let localSlot = false;
    try {
      if (Buffer.byteLength(req.url ?? '') > MAX_URL_BYTES) throw new KnowledgeError(414, 'REQUEST_TOO_LARGE', '请求地址过长。', 'request');
      if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) {
        res.shouldKeepAlive = false;
        throw badRequest('读取请求不能包含正文。');
      }
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET');
        throw new KnowledgeError(405, 'METHOD_NOT_ALLOWED', '此服务仅支持 GET 读取请求。', 'request');
      }
      let url;
      try {
        if (!req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('#')) throw new Error('invalid target');
        decodeURIComponent(req.url);
        url = new URL(req.url, 'http://127.0.0.1');
      }
      catch { throw badRequest('请求地址无效。'); }
      if (url.pathname.startsWith('/rag/')) {
        await checkRoot();
        assertActive(cancel.signal);
        return await proxyRag(res, url, cancel.signal, requestId);
      }
      if (!['/health', '/documents', '/document', '/document/meta', '/search'].includes(url.pathname)) {
        throw new KnowledgeError(404, 'ROUTE_NOT_FOUND', '可用接口：/health、/documents、/document、/document/meta、/search。', 'request');
      }
      await checkRoot();
      assertActive(cancel.signal);
      if (url.pathname === '/health') {
        allowedParameters(url.searchParams, []);
        return json(res, 200, {
          service: 'zhixuan-local-knowledge', status: indexStale ? 'degraded' : 'ready',
          files: files.size, ...snapshot, indexStale, skippedLinks,
          capabilities: { online: false, rag: !!ragBase, search: 'literal-text-and-path' },
          rag: { configured: !!ragBase, ...ragObservation, healthEndpoint: '/rag/health', searchEndpoint: '/rag/search', answerEndpoint: '/rag/answer' },
          limits: { requestTimeoutMs, maxConcurrentLocal: localLimit, maxConcurrentRag: ragLimit,
            maxConcurrentRagProbes: 1, maxUrlBytes: MAX_URL_BYTES, maxHeaderBytes: MAX_HEADER_BYTES, maxJsonBytes: MAX_JSON_BYTES,
            maxUpstreamBytes: upstreamMaxBytes, maxHealthBytes: MAX_HEALTH_BYTES, maxDocumentBytes: MAX_DOCUMENT_BYTES,
            maxEvidenceBytes: MAX_DOCUMENT_BYTES },
          runtime: { ...metrics, activeLocal: localActive, activeRag: ragActive, activeRagProbes: ragProbes },
        });
      }
      if (localActive >= localLimit) {
        metrics.busy++;
        throw new KnowledgeError(503, 'BUSY', '读取繁忙，请稍后重试。');
      }
      localActive++;
      localSlot = true;
      if (url.pathname === '/documents') {
        allowedParameters(url.searchParams, ['limit', 'offset']);
        const limit = url.searchParams.has('limit') ? integerParameter(url.searchParams, 'limit', 40, 200) : Math.max(files.size, 1);
        const offset = integerParameter(url.searchParams, 'offset', 0, Number.MAX_SAFE_INTEGER);
        const items = [...files.values()].slice(offset, offset + limit).map(publicEntry);
        const hasMore = offset + items.length < files.size;
        return json(res, 200, { ...snapshot, indexStale, total: files.size, offset, limit,
          hasMore, nextOffset: hasMore ? offset + items.length : null, items });
      }
      if (url.pathname === '/document' || url.pathname === '/document/meta') {
        allowedParameters(url.searchParams, ['id']);
        const id = parameter(url.searchParams, 'id', '');
        if (!id) throw badRequest('请提供资料编号 id。');
        const doc = /^[a-f0-9]{24}$/.test(id) ? files.get(id) : undefined;
        if (!doc) throw new KnowledgeError(404, 'DOCUMENT_NOT_FOUND', '文档不存在，请从 /documents 获取资料编号。', 'request');
        // Validate the complete read before sending success headers.
        const bytes = await verifiedBytes(doc, cancel.signal);
        assertActive(cancel.signal);
        if (url.pathname === '/document/meta') {
          return json(res, 200, { ...snapshot, indexStale, requestId, item: publicEntry(doc) });
        }
        if (res.destroyed) return;
        res.writeHead(200, {
          ...headers, 'content-type': types[path.extname(doc.path).toLowerCase()] || 'application/octet-stream',
          'content-length': bytes.length,
        });
        return res.end(bytes);
      }
      const params = url.searchParams;
      allowedParameters(params, ['mode', 'q', 'limit', 'offset']);
      const mode = parameter(params, 'mode', 'local');
      if (mode === 'online') {
        return json(res, 200, {
          ...snapshot, items: [], total: 0, onlineMatches: 0,
          onlineError: { code: 'ONLINE_UNSUPPORTED', kind: 'unsupported', message: '此服务仅支持本地知识库，未连接 ima 在线 API。' },
        });
      }
      if (mode !== 'local') throw badRequest('mode 仅支持 local；此服务没有在线搜索能力。');
      const query = parameter(params, 'q', '').trim();
      if (!query || Array.from(query).length > 200 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(query)) {
        throw badRequest('搜索内容不能为空、不能超过 200 个字符或包含无效控制字符。');
      }
      // Preserve complete literal results by default. Pagination is explicit.
      const limit = params.has('limit') ? integerParameter(params, 'limit', 40, 200) : Math.max(files.size, 1);
      const offset = integerParameter(params, 'offset', 0, Number.MAX_SAFE_INTEGER);
      if (indexStale) throw stale();
      const terms = normalize(query).split(/\s+/);
      const matches = [];
      for (const doc of files.values()) {
        if (!terms.every((term) => doc.searchPath.includes(term) || doc.searchText.includes(term))) continue;
        const fields = [];
        if (terms.some((term) => doc.searchPath.includes(term))) fields.push('path');
        if (terms.some((term) => doc.searchText.includes(term))) fields.push('content');
        const score = terms.reduce((sum, term) => sum + (doc.searchPath.includes(term) ? 2 : 0) + (doc.searchText.includes(term) ? 1 : 0), 0);
        matches.push({ doc, fields, score });
      }
      matches.sort((a, b) => b.score - a.score || compare(a.doc.path, b.doc.path));
      const page = matches.slice(offset, offset + limit);
      // Search uses a startup snapshot, but every returned file is re-read and
      // checked. New/changed files require a restart to rebuild that snapshot.
      for (const { doc } of page) await verifiedBytes(doc, cancel.signal);
      assertActive(cancel.signal);
      const hasMore = offset + page.length < matches.length;
      return json(res, 200, {
        ...snapshot, searchType: 'literal-text-and-path', total: matches.length,
        offset, limit, hasMore, nextOffset: hasMore ? offset + page.length : null,
        items: page.map(({ doc, fields }) => ({ ...publicEntry(doc), matches: fields })),
      });
    } catch (error) {
      const safe = cancel.signal.aborted ? cancel.signal.reason : error instanceof KnowledgeError ? error
        : new KnowledgeError(500, 'READ_FAILED', '本地资料读取失败，请稍后重试。');
      if (safe.status === 499 || res.writableEnded || res.destroyed) return;
      if ([429, 503, 504].includes(safe.status)) res.setHeader('retry-after', '1');
      json(res, safe.status, failure(safe, requestId));
    } finally {
      clearTimeout(timer);
      res.off('close', onClose);
      if (localSlot) localActive--;
      metrics.completed++;
      if (res.statusCode >= 400) metrics.failed++;
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  // Do not print the root, environment, request content or upstream credentials.
  console.log(`本地只读知识库已就绪：${files.size} 个文件，端口 ${port}；仅本地搜索。`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.close();
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 5000).unref();
    });
  }
}

try { await start(); }
catch (error) {
  const message = error.code === 'EADDRINUSE' ? '端口已被占用，请使用现有服务或设置其他端口。'
    : error instanceof KnowledgeError ? error.message : '服务启动失败，请检查目录权限和端口设置。';
  console.error(`知识库服务启动失败：${message}`);
  process.exitCode = 1;
}
