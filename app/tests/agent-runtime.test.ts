import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abortableDelay, cancelRun, createRun, encodeRunEvent, reportTool, RunStoppedError, runSignal, throwIfStopped, useModelAttempt, withRun } from '../lib/agent-runtime.ts';
import { fetchModelGateway } from '../lib/model-settings.ts';

test('SSE与旧NDJSON保持完整JSON、递增编号和安全的换行边界', () => {
  const run = createRun();
  const event = { type: 'notice', text: '第一行\n\nevent: forged\n第二行' };
  const sse = encodeRunEvent(event, run, true);
  assert.equal(sse.split('\n\n').filter(Boolean).length, 1);
  assert.ok(sse.startsWith(`id: ${run.id}:1\nevent: notice\ndata: `));
  const data = JSON.parse(sse.split('\ndata: ')[1].trim());
  assert.equal(data.text, event.text);
  assert.equal(data.seq, 1);
  const ndjson = JSON.parse(encodeRunEvent(event, run, false));
  assert.equal(ndjson.seq, 2);
  assert.equal(ndjson.runId, run.id);
});

test('取消严格匹配运行编号，大小写会话不能绕过；停止延迟等待', async () => {
  const run = createRun();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const task = withRun('runtime-one', run, () => {}, async () => {
    started();
    await abortableDelay(5000);
  });
  await ready;
  assert.equal(cancelRun('runtime-one', createRun().id), false);
  assert.equal(cancelRun('RUNTIME-ONE', run.id), true);
  await assert.rejects(task, (error) => error instanceof RunStoppedError && error.status === 'cancelled');
  assert.equal(run.cancelRequested, true);
  assert.equal(cancelRun('runtime-one', run.id), false);
});

test('任务超时立即结束等待，迟到任务不能提交事件且新运行不受旧取消影响', async () => {
  const oldRun = createRun();
  let release!: () => void;
  let late = false;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  await assert.rejects(withRun('runtime-late', oldRun, () => { late = true; }, async () => {
    await blocked;
    reportTool({ type: 'tool', tool: 'model', status: 'completed', label: '迟到调用' });
  }, { timeoutMs: 10 }), (error) => error instanceof RunStoppedError && error.status === 'timed_out');
  const next = createRun();
  await withRun('runtime-late', next, () => {}, async () => {
    assert.equal(cancelRun('runtime-late', oldRun.id), false);
    throwIfStopped();
  });
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(late, false);
});

test('模型调用有预算上限，不会继续重试；并发会话上下文互不影响', async () => {
  await assert.rejects(withRun('runtime-budget', createRun(), () => {}, async () => {
    useModelAttempt();
    useModelAttempt();
  }, { maxModelAttempts: 1 }), (error) => error instanceof RunStoppedError && error.status === 'failed');
  const runA = createRun(), runB = createRun();
  const signals: AbortSignal[] = [];
  await Promise.all(['a', 'b'].map((id, index) => withRun(`runtime-${id}`, index ? runB : runA, () => {}, async () => {
    signals[index] = runSignal()!;
    await abortableDelay(1);
    throwIfStopped();
  })));
  assert.notEqual(signals[0], signals[1]);
});

test('网关同时尊重调用方取消与自身超时，取消原因不会被替换为连接失败', async (t) => {
  const controller = new AbortController();
  const error = new RunStoppedError('cancelled');
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, options) => new Promise<Response>((_resolve, reject) => {
    started();
    options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
  }));
  const task = fetchModelGateway({ baseUrl: 'https://offline.example/v1', apiKey: 'fake-test-key', models: ['fake'] },
    'chat/completions', { signal: controller.signal }, 5000);
  await ready;
  controller.abort(error);
  await assert.rejects(task, (value) => value === error);
});
