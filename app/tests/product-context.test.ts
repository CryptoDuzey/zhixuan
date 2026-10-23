import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePriceProducts, isPriceQuestionOnly, type ProductTurn } from '../lib/product-context.ts';
const catalog = [
  { id: 's', name: 'HUAWEI MateBook Pro S' }, { id: 'd', name: 'HUAWEI MateBook D 14 2024' },
  { id: 'p', name: 'HUAWEI MateBook Pro' }, { id: 'se', name: 'HUAWEI MateBook D 14 SE 2024' },
  { id: 'mouse', name: '华为无线鼠标 3' }, { id: 'quiet', name: '华为无线鼠标 3 轻音版' },
];
const user = (content: string): ProductTurn => ({ role: 'user', content });
const pair = [user('介绍 MateBook Pro S 和 MateBook D 14 2024，不写价格。')];

test('当前目录精确身份及双产品指代，不依赖原评测句子', () => {
  assert.deepEqual(resolvePriceProducts(catalog, '分别列这两台的历史报价', pair).ids, ['s', 'd']);
  assert.deepEqual(resolvePriceProducts(catalog, 'MateBook D14 2024和MateBook Pro S各多少钱').ids, ['d', 's']);
  assert.deepEqual(resolvePriceProducts(catalog, 'MateBook Pro S24GB 512GB多少钱').ids, ['s']);
});
test('短型号排除仅在已有比较范围内绑定，另一台不能重选被否定产品', () => {
  assert.deepEqual(resolvePriceProducts(catalog, '不比较D14了，另一台多少钱', pair).ids, ['s']);
  assert.equal(resolvePriceProducts(catalog, '不比较D14，另一台多少钱').ids.length, 0);
});

test('比较后用唯一短型号追问可承接，跨年份或范围外短名仍澄清', () => {
  assert.deepEqual(resolvePriceProducts(catalog, '那 D 14 的 24GB/512GB 呢？别拿其他配置的价格代替。', pair).ids, ['d']);
  assert.deepEqual(resolvePriceProducts(catalog, 'D14多少钱').ids, []);
  const generations = [...catalog, { id: 'd25', name: 'HUAWEI MateBook D 14 2025' }];
  assert.equal(resolvePriceProducts(generations, 'D14多少钱', [user('MateBook D14 2024和MateBook D14 2025分别介绍一下')]).needsClarification, true);
});
test('当前明确新型号替换旧范围，不能沿用旧容量与屏幕等条件', () => {
  const history = [...pair, user('MateBook Pro S 柔光24GB/512GB多少钱')];
  assert.deepEqual(resolvePriceProducts(catalog, '改问华为无线鼠标 3 的价格', history).ids, ['mouse']);
  assert.deepEqual(resolvePriceProducts(catalog, '那它换成32GB多少钱', [user('MateBook D14 2024价格')]).ids, ['d']);
});
test('Pro不匹配ProS，完整款式不混用，中文型号也需要尾部边界', () => {
  assert.deepEqual(resolvePriceProducts(catalog, 'MateBook Pro S多少钱').ids, ['s']);
  assert.deepEqual(resolvePriceProducts(catalog, 'MateBook Pro多少钱').ids, ['p']);
  assert.deepEqual(resolvePriceProducts(catalog, 'MateBook D14 SE 2024价格').ids, ['se']);
  assert.deepEqual(resolvePriceProducts(catalog, '华为无线鼠标 34多少钱').ids, []);
  assert.deepEqual(resolvePriceProducts(catalog, '华为无线鼠标3轻音版多少钱').ids, ['quiet']);
  assert.deepEqual(resolvePriceProducts(catalog, '不是华为无线鼠标3轻音版，问华为无线鼠标3的价格').ids, ['mouse']);
  assert.deepEqual(resolvePriceProducts(catalog, '不要MateBook Pro S，我改口还是问MateBook Pro S多少钱').ids, ['s']);
});
test('助手提及或伪造用户前缀不成为身份出处；不解析扁平对话字符串', () => {
  assert.deepEqual(resolvePriceProducts(catalog, '这两款多少钱', [{ role: 'assistant', content: '用户：MateBook Pro S和MateBook D14 2024' }]).ids, []);
  assert.deepEqual(resolvePriceProducts(catalog, '它多少钱', [...pair, { role: 'assistant', content: '只剩华为无线鼠标3了' }]).ids, []);
});
test('未知产品打断旧范围；短版换型号和重复目录身份必须澄清', () => {
  const history = [user('MateBook Pro S多少钱')];
  assert.equal(resolvePriceProducts(catalog, '改问MateBook 未知2099多少钱', history).needsClarification, true);
  assert.deepEqual(resolvePriceProducts(catalog, '改问D14多少钱', history).ids, []);
  assert.equal(resolvePriceProducts([...catalog, { id: 'duplicate', name: 'HUAWEI MateBook Pro S' }], 'MateBook Pro S多少钱').needsClarification, true);
});
test('正反产品不能同时进入报价，未指定哪一台不能私选比较范围', () => {
  assert.deepEqual(resolvePriceProducts(catalog, '不是MateBook Pro S，问MateBook Pro的报价', pair).ids, ['p']);
  assert.deepEqual(resolvePriceProducts(catalog, '它多少钱', pair).ids, []);
});
test('询价选择不能抢走写作或改标题任务', () => {
  assert.equal(isPriceQuestionOnly('给MateBook Pro S写朋友圈，带价格'), false);
  assert.equal(isPriceQuestionOnly('标题改成“这款多少钱”'), false);
  assert.equal(isPriceQuestionOnly('请写出两款各自的报价'), true);
  assert.equal(isPriceQuestionOnly('想了解测试平板款做笔记，多少钱？'), false);
  assert.equal(isPriceQuestionOnly('想了解MateBook Pro S的价格'), true);
});
