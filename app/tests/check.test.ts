import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDeterministicChecks, isCheckCurrent, type Draft } from '../lib/check.ts';
import type { ImageRef } from '../lib/facts.ts';

const img = (n: number, modelId = 'pro-s'): ImageRef => ({
  id: `IMG${n}`, filename: `f${n}.jpg`, docId: `d${n}`, modelId, modelName: 'HUAWEI MateBook Pro S',
  caption: '', purpose: 'x', width: 1, height: 1, source: '本地已下载知识库', url: '',
});
const images = [img(1), img(2), img(3), img(4), img(9, 'other')];

const draft = (over: Partial<Draft> = {}): Draft => ({
  version: 1, platform: '公众号', modelId: 'pro-s', modelName: 'HUAWEI MateBook Pro S',
  title: 'MateBook Pro S 的差旅取舍', lead: '轻与取舍', body: '机身 798 g，两个 USB-C。',
  cta: '以官网规格页为准', tags: [],
  images: [{ imageId: 'IMG1', position: '开头', caption: '外观' }, { imageId: 'IMG2', position: '中段', caption: '细节' }],
  claims: [{ id: 'C1', text: '798 g', factIds: ['E001'] }],
  ...over,
});

const types = (d: Draft) => runDeterministicChecks(d, images).issues.map((i) => i.type);

test('合规稿件通过', () => {
  assert.equal(runDeterministicChecks(draft(), images).status, 'pass');
});

test('图片数量按平台校验', () => {
  assert.ok(types(draft({ platform: '小红书' })).includes('image'));
  assert.ok(types(draft({ images: [] })).includes('image'));
});

test('图片型号不一致或不存在', () => {
  assert.ok(types(draft({ images: [{ imageId: 'IMG9', position: 'a', caption: 'c' }, { imageId: 'IMG1', position: 'b', caption: 'c' }] })).includes('model'));
  assert.ok(types(draft({ images: [{ imageId: 'NOPE', position: 'a', caption: 'c' }, { imageId: 'IMG1', position: 'b', caption: 'c' }] })).includes('image'));
});

test('绝对化与承诺词拦截', () => {
  assert.ok(types(draft({ body: '它是最强的轻薄本' })).includes('absolute'));
  assert.ok(types(draft({ cta: '叠加补贴到手价，今天最后一天' })).includes('promise'));
});

test('虚构第一人称体验', () => {
  assert.ok(types(draft({ body: '我用了三个月，续航很稳' })).includes('fabricated'));
});

test('价格须带配置与日期', () => {
  assert.ok(types(draft({ body: '售价 ¥7,999' })).includes('price'));
  const ok = draft({ body: '16GB 版官网快照（2026-10-17）¥7,999', cta: '以官网实际为准' });
  assert.ok(!types(ok).includes('price'));
});

test('无依据主张拦截', () => {
  assert.ok(types(draft({ claims: [] })).includes('evidence'));
});

test('核验结果绑定稿件版本', () => {
  const r = runDeterministicChecks(draft(), images);
  assert.ok(isCheckCurrent(r, draft()));
  assert.ok(!isCheckCurrent(r, draft({ version: 2 })));
});

test('第一台/第一学期不误伤，销量第一拦截', () => {
  assert.ok(!types(draft({ title: '选第一台笔记本', body: '第一学期要装的软件' })).includes('absolute'));
  assert.ok(!types(draft({ body: '第一项取舍是接口，第一种场景是差旅' })).includes('absolute'));
  assert.ok(types(draft({ body: '它是销量第一的轻薄本' })).includes('absolute'));
});

test('平台篇幅/标签/表情为建议级提示，不阻断', () => {
  const r = runDeterministicChecks(draft({ platform: '朋友圈', body: '短'.repeat(200), images: [{ imageId: 'IMG1', position: 'a', caption: 'c' }] }), images);
  assert.ok(r.issues.some((i) => i.type === 'format' && i.location === '正文'));
  assert.ok(r.issues.filter((i) => i.type === 'format').every((i) => i.severity === 'warn'));
  const e = runDeterministicChecks(draft({ platform: '朋友圈', body: '😀😀😀😀'.repeat(10), images: [{ imageId: 'IMG1', position: 'a', caption: 'c' }] }), images);
  assert.ok(e.issues.some((i) => i.type === 'format' && i.location === '全文'));
  const x = runDeterministicChecks(draft({ platform: '小红书', tags: ['a', 'b'], images: [1, 2, 3].map((n) => ({ imageId: `IMG${n}`, position: 'a', caption: 'c' })) }), images);
  assert.ok(x.issues.some((i) => i.type === 'format' && i.location === '标签'));
});
