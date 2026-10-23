// ima 客户端：在线/本地分源、配额识别、缓存、调用留痕。不接触任何密钥（服务端持有）。
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { knowledgeReads } from './knowledge-queue.ts';
import { abortableDelay, reportTool, runSignal, throwIfStopped } from './agent-runtime.ts';

const BASE = process.env.IMA_BASE ?? 'http://127.0.0.1:8765';

export type SourceKind = 'ima 在线 API' | '本地已下载知识库';

export interface CallLog {
  at: string;
  op: 'search' | 'read' | 'image' | 'documents';
  mode?: string;
  target: string;
  ok: boolean;
  source?: SourceKind;
  bytes?: number;
  note?: string;
  /** 消费客户端缓存；不代表发起了新的 HTTP 请求。 */
  cacheHit?: boolean;
}

export interface ReadResult {
  ok: boolean;
  source: SourceKind;
  text?: string;
  bytes?: Buffer;
  readAt: string;
  error?: { code?: number; kind?: string; message?: string };
}

export interface LocalDoc {
  id: string;
  title: string;
  path: string; // 已规范为正斜杠
  bytes: number;
  sha256: string;
}

const BACKSLASH = String.fromCharCode(92);
const globalLog: CallLog[] = [];
const callScope = new AsyncLocalStorage<(entry: CallLog) => void>();
const readCache = new Map<string, ReadResult>();
const latestReads = new Map<string, object>();
let localIndex: LocalDoc[] | null = null;
let latestIndexRead: object | undefined;
let localIndexOk = false;
let quotaExhausted = false;

export function getCallLog(): CallLog[] {
  return globalLog;
}

/**
 * 只转交本次异步任务产生的记录；共享 Promise 的记录仍归其发起上下文。
 * sink 同步接收副本，异常不向外传播；持久化错误需由 sink 自行处理。
 */
export async function withCallScope<T>(sink: (entry: CallLog) => void, task: () => Promise<T>): Promise<T> {
  return callScope.run(sink, task);
}

export function isOnlineQuotaExhausted(): boolean {
  return quotaExhausted;
}
function log(e: Omit<CallLog, 'at'>) {
  throwIfStopped();
  const entry: CallLog = { at: new Date().toISOString(), ...e };
  globalLog.push(entry);
  if (globalLog.length > 500) globalLog.shift();
  try {
    // 所有字段都是标量；副本避免持久化回调改写全局记录。
    callScope.getStore()?.({ ...entry });
  } catch {
    // 回调异常不改变知识库返回结果，也不把回调中的会话信息写入全局日志。
  }
  reportTool({ type: 'tool', tool: 'knowledge', status: e.ok ? 'completed' : 'failed',
    label: e.op === 'documents' ? '载入资料目录' : e.op === 'image' ? '读取产品配图' : e.op === 'search' ? '检索产品资料' : '读取产品原文',
    cacheHit: e.cacheHit });
}

async function getJson(url: string): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    throwIfStopped();
    try {
      const signal = requestSignal();
      const { r, t } = await knowledgeReads.run(signal, async () => {
        const r = await fetch(url, { cache: 'no-store', signal });
        return { r, t: await r.text() };
      });
      throwIfStopped();
      try {
        return { status: r.status, json: JSON.parse(t) };
      } catch {
        return { status: r.status, json: null };
      }
    } catch (e) {
      throwIfStopped();
      lastErr = e;
      await abortableDelay(400 * (attempt + 1));
    }
  }
  throw lastErr;
}

