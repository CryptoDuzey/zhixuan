import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConsultSnapshot, consultRunText } from '../app/components/frontend-session.ts';
const snapshot = { turns: [], busy: false, interrupted: false, updatedAt: '' };
test('consultation snapshot requires authoritative state and bounded valid turns', () => {
  assert.deepEqual(parseConsultSnapshot(snapshot), snapshot);
  for (const change of [{ busy: 'false' }, { interrupted: null }, { turns: Array(13).fill({ question: '问题' }) },
    { turns: [{ question: '' }] }, { turns: [{ question: '问题', answer: {} }] }, { error: {} }]) {
    assert.throws(() => parseConsultSnapshot({ ...snapshot, ...change }));
  }
});
test('server answer and run fields remain whitelisted', () => {
  const run = { id: 'r-test', status: 'cancelled', phase: '检索资料', cancelRequested: true };
  const clean = parseConsultSnapshot({ ...snapshot, run: { ...run, secret: 'hidden' }, error: '服务不可用',
    turns: [{ question: '问题', answer: { reply: '回复', recommendations: [], evidence: [], private: 'hidden' } }] });
  assert.deepEqual(clean.run, run);
  assert.equal(JSON.stringify(clean).includes('hidden'), false);
  assert.equal(clean.error, '服务不可用');
});
test('consultation statuses do not reuse creation verification language', () => {
  for (const status of ['running', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted'] as const) {
    const text = consultRunText({ id: 'r', status, phase: '检索资料', cancelRequested: false });
    assert.ok(text);
    assert.doesNotMatch(text, /稿件|核验/);
  }
  assert.match(consultRunText({ id: 'r', status: 'running', phase: '', cancelRequested: true }), /等待确认/);
});
