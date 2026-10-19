import { cancelRun } from '../../../../lib/agent-runtime.ts';
import { sessionRepository } from '../../../../lib/store.ts';
import { SessionStorageError, validSessionId } from '../../../../lib/session-store.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'no-store' };

export async function POST(req: Request) {
  let body: unknown;
  try {
    if (!req.body || Number(req.headers.get('content-length')) > 1024) return Response.json({ error: '停止请求无效。' }, { status: 400, headers });
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024) {
          await reader.cancel();
          return Response.json({ error: '停止请求过长。' }, { status: 413, headers });
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return Response.json({ error: '停止请求无效。' }, { status: 400, headers }); }
  const value = body as Record<string, unknown> | null;
  if (!value || Array.isArray(value) || typeof value.sessionId !== 'string' || !validSessionId(value.sessionId)
    || typeof value.runId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.runId)
    || Object.keys(value).some((key) => !['sessionId', 'runId'].includes(key))) {
    return Response.json({ error: '停止请求编号无效。' }, { status: 400, headers });
  }
  try {
    const record = sessionRepository.find(value.sessionId);
    if (!record?.busy || record.run?.id !== value.runId || !cancelRun(value.sessionId, value.runId)) {
      return Response.json({ error: '这项任务已结束或已变化，请恢复最新进度。' }, { status: 409, headers });
    }
    sessionRepository.save(value.sessionId);
    return Response.json({ accepted: true, runId: value.runId }, { status: 202, headers });
  } catch (error) {
    return Response.json({ error: error instanceof SessionStorageError ? error.message : '无法保存停止请求，请恢复最新进度。' }, { status: 500, headers });
  }
}
