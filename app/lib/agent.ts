// Agent 主流程：需求理解 → 证据/图片检索 → 写作 → 独立核验 → 合并确定性检查 → 改稿。
// 每一步产出事件，供界面显示真实进度；任何一步失败都如实上报，不伪造成功。
import { chatJson } from './llm.ts';
import { PLATFORM_SPEC, REQUIRED_FOOTER, SYSTEM_PROMPT } from './prompts.ts';
import { loadEvidence, loadImages, MODELS, type Evidence, type ImageRef, type ModelEntry } from './facts.ts';
import { IMAGE_RANGE, mergeReports, runDeterministicChecks, type CheckReport, type Draft, type Issue, type Platform } from './check.ts';
import { loadCatalog, type CatalogEntry } from './catalog.ts';
import { answerConversation, createConversationSources, planConversation, UNCONFIRMED_PRODUCT } from './agent-conversation.ts';
import { throwIfStopped } from './agent-runtime.ts';

export interface NeedCard {
  intent: 'create' | 'revise' | 'chat';
  platform?: Platform;
  scene?: string;
  audience?: string;
  facts_from_user: string[];
  unknowns: string[];
  unsupported_requests: string[];
  next_action: 'clarify' | 'write';
  question?: string;
}

export type AgentEvent =
  | { type: 'step'; label: string; detail?: string }
  | { type: 'clarify'; question: string; options?: string[] }
  | { type: 'notice'; text: string }
  | { type: 'need'; need: NeedCard }
  | { type: 'draft'; draft: Draft }
  | { type: 'check'; report: CheckReport }
  | { type: 'error'; text: string };

type Emit = (e: AgentEvent) => void;

export const SNAPSHOT_DATE = '2026-10-17';
const PLATFORMS: Platform[] = ['公众号', '小红书', '朋友圈'];
const UNSUPPORTED = /(到手价|叠加补贴|补贴后|最后一天|今天最后|限时|最低价|全网最低|抢购|手慢无)/g;

/** 可注入离线资料源；生产对话使用动态目录，旧注入源保持确定性守卫语义。 */
export interface AgentSources {
  models: readonly ModelEntry[];
  loadEvidence: typeof loadEvidence;
  loadImages: typeof loadImages;
  catalog?: readonly CatalogEntry[];
}
const DEFAULT_SOURCES: AgentSources = { models: MODELS, loadEvidence, loadImages };

/** 与用户当前任务相关的证据：事实+限制全量，场景卡按受众选取，价格卡仅在被问到价格时带入。 */
export function selectEvidence(all: Evidence[], opts: { audience?: string; scene?: string; wantPrice: boolean }): Evidence[] {
  const hint = `${opts.audience ?? ''}${opts.scene ?? ''}`;
  const student = /学生|新生|开学|大学|课程|校园/.test(hint);
  const biz = /差旅|出差|商务|办公|会议|客户|演示/.test(hint);
  return all.filter((e) => {
    if (e.kind === 'fact' || e.kind === 'limit') return true;
    if (e.kind === 'price') return opts.wantPrice;
    if (e.kind === 'scene') return e.docTitle.includes('学生') ? student || !biz : biz || !student;
    return false;
  });
}

const evText = (list: Evidence[]) => list.map((e) => `[${e.id}|${e.docTitle}${e.section ? '·' + e.section : ''}] ${e.text}`).join('\n');
const imgText = (list: ImageRef[]) =>
  list.map((i) => `[${i.id}] 型号=${i.modelName}｜${i.visuallyReviewed === true
    ? `已人工看图复核；实际画面描述=${i.caption || '（无描述）'}`
    : `未人工看图复核；索引类别=${i.purpose}；索引说明=${i.caption || '（无）'}（仅用于检索，不能证明画面内容）`
  }｜${i.width}×${i.height}`).join('\n');

const IMAGE_CAPTION_RULES = `图注规则：已人工看图复核的实际画面描述优先于索引类别、文件名及索引说明，图注不能与实际画面描述矛盾。
未复核索引不能证明画面里的人物、动作、颜色或具体功能；即使图注照抄类别或索引说明，也不自动视为有依据。无法确认的画面内容须标为待确认，不得猜测。
画面描述只能支持可见内容，不能证明产品功能、参数或效果；功能、参数、效果仍须有产品事实证据。`;

function writingSystem(sources: AgentSources): string {
  return sources.catalog
    ? `${SYSTEM_PROMPT}

# 本轮动态目录草稿
本轮允许先交付文字草稿。图片清单不足是平台配图数量要求的例外：先完成文字，无图时 images=[]，不得凑图；配图不足由核验报告提示发布前补齐。
产品发现卡或空证据只支持有边界的场景草稿，规格、价格及适配空缺明确待确认；不因缺资料停止所有文字创作。事实引用须原样保留完整 catalog:...:E... 编号。`
    : SYSTEM_PROMPT;
}

/** 去重：被更长条目包含的短条目视为重复（如“到手价”与“叠加补贴到手价”）。 */
export function dedupeByContainment(items: string[]): string[] {
  const uniq = [...new Set(items.map((s) => s.trim()).filter(Boolean))];
  return uniq.filter((a) => !uniq.some((b) => b !== a && b.includes(a)));
}

