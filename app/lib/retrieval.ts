import { createHash } from 'node:crypto';
import { reportTool, runSignal, throwIfStopped } from './agent-runtime.ts';

export interface RetrievalSummary {
  status: 'ready' | 'unavailable';
  source: '本地已下载知识库';
  scope: 'all-indexed-documents';
  query: string;
  scannedFiles?: number;
  returned: number;
  maximumResults: 50;
  exhaustive: false;
  message: string;
  items: Array<{
    id: string;
    title: string;
    path: string;
    preview: string;
    documentUrl: string;
    score?: number;
  }>;
}

interface RetrievalTransport {
  base?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const SOURCE = '本地已下载知识库' as const;
const ID = /^[a-f0-9]{24}$/;
const TEXT = /\.(md|markdown|txt|csv|json)$/i;
const IMAGE = /\.(png|jpe?g|webp|gif|bmp|svg|avif|heic)$/i;
const MAX_BYTES = 2 * 1024 * 1024;
const safePath = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 1000 && !value.startsWith('/')
  && !/[\\:\x00-\x1f]/.test(value) && !value.split('/').some((part) => part === '..' || part === '.');
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

async function bytes(response: Response): Promise<Buffer> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Unavailable response');
  const reader = response.body.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > MAX_BYTES) {
        await reader.cancel();
        throw new Error('Response too large');
      }
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}

function transport(options: RetrievalTransport) {
  const base = (options.base ?? process.env.IMA_BASE ?? 'http://127.0.0.1:8765').replace(/\/$/, '');
  const parent = runSignal();
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 17000);
  const signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
  const request = options.fetch ?? fetch;
  return async (path: string) => {
    throwIfStopped();
    const response = await request(`${base}${path}`, {
      signal, cache: 'no-store', redirect: 'error',
    });
    if (response.status === 404 && path.startsWith('/document')) {
      throw new KnowledgeDocumentError(404, '未找到可查看的文字资料。');
    }
    const result = await bytes(response);
    throwIfStopped();
    return result;
  };
}

export function unavailableRetrieval(query: string): RetrievalSummary {
  return {
    status: 'unavailable', source: SOURCE, scope: 'all-indexed-documents',
    query, returned: 0, maximumResults: 50, exhaustive: false, items: [],
    message: '整库混合检索暂时不可用。本次仅依据已读取的产品目录和对应资料回答，不能视为已完成整库搜索。',
  };
}

/** The adapter verifies the corpus fingerprint and every returned original passage. */
export async function retrieveKnowledge(query: string, options: RetrievalTransport = {}): Promise<RetrievalSummary> {
  query = Array.from(query.trim()).slice(0, 1000).join('');
  if (!query) return unavailableRetrieval(query);
  const started = Date.now();
  reportTool({ type: 'tool', tool: 'knowledge', status: 'started', label: '检索相关知识库资料' });
  try {
    const get = transport(options);
    const body = object(JSON.parse((await get(`/rag/search?strategy=hybrid&top_k=50&q=${encodeURIComponent(query)}`)).toString('utf8')));
    if (body.source !== SOURCE || body.retrievalScope !== 'all-indexed-documents'
      || body.onlineUsed !== false || body.strategy !== 'hybrid'
      || !Number.isSafeInteger(body.scannedLocalFiles) || Number(body.scannedLocalFiles) < 1
      || !/^[a-f0-9]{64}$/.test(String(body.indexFingerprint))
      || !Array.isArray(body.items) || body.items.length > 50) throw new Error('Invalid retrieval');
    const items = body.items.map((value) => {
      const item = object(value);
      if (typeof item.id !== 'string' || !ID.test(item.id) || !safePath(item.path) || !(TEXT.test(item.path) || IMAGE.test(item.path))
        || typeof item.title !== 'string' || item.title.length > 1000
        || typeof item.preview !== 'string' || item.preview.length > 16000
        || !/^[a-f0-9]{64}$/.test(String(item.sha256))) throw new Error('Invalid passage');
      return {
        id: item.id, title: item.title, path: item.path, preview: item.preview,
        documentUrl: `/api/knowledge/document?id=${item.id}`,
        ...(typeof item.score === 'number' && Number.isFinite(item.score) ? { score: item.score } : {}),
      };
    }).filter((item) => TEXT.test(item.path));
    reportTool({ type: 'tool', tool: 'knowledge', status: 'completed', label: '检索相关知识库资料', ms: Date.now() - started });
    return {
      status: 'ready', source: SOURCE, scope: 'all-indexed-documents', query,
      scannedFiles: Number(body.scannedLocalFiles), returned: items.length,
      maximumResults: 50, exhaustive: false, items,
      message: `已检索当前索引覆盖的 ${body.scannedLocalFiles} 份本地资料，返回 ${items.length} 个相关片段；最多展示 50 个片段，不代表全部匹配或在售范围。`,
    };
  } catch {
    throwIfStopped();
    reportTool({ type: 'tool', tool: 'knowledge', status: 'failed', label: '整库检索暂不可用', ms: Date.now() - started });
    return unavailableRetrieval(query);
  }
}

export class KnowledgeDocumentError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Accept registered document IDs only; serve verified original text with no executable HTML. */
export async function readKnowledgeDocument(id: string, options: RetrievalTransport = {}): Promise<string> {
  if (!ID.test(id)) throw new KnowledgeDocumentError(400, '资料编号无效。');
  try {
    const get = transport(options);
    const metadata = object(JSON.parse((await get(`/document/meta?id=${id}`)).toString('utf8')));
    if (metadata.source !== SOURCE || metadata.indexStale === true
      || !/^[a-f0-9]{64}$/.test(String(metadata.indexFingerprint))) throw new Error('Invalid metadata');
    const doc = object(metadata.item);
    if (doc.id !== id || !safePath(doc.path) || !TEXT.test(doc.path)) throw new KnowledgeDocumentError(404, '未找到可查看的文字资料。');
    if (!/^[a-f0-9]{64}$/.test(String(doc.sha256))) throw new Error('Invalid hash');
    const original = await get(`/document?id=${id}`);
    if (createHash('sha256').update(original).digest('hex') !== doc.sha256) throw new KnowledgeDocumentError(409, '资料已发生变化，请更新知识库索引后重试。');
    return original.toString('utf8');
  } catch (error) {
    throwIfStopped();
    if (error instanceof KnowledgeDocumentError) throw error;
    throw new KnowledgeDocumentError(503, '资料暂时无法读取，请稍后重试。');
  }
}
