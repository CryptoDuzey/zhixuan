import { editDraft, handleMessage, type AgentEvent } from '../../../lib/agent.ts';
import { recoverSession, sessionRepository, toView } from '../../../lib/store.ts';
import { SessionStorageError, validSessionId, type SavedMessage } from '../../../lib/session-store.ts';
import { withCallScope } from '../../../lib/ima.ts';
import { createRun, encodeRunEvent, releaseRun, RunStoppedError, throwIfStopped, withRun } from '../../../lib/agent-runtime.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
const headers = { 'cache-control': 'no-store' };
const MAX_BODY = 32000;

function storageMessage(error: unknown) {
  return error instanceof SessionStorageError ? error.message : '本次任务未完成，请稍后重试。已保存的内容可以继续使用。';
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('sessionId') ?? '';
  if (!validSessionId(id)) return Response.json({ error: '工作记录编号无效。' }, { status: 400, headers });
  try {
    const record = recoverSession(id);
    if (!record) return Response.json({ error: '未找到工作记录。' }, { status: 404, headers });
    return Response.json({
      view: toView(record.session), messages: record.messages,
      busy: record.busy, interrupted: record.interrupted, updatedAt: record.updatedAt,
      run: record.run,
    }, { headers });
  } catch (error) {
    return Response.json({ error: storageMessage(error) }, { status: 500, headers });
  }
}

async function readBody(req: Request): Promise<unknown> {
  if (Number(req.headers.get('content-length')) > MAX_BODY) throw new RangeError();
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw new RangeError();
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** 断开浏览器连接后仍保存结果；重连通过 GET 恢复，绝不自动重复生成。 */
export async function POST(req: Request) {
  let body: any;
  try { body = await readBody(req); } catch (error) {
    return Response.json({ error: error instanceof RangeError ? '消息过长，请精简后重试。' : '请求不是合法 JSON。' }, { status: error instanceof RangeError ? 413 : 400, headers });
  }
  const id = String(body?.sessionId ?? '');
  if (!validSessionId(id)) return Response.json({ error: '工作记录编号无效。' }, { status: 400, headers });
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (message.length > 2000) return Response.json({ error: '消息超过 2000 字，请精简后重试。内容未被保存或截断。' }, { status: 413, headers });
  const patch = body?.patch && typeof body.patch === 'object' && !Array.isArray(body.patch) ? body.patch : null;
  const clean: Record<string, string> = {};
  if (patch) for (const key of ['title', 'lead', 'body', 'cta']) {
    if (typeof patch[key] === 'string') {
      if (patch[key].length > 6000) return Response.json({ error: '单项编辑超过 6000 字，请分段修改。内容未被保存或截断。' }, { status: 413, headers });
      clean[key] = patch[key];
    }
  }
  if (!message && !Object.keys(clean).length) return Response.json({ error: '请提供消息或需要修改的内容。' }, { status: 400, headers });
  try {
    recoverSession(id);
  } catch (error) {
    return Response.json({ error: storageMessage(error) }, { status: 500, headers });
  }
  try {
    const pending = sessionRepository.get(id);
    if (pending.busy) return Response.json({ error: '这项任务仍在进行，请等待完成后继续。' }, { status: 409, headers });
    pending.run = createRun();
    pending.messages.push({ role: 'user', text: message || '直接编辑稿件并重新核验' });
    pending.messages = pending.messages.slice(-80);
    sessionRepository.begin(id);
  } catch (error) {
    return Response.json({ error: storageMessage(error) }, { status: 500, headers });
  }

  const record = sessionRepository.get(id);
  const run = record.run!;
  // 异步任务仅修改自己的副本。停止之后迟到的结果不能写回，也不能影响下一次运行。
  const working = structuredClone(record.session);
  // 历史由服务端提供，不信任浏览器拼接的助手身份。
  const history = record.messages.slice(0, -1).map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.text}`).join('\n').slice(-3000);
  const enc = new TextEncoder();
  const sse = (req.headers.get('accept') ?? '').split(',').some((value) => value.trim().split(';')[0] === 'text/event-stream');
  let disconnected = false;
  const stream = new ReadableStream({
    async start(ctl) {
      const send = <T extends { type: string }>(event: T) => {
        const data = encodeRunEvent(event, run, sse);
        if (disconnected) return;
        try { ctl.enqueue(enc.encode(data)); } catch { disconnected = true; }
      };
      send({ type: 'run', run });
      const heartbeat = sse ? setInterval(() => send({ type: 'heartbeat' }), 15_000) : undefined;
      let failed = false;
      const emit = (event: AgentEvent) => {
        throwIfStopped();
        const current = sessionRepository.get(id);
        if (current.run?.id !== run.id || !current.busy) throw new RunStoppedError('cancelled');
        if (event.type === 'step') run.phase = event.label;
        current.run = run;
        current.session = structuredClone(working);
        let saved: SavedMessage | undefined;
        if (event.type === 'clarify') saved = { role: 'assistant', kind: 'clarify', text: event.question, options: event.options };
        if (event.type === 'notice' || event.type === 'error') {
          if (event.type === 'error') failed = true;
          saved = { role: 'assistant', kind: event.type, text: event.text };
        }
        if (saved) sessionRepository.appendMessage(id, saved);
        else sessionRepository.save(id);
        send(event.type === 'step' ? { ...event, run } : event);
      };
      try {
        let traceError: unknown;
        await withRun(id, run, send, () => withCallScope((entry) => {
          try {
            throwIfStopped();
            sessionRepository.appendCall(id, entry);
          } catch (error) { traceError = error; }
        }, async () => {
          if (patch) await editDraft(clean, working, emit);
          else await handleMessage(message, working, emit, history);
          throwIfStopped();
        }), { retainUntilReleased: true });
        if (traceError) throw traceError;
        const latest = sessionRepository.get(id).session;
        if (!failed && latest.draft) {
          const d = latest.draft;
          const r = latest.report;
          const current = r?.draftVersion === d.version;
          sessionRepository.appendMessage(id, { role: 'assistant', kind: 'agent', text: current
            ? `第 ${d.version} 版已核验，${r!.issues.filter((i) => i.severity === 'block').length} 项必须处理，${r!.issues.filter((i) => i.severity !== 'block').length} 项建议留意。`
            : `已保留第 ${d.version} 版，当前版本尚未完成核验。` });
        }
      } catch (error) {
        failed = true;
        run.status = error instanceof RunStoppedError ? error.status : 'failed';
        const text = error instanceof RunStoppedError ? error.message : storageMessage(error);
        try { sessionRepository.appendMessage(id, { role: 'assistant', kind: 'error', text }); } catch { /* 保存失败仍向浏览器报告。 */ }
        send({ type: 'error', text });
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (run.status === 'running') run.status = failed ? 'failed' : 'completed';
        run.endedAt = new Date().toISOString();
        run.updatedAt = run.endedAt;
        try {
          sessionRepository.get(id).run = run;
          sessionRepository.finish(id);
          send({ type: 'done', view: toView(sessionRepository.get(id).session), run });
        } catch (error) {
          send({ type: 'error', text: storageMessage(error) });
        } finally {
          releaseRun(id, run.id);
        }
        if (!disconnected) try { ctl.close(); } catch { /* 客户端已离开。 */ }
      }
    },
    cancel() { disconnected = true; },
  });
  return new Response(stream, { headers: { ...headers,
    'content-type': sse ? 'text/event-stream; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
    'x-accel-buffering': 'no',
  } });
}
