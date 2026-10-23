import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

// Transpile the real JSX module in memory; no generated files or server imports.
const require = createRequire(import.meta.url);
const ts = require('typescript');
const code = ts.transpileModule(readFileSync(new URL('../app/components/ModelPreview.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports: any = {};
vm.runInNewContext(code, { exports, require });
const { ModelPreviewStream } = exports;
const preview = (seq: number, extra = {}) => ({
  type: 'model_preview', runId: 'run-one', seq, callId: 'call-one',
  kind: 'draft', status: 'generating', text: '当前正文', ...extra,
});

test('snapshots replace text, remain bounded, and only accept the public protocol', () => {
  const stream = new ModelPreviewStream();
  assert.equal(stream.accept(preview(1)), true);
  assert.equal(stream.accept(preview(2, { text: '完整当前正文' })), true);
  assert.equal(stream.preview.text, '完整当前正文');
  for (const extra of [
    { kind: 'reasoning' }, { status: 'completed' }, { text: {} }, { text: 'x'.repeat(12001) },
    { callId: '' }, { callId: 'x'.repeat(201) }, { runId: undefined }, { seq: undefined },
  ]) {
    const previous = stream.preview;
    assert.equal(stream.accept(preview(3, extra)), false);
    assert.equal(stream.preview, previous);
  }
  assert.equal(stream.accept(preview(20, { text: 'x'.repeat(12000) })), true);
  assert.equal(stream.preview.text.length, 12000);
});

test('old runs, inconsistent run envelopes, and repeated/out of order sequences cannot replace content', () => {
  const stream = new ModelPreviewStream();
  assert.equal(stream.accept({ type: 'run', runId: 'run-one', seq: 1,
    run: { id: 'run-one', status: 'running', cancelRequested: false } }), true);
  stream.accept(preview(5));
  for (const event of [
    preview(4), preview(5), preview(10, { runId: 'run-old' }),
    preview(10, { run: { id: 'run-old', status: 'running' } }),
    { type: 'done', runId: 'run-old', seq: 12 },
  ]) assert.equal(stream.accept(event), false);
  assert.equal(stream.preview.text, '当前正文');
  assert.equal(stream.accept(preview(6, { text: '新正文' })), true);
});

test('new calls, progress, discard and steps retire previous calls permanently', () => {
  const stream = new ModelPreviewStream();
  stream.accept(preview(1));
  assert.equal(stream.accept({ type: 'model_progress', runId: 'run-one', seq: 2,
    callId: 'call-two', characters: 0, mode: 'buffered' }), true);
  assert.equal(stream.preview, null);
  assert.equal(stream.accept(preview(3)), false);
  stream.accept(preview(4, { callId: 'call-two' }));
  stream.accept(preview(5, { callId: 'call-two', status: 'discarded', text: '' }));
  assert.equal(stream.preview, null);
  assert.equal(stream.accept(preview(6, { callId: 'call-two' })), false);
  stream.accept(preview(7, { callId: 'call-three' }));
  stream.accept({ type: 'step', runId: 'run-one', seq: 8, label: '核验' });
  assert.equal(stream.preview, null);
  assert.equal(stream.accept(preview(9, { callId: 'call-three' })), false);
  assert.equal(stream.accept(preview(10, { callId: 'call-four' })), true);
});

test('formal outputs, error, done and terminal/cancelled runs clear content and reject late previews', () => {
  for (const event of [
    { type: 'answer' }, { type: 'draft' }, { type: 'clarify' }, { type: 'error' }, { type: 'done' },
    { type: 'run', run: { id: 'run-one', status: 'cancelled', cancelRequested: true } },
    { type: 'run', run: { id: 'run-one', status: 'running', cancelRequested: true } },
    { type: 'run', run: { id: 'run-one', status: 'failed', cancelRequested: false } },
  ]) {
    const stream = new ModelPreviewStream();
    stream.accept(preview(1));
    assert.equal(stream.accept({ ...event, runId: 'run-one', seq: 2 }), true);
    assert.equal(stream.preview, null);
    assert.equal(stream.accept(preview(3, { callId: 'late-call' })), false);
  }
});

test('stop/recover/reset invalidate the old stream, including late formal outputs', () => {
  const old = new ModelPreviewStream();
  old.accept(preview(1));
  old.close();
  assert.equal(old.preview, null);
  assert.equal(old.accept(preview(2)), false);
  assert.equal(old.accept({ type: 'answer', answer: { reply: '迟到' } }), false);
  const next = new ModelPreviewStream();
  assert.equal(next.accept(preview(1, { runId: 'next-run' })), true);
});

test('legacy model_progress without envelope remains accepted and never creates preview content', () => {
  const stream = new ModelPreviewStream();
  assert.equal(stream.accept({ type: 'model_progress', callId: 'legacy', characters: 20, mode: 'stream' }), true);
  assert.equal(stream.preview, null);
  assert.equal(stream.accept({ type: 'model_progress', callId: 'legacy', characters: -1, mode: 'buffered' }), false);
});
