// 本机私密会话仓库。写入成功才确认保存；损坏记录不会静默覆盖。
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Session } from './agent.ts';
import type { CallLog } from './ima.ts';
import type { RunState } from './agent-runtime.ts';

export interface SavedMessage {
  role: 'user' | 'assistant';
  text: string;
  kind?: 'clarify' | 'notice' | 'error' | 'agent';
  options?: string[];
}

export interface SavedSession {
  schema: 1;
  session: Session;
  messages: SavedMessage[];
  calls: CallLog[];
  busy: boolean;
  interrupted: boolean;
  updatedAt: string;
  run?: RunState;
}

export class SessionStorageError extends Error {
  constructor(message = '工作记录暂时无法保存，请检查本机存储后重试。') {
    super(message);
    this.name = 'SessionStorageError';
  }
}

export const validSessionId = (id: string) => /^[\w-]{6,64}$/.test(id);
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const renamePause = new Int32Array(new SharedArrayBuffer(4));

/** Windows may briefly refuse replacing an existing file. Retry only that
 * observed error, for at most 85ms, preserving the same atomic rename. */
function replaceSessionFile(temporary: string, target: string) {
  const delays = [10, 25, 50];
  for (let attempt = 0; ; attempt++) {
    try { renameSync(temporary, target); return; }
    catch (error) {
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException)?.code !== 'EPERM' || attempt >= delays.length) throw error;
      Atomics.wait(renamePause, 0, 0, delays[attempt]);
    }
  }
}

function replaceContents(target: object, source: object) {
  for (const key of Object.keys(target)) Reflect.deleteProperty(target, key);
  Object.assign(target, source);
}

export class SessionRepository {
  private records = new Map<string, SavedSession>();
  // 保存实际写入成功的 JSON，避免副本被调用方后续的嵌套修改污染。
  private persisted = new Map<string, string>();
  private directory: string;
  private create: () => Session;
  constructor(directory: string, create: () => Session) {
    this.directory = directory;
    this.create = create;
  }

  private key(id: string) {
    if (!validSessionId(id)) throw new SessionStorageError('工作记录编号无效。');
    return id.toLowerCase();
  }

  private path(id: string) {
    id = this.key(id);
    return join(this.directory, `${id}.json`);
  }

  find(id: string): SavedSession | undefined {
    id = this.key(id);
    const path = this.path(id);
    const cached = this.records.get(id);
    if (cached) return cached;
    let raw: string;
    try {
      if (statSync(path).size > MAX_FILE_BYTES) throw new Error('oversize');
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new SessionStorageError('工作记录无法读取，请保留原文件并检查本机存储。');
    }
    let record: SavedSession;
    try {
      record = JSON.parse(raw);
      if (record?.schema !== 1 || !record.session
        || typeof record.session.modelId !== 'string' || typeof record.session.modelName !== 'string'
        || !Array.isArray(record.messages) || !Array.isArray(record.calls)
        || typeof record.busy !== 'boolean' || typeof record.interrupted !== 'boolean'
        || typeof record.updatedAt !== 'string'
        || !record.messages.every((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.text === 'string')) {
        throw new Error('invalid schema');
      }
    } catch {
      throw new SessionStorageError('工作记录格式异常，已保留原文件。请开启新创作或恢复备份。');
    }
    this.persisted.set(id, raw);
    // 磁盘上仍为 busy 而本进程没有任务，代表上次在工作途中退出。
    if (record.busy) {
      const now = new Date().toISOString();
      record.busy = false;
      record.interrupted = true;
      record.updatedAt = now;
      if (record.run) {
        record.run.status = 'interrupted';
        record.run.updatedAt = now;
        record.run.endedAt = now;
      }
      this.write(id, record);
    }
    this.records.set(id, record);
    return record;
  }

  get(id: string): SavedSession {
    id = this.key(id);
    let record = this.find(id);
    if (!record) {
      record = { schema: 1, session: this.create(), messages: [], calls: [], busy: false, interrupted: false, updatedAt: new Date().toISOString() };
      this.records.set(id, record);
    }
    return record;
  }

  private rollback(id: string) {
    const record = this.records.get(id);
    if (!record) return; // 载入时的恢复尚未成功，不缓存该记录。
    const text = this.persisted.get(id);
    if (text === undefined) {
      this.records.delete(id);
      return;
    }
    const restored: SavedSession = JSON.parse(text);
    // 保留记录、session 和 run 的身份，让已持有它们的调用方也看到回滚。
    replaceContents(record.session, restored.session);
    restored.session = record.session;
    if (record.run && restored.run) {
      replaceContents(record.run, restored.run);
      restored.run = record.run;
    }
    replaceContents(record, restored);
  }

  private write(id: string, record: SavedSession) {
    id = this.key(id);
    const path = this.path(id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const text = JSON.stringify(record);
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('oversize');
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
      replaceSessionFile(temporary, path);
      this.persisted.set(id, text);
    } catch {
      this.rollback(id);
      throw new SessionStorageError();
    } finally {
      try { unlinkSync(temporary); } catch { /* rename 后临时文件已不存在。 */ }
    }
  }

  save(id: string) {
    const record = this.get(id);
    record.updatedAt = new Date().toISOString();
    this.write(id, record);
  }

  begin(id: string): boolean {
    const record = this.get(id);
    if (record.busy) return false;
    record.busy = true;
    record.interrupted = false;
    this.save(id);
    return true;
  }

  finish(id: string, interrupted = false) {
    const record = this.get(id);
    record.busy = false;
    record.interrupted = interrupted;
    this.save(id);
  }

  appendMessage(id: string, message: SavedMessage) {
    const record = this.get(id);
    record.messages.push({ ...message, text: message.text.slice(0, 12000) });
    record.messages = record.messages.slice(-80);
    this.save(id);
  }

  appendCall(id: string, entry: CallLog) {
    const record = this.get(id);
    record.calls.push({ ...entry });
    record.calls = record.calls.slice(-500);
    this.save(id);
  }
}
