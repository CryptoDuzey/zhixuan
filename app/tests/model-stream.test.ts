import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumeCompletion, previewString } from '../lib/model-stream.ts';
import { consumeModelGateway } from '../lib/model-settings.ts';
import { chatJson } from '../lib/llm.ts';
import { cancelRun, createRun, withRun, type ModelEvent, type ToolEvent } from '../lib/agent-runtime.ts';

const cwd = process.cwd();
const directory = mkdtempSync(join(tmpdir(), 'model-stream-'));
const environment = Object.fromEntries(['LLM_BASE_URL', 'LLM_MODELS', 'OPENAI_NEXT_API_KEY'].map(key => [key, process.env[key]]));
process.chdir(directory);
beforeEach(() => {
  process.env.LLM_BASE_URL = 'https://offline.example/v1';
  process.env.LLM_MODELS = 'offline-model';
  process.env.OPENAI_NEXT_API_KEY = 'offline-stream-key';
});
after(() => {
  process.chdir(cwd);
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(directory, { force: true, recursive: true });
});
const signal = () => new AbortController().signal;
const frame = (delta: unknown, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const completion = (content: string) => frame({ content }) + frame({}, 'stop') + 'data: [DONE]\n\n';
function stream(value: string, chunkSize = 19) {
  const bytes = new TextEncoder().encode(value);
  return new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

test('gateway SSE decodes split UTF8/CRLF, metadata, usage and selected choice only', async () => {
  const values: string[] = [];
  const wire = ': keepalive\n\n' + frame({ role: 'assistant', reasoning_content: 'private-reasoning' })
    + 'data: {"choices":[{"index":1,"delta":{"content":"wrong"}}]}\n\n'
    + frame({ content: '你好，' }) + frame({ content: '朋友🌱' })
    + frame({}, 'stop') + 'data: {"choices":[],"usage":{"total_tokens":6}}\n\n' + 'data: [DONE]\n\n';
  const result = await consumeCompletion(stream(wire.replaceAll('\n', '\r\n'), 1), signal(), text => values.push(text));
  assert.equal(result.text, '你好，朋友🌱');
  assert.equal(result.mode, 'stream');
  assert.ok(values.includes('你好，'));
  assert.doesNotMatch(values.join(''), /private-reasoning|wrong/);
});

test('DONE finishes immediately even when upstream does not close the socket', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(completion('OK'))); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } });
  assert.equal((await consumeCompletion(response, signal(), () => {})).text, 'OK');
  assert.equal(cancelled, true);
});

test('completed output does not wait for an unresponsive transport cleanup', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(completion('OK'))); },
    cancel() { cancelled = true; return new Promise<void>(() => {}); },
  }), { headers: { 'content-type': 'text/event-stream' } });
  const result = await Promise.race([
    consumeCompletion(response, signal(), () => {}),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('cleanup stalled completion')), 200)),
  ]);
  assert.equal(result.text, 'OK');
  assert.equal(cancelled, true);
  assert.equal(response.body?.locked, false);
});

test('stop preserves its reason even when transport cancellation never settles', async () => {
  const controller = new AbortController();
  const reason = new Error('user stopped');
  const response = new Response(new ReadableStream({
    cancel() { return new Promise<void>(() => {}); },
  }), { headers: { 'content-type': 'text/event-stream' } });
  const result = consumeCompletion(response, controller.signal, () => {});
  controller.abort(reason);
  await assert.rejects(Promise.race([
    result,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('cleanup stalled stop')), 200)),
  ]), error => error === reason);
  assert.equal(response.body?.locked, false);
});

test('ignored stream flag accepts one bounded JSON response and reports buffered', async () => {
  const modes: string[] = [];
  const result = await consumeCompletion(Response.json({ choices: [{ message: { content: '{"reply":"完整回复"}' } }] }),
    signal(), (_text, mode) => modes.push(mode));
  assert.equal(result.mode, 'buffered');
  assert.deepEqual([...new Set(modes)], ['buffered']);
});

test('truncation, length limit, refusal, tool calls and upstream errors are never successful output', async () => {
  const failures = [
    frame({ content: 'partial' }),
    frame({ content: 'partial' }) + 'data: [DONE]\n\n',
    frame({ content: 'partial' }) + frame({}, 'length'),
    frame({ content: 'partial' }) + frame({}, 'content_filter'),
    frame({ tool_calls: [{ function: { arguments: 'private' } }] }) + frame({}, 'stop'),
    'data: {"error":{"message":"offline-stream-key private"}}\n\n',
    'data: not-json-private\n\n',
    completion('OK') + frame({ content: 'late' }),
  ];
  for (const wire of failures) await assert.rejects(consumeCompletion(stream(wire, 5000), signal(), () => {}),
    (error: Error) => !/offline-stream-key|private/.test(error.message));
  await assert.rejects(consumeCompletion(stream(completion('x'.repeat(270000)), 8000), signal(), () => {}));
});

