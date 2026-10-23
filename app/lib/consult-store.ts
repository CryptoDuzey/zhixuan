// 选购咨询的本机私密记录；只有原子替换成功后才确认保存。
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { constants } from 'node:os';
import type { ConsultAnswer } from './consult.ts';
import type { CallLog } from './ima.ts';
import type { RunState } from './agent-runtime.ts';
import { SessionStorageError, validSessionId } from './session-store.ts';

export interface ConsultTurn {
  question: string;
  answer?: ConsultAnswer;
}

export interface SavedConsult {
  schema: 1;
  turns: ConsultTurn[];
  calls: CallLog[];
  busy: boolean;
  interrupted: boolean;
  updatedAt: string;
  run?: RunState;
  error?: string;
}

const MAX_FILE_BYTES = 12 * 1024 * 1024;
const renamePause = new Int32Array(new SharedArrayBuffer(4));

// Match session-store's bounded Windows EPERM handling. Keep the same source
// and destination for every atomic rename; never remove the saved destination.
function replaceConsultFile(temporary: string, target: string) {
  const delays = [10, 25, 50];
  for (let attempt = 0; ; attempt++) {
    try { renameSync(temporary, target); return; }
    catch (error) {
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException)?.code !== 'EPERM' || attempt >= delays.length) throw error;
      Atomics.wait(renamePause, 0, 0, delays[attempt]);
    }
  }
}

// Never log messages, stacks, paths, record contents, or arbitrary error fields.
function safeCause(error: unknown, depth = 0): object {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  return {
    name: ['Error', 'TypeError', 'RangeError', 'SyntaxError'].includes(String(value.name)) ? value.name : 'UnknownError',
    ...(typeof value.code === 'string' && Object.hasOwn(constants.errno, value.code) ? { code: value.code } : {}),
    ...(typeof value.syscall === 'string' && ['rename', 'open', 'write', 'mkdir', 'stat', 'read', 'unlink'].includes(value.syscall)
      ? { syscall: value.syscall } : {}),
    ...(value.cause && depth < 2 ? { cause: safeCause(value.cause, depth + 1) } : {}),
  };
}

function replaceContents(target: object, source: object) {
  for (const key of Object.keys(target)) Reflect.deleteProperty(target, key);
  Object.assign(target, source);
}

function validRecord(record: SavedConsult): boolean {
  return record?.schema === 1
    && Array.isArray(record.turns)
    && record.turns.every((turn) => turn && typeof turn.question === 'string'
      && (turn.answer === undefined || (turn.answer && typeof turn.answer.reply === 'string'
        && Array.isArray(turn.answer.recommendations) && Array.isArray(turn.answer.evidence)
        && (turn.answer.questions === undefined || (Array.isArray(turn.answer.questions)
          && turn.answer.questions.every((question) => typeof question === 'string'))))))
    && Array.isArray(record.calls)
    && record.calls.every((call) => call && typeof call.at === 'string'
      && ['search', 'read', 'image', 'documents'].includes(call.op)
      && typeof call.target === 'string' && typeof call.ok === 'boolean')
    && typeof record.busy === 'boolean'
    && typeof record.interrupted === 'boolean'
    && typeof record.updatedAt === 'string'
    && (record.error === undefined || typeof record.error === 'string')
    && (record.run === undefined || (!!record.run && typeof record.run.id === 'string'
      && ['running', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(record.run.status)
      && typeof record.run.phase === 'string' && typeof record.run.startedAt === 'string'
      && typeof record.run.updatedAt === 'string'
      && (record.run.endedAt === undefined || typeof record.run.endedAt === 'string')
      && Number.isSafeInteger(record.run.sequence) && record.run.sequence >= 0
      && typeof record.run.cancelRequested === 'boolean'));
}

export class ConsultRepository {
  private records = new Map<string, SavedConsult>();
  // 保存已成功落盘的 JSON，调用方修改嵌套内容也不能污染回滚副本。
  private persisted = new Map<string, string>();
  private directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  private key(id: string) {
    if (!validSessionId(id)) throw new SessionStorageError('咨询记录编号无效。');
    return id.toLowerCase();
  }

  private path(id: string) {
    return join(this.directory, `${this.key(id)}.json`);
  }

  find(id: string): SavedConsult | undefined {
    id = this.key(id);
    const cached = this.records.get(id);
    if (cached) return cached;
    let raw: string;
    try {
      const path = this.path(id);
      if (statSync(path).size > MAX_FILE_BYTES) throw new Error('oversize');
      raw = readFileSync(path, 'utf8');
      if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw new Error('oversize');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new SessionStorageError('咨询记录无法读取，请保留原文件并检查本机存储。');
    }
    let record: SavedConsult;
    try {
      record = JSON.parse(raw);
      if (!validRecord(record)) throw new Error('invalid schema');
    } catch {
      throw new SessionStorageError('咨询记录格式异常，已保留原文件。请开启新咨询或恢复备份。');
    }
    this.persisted.set(id, raw);
    // 本进程尚未开始任务，磁盘上的 busy 表示上次在咨询途中退出。
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

  get(id: string): SavedConsult {
    id = this.key(id);
    let record = this.find(id);
    if (!record) {
      record = {
        schema: 1, turns: [], calls: [], busy: false, interrupted: false,
        updatedAt: new Date().toISOString(),
      };
      this.records.set(id, record);
    }
    return record;
  }

  private rollback(id: string) {
    const record = this.records.get(id);
    if (!record) return; // 重启恢复尚未写入成功时，不缓存恢复结果。
    const text = this.persisted.get(id);
    if (text === undefined) {
      this.records.delete(id);
      return;
    }
    const restored: SavedConsult = JSON.parse(text);
    // 保留记录与运行状态的身份，已持有引用的路由也能看到恢复结果。
    if (record.run && restored.run) {
      replaceContents(record.run, restored.run);
      restored.run = record.run;
    }
    replaceContents(record, restored);
  }

  private write(id: string, record: SavedConsult) {
    id = this.key(id);
    const path = this.path(id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    let operation = 'serialize';
    try {
      const text = JSON.stringify(record);
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('oversize');
      operation = 'mkdir';
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      operation = 'write';
      writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
      operation = 'rename';
      replaceConsultFile(temporary, path);
      this.persisted.set(id, text);
    } catch (error) {
      try {
        console.error('[consult-store]', JSON.stringify({ event: 'consult_storage_failure', operation, cause: safeCause(error) }));
      } catch { /* Diagnostics must not prevent rollback or replace the storage error. */ }
      this.rollback(id);
      throw new SessionStorageError();
    } finally {
      try { unlinkSync(temporary); } catch { /* 成功替换后临时文件已不存在。 */ }
    }
  }

  save(id: string) {
    const record = this.get(id);
    record.turns = record.turns.slice(-12);
    record.calls = record.calls.slice(-500);
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

  appendCall(id: string, entry: CallLog) {
    this.get(id).calls.push({ ...entry });
    this.save(id);
  }
}

const g = globalThis as unknown as { __zx_consult_repository?: ConsultRepository };
export const consultRepository = (g.__zx_consult_repository ??= new ConsultRepository(
  process.env.ZHIXUAN_CONSULT_DIR || join(process.cwd(), 'data', 'private', 'consultations'),
));