export function understandPrompt(userText: string, history: string, model?: ModelEntry, models: readonly ModelEntry[] = MODELS): string {
  return `分析用户这一轮的营销创作需求，只输出 JSON：
{"intent":"create|revise|chat","platform":"公众号|小红书|朋友圈|null","scene":"一句话场景","audience":"内容读者","facts_from_user":["用户明确说的"],"unknowns":["仍未知且影响内容的"],"unsupported_requests":["用户要求但无依据、不能写进稿件的内容，如补贴叠加到手价、今天最后一天"],"next_action":"clarify|write","question":"需要追问时的一个问题"}
规则：
- 平台、场景（谁在什么情境）都不明确时 next_action=clarify，并只问 1 个最关键的问题；能合理假设就 write，并把假设放进 unknowns。
- 用户要求限时/最后一天/叠加补贴到手价/最低价等，记入 unsupported_requests，但不阻止创作。
- 已接入产品：${models.filter((m) => m.ready).map((m) => `${m.name}（${m.system}）`).join('；')}。
- 当前选定产品：${model?.name ?? '未选择'}。系统/版本：${model?.system ?? '待确认'}。需求只能属于当前产品，不能沿用其他型号的参数、需求或稿件。
- MateBook 14 必须区分鸿蒙与 Windows / 酷睿 Ultra 版本；缺少产品选择时先澄清。
${history ? `对话历史：\n${history}\n` : ''}用户：${userText}`;
}

export async function understand(userText: string, history = '', model?: ModelEntry, models: readonly ModelEntry[] = MODELS): Promise<NeedCard> {
  const { data } = await chatJson<any>(
    [
      { role: 'system', content: '你是营销创作 Agent 的需求理解模块。只输出一个 JSON 对象。' },
      { role: 'user', content: understandPrompt(userText, history, model, models) },
    ],
    { purpose: 'understand', temperature: 0.1, maxTokens: 900 },
  );
  const platform = PLATFORMS.includes(data.platform) ? (data.platform as Platform) : undefined;
  const regexHits = [...new Set(userText.match(UNSUPPORTED) ?? [])];
  const unsupported = dedupeByContainment([...(Array.isArray(data.unsupported_requests) ? data.unsupported_requests.map(String) : []), ...regexHits]);
  const need: NeedCard = {
    intent: ['create', 'revise', 'chat'].includes(data.intent) ? data.intent : 'create',
    platform,
    scene: data.scene || undefined,
    audience: data.audience || undefined,
    facts_from_user: Array.isArray(data.facts_from_user) ? data.facts_from_user : [],
    unknowns: Array.isArray(data.unknowns) ? data.unknowns : [],
    unsupported_requests: unsupported,
    next_action: data.next_action === 'clarify' ? 'clarify' : 'write',
    question: data.question || undefined,
  };
  if (!need.platform && need.next_action === 'write') {
    need.next_action = 'clarify';
    need.question ||= '这篇想发在哪个平台：公众号、小红书，还是朋友圈？';
  }
  return need;
}

function writerPrompt(need: NeedCard, platform: Platform, ev: Evidence[], images: ImageRef[], model: ModelEntry, extra = ''): string {
  const [min, max] = IMAGE_RANGE[platform];
  return `## 任务
产品：${model.name}；系统/版本：${model.system}
平台：${platform}（图片 ${min}-${max} 张；不得重复使用同一图片或借用其他型号图片）
场景：${need.scene ?? '未说明'}；读者：${need.audience ?? '未说明'}
用户明确说的：${need.facts_from_user.join('；') || '无'}
未知项（正文不得当作已知）：${need.unknowns.join('；') || '无'}
不可写进稿件的要求：${need.unsupported_requests.join('；') || '无'}
${extra}
## 平台说明
${PLATFORM_SPEC[platform]}
正文末尾或 CTA 中必须含这句话：${REQUIRED_FOOTER}

## 证据清单（产品事实只能出自这里）
${evText(ev)}

## 图片清单（只能按 imageId 选用）
${imgText(images)}
${IMAGE_CAPTION_RULES}
未复核图片只用中性图注（如“产品配图”），不得由类别名编写人物、使用场景或功能演示。

## 输出
只输出一个 JSON 对象：
{"title":"","lead":"","body":"","cta":"","tags":[],"images":[{"imageId":"IMG1","position":"导语后","caption":""}],"claims":[{"id":"C1","text":"稿件中的一个产品事实主张原句","factIds":["E001"]}]}
claims 要覆盖正文里每一条产品事实（参数、功能、限制），factIds 必须原样使用清单中的完整编号（包括 catalog: 前缀），不得缩写成 E001。
图片清单不足时仍完成文字草稿，只选真实已有图片；无图时 images=[]，不得编造图片或跨型号补位。
资料仅支持产品发现或尚无证据时，写有用的场景/需求草稿，明确标出待确认的规格及资料空缺，不把发现卡推断成参数或适配结论。`;
}

