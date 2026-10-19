import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  consultHistory, CONSULT_MAX_CHARS, CONSULT_MAX_TURNS, CONSULT_RETRIEVAL_MAX_CHARS, decodeConsultSession, encodeConsultSession,
  newStudioId, parseAgentSession, parseConsultAnswer, readStorage, SessionEpoch,
  STUDIO_SESSION_KEY, validStudioId, writeStorage, type StorageAccess,
} from '../app/components/frontend-session.ts';

const answer = {
  reply: '按实际用途选择，并核对软件版本。',
  recommendations: [{
    modelId: 'pro-s', modelName: 'HUAWEI MateBook Pro S', system: '鸿蒙',
    reason: '适合移动办公', tradeoff: '先核对软件', evidenceIds: ['E001'], creativeModelId: 'pro-s',
  }],
  evidence: [{
    id: 'E001', docId: 'doc-1', docTitle: '事实', docPath: '产品事实.md', line: 2,
    section: '', text: '产品资料', kind: 'fact', source: '本地已下载知识库', readAt: '2026-10-19',
  }],
  questions: ['常用哪些软件？'],
};
const documentId = '0123456789abcdef01234567';
const retrieval = {
  status: 'ready' as const, source: '本地已下载知识库' as const, scope: 'all-indexed-documents' as const,
  query: '移动办公', scannedFiles: 312, returned: 1, maximumResults: 50 as const, exhaustive: false as const,
  message: '按相关性返回，非穷尽结果。',
  items: [{
    id: documentId, title: '移动办公选购指南', path: '知识库/选购指南.md', preview: '先核实所需的软件与版本。',
    documentUrl: `/api/knowledge/document?id=${documentId}`, score: 0.8,
  }],
};

test('studio identifiers are random, valid and the only studio storage payload', () => {
  const ids = Array.from({ length: 100 }, newStudioId);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(validStudioId));
  assert.equal(validStudioId('../a'), false);
  assert.equal(validStudioId('x'.repeat(65)), false);
  const values = new Map<string, string>();
  const storage: StorageAccess = {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => { values.set(k, v); },
    removeItem: (k) => { values.delete(k); },
  };
  assert.equal(writeStorage(storage, STUDIO_SESSION_KEY, ids[0]), true);
  assert.deepEqual(readStorage(storage, STUDIO_SESSION_KEY), { value: ids[0], available: true });
  assert.deepEqual([...values.values()], [ids[0]]);
});

test('disabled storage, quota failures and missing storage never throw', () => {
  const broken = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('quota'); },
    removeItem() { throw new Error('denied'); },
  };
  assert.deepEqual(readStorage(broken, 'test'), { value: null, available: false });
  assert.equal(writeStorage(broken, 'test', 'value'), false);
  assert.equal(writeStorage(broken, 'test', null), false);
  assert.equal(writeStorage(undefined, 'test', 'value'), false);
  assert.deepEqual(readStorage(undefined, 'test'), { value: null, available: false });
});

test('consultation roundtrip restores recommendations and completed history without keys', () => {
  const raw = encodeConsultSession([{ question: '怎么选', answer: {
    ...answer, apiKey: 'NEVER-PERSIST', settings: { key: 'NEVER-PERSIST' },
  } as typeof answer }]);
  assert.equal(raw.includes('NEVER-PERSIST'), false);
  const saved = decodeConsultSession(raw);
  assert.equal(saved.invalid, false);
  assert.deepEqual(saved.turns[0].answer, answer);
  assert.deepEqual(consultHistory([...saved.turns, { question: '未完成' }]), [
    { role: 'user', content: '怎么选' },
    { role: 'assistant', content: answer.reply },
  ]);
});

test('consultation limits turns and serialized size, preserves unanswered questions', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ question: `问题${i}`, answer }));
  let raw = encodeConsultSession(many);
  assert.equal(decodeConsultSession(raw).turns.length, CONSULT_MAX_TURNS);
  const large = { ...answer, evidence: Array.from({ length: 160 }, () => ({ ...answer.evidence[0], text: '资'.repeat(12000) })) };
  raw = encodeConsultSession([{ question: '问题', answer: large as typeof answer }]);
  assert.ok(raw.length <= CONSULT_MAX_CHARS);
  assert.deepEqual(decodeConsultSession(raw).turns, [{ question: '问题' }]);
});

