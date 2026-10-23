import test from 'node:test';
import assert from 'node:assert/strict';
import { selectQuestionPrices } from '../lib/price-selection.ts';
import type { PriceSnapshot } from '../lib/price-snapshot.ts';
const row = (configuration: string, amount: string | undefined, configurationConfirmed: boolean, priceType = '商城页面价') => ({ configuration, amount, configurationConfirmed, priceType, productName: '测试产品', date: '2026-10-17' }) as PriceSnapshot;
test('没有明确SKU金额时，仍保留历史参考起价和下架状态，不能因型号名称看似完整而删掉金额', () => {
  const rows = [row('官网产品页对应版本', '¥5,799', false, '官网参考起价'), row('原官网商品ID', undefined, false, '当前商城状态'), row('HUAWEI MateBook D 14 2024', undefined, true, '未公开金额')];
  const result = selectQuestionPrices(rows, 'D14多少钱？历史也可以');
  assert.ok(result.some(item => item.amount === '¥5,799'));
  assert.ok(result.some(item => item.priceType === '当前商城状态'));
});
test('明确柔光屏和容量时只取柔光版，不把同容量普通款的价格套过来', () => {
  const rows = [row('24GB/512GB/烟云灰', '¥8,999', true), row('24GB/512GB/柔光版/仲夏紫', '¥9,999', true)];
  assert.deepEqual(selectQuestionPrices(rows, '柔光屏24GB 512GB多少钱'), [rows[1]]);
  assert.deepEqual(selectQuestionPrices(rows, '32GB柔光屏多少钱'), []);
});
test('同一天同一来源同款式同口径的重复记录只报一次，不合并不同金额', () => {
  const first = row('24GB/512GB/柔光版/HarmonyOS', '¥9,999', true, '官方商城页面价');
  const duplicate = { ...first, configuration: 'HarmonyOS；24GB/512GB/柔光版', priceType: '当前商城页面价' };
  const other = { ...duplicate, amount: '¥8,999' };
  assert.deepEqual(selectQuestionPrices([first, duplicate, other], '柔光屏多少钱'), [first, other]);
});
test('用户常用的24G/512G与全角写法仍绑定同一容量，未知容量不匹配末尾数字', () => {
  const rows = [row('16GB/512GB/烟云灰', '¥7,999', true), row('24GB/512GB/柔光版', '¥9,999', true)];
  assert.deepEqual(selectQuestionPrices(rows, '柔光版２４Ｇ ５１２Ｇ多少钱'), [rows[1]]);
  assert.deepEqual(selectQuestionPrices(rows, '124GB 512GB多少钱'), []);
});
test('否定柔光、指定颜色和防窥屏不能当作宽泛容量报价', () => {
  const rows = [row('24GB/512GB/烟云灰', '¥8,999', true), row('24GB/512GB/柔光版/仲夏紫', '¥9,999', true), row('24GB/512GB/防窥版/烟云灰', '¥10,999', true)];
  assert.deepEqual(selectQuestionPrices(rows, '不要柔光版，24GB 512GB烟云灰多少钱'), [rows[0], rows[2]]);
  assert.deepEqual(selectQuestionPrices(rows, '24GB 512GB防窥屏多少钱'), [rows[2]]);
  assert.deepEqual(selectQuestionPrices(rows, '24GB512GB标准版，不要柔光版'), []);
});
test('同日同SKU同金额选择较新原记录，不合并或丢掉较新记录的条件', () => {
  const first = { ...row('24GB/512GB/柔光版', '¥9,999', true), date: '2026-10-17T14:51:00-05:00', conditions: '旧条件' };
  const later = { ...first, date: '2026-10-17T14:52:00-05:00', conditions: '新条件：需符合会员资格' };
  assert.deepEqual(selectQuestionPrices([first, later], '柔光24G 512G多少钱'), [later]);
});

test('比较两款时，各型号独立选择明确报价；第一款的SKU不能挤掉另一款历史参考价与状态', () => {
  const first = Array.from({ length: 5 }, (_, i) => ({ ...row(`24GB/${512 + i}GB`, `¥${8999 + i}`, true), productName: 'MateBook Pro S' }));
  const reference = { ...row('官网产品页对应版本', '¥5,799', false, '官网参考起价'), productName: 'MateBook D 14 2024' };
  const status = { ...row('原官网商品ID', undefined, false, '当前商城状态'), productName: 'MateBook D 14 2024' };
  const selected = selectQuestionPrices([...first, reference, status], '这两款比较价格，不要联网');
  assert.equal(selected.filter(item => item.productName === 'MateBook Pro S').length, 4);
  assert.ok(selected.includes(reference));
  assert.ok(selected.includes(status));
});

test('多款都有明确SKU时，展示上限按型号计算，不能静默删掉后一款', () => {
  const rows = ['产品甲', '产品乙'].flatMap(productName => Array.from({ length: 5 }, (_, i) => ({
    ...row(`16GB/${512 + i}GB`, `¥${6000 + i}`, true), productName,
  })));
  const selected = selectQuestionPrices(rows, '两款各多少钱');
  assert.equal(selected.filter(item => item.productName === '产品甲').length, 4);
  assert.equal(selected.filter(item => item.productName === '产品乙').length, 4);
});