function requestSignal() {
  const timeout = AbortSignal.timeout(15_000);
  const parent = runSignal();
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

export async function loadLocalIndex(options?: { refresh?: boolean }): Promise<LocalDoc[]> {
  throwIfStopped();
  if (options?.refresh) {
    localIndex = null;
    localIndexOk = false;
  }
  if (localIndex?.length) {
    log({ op: 'documents', target: '/documents', ok: localIndexOk, source: '本地已下载知识库', cacheHit: true, note: `${localIndex.length} 项（缓存命中，未发起 HTTP 请求）` });
    return localIndex;
  }
  const request = {};
  latestIndexRead = request;
  try {
    const { status, json } = await getJson(`${BASE}/documents`);
    const items: any[] = json?.items ?? [];
    if (options?.refresh && (status < 200 || status >= 300 || !Array.isArray(json?.items))) {
      throw new Error('知识库目录刷新失败，请稍后重试。');
    }
    const index = items.map((x) => ({
      id: x.id,
      title: x.title,
      path: String(x.path).split(BACKSLASH).join('/'),
      bytes: x.bytes,
      sha256: x.sha256,
    }));
    const ok = status >= 200 && status < 300 && index.length > 0;
    if (latestIndexRead === request) {
      localIndex = index;
      localIndexOk = ok;
    }
    log({ op: 'documents', target: '/documents', ok, source: '本地已下载知识库', note: `${index.length} 项` });
    return index;
  } catch (e) {
    log({ op: 'documents', target: '/documents', ok: false, source: '本地已下载知识库', note: String(e instanceof Error ? e.message : e) });
    throw e;
  } finally {
    if (latestIndexRead === request) latestIndexRead = undefined;
  }
}

export async function findLocal(...fragments: string[]): Promise<LocalDoc | undefined> {
  const idx = await loadLocalIndex();
  return idx.find((d) => fragments.every((f) => d.path.includes(f)));
}

export async function searchLocal(q: string) {
  try {
    const { status, json } = await getJson(`${BASE}/search?mode=local&q=${encodeURIComponent(q)}`);
    const ok = status >= 200 && status < 300 && !!json;
    log({ op: 'search', mode: 'local', target: q, ok, source: '本地已下载知识库', note: ok ? `${json?.total ?? 0} 条` : `HTTP ${status}` });
    return json;
  } catch (e) {
    log({ op: 'search', mode: 'local', target: q, ok: false, source: '本地已下载知识库', note: String(e instanceof Error ? e.message : e) });
    throw e;
  }
}

export async function searchOnline(q: string) {
  try {
    const { status, json } = await getJson(`${BASE}/search?mode=online&q=${encodeURIComponent(q)}`);
    const ok = status >= 200 && status < 300 && !!json && !json.onlineError;
    log({ op: 'search', mode: 'online', target: q, ok, source: 'ima 在线 API', note: ok ? `${json?.onlineMatches ?? json?.total ?? 0} 条` : JSON.stringify(json?.onlineError ?? `HTTP ${status}`).slice(0, 120) });
    return json;
  } catch (e) {
    log({ op: 'search', mode: 'online', target: q, ok: false, source: 'ima 在线 API', note: String(e instanceof Error ? e.message : e) });
    throw e;
  }
}

function detectQuota(status: number, buf: Buffer): ReadResult['error'] | undefined {
  if (buf.length > 400 || buf[0] !== 0x7b) return undefined; // 不是小的 JSON 错误体
  try {
    const j = JSON.parse(buf.toString('utf8'));
    if (j?.error) return { code: j.error.code, kind: j.error.kind, message: j.error.message };
  } catch {
    /* 非 JSON，当作正文 */
  }
  return status >= 400 ? { message: `HTTP ${status}` } : undefined;
}

async function readRaw(id: string, source: SourceKind, label: string, op: 'read' | 'image', refresh = false, fingerprint = ''): Promise<ReadResult> {
  if (source === '本地已下载知识库' && !/^[a-f0-9]{64}$/i.test(fingerprint)) {
    log({ op, target: label, ok: false, source, note: '本地资料缺少有效内容指纹，未读取' });
    return { ok: false, source, readAt: new Date().toISOString(), error: { message: '资料缺少有效文件版本，请刷新知识库后重试。' } };
  }
  const cacheKey = JSON.stringify([source, id, fingerprint]);
  if (refresh) readCache.delete(cacheKey);
  const hit = readCache.get(cacheKey);
  if (hit?.ok) {
    log({ op, target: label, ok: true, source, bytes: hit.bytes?.length, cacheHit: true, note: '缓存命中，未发起 HTTP 读取' });
    if (op === 'read' && hit.text === undefined && hit.bytes) {
      const decoded = { ...hit, text: hit.bytes.toString('utf8') };
      readCache.set(cacheKey, decoded);
      return decoded;
    }
    return hit;
  }
  const readAt = new Date().toISOString();
  const request = {};
  latestReads.set(cacheKey, request);
  try {
    throwIfStopped();
    const signal = requestSignal();
    const { r, buf } = await knowledgeReads.run(signal, async () => {
      const r = await fetch(`${BASE}/document?id=${encodeURIComponent(id)}`, { cache: 'no-store', signal });
      return { r, buf: Buffer.from(await r.arrayBuffer()) };
    });
    throwIfStopped();
    const err = detectQuota(r.status, buf);
    if (err || !r.ok) {
      if (err?.kind === 'daily_quota' || err?.code === 220021) quotaExhausted = true;
      log({ op, target: label, ok: false, source, note: err ? `${err.kind ?? ''} ${err.code ?? ''}`.trim() : `HTTP ${r.status}` });
      return { ok: false, source, readAt, error: err ?? { message: `HTTP ${r.status}` } };
    }
    if (/^[a-f0-9]{64}$/i.test(fingerprint) && createHash('sha256').update(buf).digest('hex') !== fingerprint.toLowerCase()) {
      log({ op, target: label, ok: false, source, note: '返回文件与目录内容指纹不一致，未缓存' });
      return { ok: false, source, readAt, error: { message: '资料内容已变化，请刷新后重试。' } };
    }
    const res: ReadResult = { ok: true, source, readAt, bytes: buf, text: op === 'read' ? buf.toString('utf8') : undefined };
    // A slower earlier request may still serve its caller, but cannot overwrite
    // a newer refresh (or repopulate invalidated data after that refresh fails).
    if (latestReads.get(cacheKey) === request) readCache.set(cacheKey, res);
    log({ op, target: label, ok: true, source, bytes: buf.length });
    return res;
  } catch (e: any) {
    throwIfStopped();
    log({ op, target: label, ok: false, source, note: String(e?.message ?? e) });
    return { ok: false, source, readAt, error: { message: String(e?.message ?? e) } };
  } finally {
    if (latestReads.get(cacheKey) === request) latestReads.delete(cacheKey);
  }
}

export const readLocalText = (doc: LocalDoc, options?: { refresh?: boolean }) => readRaw(doc.id, '本地已下载知识库', doc.path, 'read', options?.refresh, doc.sha256);
export const readLocalImage = (doc: LocalDoc) => readRaw(doc.id, '本地已下载知识库', doc.path, 'image', false, doc.sha256);

/** 在线读取：配额耗尽后不再尝试，调用方降级到本地并如实标注。 */
export async function readOnline(onlineId: string, label: string, op: 'read' | 'image' = 'read'): Promise<ReadResult> {
  if (quotaExhausted) {
    log({ op, target: label, ok: false, source: 'ima 在线 API', note: '已知当日额度耗尽，跳过' });
    return { ok: false, source: 'ima 在线 API', readAt: new Date().toISOString(), error: { kind: 'daily_quota', code: 220021, message: '当日在线读取额度已用尽' } };
  }
  return readRaw(onlineId, 'ima 在线 API', label, op);
}

export function localImageUrl(docId: string, sha256?: string) {
  return `/api/image?id=${encodeURIComponent(docId)}${sha256 ? `&version=${encodeURIComponent(sha256)}` : ''}`;
}