test('retrieval survives refresh with only whitelisted metadata and never enters model history', () => {
  const clean = { ...answer, retrieval };
  const parsed = parseConsultAnswer({
    ...clean,
    retrieval: {
      ...retrieval, apiKey: 'NEVER-PERSIST', rawDocuments: ['NEVER-PERSIST'],
      items: [{ ...retrieval.items[0], body: 'NEVER-PERSIST', settings: { key: 'NEVER-PERSIST' } }],
    },
  });
  assert.deepEqual(parsed, clean);
  const raw = encodeConsultSession([{ question: '怎么选', answer: parsed! }]);
  assert.ok(!raw.includes('NEVER-PERSIST'));
  const saved = decodeConsultSession(raw);
  assert.equal(saved.invalid, false);
  assert.deepEqual(saved.turns[0].answer, clean);
  assert.deepEqual(consultHistory(saved.turns), [
    { role: 'user', content: '怎么选' }, { role: 'assistant', content: answer.reply },
  ]);
});

test('unavailable, no-match and legacy answers keep their distinct retrieval states', () => {
  const empty = { ...retrieval, returned: 0, items: [] };
  for (const summary of [empty, { ...empty, status: 'unavailable', message: '本地检索服务暂不可用。' }]) {
    const parsed = parseConsultAnswer({ ...answer, retrieval: summary });
    assert.deepEqual(parsed?.retrieval, summary);
    assert.deepEqual(decodeConsultSession(encodeConsultSession([{ question: '问题', answer: parsed! }])).turns[0].answer, parsed);
  }
  assert.deepEqual(parseConsultAnswer(answer), answer);
  assert.equal(Object.hasOwn(parseConsultAnswer(answer)!, 'retrieval'), false);
});

test('unsafe or mismatched document links never survive live parsing or history restoration', () => {
  for (const documentUrl of [
    `https://example.com/api/knowledge/document?id=${documentId}`,
    `//example.com/api/knowledge/document?id=${documentId}`,
    'javascript:alert(1)', 'data:text/html,test',
    `/api/knowledge/document?id=${documentId}&download=1`,
    `/api/knowledge/document?id=${documentId}#fragment`,
    `/api/knowledge/document?id=${documentId}\n`,
    `/api/knowledge/document?id=${'f'.repeat(24)}`,
    `/api/knowledge/document?id=${documentId.toUpperCase()}`,
    '/api/knowledge/document?id=../../settings',
  ]) {
    const unsafe = { ...answer, retrieval: { ...retrieval, items: [{ ...retrieval.items[0], documentUrl }] } };
    const parsed = parseConsultAnswer(unsafe);
    assert.equal(parsed?.reply, answer.reply);
    assert.equal(parsed?.retrieval?.status, 'unavailable');
    assert.deepEqual(parsed?.retrieval?.items, []);
    const restored = decodeConsultSession(JSON.stringify({ version: 1, turns: [{ question: '问题', answer: unsafe }] }));
    assert.equal(restored.invalid, false);
    assert.equal(restored.turns[0].answer?.retrieval?.status, 'unavailable');
  }
});

test('invalid retrieval counts, scope, status and oversized fields cannot claim success', () => {
  const item = retrieval.items[0];
  for (const bad of [
    null, {}, { ...retrieval, status: 'success' }, { ...retrieval, source: '网络' },
    { ...retrieval, scope: 'some-documents' }, { ...retrieval, exhaustive: true },
    { ...retrieval, maximumResults: 100 }, { ...retrieval, returned: -1 },
    { ...retrieval, returned: 1.5 }, { ...retrieval, returned: 51 },
    { ...retrieval, returned: 0 }, { ...retrieval, scannedFiles: -1 },
    { ...retrieval, scannedFiles: Number.MAX_SAFE_INTEGER + 1 },
    { ...retrieval, status: 'unavailable' }, { ...retrieval, message: '' },
    { ...retrieval, query: 'q'.repeat(2001) }, { ...retrieval, message: 'm'.repeat(2001) },
    { ...retrieval, items: [null] },
    { ...retrieval, items: [{ ...item, id: 'x'.repeat(24) }] },
    { ...retrieval, items: [{ ...item, id: `${documentId}\n` }] },
    { ...retrieval, items: [{ ...item, title: 't'.repeat(1001) }] },
    { ...retrieval, items: [{ ...item, path: 'p'.repeat(2001) }] },
    { ...retrieval, items: [{ ...item, preview: 'p'.repeat(16001) }] },
    { ...retrieval, items: [{ ...item, score: Infinity }] },
    { ...retrieval, items: [{ ...item, score: '0.9' }] },
  ]) {
    const parsed = parseConsultAnswer({ ...answer, retrieval: bad });
    assert.equal(parsed?.reply, answer.reply);
    assert.equal(parsed?.retrieval?.status, 'unavailable');
    assert.deepEqual(parsed?.retrieval?.items, []);
  }
});