function toDraft(data: any, base: { version: number; platform: Platform; modelId: string; modelName: string }): Draft {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    ...base,
    title: str(data.title),
    lead: str(data.lead),
    body: str(data.body),
    cta: str(data.cta),
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    images: Array.isArray(data.images)
      ? data.images.map((i: any) => ({ imageId: str(i.imageId), position: str(i.position), caption: str(i.caption) }))
      : [],
    claims: Array.isArray(data.claims)
      ? data.claims.map((c: any, n: number) => ({ id: str(c.id) || `C${n + 1}`, text: str(c.text), factIds: Array.isArray(c.factIds) ? c.factIds.map(String) : [] }))
      : [],
  };
}

/** 引用存在性：claim 绑定的证据编号必须真实存在。 */
export function checkClaimRefs(d: Draft, ev: Evidence[]): Issue[] {
  const ids = new Set(ev.map((e) => e.id));
  const out: Issue[] = [];
  for (const c of d.claims) {
    if (!c.factIds.length) out.push({ type: 'evidence', location: c.text.slice(0, 30), text: c.text, reason: '该主张没有绑定任何依据', action: '待确认', severity: 'block' });
    for (const f of c.factIds) {
      if (!ids.has(f)) out.push({ type: 'fabricated', location: c.text.slice(0, 30), text: f, reason: `引用的依据 ${f} 不存在`, action: '删除', severity: 'block' });
    }
  }
  return out;
}

export async function verifyEvidence(d: Draft, ev: Evidence[], images: ImageRef[] = []): Promise<Omit<CheckReport, 'draftVersion' | 'checkedAt'>> {
  const used = d.images.map((i) => images.find((r) => r.id === i.imageId)).filter((r): r is ImageRef => !!r);
  const prompt = `你是独立核验员。对照证据原文检查稿件，不采信写作者的任何“已验证”。只输出 JSON：
{"issues":[{"type":"evidence|conflict|fabricated|absolute","location":"稿件中的具体位置（如正文第2段）","text":"稿件中的原句","reason":"原文只支持…/限制丢失…","action":"删除|改写|补充条件|待确认","severity":"block|warn"}],"verified_claim_ids":["C1"]}
检查点：1 事实是否被证据原文支持；2 限制条件是否保留（典型值、仅特定版本支持、需实测）；3 是否越界推断（由电池容量推续航、由芯片推性能、由单一参数推量化效率）；4 兼容性是否绑定版本；5 正文里没写进 claims 的产品事实也要核对；6 是否有证据没有的参数、价格、功能。
${IMAGE_CAPTION_RULES}
图注与实际画面描述冲突，或仅凭未复核索引声称有人物、动作、功能时，必须列入 issues，不能放行。按每张图片的 imageId 核对对应图注。
只有被证据明确支持且限制齐全的 claim 才能进 verified_claim_ids。没有问题时 issues 为空数组。

## 证据
${evText(ev)}

## 图片资料（稿件所选，逐张标注复核状态）
${used.length ? imgText(used) : '无'}

## 稿件（版本 ${d.version}，平台 ${d.platform}）
标题：${d.title}
导语：${d.lead}
正文：${d.body}
CTA：${d.cta}
图注：${d.images.map((i) => `[${i.imageId}] ${i.caption}`).join(' / ')}

## claims
${d.claims.map((c) => `${c.id}｜${c.text}｜依据 ${c.factIds.join(',')}`).join('\n')}`;
  const { data } = await chatJson<any>(
    [
      { role: 'system', content: '你是严格的事实核验模块，只依据给定证据判断。只输出 JSON。' },
      { role: 'user', content: prompt },
    ],
    { purpose: 'verify', temperature: 0, maxTokens: 2500 },
  );
  const claimIds = new Set(d.claims.map((c) => c.id));
  const issues: Issue[] = (Array.isArray(data.issues) ? data.issues : []).map((i: any) => ({
    type: ['evidence', 'conflict', 'fabricated', 'absolute'].includes(i.type) ? i.type : 'evidence',
    location: String(i.location ?? ''),
    text: String(i.text ?? ''),
    reason: String(i.reason ?? ''),
    action: ['删除', '改写', '补充条件', '待确认', '替换图片'].includes(i.action) ? i.action : '改写',
    severity: i.severity === 'warn' ? 'warn' : 'block',
  }));
  const flagged = new Set(issues.filter((i) => i.severity === 'block').map((i) => i.text));
  const verified = (Array.isArray(data.verified_claim_ids) ? data.verified_claim_ids : [])
    .map(String)
    .filter((id: string) => claimIds.has(id) && !flagged.has(d.claims.find((c) => c.id === id)?.text ?? '\0'));
  return { status: 'pass', issues, verifiedClaimIds: verified, verifiedImageIds: [] };
}

export async function checkDraft(d: Draft, ev: Evidence[], images: ImageRef[], snapshotDate?: string): Promise<CheckReport> {
  const det = runDeterministicChecks(d, images, { snapshotDate });
  det.issues.push(...checkClaimRefs(d, ev));
  const evi = await verifyEvidence(d, ev, images);
  return mergeReports(det, evi);
}

export interface Session {
  need?: NeedCard;
  modelId: string;
  modelName: string;
  draft?: Draft;
  report?: CheckReport;
  evidence?: Evidence[];
  images?: ImageRef[];
  modelGuard?: { kind: 'choose' | 'multiple' | 'mb14-version' } | { kind: 'unsupported'; modelId: string; modelName: string };
  modelHistory?: string[];
}

export const newSession = (): Session => ({ modelId: '', modelName: '' });

