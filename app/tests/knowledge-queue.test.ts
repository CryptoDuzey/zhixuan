import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeReadQueue } from '../lib/knowledge-queue.ts';

test('排队停止不发出读取，释放后后续任务仍可运行', async () => {
  const queue = new KnowledgeReadQueue(1);
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const first = queue.run(new AbortController().signal, async () => {
    started();
    await new Promise<void>(resolve => { release = resolve; });
  });
  await ready;
  const controller = new AbortController();
  const stopped = queue.run(controller.signal, async () => assert.fail('停止后不应发出请求'));
  const reason = new Error('用户停止');
  controller.abort(reason);
  await assert.rejects(stopped, error => error === reason);
  const next = queue.run(new AbortController().signal, async () => '后续任务');
  release();
  await first;
  assert.equal(await next, '后续任务');
});

test('读取失败释放名额，等待队列超量时明确拒绝', async () => {
  const queue = new KnowledgeReadQueue(1, 0);
  let release!: () => void;
  const first = queue.run(new AbortController().signal, () => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve();
  await assert.rejects(queue.run(new AbortController().signal, async () => {}), /繁忙/);
  release();
  await first;
  await assert.rejects(queue.run(new AbortController().signal, async () => { throw new Error('读取失败'); }), /读取失败/);
  assert.equal(await queue.run(new AbortController().signal, async () => '恢复'), '恢复');
});
