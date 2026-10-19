import test from 'node:test';
import assert from 'node:assert/strict';
import { HANDOFF_KEY, parseHandoff, saveHandoff, takeHandoff, handoffMessage, type CreativeHandoff } from '../app/components/frontend-handoff.ts';
const value = (): CreativeHandoff => ({ version: 1, token: 's-test-transfer', createdAt: Date.now(), productId: 'pro-s',
  task: '完整需求'.repeat(5000), audience: '出差人群', constraints: '必须用特定插件', platform: '朋友圈' });
test('bounded handoff preserves complete needs and only allowed fields', () => {
  const item = value();
  assert.deepEqual(parseHandoff({ ...item, reason: '未经查证的推荐理由' }), item);
  assert.equal(parseHandoff({ ...item, task: 'a'.repeat(24001) }), null);
  assert.equal(parseHandoff({ ...item, productId: 'unknown' }), null);
  assert.equal(parseHandoff({ ...item, platform: 'unsupported' }), null);
  assert.equal(parseHandoff({ ...item, createdAt: Date.now() - 31 * 60000 }), null);
  assert.ok(handoffMessage(item).includes(item.task));
  assert.ok(handoffMessage(item).includes('不是产品事实'));
});
test('handoff is token-matched, single-use, and storage failures stay recoverable', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, v: string) => { data.set(key, v); }, removeItem: (key: string) => { data.delete(key); } };
  const item = value();
  assert.equal(saveHandoff(storage, item), true);
  assert.equal(takeHandoff(storage, 's-other-token'), null);
  assert.deepEqual(takeHandoff(storage, item.token), item);
  assert.equal(data.has(HANDOFF_KEY), false);
  assert.equal(takeHandoff(storage, item.token), null);
  assert.equal(saveHandoff(undefined, item), false);
  assert.equal(saveHandoff({ ...storage, setItem() { throw Error('denied'); } }, item), false);
  data.set(HANDOFF_KEY, '{broken');
  assert.equal(takeHandoff(storage, item.token), null);
});
