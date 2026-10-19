import type { SessionView } from '../../lib/store.ts';
import type { ConsultAnswer, ConsultMessage } from '../../lib/consult.ts';
import type { RetrievalSummary } from '../../lib/retrieval.ts';
import { parseAgentRun, type AgentRun } from '../../lib/agent-stream.ts';

export const STUDIO_SESSION_KEY = 'zhixuan.studio.sid.v1';
export const CONSULT_SESSION_KEY = 'zhixuan.consult.v1';
export const CONSULT_ID_KEY = 'zhixuan.consult.sid.v1';
export const CONSULT_MAX_TURNS = 12;
export const CONSULT_MAX_CHARS = 180_000;
export const CONSULT_RETRIEVAL_MAX_CHARS = 60_000;
export type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type ConsultTurn = { question: string; answer?: ConsultAnswer };
export type SavedAgentMessage = {
  role: 'user' | 'assistant';
  text: string;
  kind?: 'clarify' | 'notice' | 'error' | 'agent';
  options?: string[];
};
export type RestoredAgentSession = {
  run?: AgentRun;
  view: SessionView;
  messages: SavedAgentMessage[];
  busy: boolean;
  interrupted: boolean;
  updatedAt: string;
};

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function text(value: unknown, max = 2000): value is string {
  return typeof value === 'string' && value.length <= max;
}
function strings(value: unknown, count: number, chars: number): value is string[] {
  return Array.isArray(value) && value.length <= count && value.every((v) => text(v, chars));
}

export function browserStorage(): StorageAccess | undefined {
  try { return window.localStorage; } catch { return undefined; }
}
export function readStorage(storage: StorageAccess | undefined, key: string) {
  try { return { value: storage?.getItem(key) ?? null, available: !!storage }; }
  catch { return { value: null, available: false }; }
}
export function writeStorage(storage: StorageAccess | undefined, key: string, value: string | null): boolean {
  try {
    if (!storage) return false;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
    return true;
  } catch { return false; }
}
export function newStudioId(): string {
  return `s-${globalThis.crypto.randomUUID()}`;
}
export function validStudioId(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]{6,64}$/.test(value);
}

/** Reject incomplete snapshots instead of enabling edits against an unknown session. */
export function parseAgentSession(value: unknown): RestoredAgentSession {
  const data = object(value);
  const view = object(data.view);
  if (!Array.isArray(view.evidence) || !Array.isArray(view.images)
    || !Array.isArray(data.messages) || typeof data.busy !== 'boolean'
    || typeof data.interrupted !== 'boolean' || !text(data.updatedAt, 100)) {
    throw new Error('恢复内容不完整，请重试。');
  }
  const messages = data.messages.map((value): SavedAgentMessage => {
    const m = object(value);
    if ((m.role !== 'user' && m.role !== 'assistant') || !text(m.text, 100_000)
      || (m.kind !== undefined && !['clarify', 'notice', 'error', 'agent'].includes(String(m.kind)))
      || (m.options !== undefined && !strings(m.options, 30, 2000))) {
      throw new Error('恢复对话不完整，请重试。');
    }
    return {
      role: m.role, text: m.text, kind: m.kind as SavedAgentMessage['kind'],
      ...(m.options ? { options: m.options as string[] } : {}),
    };
  });
  // Draft/report are supplied by the same server contract as the existing stream.
  return { view: view as unknown as SessionView, messages, busy: data.busy,
    interrupted: data.interrupted, updatedAt: data.updatedAt,
    ...(parseAgentRun(data.run) ? { run: parseAgentRun(data.run) } : {}) };
}

