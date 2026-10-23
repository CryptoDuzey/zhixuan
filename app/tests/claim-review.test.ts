import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaimReview, unreviewedClaims } from '../lib/claim-review.ts';
import type { Claim } from '../lib/check.ts';

const claims: Claim[] = [{ id: 'C1', text: '标准屏版798 g', factIds: ['E1'] },
  { id: 'C2', text: '每天背也没有负担', factIds: ['E1'] }];
const evidence = [{ id: 'E1' }, { id: 'E2' }];
const row = (id = 'C1', verdict = 'supported', evidence_ids = ['E1']) => ({ id, verdict, evidence_ids, reason: '标准屏版重量有依据' });
const packet = (claim_checks: unknown, issues: unknown = []) => ({ claim_checks, issues });

test('复现真实漏审：只有已确认列表的旧回复或缺少C2均不能通过', () => {
  assert.throws(() => parseClaimReview({ issues: [], verified_claim_ids: ['C1'] }, claims, evidence));
  assert.throws(() => parseClaimReview(packet([row()]), claims, evidence), /C2/);
});
test('完整逐条处置：重量支持不等于背负体验支持', () => {
  const review = parseClaimReview(packet([row(), { ...row('C2', 'unsupported', ['E1']), reason: '重量规格不能证明背一天无负担' }]), claims, evidence);
  assert.deepEqual(review.verifiedClaimIds, ['C1']);
  assert.equal(review.issues[0].text, claims[1].text);
  assert.equal(review.issues[0].severity, 'block');
});
test('普通行动建议独立处置，不冒充已证实事实，也不阻断', () => {
  const advice = [{ id: 'C1', text: '先问学校课程软件要求', factIds: ['E1'] }];
  const result = parseClaimReview(packet([row('C1', 'advice', [])]), advice, evidence);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.verifiedClaimIds, []);
});
test('证据不足与事实错误分开，未确定不能默认为通过', () => {
  const result = parseClaimReview(packet([{ ...row('C1', 'uncertain', []), reason: '尚无具体外设的兼容资料' }]), [claims[0]], evidence);
  assert.equal(result.issues[0].action, '待确认');
  assert.match(result.issues[0].reason, /尚无具体外设/);
});
test('虚构、未绑定、空证据或重复/未知ID不可伪造覆盖率', () => {
  for (const data of [packet([row(), row()]), packet([row('NO_SUCH')]), packet([row('C1', 'supported', ['E999'])]),
    packet([row('C1', 'supported', ['E2'])]), packet([row('C1', 'supported', [])]),
    packet([row('C1', 'maybe')]), packet([row('C1', 'advice', ['E1'])]),
    { claim_checks: [], issues: 'bad' }, packet([{ ...row(), reason: '' }])]) {
    assert.throws(() => parseClaimReview(data, [claims[0]], evidence));
  }
});
test('稿件claim编号本身重复不能让一条判定覆盖两句', () => {
  assert.throws(() => parseClaimReview(packet([row()]), [claims[0], { ...claims[1], id: 'C1' }], evidence));
});
test('claims外的图片、标题等问题继续保留且严格验证', () => {
  const issue = { type: 'fabricated', location: '图注', text: '学生使用电脑', reason: '未复核图片不能证明人物', action: '改写', severity: 'block' };
  assert.deepEqual(parseClaimReview(packet([], [issue]), [], evidence).issues, [issue]);
  assert.throws(() => parseClaimReview(packet([], [{ ...issue, severity: 'optional' }]), [], evidence));
});

test('只补查遗漏项，问题中的短参数不能掩盖整句效果推断', () => {
  assert.deepEqual(unreviewedClaims(claims, ['C1'], []).map(claim => claim.id), ['C2']);
  const issue = { type: 'evidence', location: '正文', text: claims[1].text, reason: '无依据', action: '改写', severity: 'warn' } as const;
  assert.equal(unreviewedClaims(claims, ['C1'], [issue]).length, 0);
  assert.deepEqual(unreviewedClaims(claims, [], [{ ...issue, text: '798 g' }]).map(claim => claim.id), ['C1', 'C2']);
});
