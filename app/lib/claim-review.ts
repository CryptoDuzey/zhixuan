import type { Claim, Issue } from './check.ts';

/** Validate the complete ID ledger before accepting any model judgment. */
export function parseClaimReview(value: unknown, claims: Claim[], evidence: { id: string }[]): { issues: Issue[]; verifiedClaimIds: string[] } {
  const invalid = (message: string): never => { throw new Error(`核验回复不完整：${message}`); };
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const nonempty = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
  if (!object(value) || !Array.isArray(value.claim_checks) || !Array.isArray(value.issues)) return invalid('缺少逐条结论或问题列表');
  const byId = new Map(claims.map(claim => [claim.id, claim]));
  if (byId.size !== claims.length || claims.some(claim => !nonempty(claim.id))) return invalid('稿件主张编号重复或为空');
  const evidenceIds = new Set(evidence.map(item => item.id));
  const seen = new Set<string>();
  const issues: Issue[] = [];
  const verifiedClaimIds: string[] = [];
  for (const check of value.claim_checks) {
    if (!object(check) || !nonempty(check.id) || !byId.has(check.id) || seen.has(check.id)) return invalid('结论编号未知或重复');
    if (!['supported', 'unsupported', 'advice', 'uncertain'].includes(String(check.verdict))
      || !nonempty(check.reason) || !Array.isArray(check.evidence_ids)) return invalid(`${check.id}的结论或依据不合法`);
    if (check.evidence_ids.some(id => !nonempty(id) || !evidenceIds.has(id))) {
      return invalid(`${check.id}引用未提供的编号；请逐字复制完整证据ID，例如${evidence[0]?.id ?? '（无证据）'}，不能仅写尾部编号`);
    }
    const claim = byId.get(check.id)!;
    if (check.verdict === 'supported') {
      if (!check.evidence_ids.length || check.evidence_ids.some(id => !claim.factIds.includes(id))) return invalid(`${check.id}没有绑定的有效证据`);
      verifiedClaimIds.push(check.id);
    } else if (check.verdict === 'advice') {
      if (check.evidence_ids.length) return invalid(`${check.id}普通建议不应冒充证据支持的事实`);
    } else {
      issues.push({ type: 'evidence', location: `主张 ${check.id}`, text: claim.text,
        reason: check.verdict === 'uncertain' ? `该主张尚不能确认：${check.reason}` : check.reason,
        action: check.verdict === 'uncertain' ? '待确认' : '改写', severity: 'block' });
    }
    seen.add(check.id);
  }
  const missing = claims.filter(claim => !seen.has(claim.id));
  if (missing.length) return invalid(`缺少${missing.map(claim => claim.id).join('、')}`);
  for (const issue of value.issues) {
    if (!object(issue) || !['evidence', 'conflict', 'fabricated', 'absolute'].includes(String(issue.type))
      || !nonempty(issue.location) || !nonempty(issue.text) || !nonempty(issue.reason)
      || !['删除', '改写', '补充条件', '待确认', '替换图片'].includes(String(issue.action))
      || !['block', 'warn'].includes(String(issue.severity))) return invalid('额外问题字段不合法');
    const row: Issue = { type: issue.type as Issue['type'], location: issue.location, text: issue.text,
      reason: issue.reason, action: issue.action as Issue['action'], severity: issue.severity as Issue['severity'] };
    if (!issues.some(existing => existing.text === row.text && existing.type === row.type)) issues.push(row);
  }
  // A direct blocking contradiction must never be stamped as verified as well.
  const blockedText = new Set(issues.filter(issue => issue.severity === 'block').map(issue => issue.text.replace(/\s/g, '')));
  return { issues, verifiedClaimIds: verifiedClaimIds.filter(id => !blockedText.has(byId.get(id)!.text.replace(/\s/g, ''))) };
}

/** Legacy checks may cite a claim by its original sentence; short parameter
 * fragments do not establish that the rest of a long claim was assessed. */
export function unreviewedClaims(claims: Claim[], verifiedIds: string[], issues: Issue[]): Claim[] {
  const normalized = (text: string) => text.replace(/[\s\p{P}]/gu, '');
  if (new Set(claims.map(claim => claim.id)).size !== claims.length) throw new Error('稿件主张编号重复');
  const verified = new Set(verifiedIds);
  return claims.filter(claim => {
    if (verified.has(claim.id)) return false;
    const sentence = normalized(claim.text);
    return !issues.some(issue => {
      const text = normalized(issue.text);
      return text.length > 0 && (text.includes(sentence)
        || sentence.includes(text) && text.length >= Math.max(16, sentence.length * 0.6));
    });
  });
}
