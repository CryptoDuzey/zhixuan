// ima 客户端：在线/本地分源、配额识别、缓存、调用留痕。不接触任何密钥（服务端持有）。
import { AsyncLocalStorage } from 'node:async_hooks';
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
let localIndex: LocalDoc[] | null = null;
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
      const r = await fetch(url, { cache: 'no-store', signal: requestSignal() });
      const t = await r.text();
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

export async function loadLocalIndex(): Promise<LocalDoc[]> {
  throwIfStopped();
  if (localIndex?.length) {
    log({ op: 'documents', target: '/documents', ok: localIndexOk, source: '本地已下载知识库', cacheHit: true, note: `${localIndex.length} 项（缓存命中，未发起 HTTP 请求）` });
    return localIndex;
  }
  try {
    const { status, json } = await getJson(`${BASE}/documents`);
    const items: any[] = json?.items ?? [];
    localIndex = items.map((x) => ({
      id: x.id,
      title: x.title,
      path: String(x.path).split(BACKSLASH).join('/'),
      bytes: x.bytes,
      sha256: x.sha256,
    }));
    localIndexOk = status >= 200 && status < 300 && localIndex.length > 0;
    log({ op: 'documents', target: '/documents', ok: localIndexOk, source: '本地已下载知识库', note: `${localIndex.length} 项` });
    return localIndex;
  } catch (e) {
    log({ op: 'documents', target: '/documents', ok: false, source: '本地已下载知识库', note: String(e instanceof Error ? e.message : e) });
    throw e;
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

async function readRaw(id: string, source: SourceKind, label: string, op: 'read' | 'image'): Promise<ReadResult> {
  const cacheKey = `${source}|${id}`;
  const hit = readCache.get(cacheKey);
  if (hit?.ok) {
    log({ op, target: label, ok: true, source, bytes: hit.bytes?.length, cacheHit: true, note: '缓存命中，未发起 HTTP 读取' });
    return hit;
  }
  const readAt = new Date().toISOString();
  try {
    throwIfStopped();
    const r = await fetch(`${BASE}/document?id=${encodeURIComponent(id)}`, { cache: 'no-store', signal: requestSignal() });
    const buf = Buffer.from(await r.arrayBuffer());
    throwIfStopped();
    const err = detectQuota(r.status, buf);
    if (err || !r.ok) {
      if (err?.kind === 'daily_quota' || err?.code === 220021) quotaExhausted = true;
      log({ op, target: label, ok: false, source, note: err ? `${err.kind ?? ''} ${err.code ?? ''}`.trim() : `HTTP ${r.status}` });
      return { ok: false, source, readAt, error: err ?? { message: `HTTP ${r.status}` } };
    }
    const res: ReadResult = { ok: true, source, readAt, bytes: buf, text: op === 'read' ? buf.toString('utf8') : undefined };
    readCache.set(cacheKey, res);
    log({ op, target: label, ok: true, source, bytes: buf.length });
    return res;
  } catch (e: any) {
    throwIfStopped();
    log({ op, target: label, ok: false, source, note: String(e?.message ?? e) });
    return { ok: false, source, readAt, error: { message: String(e?.message ?? e) } };
  }
}

export const readLocalText = (doc: LocalDoc) => readRaw(doc.id, '本地已下载知识库', doc.path, 'read');
export const readLocalImage = (doc: LocalDoc) => readRaw(doc.id, '本地已下载知识库', doc.path, 'image');

/** 在线读取：配额耗尽后不再尝试，调用方降级到本地并如实标注。 */
export async function readOnline(onlineId: string, label: string, op: 'read' | 'image' = 'read'): Promise<ReadResult> {
  if (quotaExhausted) {
    log({ op, target: label, ok: false, source: 'ima 在线 API', note: '已知当日额度耗尽，跳过' });
    return { ok: false, source: 'ima 在线 API', readAt: new Date().toISOString(), error: { kind: 'daily_quota', code: 220021, message: '当日在线读取额度已用尽' } };
  }
  return readRaw(onlineId, 'ima 在线 API', label, op);
}

export function localImageUrl(docId: string) {
  return `/api/image?id=${encodeURIComponent(docId)}`;
}