// 明确产品名才改变型号；短答系统版本只在 MateBook 14 的上下文中解释。
const MODEL_MENTION = /matebook[\s-]*(?:pro[\s-]*s(?![a-z0-9])|(?:d[\s-]*)?\d+(?:[\s-]*(?:se|plus|pro|x|s)(?![a-z0-9]))?|x(?:[\s-]*pro)?|gt|e(?:[\s-]*go)?|[a-z0-9]+)?|(?<![a-z0-9])(?:d[\s-]*\d+(?:[\s-]*(?:se|plus|pro|x|s)(?![a-z0-9]))?|pro[\s-]*s)(?![a-z0-9])/gi;

function modelRejected(text: string, index: number, end: number): boolean {
  const before = text.slice(0, index).split(/[，,。；;！!？?\n]/).at(-1) ?? '';
  const after = text.slice(end).split(/[，,。；;！!？?\n]/)[0];
  // 只识别直接修饰型号的否定；“不要把 D16 写成 Pro S”仍在请求 D16。
  return /(?:不要|不用|别|不选|不写|不改用|不换成|不是|不考虑|不想|拒绝|不需要|不使用|不选择|不能|不可以|不打算|没|未)(?:要|再|继续)?(?:使用|选择|选用|改用|换成|写|用|选)?\s*(?:huawei\s*)?$/i.test(before)
    || /(?:不要|别|不能).*(?:写成|当成|改成)\s*(?:huawei\s*)?$/i.test(before)
    || /^\s*(?:(?:也|先|暂时)?(?:不要|不用|不选|不写|不考虑|不需要)(?:了)?)(?:\s*$|[，,。；;])/.test(after);
}

function explicitlySelects(text: string, index: number, length: number): boolean {
  // 阻断后，提问、假设和仅在谈论产品都不代表同意切换。
  if (/[？?]|吗|么|如果|假如|要是|能否|能不能|是否|为什么|怎么样|有什么|考虑|想了解|想知道/.test(text)) return false;
  const before = text.slice(0, index).split(/[，,。；;！!？?\n]/).at(-1) ?? '';
  const after = text.slice(index + length);
  if (/不|别|没|未|拒绝|并非|避免/.test(before) || /^\s*(?:也|先|暂时)?(?:不|别|拒绝)/.test(after)) return false;
  if (/本轮产品选择[:：]\s*(?:huawei\s*)?$/i.test(before)) return true;
  if (/^\s*(?:huawei\s*)?$/i.test(before) && /^\s*[。！!]*$/.test(after)) return true;
  if (/(?:改用|改成|换成|换用|选用|选择|就选|选|使用|用|写|创作|生成|那就|还是)\s*(?:huawei\s*)?$/i.test(before)) return true;
  return /^\s*(?:来写|来做|写|吧|就行|即可)/.test(after);
}

function mb14Version(text: string): string | undefined {
  const versions = new Set<string>();
  for (const m of text.matchAll(/windows|\bwin(?:10|11)?\b|酷睿(?:\s*ultra)?|ultra|鸿蒙(?:电脑|版)?|harmony(?:os)?/gi)) {
    if (!modelRejected(text, m.index, m.index + m[0].length)) {
      versions.add(/鸿蒙|harmony/i.test(m[0]) ? 'mb14-harmony' : 'mb14-ultra');
    }
  }
  return versions.size === 1 ? [...versions][0] : undefined;
}

function modelMentions(text: string) {
  return [...text.matchAll(MODEL_MENTION)].map((m) => {
    const key = m[0].replace(/[\s-]+/g, '').toLowerCase().replace(/^matebook/, '');
    const id = key === 'pros' ? 'pro-s' : key === '14' ? mb14Version(text) ?? 'mb14' : /^(d14|d16)$/.test(key) ? key : `unsupported-${key || 'matebook'}`;
    return { id, name: m[0], index: m.index, length: m[0].length, rejected: modelRejected(text, m.index, m.index + m[0].length) };
  });
}

function clearWork(s: Session) {
  s.need = undefined;
  s.draft = undefined;
  s.report = undefined;
  s.evidence = undefined;
  s.images = undefined;
}

function remember(s: Session, text: string) {
  const history = s.modelHistory ?? [];
  if (history.at(-1) !== text) history.push(text);
  s.modelHistory = history.slice(-12);
}

function selectModel(s: Session, id: string, name: string, preserveHistory = false) {
  if (s.modelId !== id) {
    clearWork(s);
    if (!preserveHistory) s.modelHistory = [];
  }
  s.modelId = id;
  s.modelName = name;
  s.modelGuard = undefined;
}

