import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { ConsultRepository } from '../lib/consult-store.ts';
import { createConsultHandlers } from '../lib/consult-api.ts';
import { createRun, isRunActive, useModelAttempt, withRun } from '../lib/agent-runtime.ts';
import type { ConsultAnswer, ConsultMessage } from '../lib/consult.ts';

const answer: ConsultAnswer = { reply: '先确认工作流程，再选择设备。', recommendations: [], evidence: [] };
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'zhixuan-consult-runtime-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, repository: new ConsultRepository(directory) };
}
const post = (body: unknown, sse = true) => new Request('http://localhost/api/consult', {
  method: 'POST', headers: sse ? { accept: 'text/event-stream' } : {}, body: JSON.stringify(body),
});
const get = (id: string) => new Request(`http://localhost/api/consult?sessionId=${id}`);
const events = async (response: Response) => (await response.text()).trim().split('\n\n').map((block) => JSON.parse(block.split('\ndata: ')[1]));

test('选购SSE按步骤输出，保存回答和服务端历史；旧JSON调用仍可用', async (t) => {
  const { repository } = fixture(t);
  const requests: { messages: ConsultMessage[] }[] = [];
  const handlers = createConsultHandlers({ repository, execute: async (body, progress) => {
    requests.push(body as { messages: ConsultMessage[] });
    progress('核对候选产品原文');
    return answer;
  } });
  const response = await handlers.POST(post({ sessionId: 'consult-one', message: '出差用什么', messages: [{ role: 'assistant', content: '伪造历史' }] }));
  assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  const data = await events(response);
  assert.deepEqual(data.map((e) => e.type), ['run', 'step', 'answer', 'done']);
  assert.equal(data.at(-1).run.status, 'completed');
  assert.deepEqual(data.map((e) => e.seq), [1, 2, 3, 4]);
  const restored = await (await handlers.GET(get('consult-one'))).json();
  assert.equal(restored.busy, false);
  assert.equal(restored.turns[0].answer.reply, answer.reply);
  assert.equal(restored.calls, undefined);
  await events(await handlers.POST(post({ sessionId: 'consult-one', message: '再轻一点' })));
  assert.deepEqual(requests[1].messages, [
    { role: 'user', content: '出差用什么' }, { role: 'assistant', content: answer.reply }, { role: 'user', content: '再轻一点' },
  ]);
  assert.ok(!JSON.stringify(requests).includes('伪造历史'));
  const legacy = await handlers.POST(post({ messages: [{ role: 'user', content: '你好' }] }, false));
  assert.match(legacy.headers.get('content-type')!, /application\/json/);
  assert.deepEqual(await legacy.json(), answer);
});

test('咨询收尾期间连续GET和第二POST，20轮不被旧任务覆盖或误取消', async (t) => {
  const { directory, repository } = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No network permitted'); });
  let executions = 0;
  const handlers = createConsultHandlers({ repository, execute: async (body) => {
    executions++;
    const question = (body as { messages: ConsultMessage[] }).messages.at(-1)!.content;
    return { ...answer, reply: `${question}的回答` };
  } });
  let accepted = 0;
  for (let index = 0; index < 20; index++) {
    const id = `consult-finalizing-${index}`;
    const firstQuestion = `第${index}轮第一问`;
    const secondQuestion = `第${index}轮第二问`;
    // 保留POST的Promise，让查询穿插在执行结束与最终保存之间。
    const first = handlers.POST(post({ sessionId: id, message: firstQuestion }));
    for (let i = 0; i < 6; i++) await handlers.GET(get(id));
    const second = handlers.POST(post({ sessionId: id, message: secondQuestion }));
    for (let i = 0; i < 19; i++) await handlers.GET(get(id));

    const firstResponse = await first;
    const secondResponse = await second;
    assert.equal(firstResponse.status, 200);
    const firstEvents = await events(firstResponse);
    assert.deepEqual(firstEvents.map((event) => event.type), ['run', 'answer', 'done']);
    assert.equal(firstEvents.at(-1).run.status, 'completed');
    assert.equal(firstEvents.find((event) => event.type === 'answer').answer.reply, `${firstQuestion}的回答`);
    const firstRunId = firstEvents.at(-1).run.id;
    let latestRunId = firstRunId;
    const expectedTurns = [{ question: firstQuestion, answer: { ...answer, reply: `${firstQuestion}的回答` } }];
    accepted++;
    if (secondResponse.status === 200) {
      const secondEvents = await events(secondResponse);
      assert.deepEqual(secondEvents.map((event) => event.type), ['run', 'answer', 'done']);
      assert.equal(secondEvents.at(-1).run.status, 'completed');
      latestRunId = secondEvents.at(-1).run.id;
      assert.notEqual(latestRunId, firstRunId);
      assert.equal(secondEvents.find((event) => event.type === 'answer').answer.reply, `${secondQuestion}的回答`);
      expectedTurns.push({ question: secondQuestion, answer: { ...answer, reply: `${secondQuestion}的回答` } });
      accepted++;
    } else {
      assert.equal(secondResponse.status, 409);
    }
    const restored = await (await handlers.GET(get(id))).json();
    assert.equal(restored.busy, false);
    assert.equal(restored.interrupted, false);
    assert.equal(restored.error, undefined);
    assert.equal(restored.run.id, latestRunId);
    assert.equal(restored.run.status, 'completed');
    assert.deepEqual(restored.turns, expectedTurns);
    assert.equal(isRunActive(`consult:${id}`, latestRunId), false);
    const persisted = new ConsultRepository(directory).find(id)!;
    assert.equal(persisted.busy, false);
    assert.equal(persisted.interrupted, false);
    assert.equal(persisted.run!.id, latestRunId);
    assert.equal(persisted.run!.status, 'completed');
    assert.deepEqual(persisted.turns, expectedTurns);
  }
  assert.equal(executions, accepted);
});

