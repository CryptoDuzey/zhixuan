/** Browser-only transport helpers. No server runtime or credentials are imported. */
export type AgentRun = {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
  phase: string;
  cancelRequested: boolean;
};

export function parseAgentRun(value: unknown): AgentRun | undefined {
  if (!value || typeof value !== 'object') return;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id || r.id.length > 160
    || !['running', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(String(r.status))
    || typeof r.phase !== 'string' || r.phase.length > 2000
    || typeof r.cancelRequested !== 'boolean') return;
  return { id: r.id, status: r.status as AgentRun['status'], phase: r.phase, cancelRequested: r.cancelRequested };
}

export function runStatusText(run: AgentRun): string {
  if (run.status === 'running') return run.cancelRequested ? '正在停止，请等待确认' : run.phase || '任务正在进行';
  return {
    completed: '本次任务已结束，稿件状态以核验结果为准',
    failed: '任务未完成，已保留最近保存的内容',
    cancelled: '任务已停止，已保留最近保存的内容',
    timed_out: '任务等待超时，已保留最近保存的内容',
    interrupted: '任务已中断，已保留最近保存的内容',
  }[run.status];
}

export type StreamEvent = Record<string, unknown> & { type: string };

/** Incremental SSE/NDJSON decoder, including UTF-8 split across network chunks. */
export class AgentStreamDecoder {
  private decoder = new TextDecoder();
  private buffer = '';
  private data: string[] = [];
  private event = '';
  private sse: boolean;
  private emit: (event: StreamEvent) => void;
  private sequences = new Map<string, number>();

  constructor(contentType: string, emit: (event: StreamEvent) => void) {
    this.emit = emit;
    this.sse = contentType.toLowerCase().includes('text/event-stream');
  }
  push(chunk: Uint8Array) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.lines(false);
  }
  finish() {
    this.buffer += this.decoder.decode();
    this.lines(true);
    // SSE dispatch requires an empty line; an unfinished frame must not claim done.
    if (this.sse && (this.data.length || this.event)) throw new Error('事件接收不完整');
  }
  private lines(final: boolean) {
    for (;;) {
      const match = /[\r\n]/.exec(this.buffer);
      if (!match) break;
      const index = match.index;
      if (!final && this.buffer[index] === '\r' && index === this.buffer.length - 1) break;
      const length = this.buffer[index] === '\r' && this.buffer[index + 1] === '\n' ? 2 : 1;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + length);
      this.line(line);
    }
    if (this.buffer.length > 2_000_000) throw new Error('事件内容过大');
    if (final && this.buffer) {
      this.line(this.buffer);
      this.buffer = '';
    }
  }
  private line(line: string) {
    if (!this.sse) {
      if (line.trim()) this.dispatch(line);
      return;
    }
    if (!line) {
      if (this.data.length && this.event !== 'heartbeat') this.dispatch(this.data.join('\n'), this.event);
      this.data = [];
      this.event = '';
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') this.event = value;
    if (field === 'data') {
      this.data.push(value);
      if (this.data.reduce((sum, item) => sum + item.length, 0) > 2_000_000) throw new Error('事件内容过大');
    }
  }
  private dispatch(json: string, name?: string) {
    const value = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.type !== 'string' || (name && value.type !== name)) throw new Error('事件格式不正确');
    if (value.type === 'heartbeat') return;
    if (typeof value.runId === 'string' && Number.isSafeInteger(value.seq)) {
      const last = this.sequences.get(value.runId) ?? -1;
      if (value.seq <= last) return;
      this.sequences.set(value.runId, value.seq);
    }
    this.emit(value);
  }
}

export async function consumeAgentStream(response: Response, emit: (event: StreamEvent) => void) {
  if (!response.body) throw new Error('没有收到任务内容');
  const decoder = new AgentStreamDecoder(response.headers.get('content-type') ?? '', emit);
  const reader = response.body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      decoder.push(chunk.value);
    }
    decoder.finish();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