/** 旧注入源保留原守卫；动态目录由模型理解后选择精确产品。 */
function guardModel(text: string, s: Session, emit: Emit, sources: AgentSources): boolean {
  if (sources.catalog) {
    s.modelGuard = undefined;
    return false;
  }
  const normalized = text.normalize('NFKC');
  const all = modelMentions(normalized);
  const mentions = all.filter((m) => !m.rejected);
  const unsupported = mentions.find((m) => m.id.startsWith('unsupported-'));
  const ids = new Set(mentions.map((m) => m.id));
  if (unsupported) {
    selectModel(s, unsupported.id, unsupported.name);
    s.modelGuard = { kind: 'unsupported', modelId: s.modelId, modelName: s.modelName };
  } else if (ids.size > 1) {
    selectModel(s, '', '');
    s.modelGuard = { kind: 'multiple' };
  } else if (mentions.length) {
    const mention = mentions[0];
    const canSelect = !s.modelGuard || s.modelGuard.kind === 'choose' || s.modelGuard.kind === 'mb14-version'
      || explicitlySelects(normalized, mention.index, mention.length);
    if (canSelect) {
      const preserve = s.modelGuard?.kind === 'mb14-version' && mention.id.startsWith('mb14')
        || !s.modelId && (!s.modelGuard || s.modelGuard.kind === 'choose');
      const model = sources.models.find((m) => m.id === mention.id);
      selectModel(s, mention.id, model?.name ?? 'HUAWEI MateBook 14（待确认版本）', preserve);
      if (mention.id === 'mb14') s.modelGuard = { kind: 'mb14-version' };
    }
  } else if (all.some((m) => m.rejected && (m.id === s.modelId || m.id === 'mb14' && s.modelId.startsWith('mb14')))) {
    selectModel(s, '', '');
    s.modelGuard = { kind: 'choose' };
  } else if (s.modelId.startsWith('mb14') && (!s.modelGuard || s.modelGuard.kind === 'mb14-version')) {
    const version = mb14Version(normalized);
    if (version) {
      const model = sources.models.find((m) => m.id === version);
      selectModel(s, version, model?.name ?? version, s.modelGuard?.kind === 'mb14-version');
    } else if (/windows|\bwin(?:10|11)?\b|酷睿|ultra|鸿蒙|harmony/i.test(normalized)) {
      // 只否定系统或同时谈到两个系统，不能继续沿用被否定的版本。
      selectModel(s, 'mb14', 'HUAWEI MateBook 14（待确认版本）');
      s.modelGuard = { kind: 'mb14-version' };
    }
  }
  if (!s.modelGuard) {
    const model = sources.models.find((m) => m.id === s.modelId);
    if (!s.modelId) s.modelGuard = { kind: 'choose' };
    else if (!model?.ready) s.modelGuard = { kind: 'unsupported', modelId: s.modelId, modelName: s.modelName };
    else s.modelName = model.name;
  }
  if (!s.modelGuard) return false;

  // done 事件会把会话交给界面；撤销旧稿，避免换型号后仍显示“已完成”。
  clearWork(s);
  remember(s, text);
  const options = sources.models.filter((m) => m.ready).map((m) => m.name);
  if (s.modelGuard.kind === 'mb14-version') {
    emit({
      type: 'clarify',
      question: '“MateBook 14”有鸿蒙电脑和 Windows（酷睿 Ultra）两个版本，你说的是哪一个？确认版本后再写稿。',
      options: ['MateBook 14 鸿蒙电脑', 'MateBook 14 Windows（酷睿 Ultra）'],
    });
  } else if (s.modelGuard.kind === 'unsupported') {
    emit({ type: 'notice', text: `${s.modelName} 的资料尚未接入，已停止写稿和改稿，并撤销旧稿的完成状态。请明确选择一个已接入产品：${options.join('、')}。` });
  } else {
    emit({
      type: 'clarify',
      question: s.modelGuard.kind === 'multiple'
        ? '这一轮包含多个产品，请先选择一个产品分别创作，避免混用资料。'
        : '你好！想用于什么用途或场景？准备为下面哪一款产品创作？',
      options,
    });
  }
  return true;
}

/** 需求卡只能校验当前选择，不能反过来用旧需求切换产品。 */
function guardNeed(need: NeedCard, s: Session, emit: Emit, sources?: AgentSources): boolean {
  // 动态产品已由路由选择精确目录 ID，不能再用五款正则把新产品误判为冲突。
  if (sources?.catalog) {
    if (!s.draft || s.draft.modelId === s.modelId) return false;
    clearWork(s);
    emit({ type: 'clarify', question: '产品已切换，请按当前产品继续创作。' });
    return true;
  }
  const text = [need.scene, need.audience, ...need.facts_from_user].filter(Boolean).join('\n').normalize('NFKC');
  const conflict = modelMentions(text).some((m) => !m.rejected && m.id !== s.modelId && !(m.id === 'mb14' && s.modelId.startsWith('mb14-')));
  if (!conflict && (!s.draft || s.draft.modelId === s.modelId)) return false;
  clearWork(s);
  s.modelHistory = [];
  emit({ type: 'clarify', question: `旧需求或稿件包含其他型号，已撤销。请重新说明 ${s.modelName} 的平台、用途和受众。` });
  return true;
}

async function understandForSession(text: string, s: Session, sources: AgentSources): Promise<NeedCard> {
  const history = (s.modelHistory ?? []).join('\n');
  remember(s, text);
  return understand(text, history, sources.models.find((m) => m.id === s.modelId), sources.models);
}

function uniqueModelImages(images: ImageRef[], modelId: string): ImageRef[] {
  const ids = new Set<string>();
  const assets = new Set<string>();
  return images.filter((image) => {
    const asset = image.docId || image.url || image.filename;
    if (image.modelId !== modelId || ids.has(image.id) || assets.has(asset)) return false;
    ids.add(image.id);
    assets.add(asset);
    return true;
  });
}

