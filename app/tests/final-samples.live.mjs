// Manual acceptance: real application, model and knowledge service. Writes local-only raw exports.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const base = process.env.FRONTEND_BASE_URL || 'http://localhost:3100';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const folder = path.resolve('../output/final-runs', `复赛-${stamp}`);
mkdirSync(folder, { recursive: true });
const cases = [
  { id: 'moments-travel', platform: '朋友圈', scene: '刚入职、经常差旅，收拾电脑包时比较携带方案',
    prompt: '为 HUAWEI MateBook Pro S 写一条朋友圈，发布者是门店内容运营，读者是刚入职、经常出差的人。围绕出发前收拾电脑包这件事，只讲一个选择理由和一个实用动作，最多一个决定性参数并带版本条件，不要列全系列重量。语气自然，别追求金句、拟人或空泛赞美。90—150字，只用现有图库，配2张真实产品图。不写价格、优惠、亲测、群体口碑和未经证实的软件适配，也不要另外生成场景图。' },
  { id: 'xhs-student', platform: '小红书', scene: '大一新生，课程软件未明确，先比较学习任务与教室外设',
    prompt: '为 HUAWEI MateBook D 14 2024 写小红书。发布者是门店内容运营，读者是准备开学、课程软件要求还没明确的大一新生，正在比较候选而不是马上下单。从写课程报告、带去教室和连接外设的实际任务切入，说清D14值得考虑的条件和取舍，不把职业年龄当需求，不默认所有课程软件都能运行。正文350—550字，恰好3段，配3张现有图库图，示意图不能当作性能或兼容证明。不写价格、优惠、亲测、假学长学姐口碑，不生成新图。用自然短句，不把文章写成参数清单或反复核对的说教。' },
  { id: 'wechat-travel', platform: '公众号', scene: '经常差旅的办公者，比较关键软件、会议外设与携带取舍',
    prompt: '为 HUAWEI MateBook Pro S 写一篇公众号，发布者是门店内容运营，读者是经常出差、正在比较换机方案的办公者。围绕一次真实会遇到的决定展开：常用软件和会议外设还没确认前，不能只凭机身重量选电脑。用条件式描述情境，不编造个人或群体使用故事。说明本型号在当前任务里的依据和取舍，重要限制跟随对应主张，不把全文写成参数百科或每段重复核对清单。标题18—26字、导语48—64字、正文900—1300字且3个具体小标题，配3张现有图库图片，图注18—36字且只描述真实画面。不写价格、优惠、亲测，不保证软件兼容，不生成新图。文字自然克制，可直接发布，不出现生成过程或核查背书。' },
];
async function run(item) {
  const sessionId = `final-${item.id}-${Date.now()}`;
  const started = Date.now();
  const response = await fetch(`${base}/api/agent`, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ sessionId, message: item.prompt }), signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  // Consume the real SSE stream, but keep internal traces out of the review package.
  const wire = await response.text();
  const errors = wire.split('\n\n').flatMap(frame => {
    const raw = frame.split('\n').find(line => line.startsWith('data:'))?.slice(5).trim();
    if (!raw) return [];
    try { const event = JSON.parse(raw); return event.type === 'error' ? [event.text] : []; } catch { return []; }
  });
  const snapshot = await (await fetch(`${base}/api/agent?sessionId=${sessionId}`, { cache: 'no-store' })).json();
  writeFileSync(path.join(folder, `${item.id}.snapshot.json`), JSON.stringify(snapshot, null, 2));
  const exported = await fetch(`${base}/api/export?sessionId=${sessionId}`, { cache: 'no-store' });
  const data = await exported.json();
  writeFileSync(path.join(folder, `${item.id}.export.json`), JSON.stringify(data, null, 2));
  const draft = snapshot.view?.draft;
  if (draft) {
    const content = [draft.title, draft.lead, draft.body, draft.cta, draft.tags?.map(tag => `#${tag.replace(/^#/, '')}`).join(' ')].filter(Boolean).join('\n\n');
    writeFileSync(path.join(folder, `${item.id}.content.md`), content + '\n');
  }
  const summary = { id: item.id, platform: item.platform, scene: item.scene, sessionId, status: snapshot.run?.status,
    exportStatus: exported.status, version: draft?.version, images: draft?.images?.length,
    bodyCharacters: draft?.body?.replace(/\s/g, '').length, title: draft?.title,
    report: snapshot.view?.report?.status, issues: snapshot.view?.report?.issues,
    errors, seconds: Math.round((Date.now() - started) / 1000), editorialReview: 'pending' };
  console.log(JSON.stringify(summary));
  return summary;
}
const results = await Promise.allSettled(cases.map(run));
const manifest = { createdAt: new Date().toISOString(), folder, source: 'real localhost application and providers',
  status: 'candidates awaiting editorial/image review', results: results.map((result, index) => result.status === 'fulfilled'
    ? result.value : { id: cases[index].id, error: String(result.reason), editorialReview: 'not started' }) };
writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ folder, candidates: manifest.results.length, reviewed: 0 }));
