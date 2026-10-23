import test from 'node:test';
import assert from 'node:assert/strict';
import { runDeterministicChecks, type Draft } from '../lib/check.ts';

const issues = (body: string) => runDeterministicChecks({ version: 1, platform: '朋友圈', modelId: 'test', modelName: '测试电脑', title: '', lead: '', body, cta: '', tags: [], images: [], claims: [] } as Draft, []).issues.filter(i => i.type === 'absolute');
test('实际失败样本中的自主检查建议及否定唯一答案不属于产品极限宣传', () => {
  for (const body of ['装进书包前最好自己掂一下。', '课程软件未确认时，先别把它定成唯一答案。']) assert.equal(issues(body).length, 0, body);
});
test('产品最佳/唯一、双重否定、先建议后宣传仍被拦截', () => {
  for (const body of ['这是最好的电脑。', '这是唯一选择。', '不能不把它定成唯一答案。', '不要不把它当作唯一选择。', '最好自己掂一下。这款电脑最好。', '先别把它定成唯一答案，但它是唯一选择。', '最好带的电脑。', '最强的轻薄本。']) assert.ok(issues(body).length > 0, body);
});
