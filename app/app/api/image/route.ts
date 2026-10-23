import { loadLocalIndex, readLocalImage } from '../../../lib/ima.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 只提供 ima 本地知识库里已登记的图片，不接受任意路径。 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const id = params.get('id') ?? '';
  const version = params.get('version');
  const headers = { 'cache-control': 'private, no-store' };
  if (version !== null && !/^[a-f0-9]{64}$/i.test(version)) {
    return new Response('图片版本无效。', { status: 400, headers });
  }
  if (!id.trim()) return new Response('not found', { status: 404, headers });
  let docs: Awaited<ReturnType<typeof loadLocalIndex>>;
  try {
    docs = await loadLocalIndex({ refresh: true });
  } catch {
    return new Response('图片目录暂时无法读取，请稍后重试。', { status: 503, headers });
  }
  const doc = docs.find((d) => d.id === id);
  if (!doc || !/\.(jpe?g|png|webp)$/i.test(doc.path)) return new Response('not found', { status: 404, headers });
  if (typeof doc.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(doc.sha256)) {
    return new Response('图片缺少可核对的文件版本。', { status: 502, headers });
  }
  if (version !== null && version.toLowerCase() !== doc.sha256.toLowerCase()) {
    return new Response('本稿配图已变化，请重新核对图片后再使用。', { status: 409, headers });
  }
  const r = await readLocalImage(doc);
  if (!r.ok || !r.bytes) return new Response('读取失败', { status: 502, headers });
  const type = /\.png$/i.test(doc.path) ? 'image/png' : /\.webp$/i.test(doc.path) ? 'image/webp' : 'image/jpeg';
  return new Response(new Uint8Array(r.bytes), { headers: { ...headers, 'content-type': type } });
}
