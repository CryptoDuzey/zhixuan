import test from 'node:test';

/** DESIGN REGISTRATION ONLY. No production import, resolver or HTTP invocation.
 * Every case is TODO: a runner exit of 0 is NOT evidence of implementation success.
 * Review contract: output/iterations/parallel-price-20261022/price-context-candidate-contract.md
 */
export const catalogFixture = [
  { id: 'catalog:096af0db608385d6f05408cc', name: 'HUAWEI MateBook Pro S', docPath: 'P1-产品参数库/07-扩展产品目录/消费级 PC/03-HUAWEI MateBook Pro S.md' },
  { id: 'catalog:a83f4501682dd16bae731d3e', name: 'HUAWEI MateBook D 14 2024', docPath: 'P1-产品参数库/07-扩展产品目录/消费级 PC/08-HUAWEI MateBook D 14 2024.md' },
] as const;
const PRO = catalogFixture[0].id;
const D14 = catalogFixture[1].id;
type Turn = { role: 'user' | 'assistant'; content: string };
type Expected = { status: 'resolved' | 'clarify' | 'out-of-contract'; ids: string[]; excludedIds: string[]; mode: string };
type Case = { id: string; history: Turn[]; current: string; catalog: readonly { id: string; name: string; docPath: string }[]; expected: Expected; note?: string };
const U = (content: string): Turn => ({ role: 'user', content });
const A = (content: string): Turn => ({ role: 'assistant', content });
export const originalInputs = {
  pair1: '只用已有资料，介绍华为 MateBook Pro S 和 MateBook D 14 2024 的主要区别，不写价格。',
  pair2: '这两款比较价格。不要联网，分别说清已有报价的配置、日期和来源；没有对应报价就直说。',
  pair3: '我改口，不比较 D 14 了，只问刚才另一款的防窥版24GB/512GB多少钱。不要联网，不要拿柔光版价格代替。',
  switch1: '联网查华为 MateBook Pro S 柔光版24GB/512GB现在官网多少钱，给实际来源。',
  switch2: '这次不用联网，我改口问 MateBook D 14 2024 的16GB/512GB价格，只用已有资料，没有这组配置就直说，别沿用刚才那款。',
  switch3: '那它换成24GB/512GB呢？仍不要联网，只说这组配置的价格，没有就直说。',
} as const;
const expected = (ids: string[], mode: string, excludedIds: string[] = []): Expected => ({ status: 'resolved', ids, excludedIds, mode });
const clarify: Expected = { status: 'clarify', ids: [], excludedIds: [], mode: 'none' };
const outside: Expected = { status: 'out-of-contract', ids: [], excludedIds: [], mode: 'none' };
const pairHistory = [U(originalInputs.pair1), U(originalInputs.pair2)];
const base = (id: string, history: Turn[], current: string, result: Expected, note?: string): Case => ({ id, history, current, catalog: catalogFixture, expected: result, note });
export const candidateContractCases: Case[] = [
  base('O1-explicit-pair-no-price', [], originalInputs.pair1, expected([PRO, D14], 'explicit-pair'), '确定两个型号不等于触发询价；本轮不写价格。'),
  base('O2-user-pair-reference', [U(originalInputs.pair1)], originalInputs.pair2, expected([PRO, D14], 'pair-reference')),
  base('O3-exclude-D14-other', pairHistory, originalInputs.pair3, expected([PRO], 'pair-subtraction', [D14])),
  base('O4-explicit-web-single', [], originalInputs.switch1, expected([PRO], 'explicit-single'), '不得以候选成功绕过真实联网分支。'),
  base('O5-current-model-replaces-old', [U(originalInputs.switch1)], originalInputs.switch2, expected([D14], 'explicit-single'), '不继承Pro S或柔光条件；本轮16GB/512GB原文交给后续筛选。'),
  base('O6-current-capacity-single-reference', [U(originalInputs.switch1), U(originalInputs.switch2)], originalInputs.switch3, expected([D14], 'single-reference'), '只续接型号；本轮24GB/512GB替换容量，不推导存在该配置。'),
  base('R1-assistant-omits-D14', [U(originalInputs.pair1), A('HUAWEI MateBook Pro S\n¥7,999；24GB/512GB ¥8,999')], originalInputs.pair2, expected([PRO, D14], 'pair-reference')),
  base('R2-assistant-denies-both-prices', [U(originalInputs.pair1), A('这两款目前都没有可用的报价资料。MateBook Pro S 和 MateBook D 14 2024 的价格我这边没有对应记录。')], originalInputs.pair2, expected([PRO, D14], 'pair-reference'), '首次复测失败回复作为污染对照，不当作产品事实。'),
  base('R3-assistant-cannot-restore-excluded', [U(originalInputs.pair1), U(originalInputs.pair2), A('D 14 2024 柔光版24GB/512GB 9999元。')], originalInputs.pair3, expected([PRO], 'pair-subtraction', [D14])),
  base('R4-assistant-only-pair-is-insufficient', [A('比较 MateBook Pro S 和 MateBook D 14 2024。')], originalInputs.pair2, clarify),
  base('R5-user-one-assistant-adds-other', [U(originalInputs.switch1), A('也可以比较 MateBook D 14 2024。')], originalInputs.pair2, clarify),
  base('R6-no-user-history', [], originalInputs.pair2, clarify),
  base('R7-other-without-established-pair', [U(originalInputs.switch1)], originalInputs.pair3, clarify),
  { ...base('R8-current-catalog-missing-D14', [U(originalInputs.pair1)], originalInputs.pair2, clarify), catalog: [catalogFixture[0]] },
  { ...base('R9-duplicate-catalog-name', [U(originalInputs.pair1)], originalInputs.pair2, clarify), catalog: [...catalogFixture, { ...catalogFixture[1], id: 'fixture:duplicate-D14' }] },
  base('R10-unsupported-user-turn-barrier', [U(originalInputs.pair1), U('换个话题，介绍鼠标。')], originalInputs.pair2, clarify),
  base('R11-quoted-user-models-not-claims', [U('请解释这段引文：“华为 MateBook Pro S 和 MateBook D 14 2024”。')], originalInputs.pair2, clarify),
  base('R12-no-fuzzy-generalization', [U(originalInputs.pair1)], '那两个本子谁划算？', outside),
  base('R13-unsupported-new-model-blocks-old', [U(originalInputs.pair1)], '改问 MateBook 幻影2099 的价格。', outside),
  base('R14-two-left-for-singular', [U(originalInputs.pair1)], originalInputs.switch3, clarify),
  base('R15-repeat-single-not-two', [U(originalInputs.switch1), U(originalInputs.switch1)], originalInputs.pair2, clarify),
  base('R16-new-single-invalidates-old-pair', [U(originalInputs.pair1), U(originalInputs.switch2)], originalInputs.pair2, clarify),
];

for (const fixture of candidateContractCases) {
  test.todo(`[CONTRACT ONLY / NOT PRODUCTION] ${fixture.id}: ${fixture.expected.status} ${fixture.expected.ids.join(',') || '(no IDs)'}`);
}