function guardImageSupply(platform: Platform, s: Session, emit: Emit): boolean {
  const count = s.images?.length ?? 0;
  const min = IMAGE_RANGE[platform][0];
  if (count >= min) return false;
  s.draft = undefined;
  s.report = undefined;
  const options = PLATFORMS.filter((p) => IMAGE_RANGE[p][0] <= count);
  const question = `${s.modelName} 当前只有 ${count} 张可用且不重复的本型号图片，${platform}至少需要 ${min} 张。缺少素材，暂不写稿；不会重复或跨型号凑图。${options.length ? `请改用${options.join('或')}，可以吗？` : '请先补充本型号图片。'}`;
  if (s.need) s.need = { ...s.need, next_action: 'clarify', question };
  emit({ type: 'clarify', question, options });
  return true;
}

function restrictDraftImages(d: Draft, images: ImageRef[]): Draft {
  const allowed = new Set(images.map((i) => i.id));
  const seen = new Set<string>();
  return {
    ...d,
    images: d.images.filter((i) => {
      if (!allowed.has(i.imageId) || seen.has(i.imageId)) return false;
      seen.add(i.imageId);
      return true;
    }),
  };
}

/** 生产默认入口：模型先理解意图，目录提供产品边界，写作仍使用独立证据核验。 */
async function handleCatalogMessage(text: string, s: Session, emit: Emit, history = ''): Promise<Session> {
  emit({ type: 'step', label: '理解需求与查阅产品目录' });
  const catalog = await loadCatalog();
  const sources = createConversationSources(catalog);
  s.modelGuard = undefined;
  const conversation = [history, ...(s.modelHistory ?? [])].filter(Boolean).join('\n').slice(-6000);
  const plan = await planConversation(text, conversation, s, catalog);
  const need = plan.need;
  need.unsupported_requests = dedupeByContainment([
    ...need.unsupported_requests, ...new Set(text.match(UNSUPPORTED) ?? []),
  ]);

  if (need.intent === 'chat') {
    const evidence: Evidence[] = [];
    for (const id of plan.evidenceModelIds) evidence.push(...await sources.loadEvidence(id, { withRules: false }));
    const reply = evidence.length || plan.evidenceModelIds.length || !plan.reply
      ? await answerConversation(text, conversation, evidence, { modelId: plan.modelId, need: s.need, draft: s.draft })
      : plan.reply;
    remember(s, `用户：${text}`);
    remember(s, `助手：${reply}`);
    emit({ type: 'notice', text: reply });
    return s;
  }

  if (need.next_action === 'clarify') {
    // 指定版本不清时旧稿不得继续带着完成状态，但保留本次用途供短答续接。
    const oldVersion = (s.draft?.version ?? 0);
    clearWork(s);
    s.modelId = '';
    s.modelName = '';
    remember(s, `用户：${text}`);
    s.need = need;
    emit({ type: 'need', need });
    const question = need.question || plan.reply || '这次内容最想解决读者的哪个问题？';
    remember(s, `助手：${question}${oldVersion ? '（旧稿已撤销）' : ''}`);
    emit({ type: 'clarify', question });
    return s;
  }

  const modelId = plan.modelId ?? UNCONFIRMED_PRODUCT;
  const model = sources.models.find((item) => item.id === modelId)!;
  const sameProduct = s.modelId === modelId && s.draft?.modelId === modelId;
  const previousNeed = sameProduct ? s.need : undefined;
  selectModel(s, modelId, model.name);
  remember(s, `用户：${text}`);
  const entry = catalog.find((item) => item.id === modelId);
  if (!entry || entry.level === 'discovery') {
    need.unknowns = [...new Set([...need.unknowns, '完整产品规格、配置、兼容性及限制资料待补充'])];
    emit({ type: 'notice', text: '这款完整规格资料尚不齐全，先按已知资料写文字草稿；空缺会明确标注，参数不作推断。' });
  }
  const merged: NeedCard = {
    ...need,
    ...(previousNeed ? {
      scene: need.scene || previousNeed.scene,
      audience: need.audience || previousNeed.audience,
      facts_from_user: [...new Set([...previousNeed.facts_from_user, ...need.facts_from_user])],
      unknowns: [...new Set([...previousNeed.unknowns, ...need.unknowns])],
      unsupported_requests: dedupeByContainment([...previousNeed.unsupported_requests, ...need.unsupported_requests]),
    } : {}),
  };
  s.need = merged;
  emit({ type: 'need', need: merged });
  if (merged.unsupported_requests.length) emit({ type: 'notice', text: `没有资料依据，不会写进稿件：${merged.unsupported_requests.join('、')}` });
  if (sameProduct && need.intent === 'revise' && s.draft && merged.platform === s.draft.platform) {
    return reviseDraft(text, s, emit, sources);
  }
  return writeFromNeed(merged, text, s, emit, sources);
}