/** Keep retrieval bounded and links tied to the same local document identifier. */
function parseRetrieval(value: unknown): RetrievalSummary | null {
  const r = object(value);
  if ((r.status !== 'ready' && r.status !== 'unavailable')
    || r.source !== '本地已下载知识库' || r.scope !== 'all-indexed-documents'
    || !text(r.query, 2000) || !text(r.message, 2000) || !r.message.trim()
    || r.maximumResults !== 50 || r.exhaustive !== false
    || !Number.isSafeInteger(r.returned) || (r.returned as number) < 0 || (r.returned as number) > 50
    || (r.scannedFiles !== undefined && (!Number.isSafeInteger(r.scannedFiles) || (r.scannedFiles as number) < 0))
    || !Array.isArray(r.items) || r.items.length !== r.returned
    || (r.status === 'unavailable' && r.returned !== 0)) return null;
  const items: RetrievalSummary['items'] = [];
  for (const value of r.items) {
    const item = object(value);
    if (!text(item.id, 24) || item.id.length !== 24 || !/^[a-f0-9]{24}$/.test(item.id)
      || !text(item.title, 1000) || !item.title.trim()
      || !text(item.path, 2000) || !text(item.preview, 16_000)
      || item.documentUrl !== `/api/knowledge/document?id=${item.id}`
      || (item.score !== undefined && (typeof item.score !== 'number' || !Number.isFinite(item.score)))) return null;
    const excerpt = (value: string, max: number) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
    items.push({
      id: item.id, title: excerpt(item.title, 500), path: excerpt(item.path, 1000), preview: excerpt(item.preview, 800),
      documentUrl: item.documentUrl,
      ...(item.score !== undefined ? { score: item.score as number } : {}),
    });
  }
  const clean: RetrievalSummary = {
    status: r.status, source: r.source, scope: r.scope, query: r.query,
    returned: r.returned as number, maximumResults: 50, exhaustive: false,
    message: r.message, items,
    ...(r.scannedFiles !== undefined ? { scannedFiles: r.scannedFiles as number } : {}),
  };
  return JSON.stringify(clean).length <= CONSULT_RETRIEVAL_MAX_CHARS ? clean : null;
}

function unavailableRetrieval(): RetrievalSummary {
  return {
    status: 'unavailable', source: '本地已下载知识库', scope: 'all-indexed-documents',
    query: '', returned: 0, maximumResults: 50, exhaustive: false, items: [],
    message: '检索信息未通过校验或内容过大，暂时无法展示。可继续咨询或稍后重试。',
  };
}

/** Whitelist fields so saved consultation data cannot accidentally include settings or keys. */
export function parseConsultAnswer(value: unknown): ConsultAnswer | null {
  const a = object(value);
  if (!text(a.reply, 12_000) || !a.reply.trim()
    || !Array.isArray(a.recommendations) || a.recommendations.length > 20
    || !Array.isArray(a.evidence) || a.evidence.length > 160
    || (a.questions !== undefined && !strings(a.questions, 12, 2000))) return null;
  const recommendations: ConsultAnswer['recommendations'] = [];
  for (const value of a.recommendations) {
    const r = object(value);
    if (!['modelId', 'modelName', 'system', 'reason', 'tradeoff'].every((key) => text(r[key], 4000))
      || !strings(r.evidenceIds, 160, 200)
      || (r.creativeModelId !== undefined && !text(r.creativeModelId, 100))) return null;
    recommendations.push({
      modelId: r.modelId as string, modelName: r.modelName as string, system: r.system as string,
      reason: r.reason as string, tradeoff: r.tradeoff as string, evidenceIds: r.evidenceIds,
      ...(r.creativeModelId ? { creativeModelId: r.creativeModelId as string } : {}),
    });
  }
  const evidence: ConsultAnswer['evidence'] = [];
  for (const value of a.evidence) {
    const e = object(value);
    if (!['id', 'docId', 'docTitle', 'docPath', 'section', 'text', 'source', 'readAt']
      .every((key) => text(e[key], key === 'text' ? 12_000 : 2000))
      || !['fact', 'limit', 'price', 'scene', 'rule'].includes(String(e.kind))
      || !Number.isSafeInteger(e.line) || (e.line as number) < 0) return null;
    evidence.push({
      id: e.id as string, docId: e.docId as string, docTitle: e.docTitle as string,
      docPath: e.docPath as string, section: e.section as string, text: e.text as string,
      source: e.source as ConsultAnswer['evidence'][number]['source'],
      readAt: e.readAt as string, line: e.line as number,
      kind: e.kind as ConsultAnswer['evidence'][number]['kind'],
    });
  }
  return { reply: a.reply, recommendations, evidence,
    ...(a.retrieval !== undefined ? { retrieval: parseRetrieval(a.retrieval) ?? unavailableRetrieval() } : {}),
    ...(a.questions ? { questions: a.questions as string[] } : {}) };
}

