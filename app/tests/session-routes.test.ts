import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStorageError } from '../lib/session-store.ts';

const directory = mkdtempSync(join(tmpdir(), 'zhixuan-routes-'));
process.env.ZHIXUAN_SESSION_DIR = directory;
const { GET, POST } = await import('../app/api/agent/route.ts');
const { POST: stop } = await import('../app/api/agent/cancel/route.ts');
const { GET: exportDraft } = await import('../app/api/export/route.ts');
const { sessionRepository } = await import('../lib/store.ts');
const { createRun, withRun } = await import('../lib/agent-runtime.ts');
after(() => rmSync(directory, { recursive: true, force: true }));
beforeEach((t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No network permitted'); });
});
const request = (body: unknown) => new Request('http://localhost/api/agent', { method: 'POST', body: JSON.stringify(body) });
const url = (id: string, path = 'agent') => new Request(`http://localhost/api/${path}?sessionId=${encodeURIComponent(id)}`);

test('恢复接口区分无效编号、不存在和已保存记录，响应禁止缓存', async () => {
  assert.equal((await GET(url('../escape'))).status, 400);
  assert.equal((await GET(url('missing-session'))).status, 404);
  sessionRepository.appendMessage('saved-session', { role: 'user', text: '差旅场景' });
  const response = await GET(url('saved-session'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.messages[0].text, '差旅场景');
  assert.equal(body.busy, false);
  assert.equal(body.interrupted, false);
  assert.deepEqual(body.view.evidence, []);
});

test('任务重复提交和处理中导出均被拒绝，不污染对话', async () => {
  sessionRepository.begin('locked-session');
  assert.equal((await POST(request({ sessionId: 'locked-session', message: '写一篇' }))).status, 409);
  assert.equal((await exportDraft(url('locked-session', 'export'))).status, 409);
  assert.deepEqual(sessionRepository.get('locked-session').messages, []);
  sessionRepository.finish('locked-session');
});

test('无产品澄清不调用网络，完成后保存消息且可恢复', async () => {
  const response = await POST(request({ sessionId: 'guard-session', message: '帮我写篇小红书' }));
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === 'clarify'));
  assert.equal(events.at(-1).type, 'done');
  const saved = await (await GET(url('guard-session'))).json();
  assert.equal(saved.busy, false);
  assert.equal(saved.messages[0].role, 'user');
  assert.equal(saved.messages[1].kind, 'clarify');
  assert.equal(saved.view.draft, undefined);
});

test('非法与过大请求不创建会话，分块超限也拒绝', async () => {
  assert.equal((await POST(request(null))).status, 400);
  assert.equal((await POST(request({ sessionId: 'empty-patch', patch: [] }))).status, 400);
  assert.equal((await POST(request({ sessionId: 'empty-patch', patch: { arbitrary: 'value' } }))).status, 400);
  assert.equal(sessionRepository.find('empty-patch'), undefined);
  assert.equal((await POST(request({ sessionId: 'large-input', message: '字'.repeat(12000) }))).status, 413);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(16001)); controller.enqueue(new Uint8Array(16001)); controller.close(); },
  });
  const chunked = new Request('http://localhost/api/agent', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
  assert.equal((await POST(chunked)).status, 413);
});

test('损坏记录返回可读错误，不泄露文件内容或覆盖文件', async () => {
  writeFileSync(join(directory, 'broken-record.json'), '{private content');
  const response = await GET(url('broken-record'));
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.ok(!text.includes(directory));
  assert.ok(!text.includes('private content'));
});

