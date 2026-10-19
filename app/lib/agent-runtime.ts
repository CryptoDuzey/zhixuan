// 单机任务运行支架：有限预算、显式停止、超时与可恢复的安全进度。
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RunState {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
  phase: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  sequence: number;
  cancelRequested: boolean;
}

export interface ToolEvent {
  type: 'tool';
  tool: 'model' | 'knowledge';
  status: 'started' | 'completed' | 'failed';
  label: string;
  ms?: number;
  cacheHit?: boolean;
}

export class RunStoppedError extends Error {
  status: 'cancelled' | 'timed_out' | 'failed';
  constructor(status: RunStoppedError['status'], message?: string) {
    super(message ?? (status === 'cancelled'
      ? '任务已停止，最近保存的内容仍可继续使用。'
      : status === 'timed_out' ? '任务已超过运行时限，最近保存的内容仍可继续使用。'
        : '本次任务已达到模型调用上限，请缩小需求后继续。'));
    this.name = 'RunStoppedError';
    this.status = status;
  }
}

interface RunContext {
  state: RunState;
  controller: AbortController;
  modelAttempts: number;
  maxModelAttempts: number;
  onTool: (event: ToolEvent) => void;
  settled: boolean;
}

const globalRuntime = globalThis as unknown as {
  __zxRuns?: Map<string, RunContext>;
  __zxRunContext?: AsyncLocalStorage<RunContext>;
};
const registry = globalRuntime.__zxRuns ??= new Map();
const context = globalRuntime.__zxRunContext ??= new AsyncLocalStorage<RunContext>();
const keyFor = (sessionId: string) => sessionId.toLowerCase();

export function createRun(): RunState {
  const now = new Date().toISOString();
  return { id: randomUUID(), status: 'running', phase: '准备任务', startedAt: now, updatedAt: now, sequence: 0, cancelRequested: false };
}

export function runSignal(): AbortSignal | undefined {
  return context.getStore()?.controller.signal;
}

export function isRunActive(sessionId: string, runId: string): boolean {
  return registry.get(keyFor(sessionId))?.state.id === runId;
}

/** 持久任务将收尾写盘也纳入锁；只有执行已退出且编号匹配才能释放。 */
export function releaseRun(sessionId: string, runId: string) {
  const key = keyFor(sessionId);
  const current = registry.get(key);
  if (current?.state.id === runId && current.settled) registry.delete(key);
}

export function throwIfStopped() {
  const current = context.getStore();
  if (current?.controller.signal.aborted) {
    throw current.controller.signal.reason instanceof RunStoppedError
      ? current.controller.signal.reason : new RunStoppedError('cancelled');
  }
}

export function reportTool(event: ToolEvent) {
  throwIfStopped();
  context.getStore()?.onTool(event);
}

export function useModelAttempt() {
  throwIfStopped();
  const current = context.getStore();
  if (!current) return;
  if (++current.modelAttempts > current.maxModelAttempts) {
    const error = new RunStoppedError('failed');
    current.controller.abort(error);
    throw error;
  }
}

export function cancelRun(sessionId: string, runId: string): boolean {
  const current = registry.get(keyFor(sessionId));
  if (!current || current.settled || current.state.id !== runId || current.state.status !== 'running' || current.controller.signal.aborted) return false;
  current.state.cancelRequested = true;
  current.state.updatedAt = new Date().toISOString();
  current.controller.abort(new RunStoppedError('cancelled'));
  return true;
}

export async function abortableDelay(ms: number) {
  throwIfStopped();
  const signal = runSignal();
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** 任务层也竞速停止；迟到的异步结果由调用层检查，不能提交到会话。 */
export async function withRun<T>(
  sessionId: string,
  state: RunState,
  onTool: RunContext['onTool'],
  task: () => Promise<T>,
  options: { timeoutMs?: number; maxModelAttempts?: number; retainUntilReleased?: boolean } = {},
): Promise<T> {
  const key = keyFor(sessionId);
  if (registry.has(key)) throw new Error('这项任务仍在进行。');
  const current: RunContext = { state, controller: new AbortController(), modelAttempts: 0, maxModelAttempts: options.maxModelAttempts ?? 16, onTool, settled: false };
  registry.set(key, current);
  const timer = setTimeout(() => current.controller.abort(new RunStoppedError('timed_out')), options.timeoutMs ?? 300_000);
  let abort: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(current.controller.signal.reason);
    current.controller.signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await context.run(current, () => Promise.race([Promise.resolve().then(task), stopped]));
  } finally {
    clearTimeout(timer);
    current.controller.signal.removeEventListener('abort', abort);
    current.settled = true;
    if (!options.retainUntilReleased && registry.get(key) === current) registry.delete(key);
  }
}

export function encodeRunEvent(
  event: { type: string },
  run: RunState,
  sse: boolean,
) {
  const at = new Date().toISOString();
  const seq = ++run.sequence;
  run.updatedAt = at;
  const data = JSON.stringify({ ...event, runId: run.id, seq, at });
  return sse ? `id: ${run.id}:${seq}\nevent: ${event.type}\ndata: ${data}\n\n` : `${data}\n`;
}