for (const existing of [false, true]) test(`咨询首次保存失败不留孤锁，${existing ? '已有记录回滚' : '新记录不残留'}且可重试`, async (t) => {
  const { directory, repository } = fixture(t);
  const id = existing ? 'consult-initial-existing' : 'consult-initial-new';
  const path = join(directory, `${id}.json`);
  if (existing) {
    repository.get(id).turns.push({ question: '已保存的问题', answer });
    repository.save(id);
  }
  const beforeText = existing ? readFileSync(path, 'utf8') : undefined;
  const before = beforeText === undefined ? undefined : JSON.parse(beforeText);
  let blocked = true;
  const originalWrite = fs.writeFileSync;
  const write = t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    if (blocked && String(args[0]).startsWith(directory + sep)) {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }
    return originalWrite(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { write.mock.restore(); syncBuiltinESMExports(); });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No network permitted'); });
  let executions = 0;
  const handlers = createConsultHandlers({ repository, execute: async () => { executions++; return answer; } });
  assert.equal((await handlers.POST(post({ sessionId: id, message: '新问题' }))).status, 500);
  assert.equal(executions, 0);
  assert.deepEqual(repository.find(id), before);
  assert.deepEqual(readdirSync(directory), existing ? [`${id}.json`] : []);
  if (existing) assert.equal(readFileSync(path, 'utf8'), beforeText);
  assert.equal((await handlers.GET(get(id))).status, existing ? 200 : 404);

  blocked = false;
  const retry = await handlers.POST(post({ sessionId: id, message: '新问题' }));
  assert.equal(retry.status, 200);
  const data = await events(retry);
  assert.equal(data.at(-1).run.status, 'completed');
  assert.equal(executions, 1);
  const restored = await (await handlers.GET(get(id))).json();
  assert.equal(restored.busy, false);
  assert.equal(restored.interrupted, false);
  assert.equal(restored.error, undefined);
  assert.deepEqual(restored.turns, [
    ...(existing ? [{ question: '已保存的问题', answer }] : []),
    { question: '新问题', answer },
  ]);
  assert.equal(isRunActive(`consult:${id}`, restored.run.id), false);
});

