import { editDraft, handleMessage, type AgentEvent } from '../../../lib/agent.ts';
import { getSession, toView } from '../../../lib/store.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** NDJSON 流：每行一个事件，最后一行 {type:'done', view}。任何失败都以 error 事件如实返回。 */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: '请求不是合法 JSON' }, { status: 400 });
  }
  const sessionId = String(body?.sessionId ?? '');
  if (!/^[\w-]{6,64}$/.test(sessionId)) return Response.json({ error: 'sessionId 不合法' }, { status: 400 });
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 2000) : '';
  const patch = body.patch && typeof body.patch === 'object' ? body.patch : null;
  if (!message && !patch) return Response.json({ error: '缺少 message 或 patch' }, { status: 400 });
  const history = typeof body.history === 'string' ? body.history.slice(-3000) : '';

  const s = getSession(sessionId);
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctl) {
      const send = (o: unknown) => ctl.enqueue(enc.encode(JSON.stringify(o) + '\n'));
      const emit = (e: AgentEvent) => send(e);
      try {
        if (patch) {
          const clean: Record<string, string> = {};
          for (const k of ['title', 'lead', 'body', 'cta']) if (typeof patch[k] === 'string') clean[k] = patch[k].slice(0, 6000);
          await editDraft(clean, s, emit);
        } else {
          await handleMessage(message, s, emit, history);
        }
      } catch (e: any) {
        send({ type: 'error', text: String(e?.message ?? e) });
      }
      send({ type: 'done', view: toView(s) });
      ctl.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' } });
}
