import test from 'node:test';
import assert from 'node:assert/strict';
import { answerParts } from '../lib/answer-links.ts';
test('普通文字保持原样，来源URL和命名来源均可点击且不吞标点', () => {
  const parts = answerParts('价格7999元。[查看来源](https://vmall.com/item?a=1&b=2)\n官网：https://consumer.huawei.com/cn/。');
  assert.deepEqual(parts.filter(part => part.href), [{ text: '查看来源', href: 'https://vmall.com/item?a=1&b=2' }, { text: 'https://consumer.huawei.com/cn/', href: 'https://consumer.huawei.com/cn/' }]);
  assert.equal(parts.at(-1)?.text, '。');
});
test('危险协议、凭证及HTML不转成可执行内容', () => {
  const text = '[坏链接](javascript:alert(1)) <script>alert(1)</script> https://secret@example.com/';
  assert.equal(answerParts(text).some(part => part.href), false);
  assert.equal(answerParts(text).map(part => part.text).join(''), text);
});