export function encodeConsultSession(turns: ConsultTurn[]): string {
  const clean = turns.slice(-CONSULT_MAX_TURNS).flatMap((turn): ConsultTurn[] => {
    if (!text(turn.question) || !turn.question.trim()) return [];
    const answer = turn.answer ? parseConsultAnswer(turn.answer) : null;
    return [{ question: turn.question, ...(answer ? { answer } : {}) }];
  });
  // An oversized individual answer is omitted; retain its question for an explicit retry.
  for (;;) {
    const encoded = JSON.stringify({ version: 1, turns: clean });
    if (encoded.length <= CONSULT_MAX_CHARS) return encoded;
    if (clean.length > 1) clean.shift();
    else delete clean[0].answer;
  }
}
export function decodeConsultSession(raw: string | null): { turns: ConsultTurn[]; invalid: boolean } {
  if (raw === null) return { turns: [], invalid: false };
  try {
    if (raw.length > CONSULT_MAX_CHARS) throw new Error('size');
    const data = object(JSON.parse(raw));
    if (data.version !== 1 || !Array.isArray(data.turns) || data.turns.length > CONSULT_MAX_TURNS) throw new Error('version');
    const turns = data.turns.map((value): ConsultTurn => {
      const t = object(value);
      if (!text(t.question) || !t.question.trim()) throw new Error('question');
      const answer = t.answer === undefined ? undefined : parseConsultAnswer(t.answer);
      if (answer === null) throw new Error('answer');
      return { question: t.question, ...(answer ? { answer } : {}) };
    });
    return { turns, invalid: false };
  } catch { return { turns: [], invalid: true }; }
}
export function consultHistory(turns: ConsultTurn[]): ConsultMessage[] {
  return turns.flatMap((turn): ConsultMessage[] => turn.answer ? [
    { role: 'user', content: turn.question },
    { role: 'assistant', content: turn.answer.reply.slice(0, 2000) },
  ] : []).slice(-24);
}

/** Server snapshot is authoritative; sanitize answers with the same display whitelist. */
export function parseConsultSnapshot(value: unknown): {
  turns: ConsultTurn[]; busy: boolean; interrupted: boolean; updatedAt: string; run?: AgentRun; error?: string;
} {
  const data = object(value);
  if (!Array.isArray(data.turns) || data.turns.length > CONSULT_MAX_TURNS
    || typeof data.busy !== 'boolean' || typeof data.interrupted !== 'boolean'
    || !text(data.updatedAt, 100) || (data.error !== undefined && !text(data.error, 4000))) {
    throw new Error('咨询记录不完整，请重试恢复。');
  }
  const turns = data.turns.map((value): ConsultTurn => {
    const turn = object(value);
    if (!text(turn.question) || !turn.question.trim()) throw new Error('咨询问题无法读取，请重试恢复。');
    const answer = turn.answer === undefined ? undefined : parseConsultAnswer(turn.answer);
    if (answer === null) throw new Error('咨询回复不完整，请重试恢复。');
    return { question: turn.question, ...(answer ? { answer } : {}) };
  });
  const run = parseAgentRun(data.run);
  return { turns, busy: data.busy, interrupted: data.interrupted, updatedAt: data.updatedAt,
    ...(run ? { run } : {}), ...(data.error ? { error: data.error as string } : {}) };
}

export function consultRunText(run: AgentRun): string {
  if (run.status === 'running') return run.cancelRequested ? '正在停止咨询，请等待确认' : run.phase || '正在处理咨询';
  return {
    completed: '本次咨询已结束',
    failed: '本次咨询未完成，可补充需求或重试',
    cancelled: '咨询已停止，已保留收到的回复',
    timed_out: '咨询等待超时，可稍后重试',
    interrupted: '咨询已中断，可稍后重试',
  }[run.status];
}

/** Cancellation isolates late responses when the user starts a different session. */
export class SessionEpoch {
  private epoch = 0;
  private controller: AbortController | undefined;
  start() {
    this.controller?.abort();
    this.controller = new AbortController();
    const epoch = ++this.epoch;
    return { signal: this.controller.signal, current: () => epoch === this.epoch && !this.controller?.signal.aborted };
  }
  cancel() {
    ++this.epoch;
    this.controller?.abort();
  }
}