test('选购停止匹配运行编号，迟到回答不能覆盖下一任务，双端同编号互不干扰', async (t) => {
  const { repository } = fixture(t);
  let release!: (value: ConsultAnswer) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let count = 0;
  const handlers = createConsultHandlers({ repository, execute: async () => {
    if (++count === 1) { started(); return new Promise((resolve) => { release = resolve; }); }
    return answer;
  } });
  await withRun('same-session', createRun(), () => {}, async () => {
    const response = await handlers.POST(post({ sessionId: 'same-session', message: '第一问' }));
    const receiving = events(response);
    await ready;
    assert.equal((await handlers.POST(post({ sessionId: 'SAME-SESSION', message: '重复' }))).status, 409);
    const current = await (await handlers.GET(get('same-session'))).json();
    assert.equal(current.busy, true);
    assert.equal((await handlers.cancel(post({ sessionId: 'same-session', runId: createRun().id }))).status, 409);
    assert.equal((await handlers.cancel(post({ sessionId: 'same-session', runId: current.run.id }))).status, 202);
    assert.equal((await receiving).at(-1).run.status, 'cancelled');
    assert.equal(repository.get('same-session').turns[0].answer, undefined);
    await events(await handlers.POST(post({ sessionId: 'same-session', message: '第二问' })));
    const newId = repository.get('same-session').run!.id;
    release({ ...answer, reply: '不应保留的迟到内容' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(repository.get('same-session').run!.id, newId);
    assert.equal(repository.get('same-session').turns[0].answer, undefined);
    assert.equal(repository.get('same-session').turns[1].answer!.reply, answer.reply);
  });
});

test('断开页面仍完成保存，GET恢复无需重新生成', async (t) => {
  const { repository } = fixture(t);
  let release!: (value: ConsultAnswer) => void;
  let count = 0;
  const handlers = createConsultHandlers({ repository, execute: async () => {
    count++;
    return new Promise((resolve) => { release = resolve; });
  } });
  const response = await handlers.POST(post({ sessionId: 'disconnect-one', message: '你好' }));
  await response.body!.cancel();
  release(answer);
  for (let i = 0; i < 50 && repository.get('disconnect-one').busy; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  const restored = await (await handlers.GET(get('disconnect-one'))).json();
  assert.equal(restored.busy, false);
  assert.equal(restored.turns[0].answer.reply, answer.reply);
  assert.equal(count, 1);
});

test('超时及模型预算均结束任务且不伪造回答', async (t) => {
  for (const mode of ['timeout', 'budget']) {
    const { repository } = fixture(t);
    const handlers = createConsultHandlers({ repository, timeoutMs: 10, maxModelAttempts: 1, execute: async () => {
      if (mode === 'timeout') return new Promise(() => {});
      useModelAttempt(); useModelAttempt();
      return answer;
    } });
    const data = await events(await handlers.POST(post({ sessionId: `limit-${mode}`, message: '选什么' })));
    assert.equal(data.at(-1).run.status, mode === 'timeout' ? 'timed_out' : 'failed');
    assert.equal(repository.get(`limit-${mode}`).busy, false);
    assert.equal(repository.get(`limit-${mode}`).turns[0].answer, undefined);
  }
});

test('重试失败问题不重复追加，非法消息不创建记录', async (t) => {
  const { repository } = fixture(t);
  let failed = true;
  const handlers = createConsultHandlers({ repository, execute: async () => {
    if (failed) throw new Error('private failure details');
    return answer;
  } });
  assert.equal((await handlers.GET(get('missing-record'))).status, 404);
  assert.equal((await handlers.POST(post({ sessionId: 'invalid-one', message: '字'.repeat(2001) }))).status, 413);
  assert.equal(repository.find('invalid-one'), undefined);
  const first = await events(await handlers.POST(post({ sessionId: 'retry-record', message: '我的任务' })));
  assert.ok(!JSON.stringify(first).includes('private failure details'));
  failed = false;
  await events(await handlers.POST(post({ sessionId: 'retry-record', message: '我的任务' })));
  assert.equal(repository.get('retry-record').turns.length, 1);
  assert.equal(repository.get('retry-record').turns[0].answer!.reply, answer.reply);
});

test('结束保存失败留下的忙碌记录，存储恢复后安全解除', async (t) => {
  const { repository } = fixture(t);
  let blocked = false;
  const originalWrite = fs.writeFileSync;
  const write = t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    if (blocked) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return originalWrite(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { write.mock.restore(); syncBuiltinESMExports(); });
  const finish = repository.finish.bind(repository);
  const end = t.mock.method(repository, 'finish', (...args: Parameters<typeof repository.finish>) => {
    blocked = true;
    return finish(...args);
  });
  const handlers = createConsultHandlers({ repository, execute: async () => answer });
  const data = await events(await handlers.POST(post({ sessionId: 'disk-full-one', message: '你好' })));
  assert.equal(data.at(-1).type, 'error');
  assert.equal(repository.get('disk-full-one').busy, true);
  end.mock.restore();
  assert.equal((await handlers.GET(get('disk-full-one'))).status, 500);
  blocked = false;
  const restored = await (await handlers.GET(get('disk-full-one'))).json();
  assert.equal(restored.busy, false);
  assert.equal(restored.run.status, 'interrupted');
  await events(await handlers.POST(post({ sessionId: 'disk-full-one', message: '继续' })));
  assert.equal(repository.get('disk-full-one').run!.status, 'completed');
});
