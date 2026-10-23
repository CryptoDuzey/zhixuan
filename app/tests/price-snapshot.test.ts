import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Evidence } from '../lib/facts.ts';

const root = 'P1-产品参数库/08-官方公开价格快照/';
const samples = {
  pros: '01-消费级PC/HUAWEI MateBook Pro S-价格卡.md',
  d14: '01-消费级PC/HUAWEI MateBook D 14 2024-价格卡.md',
  display: '03-显示器/HUAWEI MateView GT 27 英寸高刷版-价格卡.md',
  mouse: '05-电脑配件/华为无线鼠标 3-价格卡.md',
  inquiry: '02-商用电脑/华为擎云 L540x-价格卡.md',
};
function evidence(key: keyof typeof samples): Evidence[] {
  const p = root + samples[key];
  const body = readFileSync(new URL(`../../kb/华为PC全板块深度知识库_v7/${p}`, import.meta.url), 'utf8');
  let section = '';
  return body.split(/\r?\n/).flatMap((text, i) => {
    if (/^#+\s/.test(text)) { section = text.replace(/^#+\s*/, ''); return []; }
    return text.trim() ? [{ id: `${key}:E${i}`, docId: key, docTitle: samples[key], docPath: p, line: i + 1, section,
      text: `${section ? `[${section}] ` : ''}${text}`, kind: 'price' as const, source: '本地已下载知识库' as const, readAt: '2099-01-01T00:00:00Z' }] : [];
  });
}
async function api() {
  const mod = await import('../lib/price-snapshot.ts').catch(() => null);
  assert.ok(mod, '价格快照模块必须存在');
  assert.equal(typeof mod.extractPriceSnapshots, 'function');
  assert.equal(typeof mod.formatPriceSnapshots, 'function');
  return mod;
}

test('真实Pro S标准/柔光款完整保留SKU、同行日期、金额口径、条件与来源', async () => {
  const { extractPriceSnapshots, formatPriceSnapshots } = await api();
  const input = evidence('pros');
  const rows = extractPriceSnapshots(input);
  const standard = rows.find(r => r.configuration === '24GB/512GB/烟云灰/HarmonyOS/麒麟XE90' && r.priceType === '官方商城页面价');
  const soft = rows.find(r => r.configuration === '24GB/512GB/柔光版/仲夏紫/HarmonyOS/麒麟XE90' && r.priceType === '官方商城页面价');
  assert.ok(standard); assert.ok(soft);
  assert.equal(standard.amount, '¥8,999'); assert.equal(soft.amount, '¥9,999');
  assert.equal(soft.date, '2026-10-17T14:51:00-05:00');
  assert.ok(soft.conditions.includes('赠品'));
  assert.ok(soft.sourceUrl.startsWith('https://item.vmall.com/'));
  assert.ok(input.some(e => e.id === soft.evidence.id && e.line === soft.evidence.line));
  const output = formatPriceSnapshots([standard, soft]);
  assert.match(output, /柔光版\/仲夏紫\/HarmonyOS\/麒麟XE90/);
  assert.match(output, /历史|快照/); assert.match(output, /非.*成交价|不代表.*成交价/);
  assert.doesNotMatch(output, /2099/);
});

test('真实D14保留参考起价和下架状态，不伪称对应SKU现价', async () => {
  const { extractPriceSnapshots, formatPriceSnapshots } = await api();
  const rows = extractPriceSnapshots(evidence('d14'));
  const reference = rows.find(r => r.priceType === '官网参考起价');
  assert.ok(reference); assert.equal(reference.amount, '¥5,799');
  assert.equal(reference.configuration, '官网产品页对应版本');
  assert.equal(reference.configurationConfirmed, false);
  assert.ok(rows.some(r => !r.amount && r.salesStatus.includes('下架')));
  const output = formatPriceSnapshots(rows);
  assert.match(output, /参考起价/); assert.match(output, /下架/); assert.match(output, /款式.*未明确|配置.*未明确/);
});

test('真实显示器和鼠标不要求内存硬盘，未知款式保留原文边界', async () => {
  const { extractPriceSnapshots, formatPriceSnapshots } = await api();
  for (const [key, amount, config] of [['display', '¥899', '专区默认展示款'], ['mouse', '¥109', '版本与颜色未展开']] as const) {
    const row = extractPriceSnapshots(evidence(key)).find(r => r.amount === amount);
    assert.ok(row); assert.equal(row.configuration, config); assert.equal(row.configurationConfirmed, false);
    assert.match(formatPriceSnapshots([row]), /款式.*未明确|配置.*未明确/);
  }
});

test('真实商用无价记录可回答需询价，不从参考金额或条件数字造价格', async () => {
  const { extractPriceSnapshots, formatPriceSnapshots } = await api();
  const rows = extractPriceSnapshots(evidence('inquiry'));
  assert.equal(rows.length, 1); assert.equal(rows[0].amount, undefined);
  assert.equal(rows[0].priceType, '官方询价');
  assert.match(formatPriceSnapshots(rows), /询价/);
});

test('未公开金额是有效价格状态，不能被当作空价格类型丢弃', async () => {
  const { extractPriceSnapshots, formatPriceSnapshots } = await api();
  for (const sample of ['pros', 'd14', 'display', 'mouse'] as const) {
    const status = extractPriceSnapshots(evidence(sample)).find(r => r.priceType === '未公开金额');
    assert.ok(status, sample);
    assert.equal(status.amount, undefined);
    assert.equal(status.date, '2026-10-17T15:05:00-05:00');
    assert.match(formatPriceSnapshots([status]), /未公开金额/);
  }
});

test('缺失/非法同行日期不借元数据、其他记录或读取时间；空配置不补写', async () => {
  const { extractPriceSnapshots } = await api();
  for (const date of ['', '2026-02-30T14:51:00-05:00', '2099-99-99']) {
    const input = evidence('pros').map(e => ({ ...e, text: e.text.replace(/\| 2026-10-17T[^|]+\|/g, `| ${date} |`) }));
    assert.equal(extractPriceSnapshots(input).length, 0, date);
  }
  const empty = evidence('pros').map(e => ({ ...e, text: e.text.replace(/\| 24GB\/512GB\/柔光版\/仲夏紫\/HarmonyOS\/麒麟XE90 \|/g, '| — |') }));
  const rows = extractPriceSnapshots(empty);
  assert.ok(!rows.some(r => r.amount === '¥9,999' && r.date === '2026-10-17T14:51:00-05:00'));
});

test('多产品混合输入按各自文档隔离，不读机密归档，错名元数据拒绝', async () => {
  const { extractPriceSnapshots } = await api();
  const pros = evidence('pros'); const mouse = evidence('mouse');
  const rows = extractPriceSnapshots([...pros, ...mouse]);
  assert.ok(rows.filter(r => r.productName === '华为无线鼠标 3').every(r => r.evidence.docId === 'mouse' && r.amount !== '¥9,999'));
  assert.deepEqual(extractPriceSnapshots(pros.map(e => ({ ...e, docPath: `归档/${e.docPath}` }))), []);
  assert.deepEqual(extractPriceSnapshots(pros.map(e => ({ ...e, docPath: `P4-机密/${e.docPath}` }))), []);
  assert.deepEqual(extractPriceSnapshots(pros.map(e => ({ ...e, text: e.text.replace('product_name: HUAWEI MateBook Pro S', 'product_name: 其他型号') }))), []);
});

test('用户价格文案先给金额与完整款式，不出现证据ID或核验用语', async () => {
  const { extractPriceSnapshots, formatPriceSnapshots } = await api();
  const rows = extractPriceSnapshots(evidence('pros')).filter(r => r.configuration.includes('柔光版') && r.priceType === '官方商城页面价');
  const output = formatPriceSnapshots(rows);
  assert.ok(output.indexOf('¥9,999') < output.indexOf('不代表'));
  assert.match(output, /24GB\/512GB\/柔光版\/仲夏紫\/HarmonyOS\/麒麟XE90/);
  assert.match(output, /2026-10-17/);
  assert.doesNotMatch(output, /核验|pros:E|catalog:|readAt|docId|evidence/);
  assert.match(output, /https:\/\/item.vmall.com\//);
  const noPrice = formatPriceSnapshots(extractPriceSnapshots(evidence('inquiry')));
  assert.doesNotMatch(noPrice, /核验|只登记|不得以第三方|证据|本记录/);
  assert.match(noPrice, /配置、数量、服务|询价/);
});

test('历史记录中的当前价只作当时页面价展示，不改写来源记录', async () => {
  const { extractPriceSnapshots, formatPriceSnapshots } = await api();
  const rows = extractPriceSnapshots(evidence('pros')).filter(r => r.amount);
  const sample = { ...rows[0], priceType: '当前商城页面价' };
  const before = JSON.stringify(sample);
  const output = formatPriceSnapshots([sample]);
  assert.match(output, /当时商城页面价/);
  assert.doesNotMatch(output, /当前商城页面价/);
  assert.match(output, /2026-10-17.*历史页面记录/);
  assert.equal(JSON.stringify(sample), before);
});
