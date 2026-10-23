// Network replacements only: mirrors the verifier wire shape, not evidence quality.
export function reviewFixture(prompt: string) {
  const evidenceIds = new Set([...prompt.matchAll(/^\[([^|\]\n]+)\|/gm)].map(match => match[1]));
  const claimText = prompt.split('## claims\n').at(-1) ?? '';
  const claim_checks = [...claimText.matchAll(/^([^｜\n]+)｜[^\n]*｜依据 ([^\n]*)$/gm)].map(match => {
    const evidence_ids = match[2].split(',').filter(id => evidenceIds.has(id));
    return { id: match[1], verdict: evidence_ids.length ? 'supported' : 'uncertain', evidence_ids,
      reason: evidence_ids.length ? '离线协议夹具' : '离线夹具无有效引用' };
  });
  return { verified_claim_ids: claim_checks.filter(row => row.verdict === 'supported').map(row => row.id), issues: [] };
}
