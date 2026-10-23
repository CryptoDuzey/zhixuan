// New independently calibrated corpus; old ambiguous labels/results are untouched.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyEvidence } from '../lib/agent.ts';
const folder = '../output/iterations/verifier-calibrated-20261021';
mkdirSync(folder, { recursive: true });
if (existsSync(`${folder}/results.json`)) throw new Error('Refusing to overwrite calibrated results');
const source = JSON.parse(readFileSync('../output/iterations/agent-pro-evidence-effects-20261021/agent-effects.json', 'utf8'));
const state = source.cases.find(item => item.name === 'D14学生创作').after.session;
const bySuffix = suffix => {
  const matches = state.evidence.filter(item => item.id.endsWith(`:${suffix}`));
  assert.equal(matches.length, 1);
  return matches[0].id;
};
const cases = [
  { id: 'reversed-gamut', bad: true, text: 'HUAWEI MateBook D 14 2024标准版色域45% NTSC，SE版100% sRGB，以上数值为典型值。', refs: ['E126', 'E127', 'E129'] },
  { id: 'universal-projector', bad: true, text: 'HUAWEI MateBook D 14 2024保证兼容任意教室投影，无需验证。', refs: ['E187', 'E188'] },
  { id: 'gamut-is-not-accuracy', bad: true, text: 'HUAWEI MateBook D 14 2024标准版100% sRGB（典型值）就能保证色准更高。', refs: ['E126', 'E129'] },
  { id: 'correct-gamut-with-condition', bad: false, text: 'HUAWEI MateBook D 14 2024标准版色域100% sRGB，SE版45% NTSC，以上色域数值为典型值。', refs: ['E126', 'E127', 'E129'] },
  { id: 'correct-system-with-condition', bad: false, text: 'HUAWEI MateBook D 14 2024提供Windows 11家庭版和Linux V20版，具体系统请按所选版本确认。', refs: ['E4', 'E5'] },
  { id: 'ordinary-decision-advice', bad: false, text: '先确认教室投影设备的接口和线材，再决定是否需要转接器。', refs: ['E188'] },
].map(item => ({ ...item, refs: item.refs.map(bySuffix) }));
const corpusHash = createHash('sha256').update(JSON.stringify(cases)).digest('hex');
writeFileSync(`${folder}/fixed-inputs.json`, JSON.stringify({ corpusHash, repeats: 2, cases }, null, 2));
const results = [];
let cursor = 0;
async function worker() {
  while (cursor < cases.length * 2) {
    const n = cursor++, item = cases[n % cases.length], repeat = Math.floor(n / cases.length) + 1;
    const draft = { ...state.draft, title: '', lead: '', body: item.text, cta: '', tags: [], images: [],
      claims: [{ id: 'C1', text: item.text, factIds: item.refs }] };
    try {
      const report = await verifyEvidence(draft, state.evidence, []);
      const correct = Boolean(report.issues.length) === item.bad;
      results.push({ id: item.id, repeat, expectedBad: item.bad, correct, report });
      console.log(JSON.stringify({ id: item.id, repeat, correct }));
    } catch (error) { results.push({ id: item.id, repeat, correct: false, error: error.message }); }
  }
}
await Promise.all([worker(), worker()]);
const summary = { corpusHash, correct: results.filter(item => item.correct).length, total: results.length,
  errors: results.filter(item => item.error).length,
  scope: 'unambiguous param/version/compatibility/accuracy controls only; not a score for subjective copywriting quality' };
writeFileSync(`${folder}/results.json`, JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary));
assert.ok(results.every(item => item.correct), 'Calibrated factual gate failed');
