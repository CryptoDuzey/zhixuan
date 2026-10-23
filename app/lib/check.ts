// 确定性核验：图片数量/型号/来源、价格完整性、绝对化与违规承诺词。绑定稿件版本，改稿后旧结果作废。
import type { ImageRef } from './facts.ts';

export type Platform = '公众号' | '小红书' | '朋友圈';

export const IMAGE_RANGE: Record<Platform, [number, number]> = {
  公众号: [2, 4],
  小红书: [3, 6],
  朋友圈: [1, 3],
};

export interface Claim {
  id: string;
  text: string;
  factIds: string[];
}

export interface Draft {
  version: number;
  platform: Platform;
  modelId: string;
  modelName: string;
  title: string;
  lead: string;
  body: string;
  cta: string;
  tags: string[];
  images: { imageId: string; position: string; caption: string }[];
  claims: Claim[];
}

export type IssueType = 'image' | 'model' | 'price' | 'absolute' | 'promise' | 'fabricated' | 'evidence' | 'conflict' | 'format';

export interface Issue {
  type: IssueType;
  location: string;
  text: string;
  reason: string;
  action: '删除' | '改写' | '补充条件' | '待确认' | '替换图片';
  severity: 'block' | 'warn';
}

export interface CheckReport {
  draftVersion: number;
  status: 'pass' | 'needs_fix' | 'blocked';
  issues: Issue[];
  verifiedClaimIds: string[];
  reviewedClaimIds?: string[];
  verifiedImageIds: string[];
  checkedAt: string;
}

const ABSOLUTE = ['最好', '最强', '唯一', '顶级', '绝对', '完美', '零风险', '终身', '全部兼容', '完全兼容', '碾压', '秒杀', '遥遥领先', '无与伦比', '史上'];
const PROMISE = ['保证', '承诺', '一定能', '稳赚', '最低价', '全网最低', '史低', '必抢', '今天最后一天', '最后一天', '限时', '仅剩', '抢完即止', '手慢无', '到手价', '补贴后', '叠加补贴', '叠加优惠'];
const PRICE_RE = /[¥￥]\s*\d[\d,，.]*|\d[\d,，.]*\s*元/g;
const FIRST_PERSON = /(我用了|我入手|我买了|亲测|我已经用了|用了[一二三两\d]+(天|周|个月|年)|真实体验|自用)/;

type Range = [number, number];
const FORMAT: Record<Platform, { title?: Range; lead?: Range; body?: Range; tags?: Range; emoji?: number }> = {
  公众号: { title: [18, 26], lead: [48, 64], body: [900, 1300] },
  小红书: { body: [350, 550], tags: [6, 9] },
  朋友圈: { emoji: 3 },
};
const FIELD_LABEL = { title: '标题', lead: '导语', body: '正文' } as const;

export function draftFullText(d: Draft): string {
  return [d.title, d.lead, d.body, d.cta, d.tags.join(' '), ...d.images.map((i) => i.caption)].join('\n');
}

/** Same text the user copies/downloads; image captions are separate assets. */
export function draftPublishableText(d: Draft): string {
  return [d.title, d.lead, d.body, d.cta, d.tags.map(tag => tag.startsWith('#') ? tag : `#${tag}`).join(' ')]
    .filter(Boolean).join('\n\n');
}

function deniedPromise(text: string, at: number): boolean {
  const prefix = text.slice(Math.max(0, at - 40), at).split(/[。！？!?；;，,\n]/).at(-1) ?? '';
  const denied = prefix.match(/(?:不能|不可|无法|不应(?:该)?|不要|不)(?:(?:据此|以此|用来|用于|作出|做出|轻易|直接|随意)){0,2}$/);
  if (!denied) return false;
  // “不能不保证 / 并非不能保证” are not denials of a guarantee.
  const before = prefix.slice(0, denied.index);
  return !/(?:不能|不可|无法|不应(?:该)?|不要|不|并非|不是|绝非|没有理由)(?:用来|据此|完全|一定)?$/.test(before);
}

function locate(text: string, needle: string): string {
  const i = text.indexOf(needle);
  const start = Math.max(0, i - 8);
  return text.slice(start, Math.min(text.length, i + needle.length + 8)).replace(/\n/g, ' ');
}