test('retrieval supports 50 results within its own size cap and keeps answers when retrieval is too large', () => {
  const items = Array.from({ length: 50 }, (_, index) => {
    const id = index.toString(16).padStart(24, '0');
    return { ...retrieval.items[0], id, documentUrl: `/api/knowledge/document?id=${id}` };
  });
  const full = { ...retrieval, returned: 50, items };
  assert.deepEqual(parseConsultAnswer({ ...answer, retrieval: full })?.retrieval, full);
  const longPassage = parseConsultAnswer({ ...answer, retrieval: {
    ...retrieval, items: [{ ...retrieval.items[0], title: '题'.repeat(1000), preview: '资'.repeat(16000) }],
  } });
  assert.equal(longPassage?.retrieval?.status, 'ready');
  assert.equal(longPassage?.retrieval?.items[0].preview.length, 800);
  assert.ok(longPassage?.retrieval?.items[0].preview.endsWith('…'));
  assert.equal(longPassage?.retrieval?.items[0].title.length, 500);
  const repeatedPassages = { ...retrieval, returned: 2, items: [retrieval.items[0], retrieval.items[0]] };
  assert.deepEqual(parseConsultAnswer({ ...answer, retrieval: repeatedPassages })?.retrieval, repeatedPassages);
  const oversized = { ...full, items: items.map((item) => ({
    ...item, title: '题'.repeat(1000), path: '路'.repeat(2000), preview: '资'.repeat(16000),
  })) };
  assert.ok(JSON.stringify(oversized).length > CONSULT_RETRIEVAL_MAX_CHARS);
  const parsed = parseConsultAnswer({ ...answer, retrieval: oversized });
  assert.equal(parsed?.reply, answer.reply);
  assert.equal(parsed?.retrieval?.status, 'unavailable');
  const raw = encodeConsultSession([{ question: '问题', answer: parsed! }]);
  assert.ok(raw.length <= CONSULT_MAX_CHARS);
  assert.equal(decodeConsultSession(raw).turns[0].answer?.reply, answer.reply);
});

test('corrupt, oversized, unsupported-version or invalid nested data is rejected', () => {
  for (const raw of [
    '{', 'x'.repeat(CONSULT_MAX_CHARS + 1),
    '{"version":2,"turns":[]}',
    '{"version":1,"turns":[{"question":23}]}',
    JSON.stringify({ version: 1, turns: [{ question: 'test', answer: { ...answer, recommendations: [null] } }] }),
    JSON.stringify({ version: 1, turns: [{ question: 'test', answer: { ...answer, evidence: [{ ...answer.evidence[0], line: '2' }] } }] }),
  ]) {
    assert.deepEqual(decodeConsultSession(raw), { turns: [], invalid: true });
  }
  assert.equal(parseConsultAnswer({ ...answer, questions: [null] }), null);
  assert.equal(parseConsultAnswer({ ...answer, reply: '' }), null);
  assert.deepEqual(decodeConsultSession(null), { turns: [], invalid: false });
});

test('agent restoration retains busy/interrupted and clarification messages without inventing completion', () => {
  const data = {
    view: { evidence: [], images: [] },
    messages: [{ role: 'assistant', text: '受众是谁', kind: 'clarify', options: ['学生'] }],
    busy: true, interrupted: false, updatedAt: '2026-10-19T01:00:00Z',
  };
  assert.deepEqual(parseAgentSession(data), data);
  assert.equal(parseAgentSession({ ...data, busy: false, interrupted: true }).interrupted, true);
  assert.throws(() => parseAgentSession({ ...data, busy: 'yes' }));
  assert.throws(() => parseAgentSession({ ...data, messages: [{ role: 'tool', text: 'x' }] }));
  assert.throws(() => parseAgentSession({ ...data, messages: [{ role: 'assistant', text: 'x', options: [1] }] }));
});

test('session epochs abort old requests and reject delayed success, errors and finally handlers', async () => {
  const epoch = new SessionEpoch();
  const old = epoch.start();
  const newer = epoch.start();
  assert.equal(old.signal.aborted, true);
  assert.equal(old.current(), false);
  assert.equal(newer.current(), true);
  let mutations = 0;
  const late = Promise.resolve().then(() => { if (newer.current()) mutations++; });
  epoch.cancel();
  await late;
  assert.equal(newer.current(), false);
  assert.equal(mutations, 0);
});
