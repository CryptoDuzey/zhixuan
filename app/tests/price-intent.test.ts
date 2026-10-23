import test from 'node:test';
import assert from 'node:assert/strict';
import { asksPrice } from '../lib/price-intent.ts';
test('创作中的不写、不提价格优惠是排除条件，不是询价', () => {
  for (const input of ['不写价格优惠或亲测', '不要写价格', '不要提价格', '先不提及优惠', '价格先不写', '价格和优惠不用写', '不要加入促销']) assert.equal(asksPrice(input), false, input);
  for (const input of ['写出价格', '请告诉我价格', '官网参考标价是多少', '看看定价', '不要写广告，但告诉我多少钱', '之前不写价格，现在告诉我多少钱']) assert.equal(asksPrice(input), true, input);
});