function ordinaryAbsoluteAdvice(text: string, word: string, at: number): boolean {
  if (word === '最好') return /^(?:先)?(?:自己|亲自)(?:到店)?(?:确认|核对|掂|试用|试一下|看看|检查|咨询)/.test(text.slice(at + word.length));
  if (word !== '唯一' || !/^(?:答案|选择|方案)/.test(text.slice(at + word.length))) return false;
  const prefix = text.slice(0, at).split(/[。！？!?；;，,\n]/).at(-1) ?? '';
  const denial = prefix.match(/(?:不要|不|别)(?:把|将)[^。！？!?；;，,\n]{0,12}(?:定成|当作|当成|作为)$/);
  if (!denial) return false;
  return !/(?:不能|不可|不应|并非|不是|不要|别|不)$/.test(prefix.slice(0, denial.index));
}

export function runDeterministicChecks(d: Draft, images: ImageRef[], opts: { snapshotDate?: string } = {}): CheckReport {
  const issues: Issue[] = [];
  const byId = new Map(images.map((i) => [i.id, i]));
  const [min, max] = IMAGE_RANGE[d.platform];

  if (d.images.length < min || d.images.length > max) {
    issues.push({ type: 'image', location: '图片计划', text: `${d.images.length} 张`, reason: `${d.platform}要求 ${min}-${max} 张`, action: '替换图片', severity: 'block' });
  }
  const seen = new Set<string>();
  for (const im of d.images) {
    const ref = byId.get(im.imageId);
    if (!ref) {
      issues.push({ type: 'image', location: `图片 ${im.imageId}`, text: im.imageId, reason: '该图片不在 ima 图片索引中', action: '替换图片', severity: 'block' });
      continue;
    }
    if (ref.modelId !== d.modelId) {
      issues.push({ type: 'model', location: `图片 ${ref.filename}`, text: ref.modelName, reason: `图片型号与稿件型号不一致（${d.modelName}）`, action: '替换图片', severity: 'block' });
    }
    if (seen.has(im.imageId)) issues.push({ type: 'image', location: `图片 ${ref.filename}`, text: im.imageId, reason: '同一张图重复使用', action: '替换图片', severity: 'warn' });
    seen.add(im.imageId);
    if (!im.caption.trim()) issues.push({ type: 'image', location: `图片 ${ref.filename}`, text: '', reason: '缺少图注', action: '补充条件', severity: 'warn' });
  }

  const text = draftFullText(d);
  if (!text.includes(d.modelName.replace(/^HUAWEI\s*/i, '')) && !text.includes(d.modelName)) {
    issues.push({ type: 'model', location: '全文', text: d.modelName, reason: '稿件未写明具体型号', action: '改写', severity: 'warn' });
  }

  const fmt = (loc: string, shown: string, reason: string) =>
    issues.push({ type: 'format', location: loc, text: shown, reason, action: '改写', severity: 'warn' });
  const len = (s: string) => s.replace(/\s/g, '').length;
  const rule = FORMAT[d.platform];
  if (d.platform === '朋友圈') {
    const n = len(draftPublishableText(d));
    if (n < 90 || n > 150) fmt('全文', `${n} 字`, '朋友圈全文建议 90-150 字（含标题、导语、结尾与标签）');
  }
  for (const f of ['title', 'lead', 'body'] as const) {
    const r = rule[f];
    if (!r) continue;
    const n = len(d[f]);
    if (n < r[0] || n > r[1]) fmt(FIELD_LABEL[f], `${n} 字`, `${d.platform}${FIELD_LABEL[f]}建议 ${r[0]}-${r[1]} 字`);
  }
  if (rule.tags && (d.tags.length < rule.tags[0] || d.tags.length > rule.tags[1])) {
    fmt('标签', `${d.tags.length} 个`, `${d.platform}建议 ${rule.tags[0]}-${rule.tags[1]} 个标签`);
  }
  if (rule.emoji !== undefined) {
    const n = (text.match(/\p{Extended_Pictographic}/gu) ?? []).length;
    if (n > rule.emoji) fmt('全文', `${n} 个表情`, `${d.platform}表情不超过 ${rule.emoji} 个`);
  }

  for (const w of ABSOLUTE) {
    let at = text.indexOf(w);
    while (at >= 0) {
      if (!ordinaryAbsoluteAdvice(text, w, at)) {
        issues.push({ type: 'absolute', location: locate(text.slice(at), w), text: w, reason: '绝对化/极限用语，无法由官方资料支持', action: '改写', severity: 'block' });
        break;
      }
      at = text.indexOf(w, at + w.length);
    }
  }
  // “第一台/第一次/第一学期”是普通序数，只拦“行业第一/销量第一/第一品牌”这类极限表述
  const rank = text.match(/第一(?![台次天个学期步件年批眼页章课节轮周月波代项种类条点是步])/);
  if (rank) issues.push({ type: 'absolute', location: locate(text, rank[0]), text: rank[0], reason: '绝对化/极限用语，无法由官方资料支持', action: '改写', severity: 'block' });
  for (const w of PROMISE) {
    let at = text.indexOf(w);
    while (at >= 0) {
      if (!(['保证', '承诺'].includes(w) && deniedPromise(text, at))) {
        issues.push({ type: 'promise', location: locate(text.slice(at), w), text: w, reason: '促销/承诺类表述缺少 ima 有效依据', action: '删除', severity: 'block' });
        break;
      }
      at = text.indexOf(w, at + w.length);
    }
  }
  const fp = text.match(FIRST_PERSON);
  if (fp) issues.push({ type: 'fabricated', location: locate(text, fp[0]), text: fp[0], reason: '疑似虚构个人使用体验', action: '改写', severity: 'block' });

  const prices = text.match(PRICE_RE) ?? [];
  const firstPrice = prices[0];
  if (firstPrice) {
    const hasDate = /20\d{2}[-年/.]\s*\d{1,2}/.test(text) || (opts.snapshotDate ? text.includes(opts.snapshotDate) : false);
    const hasSku = /(GB|TB|版)/.test(text);
    if (!hasDate || !hasSku) {
      issues.push({ type: 'price', location: locate(text, firstPrice), text: firstPrice, reason: '价格须同时写明配置/SKU 与截至日期，并注明以官网实际为准', action: '补充条件', severity: 'block' });
    }
    if (!/以[^。]*(官方|官网|实际)[^。]*为准/.test(text)) {
      issues.push({ type: 'price', location: '全文', text: firstPrice, reason: '缺少“以官网/实际销售为准”提示', action: '补充条件', severity: 'warn' });
    }
  }

  if (!d.claims.length) issues.push({ type: 'evidence', location: '全文', text: '', reason: '没有任何产品主张绑定到依据', action: '待确认', severity: 'block' });

  const blocked = issues.some((i) => i.severity === 'block');
  return {
    draftVersion: d.version,
    status: blocked ? 'needs_fix' : 'pass',
    issues,
    verifiedClaimIds: [],
    verifiedImageIds: d.images.filter((i) => byId.get(i.imageId)?.modelId === d.modelId).map((i) => i.imageId),
    checkedAt: new Date().toISOString(),
  };
}

