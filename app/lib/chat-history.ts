// Read-only index over the existing authoritative files. Do not call repository.find():
// it can recover persisted busy records by writing them. No cache or secondary database.
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validSessionId } from './session-store.ts';

export type ChatKind = 'agent' | 'consult';
export interface ChatSummary {
  id: string;
  kind: ChatKind;
  title: string;
  updatedAt: string;
  /** Persisted busy flag, not a claim that an old process is still running. */
  busy: boolean;
}
export interface ChatPage { items: ChatSummary[]; nextCursor?: string }
export interface ChatHistoryQuery { kind?: ChatKind; limit?: number; cursor?: string }
export interface ChatDirectories { agent: string; consult: string }
export class ChatHistoryQueryError extends Error {
  constructor(message = '历史对话查询参数无效。') { super(message); this.name = 'ChatHistoryQueryError'; }
}
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isKind = (value: unknown): value is ChatKind => value === 'agent' || value === 'consult';
const time = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** Public query never accepts directories; these match store.ts/consult-store.ts. */
export function chatDirectories(): ChatDirectories {
  return {
    agent: process.env.ZHIXUAN_SESSION_DIR || join(process.cwd(), 'data', 'private', 'sessions'),
    consult: process.env.ZHIXUAN_CONSULT_DIR || join(process.cwd(), 'data', 'private', 'consultations'),
  };
}

export function parseChatHistoryQuery(params: URLSearchParams): ChatHistoryQuery {
  for (const key of params.keys()) {
    if (!['kind', 'limit', 'cursor'].includes(key) || params.getAll(key).length !== 1) throw new ChatHistoryQueryError();
  }
  const kind = params.get('kind');
  const limit = params.get('limit');
  const cursor = params.get('cursor');
  if (kind !== null && !isKind(kind)) throw new ChatHistoryQueryError();
  if (limit !== null && (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > MAX_LIMIT)) throw new ChatHistoryQueryError();
  if (cursor !== null && !cursor) throw new ChatHistoryQueryError('分页参数无效。');
  return { ...(kind === null ? {} : { kind }), ...(limit === null ? {} : { limit: Number(limit) }), ...(cursor === null ? {} : { cursor }) };
}

type Position = Pick<ChatSummary, 'id' | 'kind' | 'updatedAt'>;
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const compare = (a: Position, b: Position) => lexical(b.updatedAt, a.updatedAt) || lexical(a.kind, b.kind) || lexical(a.id, b.id);

function encodeCursor(row: Position, filter?: ChatKind): string {
  // Only public summary fields. Never include file names, directories or message text.
  return Buffer.from(JSON.stringify({ v: 1, filter: filter ?? null, id: row.id, kind: row.kind, updatedAt: row.updatedAt })).toString('base64url');
}
function decodeCursor(cursor: string, filter?: ChatKind): Position {
  try {
    if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const raw = Buffer.from(cursor, 'base64url');
    if (raw.toString('base64url') !== cursor) throw new Error();
    const value: unknown = JSON.parse(raw.toString('utf8'));
    if (!object(value) || value.v !== 1 || value.filter !== (filter ?? null)
      || typeof value.id !== 'string' || !validSessionId(value.id) || value.id !== value.id.toLowerCase()
      || !isKind(value.kind) || filter && filter !== value.kind || !time(value.updatedAt)
      || Object.keys(value).sort().join(',') !== 'filter,id,kind,updatedAt,v') throw new Error();
    return { id: value.id, kind: value.kind, updatedAt: value.updatedAt };
  } catch { throw new ChatHistoryQueryError('分页参数无效。'); }
}

