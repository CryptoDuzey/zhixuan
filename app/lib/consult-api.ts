import { randomUUID } from 'node:crypto';
import { consult, ConsultError, CONSULT_LIMITS, type ConsultAnswer, type ConsultMessage } from './consult.ts';
import { consultRepository, type ConsultRepository, type SavedConsult } from './consult-store.ts';
import { cancelRun, createRun, encodeRunEvent, isRunActive, releaseRun, RunStoppedError, throwIfStopped, withRun } from './agent-runtime.ts';
import { SessionStorageError, validSessionId } from './session-store.ts';
import { withCallScope } from './ima.ts';
import { ModelSettingsError } from './model-settings.ts';

const headers = { 'cache-control': 'no-store' };
const runKey = (id: string) => `consult:${id.toLowerCase()}`;
const failure = (error: unknown) => error instanceof SessionStorageError || error instanceof ConsultError || error instanceof RunStoppedError || error instanceof ModelSettingsError
  ? error.message : '咨询暂时没有完成，请稍后重试。已保存的问题可以保留后继续。';

async function readBody(request: Request, maximum = CONSULT_LIMITS.bodyBytes): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > maximum) throw new ConsultError(413, '消息过长，请精简后重试。');
  if (!request.body) throw new ConsultError(400, '请提供咨询消息。');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new ConsultError(413, '消息过长，请精简后重试。');
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ConsultError(400, '消息格式无效，请重试。'); }
}

type Runner = (body: unknown, onProgress: (label: string) => void) => Promise<ConsultAnswer>;