test('问题与忙碌状态一同保存失败时不留下任务锁', async (t) => {
  sessionRepository.save('write-failure');
  const write = t.mock.method(fs, 'writeFileSync', () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
  syncBuiltinESMExports();
  t.after(() => { write.mock.restore(); syncBuiltinESMExports(); });
  assert.equal((await POST(request({ sessionId: 'write-failure', message: '你好' }))).status, 500);
  assert.equal(sessionRepository.get('write-failure').busy, false);
  assert.equal(sessionRepository.get('write-failure').run, undefined);
  assert.deepEqual(sessionRepository.get('write-failure').messages, []);
});

test('收尾期间连续恢复和提交，不误判孤立任务或覆盖新任务', async () => {
  for (let index = 0; index < 20; index++) {
    const id = `finalizing-${index}`;
    const first = await POST(request({ sessionId: id, message: '你好' }));
    for (let i = 0; i < 6; i++) await GET(url(id));
    const second = await POST(request({ sessionId: id, message: '你好' }));
    for (let i = 0; i < 4; i++) await GET(url(id));
    const firstEvents = (await first.text()).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(firstEvents.at(-1).run.status, 'completed');
    if (second.status === 200) {
      const secondEvents = (await second.text()).trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(secondEvents.at(-1).run.status, 'completed');
    } else assert.equal(second.status, 409);
    const saved = await (await GET(url(id))).json();
    assert.equal(saved.busy, false);
    assert.equal(saved.run.status, 'completed');
    assert.equal(saved.interrupted, false);
  }
});

for (const recovery of ['GET', 'POST'] as const) test(`结束时磁盘写满不伪报完成，存储恢复后${recovery}解除孤立锁`, async (t) => {
  const id = `disk-full-${recovery.toLowerCase()}`;
  const originalWrite = fs.writeFileSync;
  const originalFinish = sessionRepository.finish.bind(sessionRepository);
  let blocked = false;
  const writeMock = t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    if (blocked) throw Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });
    return originalWrite(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { writeMock.mock.restore(); syncBuiltinESMExports(); });
  const finishMock = t.mock.method(sessionRepository, 'finish', (...args: Parameters<typeof sessionRepository.finish>) => {
    blocked = true;
    return originalFinish(...args);
  });
  const response = await POST(request({ sessionId: id, message: '你好' }));
  const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.some((event) => event.type === 'done'), false);
  assert.equal(sessionRepository.get(id).busy, true);
  finishMock.mock.restore();
  assert.equal((await GET(url(id))).status, 500);
  assert.equal((await POST(request({ sessionId: id, message: '你好' }))).status, 500);
  assert.equal(sessionRepository.get(id).busy, true);
  blocked = false;
  if (recovery === 'GET') {
    const restored = await (await GET(url(id))).json();
    assert.equal(restored.busy, false);
    assert.equal(restored.interrupted, true);
    assert.equal(restored.run.status, 'interrupted');
    assert.ok(restored.run.endedAt);
  }
  const next = await POST(request({ sessionId: id, message: '你好' }));
  assert.equal(next.status, 200);
  await next.text();
  assert.equal(sessionRepository.get(id).busy, false);
  assert.equal(sessionRepository.get(id).run!.status, 'completed');
});

test('恢复查询不打断注册中的真实任务，重复提交仍拒绝', async () => {
  const id = 'active-recovery';
  const run = createRun();
  sessionRepository.get(id).run = run;
  sessionRepository.begin(id);
  await withRun(id, run, () => {}, async () => {
    const current = await (await GET(url(id))).json();
    assert.equal(current.busy, true);
    assert.equal(current.run.status, 'running');
    assert.equal((await POST(request({ sessionId: id, message: '你好' }))).status, 409);
  });
  const recovered = await (await GET(url(id))).json();
  assert.equal(recovered.busy, false);
  assert.equal(recovered.run.status, 'interrupted');
});

