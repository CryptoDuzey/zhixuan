import test from 'node:test';
import assert from 'node:assert/strict';
import { priceIntent } from '../lib/price-intent.ts';
test('实际重试任务中并列排除的价格不触发询价', () => {
  for (const text of ['不写测评结论、价格或减负效果', '重试公众号任务，不写亲测、价格、优惠', '不提性能和价格', '不要加入故事与促销']) assert.equal(priceIntent(text), false, text);
});
test('后续明确问价和不同语义动词不被前面的排除吞掉', () => {
  for (const text of ['不写测评结论、价格，但现在告诉我多少钱', '不要写广告、请告诉我价格', '不写参数但给价格', '请写参数和价格']) assert.equal(priceIntent(text), true, text);
});