export async function createDraft(userText: string, s: Session, emit: Emit, _history = '', sources: AgentSources = DEFAULT_SOURCES): Promise<Session> {
  if (sources === DEFAULT_SOURCES) return handleCatalogMessage(userText, s, emit, _history);
  if (guardModel(userText, s, emit, sources)) return s;
  emit({ type: 'step', label: '理解需求' });
  const need = await understandForSession(userText, s, sources);
  s.need = need;
  emit({ type: 'need', need });
  if (need.next_action === 'clarify') {
    emit({ type: 'clarify', question: need.question ?? '能再说具体一点吗？' });
    return s;
  }
  if (need.unsupported_requests.length) {
    emit({ type: 'notice', text: `资料里没有依据，不会写进稿件：${need.unsupported_requests.join('、')}` });
  }
  return writeFromNeed(need, userText, s, emit, sources);
}

/** 根据需求卡取证据、写稿并核验。换平台/换场景时版本号延续，旧核验自动失效。 */
export async function writeFromNeed(need: NeedCard, userText: string, s: Session, emit: Emit, sources: AgentSources = DEFAULT_SOURCES): Promise<Session> {
  if (sources === DEFAULT_SOURCES) return handleCatalogMessage(userText, s, emit, JSON.stringify({ proposedNeed: need }));
  const previousModel = s.modelId;
  const previousNeed = s.need;
  if (guardModel(userText, s, emit, sources)) return s;
  if (previousModel !== s.modelId && need === previousNeed) {
    clearWork(s);
    emit({ type: 'clarify', question: `已切换为 ${s.modelName}，请重新说明这款产品的平台、用途和受众。` });
    return s;
  }
  if (guardNeed(need, s, emit, sources)) return s;
  remember(s, userText);
  const platform = need.platform;
  if (!platform || !PLATFORMS.includes(platform)) {
    emit({ type: 'clarify', question: '这篇想发在哪个平台：公众号、小红书，还是朋友圈？', options: PLATFORMS });
    return s;
  }
  const model = sources.models.find((m) => m.id === s.modelId)!;
  const version = (s.draft?.version ?? 0) + 1;
  s.need = need;
  emit({ type: 'step', label: '核对产品资料', detail: model.name });
  const all = await sources.loadEvidence(model.id, { withRules: false });
  let images: ImageRef[];
  try {
    images = uniqueModelImages(await sources.loadImages(model.id), model.id);
  } catch (error) {
    if (!sources.catalog) throw error;
    // 缺图片索引不妨碍有证据的文字；取消和预算错误仍应传到任务层。
    throwIfStopped();
    images = [];
    emit({ type: 'notice', text: '本型号图片暂时无法读取，先生成文字草稿，发布前需要补图。' });
  }
  const wantPrice = /价格|多少钱|售价|预算|报价/.test(userText);
  const ev = selectEvidence(all, { audience: need.audience, scene: need.scene, wantPrice });
  s.evidence = ev;
  s.images = images;
  emit({ type: 'step', label: '调用资料与图片', detail: `${ev.length} 条证据 · ${images.length} 张官方图片` });
  if (sources.catalog) {
    if (images.length < IMAGE_RANGE[platform][0]) emit({ type: 'notice', text: `${model.name} 配图不足，先交付文字草稿；发布前需要补图，不借用其他产品图片。` });
  } else if (guardImageSupply(platform, s, emit)) return s;

  emit({ type: 'step', label: `撰写${platform}稿件` });
  const { data } = await chatJson<any>(
    [
      { role: 'system', content: writingSystem(sources) },
      { role: 'user', content: writerPrompt(need, platform, ev, images, model) },
    ],
    { purpose: 'write', temperature: 0.5, maxTokens: 4500, timeoutMs: 180_000 },
  );
  const draft = restrictDraftImages(toDraft(data, { version, platform, modelId: model.id, modelName: model.name }), images);
  s.draft = draft;
  s.report = undefined;
  emit({ type: 'draft', draft });

  emit({ type: 'step', label: '核验事实与图片' });
  s.report = await checkDraft(draft, ev, images, SNAPSHOT_DATE);
  emit({ type: 'check', report: s.report });
  return s;
}

/** 默认由模型理解自由对话；注入源保留原创作流程。 */
export async function handleMessage(text: string, s: Session, emit: Emit, history = '', sources: AgentSources = DEFAULT_SOURCES): Promise<Session> {
  if (sources === DEFAULT_SOURCES) return handleCatalogMessage(text, s, emit, history);
  if (guardModel(text, s, emit, sources)) return s;
  if (!s.draft || !s.need) return createDraft(text, s, emit, history, sources);
  if (guardNeed(s.need, s, emit, sources)) return s;
  emit({ type: 'step', label: '理解需求' });
  const n = await understandForSession(text, s, sources);
  if (n.intent === 'chat') {
    emit({ type: 'notice', text: await answerConversation(text, history, s.evidence ?? [], { modelName: s.modelName, need: s.need }) });
    return s;
  }
  const prev = s.need;
  const platformChanged = !!n.platform && n.platform !== s.draft.platform;
  if (n.next_action === 'clarify' && !platformChanged) {
    emit({ type: 'clarify', question: n.question ?? '请补充本次修改的用途或平台。' });
    return s;
  }
  if (platformChanged || n.intent === 'create') {
    const merged: NeedCard = {
      ...prev,
      ...n,
      platform: n.platform ?? s.draft.platform,
      scene: n.scene ?? prev.scene,
      audience: n.audience ?? prev.audience,
      facts_from_user: [...new Set([...prev.facts_from_user, ...n.facts_from_user])],
      unknowns: n.unknowns,
      unsupported_requests: dedupeByContainment([...prev.unsupported_requests, ...n.unsupported_requests]),
      next_action: 'write',
    };
    emit({ type: 'need', need: merged });
    if (n.unsupported_requests.length) emit({ type: 'notice', text: `资料里没有依据，不会写进稿件：${n.unsupported_requests.join('、')}` });
    emit({ type: 'step', label: platformChanged ? `换到${merged.platform}，重新规划结构` : '换场景，重新选择切入角度' });
    return writeFromNeed(merged, text, s, emit, sources);
  }
  if (n.unsupported_requests.length) {
    s.need = { ...prev, unsupported_requests: dedupeByContainment([...prev.unsupported_requests, ...n.unsupported_requests]) };
    emit({ type: 'notice', text: `资料里没有依据，不会写进稿件：${n.unsupported_requests.join('、')}` });
  }
  return reviseDraft(text, s, emit, sources);
}