test('only explicit top-level reply/body strings can enter a preview', () => {
  assert.equal(previewString('{"reasoning":"secret","reply":"先做实际任务', 'reply'), '先做实际任务');
  assert.equal(previewString('{"nested":{"reply":"private"},"body":"用户正文', 'reply'), '');
  assert.equal(previewString('{"candidateIds":["private"],"reply":"公开回答"}', 'body'), '');
  assert.equal(previewString('{"nested":[{"body":"private"}],"body":"正文\\n换行\\"引号', 'body'), '正文\n换行"引号');
  assert.equal(previewString('```json\n{"reply":"中文\\u4f60\\u597d', 'reply'), '中文你好');
  assert.equal(previewString('{"reply":"\\ud83c', 'reply'), '');
  assert.equal(previewString('{"reply":"\\ud83c\\udf31', 'reply'), '🌱');
  assert.equal(previewString('preamble private {"reply":"text"}', 'reply'), '');
  assert.equal(previewString('{"reply":"bad\\q"}', 'reply'), '');
  assert.equal(previewString('{"reply":123}', 'reply'), '');
  assert.equal(previewString(`{"reply":"${'字'.repeat(13000)}`, 'reply').length, 12000);
});

test('real chat path emits partial safe snapshots before completion and preserves final structured result', async t => {
  const events: (ToolEvent | ModelEvent)[] = [];
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).stream, true);
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame({ reasoning_content: 'hidden' }) + frame({ content: '{"reply":"先做' })));
        release = () => {
          controller.enqueue(new TextEncoder().encode(frame({ content: '任务","internal":"private"}' }) + frame({}, 'stop') + 'data: [DONE]\n\n'));
          controller.close();
        };
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const result = withRun('stream-real-path', createRun(), event => {
    events.push(event);
    if (event.type === 'model_preview') started();
  }, () => chatJson([{ role: 'user', content: 'test' }], { purpose: 'test', preview: { field: 'reply', kind: 'answer' } }));
  await ready;
  assert.equal(events.filter(e => e.type === 'model_preview').at(-1)?.text, '先做');
  release();
  const value = await result;
  assert.deepEqual(value.data, { reply: '先做任务', internal: 'private' });
  const previews = events.filter((e): e is Extract<ModelEvent, { type: 'model_preview' }> => e.type === 'model_preview');
  assert.ok(previews.length);
  assert.equal(previews.at(-1)?.text, '先做任务');
  assert.doesNotMatch(JSON.stringify(events), /hidden|private|offline-stream-key/);
});

test('internal routing reports counts but never previews JSON fields', async t => {
  const events: (ToolEvent | ModelEvent)[] = [];
  t.mock.method(globalThis, 'fetch', async () => stream(completion('{"reply":"private-route","candidateIds":["internal"]}')));
  await withRun('internal-stream', createRun(), e => events.push(e),
    () => chatJson([{ role: 'user', content: 'route' }], { purpose: 'understand' }));
  assert.ok(events.some(e => e.type === 'model_progress'));
  assert.ok(events.every(e => e.type !== 'model_preview'));
  assert.doesNotMatch(JSON.stringify(events), /private-route|internal/);
});

test('invalid JSON preview is discarded before format repair starts with a new call id', async t => {
  const events: (ToolEvent | ModelEvent)[] = [];
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => stream(completion(++requests === 1 ? '{"reply":"old"' : '{"reply":"new"}')));
  const result = await withRun('repair-stream', createRun(), e => events.push(e),
    () => chatJson([{ role: 'user', content: 'test' }], { purpose: 'test', preview: { field: 'reply', kind: 'answer' } }));
  assert.deepEqual(result.data, { reply: 'new' });
  const discardIndex = events.findIndex(e => e.type === 'model_preview' && e.status === 'discarded');
  const discarded = events[discardIndex] as Extract<ModelEvent, { type: 'model_preview' }>;
  const next = events.slice(discardIndex + 1).find(e => e.type === 'model_preview') as Extract<ModelEvent, { type: 'model_preview' }>;
  assert.ok(discardIndex >= 0);
  assert.notEqual(discarded.callId, next.callId);
  assert.equal(discarded.text, '');
});

test('quota failures stop once without exposing upstream messages in events', async t => {
  const events: (ToolEvent | ModelEvent)[] = [];
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: { code: 'insufficient_quota', message: 'offline-stream-key private' } }, { status: 429 }));
  await assert.rejects(withRun('quota-stream', createRun(), e => events.push(e),
    () => chatJson([{ role: 'user', content: 'test' }], { purpose: 'test', preview: { field: 'reply', kind: 'answer' } })),
  (error: Error) => /额度不足/.test(error.message) && !/private|offline-stream-key/.test(error.message));
  assert.equal(fetch.mock.callCount(), 1);
  assert.doesNotMatch(JSON.stringify(events), /private|offline-stream-key/);
});

test('gateway timeout covers a stalled response body after headers', async t => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(frame({ content: 'partial' }))); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  await assert.rejects(consumeModelGateway({
    baseUrl: 'https://offline.example/v1', apiKey: 'offline-stream-key', models: ['offline'], model: 'offline',
  }, 'chat/completions', {}, 15, (response, abort) => consumeCompletion(response, abort, () => {})),
  (error: Error) => /超时/.test(error.message));
  assert.equal(cancelled, true);
});

test('user stop cancels an open model body with no late model events', async t => {
  const run = createRun();
  const events: (ToolEvent | ModelEvent)[] = [];
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(frame({ content: '{"reply":"partial' }))); },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const result = withRun('cancel-stream', run, e => { events.push(e); if (e.type === 'model_progress') ready(); },
    () => chatJson([{ role: 'user', content: 'test' }], { purpose: 'test', preview: { field: 'reply', kind: 'answer' } }));
  await started;
  assert.equal(cancelRun('cancel-stream', run.id), true);
  await assert.rejects(result, (error: Error) => /停止/.test(error.message));
  const count = events.length;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(events.length, count);
});
