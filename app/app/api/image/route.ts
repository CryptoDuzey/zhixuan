import { loadLocalIndex, readLocalImage } from '../../../lib/ima.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 只提供 ima 本地知识库里已登记的图片，不接受任意路径。 */
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('id') ?? '';
  const docs = await loadLocalIndex();
  const doc = docs.find((d) => d.id === id);
  if (!doc || !/\.(jpe?g|png|webp)$/i.test(doc.path)) return new Response('not found', { status: 404 });
  const r = await readLocalImage(doc);
  if (!r.ok || !r.bytes) return new Response('读取失败', { status: 502 });
  const type = /\.png$/i.test(doc.path) ? 'image/png' : /\.webp$/i.test(doc.path) ? 'image/webp' : 'image/jpeg';
  return new Response(new Uint8Array(r.bytes), { headers: { 'content-type': type, 'cache-control': 'private, max-age=3600' } });
}
