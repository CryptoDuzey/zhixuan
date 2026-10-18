import { consult, ConsultError, CONSULT_LIMITS } from '../../../lib/consult.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > CONSULT_LIMITS.bodyBytes) {
    throw new ConsultError(413, '消息过长，请精简后重试。');
  }
  if (!request.body) throw new ConsultError(400, '请提供咨询消息。');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > CONSULT_LIMITS.bodyBytes) {
        await reader.cancel();
        throw new ConsultError(413, '消息过长，请精简后重试。');
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new ConsultError(400, '消息格式无效，请重试。');
  }
}

export async function POST(request: Request): Promise<Response> {
  const headers = { 'cache-control': 'no-store' };
  try {
    return Response.json(await consult(await readBody(request)), { headers });
  } catch (error) {
    const known = error instanceof ConsultError;
    return Response.json({
      error: known ? error.message : '咨询暂时没有完成，请稍后重试。你的问题可以保留后继续。',
    }, { status: known ? error.status : 502, headers });
  }
}
