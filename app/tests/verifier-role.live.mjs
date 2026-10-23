import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { verifyEvidence } from '../lib/agent.ts';
// Retired after independent audit found an invalid positive and mixed targets.
if (process.env.REPLAY_RETIRED_VERIFIER_CORPUS !== '1') throw new Error('历史评测已停用：样本标签存在歧义。请使用verifier-calibrated.live.mjs；显式历史复现才设置REPLAY_RETIRED_VERIFIER_CORPUS=1。');
const path = process.env.VERIFIER_ROLE_OUT || '../output/iterations/verifier-role-pro-20261021';
mkdirSync(path, { recursive: true });
if (existsSync(`${path}/results.json`)) throw new Error('Refusing to overwrite prior role experiment');
const load = name => JSON.parse(readFileSync(`../output/iterations/${name}/agent-effects.json`, 'utf8'));
const original = load('verifier-coverage-guard-v2-20261021');
const strongerWriter = load('agent-pro-evidence-effects-20261021');
const cases = [original.cases.at(-1), strongerWriter.cases.find(item => item.name === 'D14学生创作'), strongerWriter.cases.at(-1)]
  .map((item, index) => ({ id: `observed-unsupported-${index + 1}`, expectedIssue: true, state: item.after.session }));
const state = original.cases.at(-1).after.session;
for (const [id, body] of [
  ['qualified-system', 'HUAWEI MateBook D 14 2024 提供Windows 11家庭版和Linux V20版，具体系统请按所选版本确认。'],
  ['qualified-screen', 'HUAWEI MateBook D 14 2024标准版屏幕为14英寸、16:10，1920×1200；标准版色域100% sRGB，SE版45% NTSC。'],
  ['decision-advice', '先确认教室投影设备的接口和线材，再决定是否需要转接器。'],
]) cases.push({ id, expectedIssue: false, state: { ...state, draft: { ...state.draft, title: '', lead: '', body, cta: '', images: [], claims: [], tags: [] } } });
writeFileSync(`${path}/fixed-labels.json`, JSON.stringify(cases.map(item => ({ id: item.id, body: item.state.draft.body, expectedIssue: item.expectedIssue })), null, 2));
const results = [];
let cursor = 0;
async function worker() {
  while (cursor < cases.length) {
    const item = cases[cursor++], start = Date.now();
    try {
      const report = await verifyEvidence(item.state.draft, item.state.evidence, item.state.images);
      const correct = (report.issues.length > 0) === item.expectedIssue;
      results.push({ id: item.id, expectedIssue: item.expectedIssue, correct, report, ms: Date.now() - start });
      console.log(JSON.stringify({ id: item.id, correct, issues: report.issues.length }));
    } catch (error) { results.push({ id: item.id, correct: false, error: error.message }); }
  }
}
await Promise.all([worker(), worker()]);
writeFileSync(`${path}/results.json`, JSON.stringify(results, null, 2));
assert.ok(results.every(item => item.correct), 'Verifier role gate failed');
