import { recoverSession } from '../../../lib/store.ts';
import { isCheckCurrent } from '../../../lib/check.ts';
import { validSessionId, SessionStorageError } from '../../../lib/session-store.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 导出：只有核验结果对应当前版本且无拦截项才放行；附依据清单、图片来源与核验报告。 */
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('sessionId') ?? '';
  if (!validSessionId(id)) return Response.json({ error: '工作记录编号无效。' }, { status: 400 });
  let record;
  try { record = recoverSession(id); } catch (error) {
    return Response.json({ error: error instanceof SessionStorageError ? error.message : '工作记录暂时无法读取。' }, { status: 500 });
  }
  if (!record) return Response.json({ error: '会话不存在' }, { status: 404 });
  if (record.busy) return Response.json({ error: '任务仍在进行，完成后再导出。' }, { status: 409 });
  const s = record.session;
  const d = s.draft;
  if (!d) return Response.json({ error: '还没有稿件' }, { status: 409 });
  if (!isCheckCurrent(s.report, d)) return Response.json({ error: '当前版本尚未核验，不能导出' }, { status: 409 });
  const blocks = s.report!.issues.filter((i) => i.severity === 'block');
  if (blocks.length) return Response.json({ error: `还有 ${blocks.length} 个必须处理的问题，不能导出`, issues: blocks }, { status: 409 });

  const usedImages = d.images.map((im) => {
    const ref = s.images?.find((r) => r.id === im.imageId);
    return { imageId: im.imageId, filename: ref?.filename, docId: ref?.docId, model: ref?.modelName, source: ref?.source, sourceUrl: ref?.url, visuallyReviewed: ref?.visuallyReviewed ?? false, description: ref?.caption, position: im.position, caption: im.caption };
  });
  const usedFactIds = new Set(d.claims.flatMap((c) => c.factIds));
  const evidence = (s.evidence ?? []).filter((e) => usedFactIds.has(e.id)).map((e) => ({ id: e.id, doc: e.docTitle, docId: e.docId, docPath: e.docPath, line: e.line, section: e.section, text: e.text, source: e.source, readAt: e.readAt }));

  const publishable = [d.title, d.lead, d.body, d.cta, d.tags.map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' ')].filter(Boolean).join('\n\n');
  return Response.json({
    version: d.version,
    platform: d.platform,
    model: d.modelName,
    publishable,
    images: usedImages,
    claims: d.claims,
    evidence,
    report: s.report,
    imaCallsScope: 'session',
    imaCallsNote: '仅含本会话最近500条知识库调用与缓存使用记录；本稿依据以 evidence 和 images 为准。',
    imaCalls: record.calls,
  }, { headers: { 'cache-control': 'no-store' } });
}