/** 依赖可注入，离线检查不需要真实资料或模型。两个工作端使用独立的任务编号空间。 */
export function createConsultHandlers(options: {
  repository?: ConsultRepository;
  execute?: Runner;
  timeoutMs?: number;
  maxModelAttempts?: number;
} = {}) {
  const repository = options.repository ?? consultRepository;
  const execute: Runner = options.execute ?? ((body, progress) => consult(body, undefined, progress));
  const limits = { timeoutMs: options.timeoutMs ?? 180_000, maxModelAttempts: options.maxModelAttempts ?? 8 };
  function recover(id: string) {
    const record = repository.find(id);
    if (record?.busy && record.run && !isRunActive(runKey(id), record.run.id)) {
      const now = new Date().toISOString();
      record.run.status = 'interrupted';
      record.run.endedAt = record.run.updatedAt = now;
      record.error = '上次咨询已中断，最近保存的内容仍可查看。请按需重新发送。';
      repository.finish(id, true);
    }
    return record;
  }
  const snapshot = (record: SavedConsult) => ({
    turns: record.turns, busy: record.busy, interrupted: record.interrupted,
    updatedAt: record.updatedAt, run: record.run, error: record.error,
  });
  const errorResponse = (error: unknown, fallback = 500) => Response.json(
    { error: failure(error) }, { status: error instanceof ConsultError ? error.status : fallback, headers },
  );

  async function GET(request: Request) {
    const id = new URL(request.url).searchParams.get('sessionId') ?? '';
    if (!validSessionId(id)) return errorResponse(new ConsultError(400, '咨询记录编号无效。'));
    try {
      const record = recover(id);
      return record ? Response.json(snapshot(record), { headers })
        : errorResponse(new ConsultError(404, '未找到咨询记录。'));
    } catch (error) { return errorResponse(error); }
  }

  async function POST(request: Request) {
    let body: unknown;
    try { body = await readBody(request); } catch (error) { return errorResponse(error); }
    const value = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    // 兼容原JSON调用；页面的新协议以服务端保存的历史为准，不导入客户端助手身份。
    if (value.sessionId === undefined) {
      try {
        const result = await withRun(`consult:legacy:${randomUUID()}`, createRun(), () => {},
          () => execute(body, () => {}), limits);
        return Response.json(result, { headers });
      } catch (error) { return errorResponse(error, 502); }
    }
    const id = typeof value.sessionId === 'string' ? value.sessionId : '';
    if (!validSessionId(id)) return errorResponse(new ConsultError(400, '咨询记录编号无效。'));
    const question = typeof value.message === 'string' ? value.message.trim() : '';
    if (!question) return errorResponse(new ConsultError(400, '请先说说你的用途。'));
    if (question.length > CONSULT_LIMITS.messageChars) return errorResponse(new ConsultError(413, '每条问题最多2000字，内容未被保存或截断。'));
    let record: SavedConsult;
    try {
      recover(id);
      record = repository.get(id);
      if (record.busy) return errorResponse(new ConsultError(409, '这项咨询仍在进行，请先等待或停止。'));
      record.run = createRun();
      delete record.error;
      const last = record.turns.at(-1);
      if (!last || last.answer || last.question !== question) record.turns.push({ question });
      // 问题、运行编号与忙碌状态一次保存，失败不会留下没有运行编号的锁。
      if (!repository.begin(id)) return errorResponse(new ConsultError(409, '这项咨询仍在进行，请先等待或停止。'));
    } catch (error) { return errorResponse(error); }
    const run = record.run!;
    const messages: ConsultMessage[] = record.turns.slice(0, -1).flatMap((turn): ConsultMessage[] => turn.answer ? [
      { role: 'user', content: turn.question },
      { role: 'assistant', content: turn.answer.reply.slice(0, 2000) },
    ] : []).slice(-22);
    messages.push({ role: 'user', content: question });
    const sse = (request.headers.get('accept') ?? '').split(',').some((item) => item.trim().split(';')[0] === 'text/event-stream');
    const encoder = new TextEncoder();
    let disconnected = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = <T extends { type: string }>(event: T) => {
          const data = encodeRunEvent(event, run, sse);
          if (!disconnected) try { controller.enqueue(encoder.encode(data)); } catch { disconnected = true; }
        };
        const current = () => {
          throwIfStopped();
          const saved = repository.get(id);
          if (!saved.busy || saved.run?.id !== run.id) throw new RunStoppedError('cancelled');
          return saved;
        };
        send({ type: 'run', run });
        const heartbeat = sse ? setInterval(() => send({ type: 'heartbeat' }), 15_000) : undefined;
        let outcome: typeof run.status = 'failed';
        try {
          let traceError: unknown;
          await withRun(runKey(id), run, send, () => withCallScope((entry) => {
            try { current(); repository.appendCall(id, entry); } catch (error) { traceError = error; }
          }, async () => {
            const answer = await execute({ messages }, (label) => {
              current();
              if (traceError) throw traceError;
              run.phase = label;
              repository.save(id);
              send({ type: 'step', label, run });
            });
            const saved = current();
            if (traceError) throw traceError;
            saved.turns.at(-1)!.answer = answer;
            run.phase = '方案已整理';
            repository.save(id);
            send({ type: 'answer', answer });
          }), { ...limits, retainUntilReleased: true });
          outcome = 'completed';
        } catch (error) {
          outcome = error instanceof RunStoppedError ? error.status : 'failed';
          const text = failure(error);
          try { repository.get(id).error = text; repository.save(id); } catch { /* 原保存错误优先。 */ }
          send({ type: 'error', text });
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          run.status = outcome;
          run.endedAt = run.updatedAt = new Date().toISOString();
          try {
            repository.get(id).run = run;
            repository.finish(id);
            send({ type: 'done', run });
          } catch (error) { send({ type: 'error', text: failure(error) }); }
          finally { releaseRun(runKey(id), run.id); }
          if (!disconnected) try { controller.close(); } catch { /* 页面已离开。 */ }
        }
      },
      cancel() { disconnected = true; },
    });
    return new Response(stream, { headers: {
      ...headers, 'content-type': sse ? 'text/event-stream; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
      'x-accel-buffering': 'no',
    } });
  }

  async function cancel(request: Request) {
    try {
      const raw = await readBody(request, 1024);
      const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      if (typeof value.sessionId !== 'string' || !validSessionId(value.sessionId)
        || typeof value.runId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.runId)
        || Object.keys(value).some((key) => !['sessionId', 'runId'].includes(key))) {
        return errorResponse(new ConsultError(400, '停止请求编号无效。'));
      }
      const record = repository.find(value.sessionId);
      if (!record?.busy || record.run?.id !== value.runId || !cancelRun(runKey(value.sessionId), value.runId)) {
        return errorResponse(new ConsultError(409, '这项咨询已结束或已变化，请恢复最新进度。'));
      }
      repository.save(value.sessionId);
      return Response.json({ accepted: true, runId: value.runId }, { status: 202, headers });
    } catch (error) { return errorResponse(error); }
  }
  return { GET, POST, cancel };
}

export const consultHandlers = createConsultHandlers();