test('导出仅包含本会话调用，修改版本未核验则禁止导出', async () => {
  const record = sessionRepository.get('export-session');
  const s = record.session;
  s.modelId = 'd14'; s.modelName = 'D14';
  s.draft = { version: 1, modelId: 'd14', modelName: 'D14', platform: '朋友圈', title: '先看课程', lead: '', body: '确认软件后再选', cta: '以官网为准', tags: [], images: [], claims: [] };
  s.report = { draftVersion: 1, status: 'pass', issues: [], verifiedClaimIds: [], verifiedImageIds: [], checkedAt: new Date().toISOString() };
  sessionRepository.appendCall('export-session', { at: new Date().toISOString(), op: 'read', target: 'own-document', ok: true });
  sessionRepository.appendCall('another-session', { at: new Date().toISOString(), op: 'read', target: 'other-document', ok: true });
  const response = await exportDraft(url('export-session', 'export'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.imaCallsScope, 'session');
  assert.deepEqual(body.imaCalls.map((entry: { target: string }) => entry.target), ['own-document']);
  s.draft.version = 2;
  sessionRepository.save('export-session');
  assert.equal((await exportDraft(url('export-session', 'export'))).status, 409);
});

test('长正文和长消息明确拒绝，不截断、也不创建会话', async () => {
  for (const body of [
    { sessionId: 'long-edit', patch: { body: '字'.repeat(6008) } },
    { sessionId: 'long-edit', message: 'a'.repeat(2001) },
  ]) {
    const response = await POST(request(body));
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /未被保存或截断/);
    assert.equal(sessionRepository.find('long-edit'), undefined);
  }
});

test('真实路由协商SSE并在GET恢复运行状态，done仅说明任务结束', async () => {
  const response = await POST(new Request('http://localhost/api/agent', { method: 'POST',
    headers: { accept: 'text/event-stream' }, body: JSON.stringify({ sessionId: 'sse-session', message: '你好' }) }));
  assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  const blocks = (await response.text()).trim().split('\n\n');
  const events = blocks.map((block) => JSON.parse(block.split('\ndata: ')[1]));
  assert.equal(events[0].type, 'run');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).run.status, 'completed');
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
  const restored = await (await GET(url('sse-session'))).json();
  assert.equal(restored.run.id, events[0].runId);
  assert.equal(restored.busy, false);
  assert.equal(restored.view.report, undefined);
});

test('取消正在等待的模型，不重试；忽略取消的迟到结果不会改坏下一项任务', async (t) => {
  t.mock.method(process, 'cwd', () => directory);
  const key = process.env.OPENAI_NEXT_API_KEY;
  process.env.OPENAI_NEXT_API_KEY = 'offline-placeholder';
  t.after(() => {
    if (key === undefined) delete process.env.OPENAI_NEXT_API_KEY;
    else process.env.OPENAI_NEXT_API_KEY = key;
  });
  let calls = 0;
  let resolveFetch!: (value: Response) => void;
  let started!: () => void;
  let signal: AbortSignal | undefined;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++;
    signal = options?.signal as AbortSignal;
    started();
    return new Promise<Response>((resolve) => { resolveFetch = resolve; });
  });
  const record = sessionRepository.get('cancel-session');
  record.session.modelId = 'pro-s';
  record.session.modelName = 'HUAWEI MateBook Pro S';
  sessionRepository.save('cancel-session');
  const response = await POST(request({ sessionId: 'cancel-session', message: '写小红书' }));
  const stream = response.text();
  await ready;
  const runId = sessionRepository.get('cancel-session').run!.id;
  const cancelRequest = (id: string) => new Request('http://localhost/api/agent/cancel', { method: 'POST',
    body: JSON.stringify({ sessionId: 'cancel-session', runId: id }) });
  assert.equal((await stop(cancelRequest('00000000-0000-0000-0000-000000000000'))).status, 409);
  assert.equal((await stop(cancelRequest(runId))).status, 202);
  const events = (await stream).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.at(-1).run.status, 'cancelled');
  assert.equal(signal!.aborted, true);
  assert.equal(calls, 1);
  assert.equal((await (await GET(url('cancel-session'))).json()).busy, false);
  sessionRepository.get('cancel-session').session.modelId = '';
  sessionRepository.save('cancel-session');
  const next = await POST(request({ sessionId: 'cancel-session', message: '你好' }));
  await next.text();
  const newRun = sessionRepository.get('cancel-session').run!.id;
  assert.notEqual(runId, newRun);
  resolveFetch(Response.json({ choices: [{ message: { content: '{"next_action":"write","platform":"小红书"}' } }] }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sessionRepository.get('cancel-session').run!.id, newRun);
  assert.equal(sessionRepository.get('cancel-session').session.draft, undefined);
  assert.equal(calls, 1);
});
