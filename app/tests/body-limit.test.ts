import test from 'node:test';
import assert from 'node:assert/strict';
import { explicitBodyMaximum, explicitBodyRange } from '../lib/body-limit.ts';
test('识别明确正文上限，避免误读标题、否定和字数范围', () => {
  for (const text of ['正文缩到120字以内，去掉参数堆砌', '正文不超过120字', '正文最多 120 字']) assert.equal(explicitBodyMaximum(text), 120);
  for (const text of ['标题不超过20字', '正文150到250字', '正文不用缩到120字以内', '不要把正文限制在120字以内']) assert.equal(explicitBodyMaximum(text), undefined);
});
test('正文范围独立识别，不能把标题范围误当正文限制', () => {
  for (const text of ['正文150到250字', '正文 150—250 字']) assert.deepEqual(explicitBodyRange(text), { min: 150, max: 250 });
  assert.equal(explicitBodyRange('标题18到26字'), undefined);
  assert.equal(explicitBodyRange('正文250到150字'), undefined);
});