/** 按指令改稿（表达调整/换卖点/换受众等）。版本号加一，旧核验自动失效，随后重新核验。 */
export async function reviseDraft(instruction: string, s: Session, emit: Emit, sources: AgentSources = DEFAULT_SOURCES): Promise<Session> {
  if (sources === DEFAULT_SOURCES) return handleCatalogMessage(instruction, s, emit);
  if (guardModel(instruction, s, emit, sources)) return s;
  if (s.need && guardNeed(s.need, s, emit, sources)) return s;
  if (!s.draft || !s.evidence || !s.images || !s.need) {
    emit({ type: 'error', text: '还没有可修改的稿件' });
    return s;
  }
  const d = s.draft;
  s.images = uniqueModelImages(s.images, s.modelId);
  if (!sources.catalog && guardImageSupply(d.platform, s, emit)) return s;
  const model = sources.models.find((m) => m.id === s.modelId)!;
  emit({ type: 'step', label: '按你的要求改稿' });
  const prompt = writerPrompt(s.need, d.platform, s.evidence, s.images, model, `## 现有稿件（版本 ${d.version}）\n${JSON.stringify({ title: d.title, lead: d.lead, body: d.body, cta: d.cta, tags: d.tags, images: d.images, claims: d.claims })}\n\n## 用户修改要求\n${instruction}\n只改需要改的部分；不得引入证据清单之外的新事实；修改后 claims 必须同步更新。\n`);
  const { data } = await chatJson<any>(
    [
      { role: 'system', content: writingSystem(sources) },
      { role: 'user', content: prompt },
    ],
    { purpose: 'revise', temperature: 0.4, maxTokens: 4500, timeoutMs: 180_000 },
  );
  const next = restrictDraftImages(toDraft(data, { version: d.version + 1, platform: d.platform, modelId: s.modelId, modelName: s.modelName }), s.images);
  s.draft = next;
  s.report = undefined;
  emit({ type: 'draft', draft: next });
  emit({ type: 'step', label: '重新核验' });
  s.report = await checkDraft(next, s.evidence, s.images, SNAPSHOT_DATE);
  emit({ type: 'check', report: s.report });
  return s;
}

/** 用户直接编辑稿件文字：版本加一，核验作废并重跑。 */
export async function editDraft(patch: Partial<Pick<Draft, 'title' | 'lead' | 'body' | 'cta'>>, s: Session, emit: Emit, sources: AgentSources = DEFAULT_SOURCES): Promise<Session> {
  if (sources === DEFAULT_SOURCES) {
    sources = createConversationSources(await loadCatalog());
    // 兼容已保存的五款旧稿，但不跨系统转换，不替换其原有证据引用。
    const entry = sources.catalog!.find((item) => item.id === s.modelId || item.creativeModelId === s.modelId);
    if (entry && s.draft?.modelId === s.modelId) {
      s.modelId = entry.id;
      s.modelName = entry.name;
      s.draft = { ...s.draft, modelId: entry.id, modelName: entry.name };
      s.images = s.images?.map((image) => image.modelId === entry.creativeModelId ? { ...image, modelId: entry.id, modelName: entry.name } : image);
    }
  }
  if (guardModel(Object.values(patch).join('\n'), s, emit, sources)) return s;
  if (s.need && guardNeed(s.need, s, emit, sources)) return s;
  if (!s.draft || !s.evidence || !s.images) {
    emit({ type: 'error', text: '还没有可编辑的稿件' });
    return s;
  }
  if (s.draft.modelId !== s.modelId) {
    clearWork(s);
    emit({ type: 'clarify', question: '稿件与当前产品不一致，请按当前产品重新创作。' });
    return s;
  }
  s.images = uniqueModelImages(s.images, s.modelId);
  if (!sources.catalog && guardImageSupply(s.draft.platform, s, emit)) return s;
  const next: Draft = { ...s.draft, ...patch, version: s.draft.version + 1 };
  s.draft = next;
  s.report = undefined;
  emit({ type: 'draft', draft: next });
  emit({ type: 'step', label: '重新核验' });
  s.report = await checkDraft(next, s.evidence, s.images, SNAPSHOT_DATE);
  emit({ type: 'check', report: s.report });
  return s;
}