function title(value: string | undefined, kind: ChatKind): string {
  const clean = (value ?? '')
    // User questions can contain local paths too; omit these from the list label.
    .replace(/(?:[a-z]:[\\/]|\\\\)[^\s，。；！？<>"']+/gi, '[路径]')
    .replace(/(?:file:\/\/\/|(?<![:\w])\/)[^\s，。；！？<>"']+/gi, '[路径]')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return [...clean].slice(0, 80).join('') || (kind === 'agent' ? '新创作' : '新咨询');
}

function summarize(value: unknown, id: string, kind: ChatKind): ChatSummary | undefined {
  if (!object(value) || value.schema !== 1 || !Array.isArray(value.calls)
    || typeof value.busy !== 'boolean' || typeof value.interrupted !== 'boolean' || !time(value.updatedAt)) return;
  let question: string | undefined;
  if (kind === 'agent') {
    if (!object(value.session) || typeof value.session.modelId !== 'string' || typeof value.session.modelName !== 'string'
      || !Array.isArray(value.messages) || !value.messages.every(message => object(message)
        && ['user', 'assistant'].includes(String(message.role)) && typeof message.text === 'string')) return;
    question = value.messages.find(message => message.role === 'user' && message.text.trim())?.text;
  } else {
    if (!Array.isArray(value.turns) || !value.turns.every(turn => object(turn) && typeof turn.question === 'string'
      && (turn.answer === undefined || object(turn.answer) && typeof turn.answer.reply === 'string'
        && Array.isArray(turn.answer.recommendations) && Array.isArray(turn.answer.evidence)
        && (turn.answer.questions === undefined || Array.isArray(turn.answer.questions) && turn.answer.questions.every(q => typeof q === 'string'))))
      || !value.calls.every(call => object(call) && typeof call.at === 'string'
        && ['search', 'read', 'image', 'documents'].includes(String(call.op)) && typeof call.target === 'string' && typeof call.ok === 'boolean')
      || value.error !== undefined && typeof value.error !== 'string') return;
    if (value.run !== undefined && (!object(value.run) || typeof value.run.id !== 'string'
      || !['running', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(String(value.run.status))
      || typeof value.run.phase !== 'string' || typeof value.run.startedAt !== 'string' || typeof value.run.updatedAt !== 'string'
      || value.run.endedAt !== undefined && typeof value.run.endedAt !== 'string'
      || !Number.isSafeInteger(value.run.sequence) || Number(value.run.sequence) < 0 || typeof value.run.cancelRequested !== 'boolean')) return;
    question = value.turns.find(turn => turn.question.trim())?.question;
  }
  return { id, kind, title: title(question, kind), updatedAt: value.updatedAt, busy: value.busy };
}

async function readSummaries(directory: string, kind: ChatKind): Promise<ChatSummary[]> {
  try {
    // Do not follow a linked private directory or any linked record file.
    const stat = await lstat(directory);
    if (stat.isSymbolicLink()) return [];
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const entries = await readdir(directory, { withFileTypes: true });
  // Stable canonical casing on Windows. When a case-sensitive filesystem has
  // colliding names, the repository's lowercase file takes precedence.
  entries.sort((a, b) => Number(b.name === b.name.toLowerCase()) - Number(a.name === a.name.toLowerCase()) || lexical(a.name, b.name));
  const seen = new Set<string>();
  const rows: ChatSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.json$/i.test(entry.name)) continue;
    const id = entry.name.slice(0, -5).toLowerCase();
    if (!validSessionId(id) || seen.has(id)) continue;
    seen.add(id);
    let handle;
    try {
      const filename = join(directory, entry.name);
      const before = await lstat(filename);
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) continue;
      handle = await open(filename, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.ino !== before.ino || stat.dev !== before.dev) continue;
      // Bounded read even if a foreign writer grows the file after stat().
      const buffer = Buffer.alloc(stat.size + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const part = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
        if (!part.bytesRead) break;
        bytes += part.bytesRead;
      }
      if (bytes > stat.size) continue;
      const row = summarize(JSON.parse(buffer.subarray(0, bytes).toString('utf8')), id, kind);
      if (row) rows.push(row);
    } catch {
      // Corrupt, oversized, disappeared or unreadable individual records do not
      // hide healthy history. Never repair/overwrite them or expose error paths.
    } finally { await handle?.close(); }
  }
  return rows;
}

/** Keyset pagination: updatedAt descending, then kind/id ascending. A cursor
 * survives deletion of its row. This is a live disk view, not a frozen snapshot:
 * updated chats can move before the cursor; refresh page one to see them. */
export async function listChats(query: ChatHistoryQuery = {}, directories: ChatDirectories = chatDirectories()): Promise<ChatPage> {
  if (query.kind !== undefined && !isKind(query.kind)) throw new ChatHistoryQueryError();
  const limit = query.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new ChatHistoryQueryError();
  const position = query.cursor === undefined ? undefined : decodeCursor(query.cursor, query.kind);
  const rows: ChatSummary[] = [];
  for (const kind of ['agent', 'consult'] as const) {
    if (query.kind === undefined || query.kind === kind) rows.push(...await readSummaries(directories[kind], kind));
  }
  rows.sort(compare);
  const remaining = position ? rows.filter(row => compare(row, position) > 0) : rows;
  const items = remaining.slice(0, limit);
  return { items, ...(remaining.length > limit ? { nextCursor: encodeCursor(items.at(-1)!, query.kind) } : {}) };
}
