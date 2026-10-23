import { recoverSession } from '../../../lib/store.ts';
import { validSessionId } from '../../../lib/session-store.ts';
import { currentSceneImages } from '../../../lib/supplementary-images.ts';
import { readSceneImage } from '../../../lib/scene-images.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const sessionId = params.get('sessionId') ?? '';
  const id = params.get('id') ?? '';
  const version = params.get('version') ?? '';
  const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };
  if (!validSessionId(sessionId) || !/^[a-f0-9-]{36}$/.test(id) || !/^[a-f0-9]{64}$/.test(version)) return new Response('图片编号或版本无效。', { status: 400, headers });
  try {
    const record = recoverSession(sessionId);
    const image = record && currentSceneImages(record.session).find(item => item.id === id);
    if (!image) return new Response('当前稿件没有这张配图。', { status: 404, headers });
    if (image.sha256 !== version) return new Response('配图版本已变化，请重新选择。', { status: 409, headers });
    return new Response(new Uint8Array(readSceneImage(image)), { headers: { ...headers, 'content-type': 'image/png',
      'content-disposition': `inline; filename="scene-${image.id}.png"` } });
  } catch { return new Response('配图暂时无法读取，请重新选择。', { status: 502, headers }); }
}
