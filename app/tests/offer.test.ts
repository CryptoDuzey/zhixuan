import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOffer, type Offer } from '../lib/offer.ts';

const base = { channel: 'A渠道', validOn: true, eligible: true } as const;
const coupon = (over: Partial<Offer> = {}): Offer => ({ id: 'c', kind: 'coupon', value: 100, ...base, ...over });
const disc = (over: Partial<Offer> = {}): Offer => ({ id: 'd', kind: 'discount', value: 0.9, ...base, ...over });

test('先券后折 810', () => {
  const r = computeOffer({ basePrice: 1000, channel: 'A渠道', order: ['c', 'd'] }, [coupon(), disc()]);
  assert.equal(r.amount, 810);
});

test('先折后券 800', () => {
  const r = computeOffer({ basePrice: 1000, channel: 'A渠道', order: ['d', 'c'] }, [coupon(), disc()]);
  assert.equal(r.amount, 800);
});

test('互斥取更优 900', () => {
  const r = computeOffer({ basePrice: 1000, channel: 'A渠道', order: ['c', 'd'] }, [coupon({ exclusiveGroup: 'g' }), disc({ exclusiveGroup: 'g' })]);
  assert.equal(r.amount, 900);
  assert.equal(r.skipped.length, 1);
});

test('折扣封顶 150 → 850', () => {
  const r = computeOffer({ basePrice: 1000, channel: 'A渠道', order: ['d'] }, [disc({ value: 0.8, cap: 150 })]);
  assert.equal(r.amount, 850);
});

test('门槛按券后金额判断 → 900', () => {
  const second: Offer = { id: 'm', kind: 'coupon', value: 50, threshold: 950, ...base };
  const r = computeOffer({ basePrice: 1000, channel: 'A渠道', order: ['c', 'm'] }, [coupon(), second]);
  assert.equal(r.amount, 900);
  assert.match(r.skipped[0].reason, /未达门槛/);
});

test('赠品不抵现', () => {
  const g: Offer = { id: 'g', kind: 'gift', ...base };
  const r = computeOffer({ basePrice: 1000, channel: 'A渠道', order: ['c', 'g'] }, [coupon(), g]);
  assert.equal(r.amount, 900);
  assert.deepEqual(r.gifts, ['g']);
});

test('换渠道使优惠失效', () => {
  const r = computeOffer({ basePrice: 1000, channel: 'B渠道', order: ['c'] }, [coupon()]);
  assert.equal(r.amount, 1000);
  assert.match(r.skipped[0].reason, /渠道不适用/);
});

test('任何条件未知则不出金额', () => {
  const r = computeOffer({ basePrice: 1000, channel: 'A渠道', order: ['c'] }, [coupon({ eligible: 'unknown' })]);
  assert.equal(r.computable, false);
  assert.equal(r.amount, undefined);
  assert.ok(r.missing.some((m) => m.includes('资格')));
  const r2 = computeOffer({ basePrice: 1000, channel: 'A渠道', order: 'unknown' }, [coupon()]);
  assert.equal(r2.computable, false);
});
