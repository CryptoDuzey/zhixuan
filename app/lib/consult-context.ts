import type { Evidence } from './facts.ts';

/** Keep per-product budgets while ranking rows by the current question. */
export function selectConsultEvidence(rows: Evidence[], question: string, retrievalScore: (row: Evidence) => number): Evidence[] {
  const normalized = question.toLowerCase();
  const terms = new Set(normalized.match(/[a-z][a-z0-9-]{1,}/g) ?? []);
  for (const run of normalized.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for(let i=0;i+1<run.length;i++) terms.add(run.slice(i,i+2));
  }
  const lexical = (row: Evidence) => {
    const text=row.text.toLowerCase(), section=row.section.toLowerCase();
    return [...terms].reduce((score,term)=>score+(section.includes(term)?4:0)+(text.includes(term)?1:0),0);
  };
  const ranked = [...rows].sort((a, b) => lexical(b)-lexical(a) || retrievalScore(b) - retrievalScore(a));
  return [...ranked.filter(e => e.kind === 'fact').slice(0, 65), ...ranked.filter(e => e.kind === 'limit').slice(0, 25), ...ranked.filter(e => e.kind === 'scene').slice(0, 10)];
}
