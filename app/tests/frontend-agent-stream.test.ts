import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentStreamDecoder, consumeAgentStream, parseAgentRun, runStatusText } from '../lib/agent-stream.ts';
import { parseAgentSession } from '../app/components/frontend-session.ts';

const run = { id: 'r-test', status: 'running', phase: '核验事实与图片', cancelRequested: false };
const encode = new TextEncoder();

test('SSE handles every UTF-8 byte boundary, CRLF, comments, multiple data lines and heartbeats', () => {
  const events: unknown[] = [];
  const decoder = new AgentStreamDecoder('text/event-stream; charset=utf-8', (e) => events.push(e));
  const stream = ': keepalive\r\n\r\nevent: heartbeat\r\ndata: {}\r\n\r\n'
    + 'id: r-test:1\r\nevent: step\r\ndata: {"type":"step",\r\ndata: "label":"核验事实与图片","runId":"r-test","seq":1}\r\n\r\n';
  for (const byte of encode.encode(stream)) decoder.push(new Uint8Array([byte]));
  decoder.finish();
  assert.deepEqual(events, [{ type: 'step', label: '核验事实与图片', runId: 'r-test', seq: 1 }]);
});

test('NDJSON remains compatible with trailing JSON without newline and split Chinese text', () => {
  const events: unknown[] = [];
  const decoder = new AgentStreamDecoder('application/x-ndjson', (e) => events.push(e));
  for (const byte of encode.encode('{"type":"step","label":"核对资料"}\n{"type":"done","view":{}}')) {
    decoder.push(new Uint8Array([byte]));
  }
  decoder.finish();
  assert.deepEqual(events, [{ type: 'step', label: '核对资料' }, { type: 'done', view: {} }]);
});

test('replayed sequence is ignored without dropping a different run', () => {
  const events: unknown[] = [];
  const decoder = new AgentStreamDecoder('text/event-stream', (e) => events.push(e));
  for (const [runId, seq] of [['a', 1], ['a', 1], ['a', 0], ['b', 0], ['a', 2]]) {
    decoder.push(encode.encode(`event: notice\ndata: ${JSON.stringify({ type: 'notice', runId, seq, text: '消息' })}\n\n`));
  }
  decoder.finish();
  assert.equal(events.length, 3);
});

test('incomplete or mismatched SSE never dispatches done', () => {
  for (const frame of [
    'event: done\ndata: {"type":"done","view":{}}\n',
    'event: done\ndata: {"type":"draft"}\n\n',
    'event: done\ndata: {}\n\n',
    'event: done\ndata: invalid\n\n',
  ]) {
    const events: unknown[] = [];
    const decoder = new AgentStreamDecoder('text/event-stream', (e) => events.push(e));
    assert.throws(() => { decoder.push(encode.encode(frame)); decoder.finish(); });
    assert.equal(events.length, 0);
  }
});

test('large unterminated lines and oversized multiline frames are rejected', () => {
  const decoder = new AgentStreamDecoder('text/event-stream', () => {});
  assert.throws(() => decoder.push(encode.encode('data: ' + 'a'.repeat(2_000_001))));
  const multiline = new AgentStreamDecoder('text/event-stream', () => {});
  assert.throws(() => multiline.push(encode.encode(('data: ' + 'a'.repeat(1000) + '\n').repeat(2001))));
});

test('consumer releases stream reader even when event handling fails', async () => {
  const response = new Response('{"type":"error","text":"服务不可用"}\n', { headers: { 'content-type': 'application/x-ndjson' } });
  await assert.rejects(consumeAgentStream(response, () => { throw new Error('handler'); }), /handler/);
  assert.equal(response.body!.locked, false);
});

test('restoration keeps safe optional run state and preserves legacy contract', () => {
  const snapshot = { view: { evidence: [], images: [] }, messages: [], busy: true, interrupted: false, updatedAt: '' };
  assert.deepEqual(parseAgentSession(snapshot), snapshot);
  assert.deepEqual(parseAgentSession({ ...snapshot, run: { ...run, gateway: 'private', sequence: 9 } }).run, run);
  assert.equal(parseAgentSession({ ...snapshot, run: { ...run, status: 'invented' } }).run, undefined);
  for (const status of ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted']) {
    assert.ok(parseAgentRun({ ...run, status }));
  }
  assert.match(runStatusText(parseAgentRun({ ...run, cancelRequested: true })!), /等待确认/);
  assert.match(runStatusText(parseAgentRun({ ...run, status: 'completed' })!), /核验结果为准/);
  assert.match(runStatusText(parseAgentRun({ ...run, status: 'cancelled' })!), /已停止/);
});