/** 核验结果只对对应版本有效。 */
export function isCheckCurrent(report: CheckReport | undefined, draft: Draft): boolean {
  return !!report && report.draftVersion === draft.version;
}

/** Older saved reports lack a coverage ledger and must be checked again before
 * presenting a factual draft as ready. Never infer missing coverage from pass. */
export function hasCompleteClaimReview(report: CheckReport | undefined, draft: Draft): boolean {
  if (!report) return false;
  if (!draft.claims.length) return true;
  const ids = new Set(draft.claims.map(claim => claim.id));
  const reviewed = report.reviewedClaimIds;
  return ids.size === draft.claims.length && Array.isArray(reviewed)
    && reviewed.length === ids.size && new Set(reviewed).size === ids.size
    && reviewed.every(id => ids.has(id));
}

/** Unresolved factual/compliance findings cannot be downgraded to optional
 * advice by a model's severity field. Format and other warnings keep their
 * existing meaning. This policy also applies to unmodified saved reports. */
export function isBlockingIssue(issue: Issue): boolean {
  return issue.severity === 'block'
    || ['evidence', 'conflict', 'fabricated', 'absolute'].includes(issue.type);
}

export function hasBlockingIssues(report: Pick<CheckReport, 'issues'> | undefined): boolean {
  return !!report?.issues.some(isBlockingIssue);
}

/** Shared UI/export gate. Complete registered IDs alone do not prove that
 * unregistered sentences were detected; this function cannot repair misses. */
export function isPublishableReport(report: CheckReport | undefined, draft: Draft): boolean {
  return !!report && isCheckCurrent(report, draft) && hasCompleteClaimReview(report, draft)
    && report.status === 'pass' && !hasBlockingIssues(report);
}

export function mergeReports(det: CheckReport, ev: Omit<CheckReport, 'draftVersion' | 'checkedAt'>): CheckReport {
  const issues = [...det.issues, ...ev.issues].map((issue): Issue =>
    isBlockingIssue(issue) && issue.severity !== 'block' ? { ...issue, severity: 'block' } : issue);
  const blocked = hasBlockingIssues({ issues });
  return {
    draftVersion: det.draftVersion,
    status: blocked ? 'needs_fix' : 'pass',
    issues,
    verifiedClaimIds: ev.verifiedClaimIds,
    ...(ev.reviewedClaimIds ? { reviewedClaimIds: ev.reviewedClaimIds } : {}),
    verifiedImageIds: det.verifiedImageIds,
    checkedAt: new Date().toISOString(),
  };
}
