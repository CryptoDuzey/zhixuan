// Real-model coverage repair plus a fixed corrected long draft. No web-service substitutes.
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { verifyEvidence } from '../lib/agent.ts';
const folder = '../output/iterations/verifier-coverage-guard-v2-20261021';
const original = JSON.parse(readFileSync('data/private/sessions/final-wechat-travel-1792506250983.json', 'utf8')).session;
const failed = JSON.parse(readFileSync('../output/iterations/verifier-decisions-20261021/candidate.json', 'utf8')).results.find(row => row.id === 'real-wechat' && row.repeat === 1);
assert.ok(!failed.verified.includes('C2') && failed.issues.length === 0);
const positive = structuredClone(original.draft);
const replacements = [
  ['出差换机时，798 g 这样的数字很容易先抓住注意力。', ''],
  ['，厚度 11.9 mm，确实属于会让人想先看外观的那类机器', ''],
  ['但真正决定你每天能不能顺利开会的，往往不是合盖后有多薄，而是常用软件能不能跑、会议外设能不能接、投屏链路顺不顺。', ''],
  ['重量只解决“愿不愿意带”，不解决“带出去能不能用”。', ''],
  ['轻机身先解决的是携带，不是工作流', '携带重量与随身转接装备'],
  ['如果出差时最常做的动作是背着电脑在机场、客户现场和酒店之间移动，标准屏版 798 g 的机身重量会直接影响你愿不愿意每天把它放进包里。', ''],
  ['这个数字来自标准屏版，', ''], ['但重量只回答携带这一半问题。', ''],
  ['，但没有原生 USB-A、HDMI 或 SD 卡槽', ''],
  ['屏幕为 14.2 英寸柔性 OLED', '标准屏、防窥屏、柔光屏版的屏幕为 14.2 英寸柔性 OLED'],
  ['对经常看文档、表格和演示稿的人来说，3:2 的纵向空间和触控操作是实际会碰到的使用面；但屏幕规格不能替代软件验证。', ''],
  ['若你经常在客户旁边开共享屏幕，防窥需求会改变版本选择；若只是轻量移动办公，标准屏版的 798 g 更直接。', ''],
  ['回到开头：重量值得看，但它只帮你判断愿不愿意带。', ''],
];
for (const [before, after] of replacements) {
  assert.ok(positive.body.includes(before), `Fixture source changed: ${before}`);
  positive.body = positive.body.replace(before, after);
}
positive.claims = positive.claims.filter(claim => claim.id !== 'C2').map(claim => ({ ...claim,
  text: claim.id === 'C1' ? claim.text.replace('，厚度 11.9 mm', '')
    : claim.id === 'C11' ? claim.text.replace('屏幕为', '标准屏、防窥屏、柔光屏版的屏幕为') : claim.text,
}));
const inputHash = createHash('sha256').update(JSON.stringify(positive)).digest('hex');
writeFileSync(`${folder}/positive-input.json`, JSON.stringify({ inputHash, draft: positive, source: 'independent review: remove unsupported effects; preserve facts and decision cautions' }, null, 2));
const actualFetch = globalThis.fetch, context = new AsyncLocalStorage();
globalThis.fetch = async (...args) => {
  const run = context.getStore();
  if (run && String(args[0]).includes('/chat/completions')) {
    run.calls++;
    if (run.fault && run.calls === 1) return Response.json({ choices: [{ message: { content: JSON.stringify({ issues: failed.issues, verified_claim_ids: failed.verified }) } }] });
  }
  return actualFetch(...args);
};
const results = [];
for (const fault of [true, false]) for (let repeat = 1; repeat <= 3; repeat++) {
  const run = { fault, calls: 0 }, draft = fault ? original.draft : positive;
  try {
    const report = await context.run(run, () => verifyEvidence(draft, original.evidence, original.images));
    const detected = report.issues.some(issue => issue.text.includes('直接影响你愿不愿意'));
    const correct = fault ? detected && run.calls === 2 && report.status === 'needs_fix'
      : report.status === 'pass' && report.reviewedClaimIds?.length === draft.claims.length;
    results.push({ scenario: fault ? 'recorded-omission-replay-plus-live-repair' : 'corrected-long-draft', repeat, calls: run.calls, correct, report });
    console.log(JSON.stringify({ scenario: results.at(-1).scenario, repeat, calls: run.calls, correct, issues: report.issues.length }));
  } catch (error) { results.push({ scenario: fault ? 'omission-replay' : 'corrected-long-draft', repeat, correct: false, error: String(error) }); }
}
writeFileSync(`${folder}/acceptance.json`, JSON.stringify({ inputHash, positiveBodyCharacters: positive.body.replace(/\s/g, '').length,
  method: 'fault replay is explicitly injected; only completion is live. Positive uses normal live verifier.', results }, null, 2));
assert.ok(results.every(result => result.correct), 'Coverage acceptance gate failed; inspect saved issues');
