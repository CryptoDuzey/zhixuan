import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ConsultRepository, consultRepository, type SavedConsult } from '../lib/consult-store.ts';
import { SessionRepository, SessionStorageError } from '../lib/session-store.ts';
import type { ConsultAnswer } from '../lib/consult.ts';
import type { CallLog } from '../lib/ima.ts';
import type { RunState } from '../lib/agent-runtime.ts';

const MAX_FILE_BYTES = 12 * 1024 * 1024;

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'zhixuan-consult-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, repo: new ConsultRepository(dir), reopen: () => new ConsultRepository(dir) };
}

function failWrites(t: TestContext, directory: string) {
  const original = fs.writeFileSync;
  let blocked = true;
  const mocked = t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    if (blocked && String(args[0]).startsWith(directory + sep)) {
      throw Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  return () => { blocked = false; };
}

function running(): RunState {
  return {
    id: 'consult-run', status: 'running', phase: '查阅选购资料',
    startedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:01.000Z',
    sequence: 7, cancelRequested: false,
  };
}

function answer(): ConsultAnswer {
  return {
    reply: '先确认课程软件与预算。',
    questions: ['需要使用什么软件？'],
    recommendations: [{
      modelId: 'd14', modelName: 'MateBook D 14', system: 'Windows',
      reason: '适合列为候选。', tradeoff: '需先试用课程软件。', evidenceIds: ['E001'],
    }],
    evidence: [{
      id: 'E001', docId: 'document-one', docTitle: '产品资料', docPath: 'product/facts.md',
      line: 1, section: '适用场景', text: '请先确认软件版本。', kind: 'limit',
      source: '本地已下载知识库', readAt: '2020-01-01T00:00:00.000Z',
    }],
  };
}

const call = (target: string): CallLog => ({ at: '', op: 'read', target, ok: true });

test('get 创建空咨询且不写盘，find 不创建记录', (t) => {
  const { dir, repo, reopen } = fixture(t);
  assert.equal(repo.find('consult-one'), undefined);
  const record = repo.get('consult-one');
  assert.deepEqual(record, {
    schema: 1, turns: [], calls: [], busy: false, interrupted: false, updatedAt: record.updatedAt,
  });
  assert.ok(Number.isFinite(Date.parse(record.updatedAt)));
  assert.equal(repo.find('consult-one'), record);
  assert.equal(reopen().find('consult-one'), undefined);
  assert.deepEqual(readdirSync(dir), []);
});

test('问题、完整回答、任务状态与错误实际落盘并恢复', (t) => {
  const { dir, repo, reopen } = fixture(t);
  const record = repo.get('consult-one');
  record.turns.push({ question: '学生该选什么电脑？', answer: answer() }, { question: '软件版本还没确定' });
  record.run = { ...running(), status: 'completed', endedAt: '2020-01-01T00:00:02.000Z' };
  record.error = '上次资料读取失败，请重试。';
  repo.appendCall('consult-one', call('product-one'));
  assert.deepEqual(reopen().find('consult-one'), record);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'consult-one.json'), 'utf8')), record);
  assert.deepEqual(readdirSync(dir), ['consult-one.json']);
});

test('咨询之间、咨询与创作仓库之间，以及独立目录之间互相隔离', (t) => {
  const { dir, repo, reopen } = fixture(t);
  const other = new ConsultRepository(join(dir, 'other'));
  const creative = new SessionRepository(join(dir, 'sessions'), () => ({ modelId: '', modelName: '' }));
  repo.get('consult-one').turns.push({ question: '第一个问题' });
  repo.appendCall('consult-one', call('product-one'));
  repo.get('consult-two').turns.push({ question: '第二个问题' });
  repo.appendCall('consult-two', call('product-two'));
  other.get('consult-one').turns.push({ question: '另一个目录的问题' });
  other.save('consult-one');
  creative.appendMessage('consult-one', { role: 'user', text: '生成文案' });
  assert.deepEqual(reopen().find('consult-one')!.turns, [{ question: '第一个问题' }]);
  assert.deepEqual(reopen().find('consult-two')!.calls.map((entry) => entry.target), ['product-two']);
  assert.deepEqual(new ConsultRepository(join(dir, 'other')).find('consult-one')!.turns, [{ question: '另一个目录的问题' }]);
  assert.deepEqual(creative.get('consult-one').messages.map((message) => message.text), ['生成文案']);
  assert.notEqual(repo.get('consult-one').turns, repo.get('consult-two').turns);
});

test('begin 只设置忙碌和中断标志，不添加问题或创建任务', (t) => {
  const { repo, reopen } = fixture(t);
  const record = repo.get('consult-one');
  record.turns.push({ question: '保留原问题', answer: answer() });
  record.error = '保留原错误';
  repo.finish('consult-one', true);
  const turns = structuredClone(record.turns);
  assert.equal(repo.begin('consult-one'), true);
  assert.equal(record.busy, true);
  assert.equal(record.interrupted, false);
  assert.equal(record.run, undefined);
  assert.equal(record.error, '保留原错误');
  assert.deepEqual(record.turns, turns);
  assert.equal(repo.begin('consult-one'), false);
  assert.equal(repo.begin('consult-two'), true);
  repo.finish('consult-one');
  assert.equal(repo.begin('consult-one'), true);
  assert.deepEqual(reopen().find('consult-one')!.turns, turns);
});

test('begin 和 finish 保留路由提供的任务身份与状态', (t) => {
  const { repo } = fixture(t);
  const record = repo.get('consult-one');
  const run = record.run = running();
  const snapshot = structuredClone(run);
  assert.equal(repo.begin('consult-one'), true);
  assert.equal(record.run, run);
  assert.deepEqual(run, snapshot);
  repo.finish('consult-one', true);
  assert.equal(record.busy, false);
  assert.equal(record.interrupted, true);
  assert.equal(record.run, run);
  assert.deepEqual(run, snapshot);
  repo.finish('consult-one');
  assert.equal(record.interrupted, false);
});

test('大小写编号共用记录、任务锁和小写文件名', (t) => {
  const { dir, repo, reopen } = fixture(t);
  const record = repo.get('CONSULT-One');
  assert.equal(repo.get('consult-one'), record);
  assert.equal(repo.begin('CONSULT-One'), true);
  assert.equal(repo.begin('consult-one'), false);
  record.turns.push({ question: '第一轮', answer: answer() });
  repo.save('CONSULT-ONE');
  repo.appendCall('Consult-One', call('own-document'));
  assert.equal(record.interrupted, false);
  assert.equal(record.busy, true);
  repo.finish('Consult-ONE');
  assert.deepEqual(readdirSync(dir), ['consult-one.json']);
  assert.deepEqual(reopen().find('CONSULT-ONE'), record);
});

test('所有入口拒绝无效编号且不生成文件', (t) => {
  const { dir, repo } = fixture(t);
  for (const id of ['../secret', '..\\secret', 'a/b', 'short', 'a'.repeat(65), '咨询编号一二三', 'consult\none']) {
    for (const operation of [
      () => repo.find(id), () => repo.get(id), () => repo.save(id),
      () => repo.begin(id), () => repo.finish(id), () => repo.appendCall(id, call('test')),
    ]) assert.throws(operation, SessionStorageError);
  }
  repo.save('A_1234');
  assert.deepEqual(readdirSync(dir), ['a_1234.json']);
});

test('save 对直接修改的历史只保留最新 12 轮和 500 条调用', (t) => {
  const { repo, reopen } = fixture(t);
  const record = repo.get('consult-one');
  record.turns = Array.from({ length: 15 }, (_, index) => ({ question: `question-${index}` }));
  record.calls = Array.from({ length: 505 }, (_, index) => call(`call-${index}`));
  repo.save('consult-one');
  assert.equal(record.turns.length, 12);
  assert.equal(record.turns[0].question, 'question-3');
  assert.equal(record.turns.at(-1)!.question, 'question-14');
  assert.equal(record.calls.length, 500);
  assert.equal(record.calls[0].target, 'call-5');
  assert.deepEqual(reopen().find('consult-one'), record);
  const entry = call('latest-call');
  repo.appendCall('consult-one', entry);
  entry.target = 'caller-mutated';
  assert.equal(record.calls.length, 500);
  assert.equal(record.calls[0].target, 'call-6');
  assert.equal(record.calls.at(-1)!.target, 'latest-call');
  assert.deepEqual(reopen().find('consult-one'), record);
});

test('第 13 轮先追加问题再 begin，后续保存裁剪仍保留最新问题和完整回答', (t) => {
  const { dir, repo, reopen } = fixture(t);
  const record = repo.get('consult-one');
  record.turns = Array.from({ length: 12 }, (_, index) => ({
    question: `question-${index + 1}`, answer: { ...answer(), reply: `answer-${index + 1}` },
  }));
  repo.save('consult-one');
  const previous = structuredClone(record.turns);
  const latest = { question: '第 13 轮的新问题', answer: undefined as ConsultAnswer | undefined };
  record.turns.push(latest);
  record.run = running();
  assert.equal(repo.begin('consult-one'), true);
  assert.equal(record.turns.length, 12);
  assert.equal(record.turns.at(-1), latest);
  assert.deepEqual(record.turns.slice(0, -1), previous.slice(1));
  assert.equal(JSON.parse(readFileSync(join(dir, 'consult-one.json'), 'utf8')).turns.at(-1).question, latest.question);
  const newestAnswer = answer();
  latest.answer = newestAnswer;
  repo.save('CONSULT-ONE');
  repo.save('consult-one');
  assert.equal(record.turns.at(-1), latest);
  assert.equal(record.turns.at(-1)!.answer, newestAnswer);
  repo.finish('consult-one');
  const restored = reopen().find('consult-one')!;
  assert.deepEqual(restored.turns, [...previous.slice(1), latest]);
  assert.equal(restored.turns.length, 12);
  assert.equal(restored.busy, false);
});

test('保存失败恢复嵌套回答、任务状态、错误与时间，并保留记录和任务引用', (t) => {
  const { dir, repo, reopen } = fixture(t);
  const record = repo.get('consult-one');
  record.turns.push({ question: '原问题', answer: answer() });
  const run = record.run = { ...running(), status: 'completed' as const, endedAt: '2020-01-01T00:00:02.000Z' };
  record.error = '原错误';
  repo.save('consult-one');
  const savedText = readFileSync(join(dir, 'consult-one.json'), 'utf8');
  const saved = JSON.parse(savedText);
  const resumeWrites = failWrites(t, dir);
  record.turns[0].answer!.reply = '未保存回答';
  record.turns[0].answer!.questions!.push('未保存追问');
  record.turns[0].answer!.evidence[0].text = '未保存证据';
  record.turns[0].answer!.recommendations[0].evidenceIds.push('未保存引用');
  record.run.sequence++;
  record.run.phase = '未保存进度';
  record.error = '未保存错误';
  record.updatedAt = '2099-01-01T00:00:00.000Z';
  assert.throws(() => repo.save('CONSULT-ONE'), SessionStorageError);
  assert.equal(repo.find('consult-one'), record);
  assert.equal(record.run, run);
  assert.deepEqual(record, saved);
  record.turns[0].answer!.reply = '再次修改';
  run.sequence++;
  assert.throws(() => repo.save('consult-one'), SessionStorageError);
  assert.deepEqual(record, saved);
  assert.equal(record.run, run);
  assert.equal(readFileSync(join(dir, 'consult-one.json'), 'utf8'), savedText);
  assert.deepEqual(reopen().find('consult-one'), saved);
  resumeWrites();
  record.turns[0].answer!.reply = '重试成功';
  repo.save('consult-one');
  assert.equal(reopen().find('consult-one')!.turns[0].answer!.reply, '重试成功');
  assert.deepEqual(readdirSync(dir), ['consult-one.json']);
});

test('替换文件失败保留原文件、恢复内存并清除临时文件', (t) => {
  const { dir, repo, reopen } = fixture(t);
  const record = repo.get('consult-one');
  record.turns.push({ question: '已保存问题' });
  repo.save('consult-one');
  const path = join(dir, 'consult-one.json');
  const savedText = readFileSync(path, 'utf8');
  const original = fs.renameSync;
  let blocked = true;
  const mocked = t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
    if (blocked && String(args[1]) === path) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  record.turns.push({ question: '未保存问题' });
  assert.throws(() => repo.save('CONSULT-ONE'), SessionStorageError);
  assert.deepEqual(record, JSON.parse(savedText));
  assert.equal(readFileSync(path, 'utf8'), savedText);
  assert.deepEqual(readdirSync(dir), ['consult-one.json']);
  assert.deepEqual(reopen().find('consult-one'), record);
  blocked = false;
  record.turns.push({ question: '重试成功' });
  repo.save('consult-one');
  assert.equal(reopen().find('consult-one')!.turns.at(-1)!.question, '重试成功');
});

test('首次写入失败移除未保存记录，恢复存储后可以重新开始', (t) => {
  const { dir, repo, reopen } = fixture(t);
  const resumeWrites = failWrites(t, dir);
  repo.get('consult-one').turns.push({ question: '未保存问题' });
  assert.throws(() => repo.begin('CONSULT-ONE'), SessionStorageError);
  assert.equal(repo.find('consult-one'), undefined);
  assert.equal(reopen().find('consult-one'), undefined);
  assert.deepEqual(readdirSync(dir), []);
  resumeWrites();
  assert.equal(repo.begin('consult-one'), true);
  assert.deepEqual(repo.get('consult-one').turns, []);
});

test('重新载入后保存失败仍恢复磁盘副本', (t) => {
  const { dir, repo, reopen } = fixture(t);
  repo.get('consult-one').turns.push({ question: '原问题' });
  repo.save('consult-one');
  const loaded = reopen();
  const record = loaded.get('CONSULT-ONE');
  const saved = structuredClone(record);
  failWrites(t, dir);
  record.turns[0].question = '未保存问题';
  assert.throws(() => loaded.save('consult-one'), SessionStorageError);
  assert.equal(loaded.find('consult-one'), record);
  assert.deepEqual(record, saved);
});

test('裁剪历史或追加调用失败不丢弃原有历史，也不保留未保存条目', (t) => {
  const { dir, repo, reopen } = fixture(t);
  const record = repo.get('consult-one');
  record.turns = Array.from({ length: 12 }, (_, index) => ({ question: `question-${index}` }));
  record.calls = Array.from({ length: 500 }, (_, index) => call(`call-${index}`));
  repo.save('consult-one');
  const saved = structuredClone(record);
  failWrites(t, dir);
  record.turns.push({ question: '未保存问题' });
  assert.throws(() => repo.save('consult-one'), SessionStorageError);
  assert.deepEqual(record, saved);
  assert.throws(() => repo.appendCall('CONSULT-ONE', call('未保存调用')), SessionStorageError);
  assert.deepEqual(record, saved);
  assert.deepEqual(reopen().find('consult-one'), saved);
});

test('开始任务保存失败恢复原来的空闲与中断标志', (t) => {
  const { dir, repo } = fixture(t);
  repo.finish('consult-one', true);
  const record = repo.get('consult-one');
  const saved = structuredClone(record);
  failWrites(t, dir);
  assert.throws(() => repo.begin('CONSULT-ONE'), SessionStorageError);
  assert.equal(repo.find('consult-one'), record);
  assert.deepEqual(record, saved);
});

test('结束任务保存失败恢复忙碌状态与原任务引用，允许恢复后重试', (t) => {
  const { dir, repo } = fixture(t);
  const record = repo.get('consult-one');
  const run = record.run = running();
  repo.begin('consult-one');
  const saved = structuredClone(record);
  const resumeWrites = failWrites(t, dir);
  run.status = 'completed';
  run.endedAt = new Date().toISOString();
  record.turns.push({ question: '未保存问题', answer: answer() });
  assert.throws(() => repo.finish('CONSULT-ONE'), SessionStorageError);
  assert.equal(record.run, run);
  assert.deepEqual(record, saved);
  resumeWrites();
  run.status = 'failed';
  repo.finish('consult-one', true);
  assert.equal(record.busy, false);
  assert.equal(record.interrupted, true);
  assert.equal(repo.begin('consult-one'), true);
});

test('重启读取 busy 记录时保存中断状态，不凭空创建任务或回答', (t) => {
  const { dir, repo, reopen } = fixture(t);
  repo.begin('consult-one');
  repo.get('consult-one').turns.push({ question: '尚未回答的问题' });
  repo.save('consult-one');
  const record = reopen().find('CONSULT-ONE')!;
  assert.equal(record.busy, false);
  assert.equal(record.interrupted, true);
  assert.equal(record.run, undefined);
  assert.deepEqual(record.turns, [{ question: '尚未回答的问题' }]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'consult-one.json'), 'utf8')), record);
  assert.deepEqual(reopen().find('consult-one'), record);
});

test('重启中断保留原有失败文案和历史回答，不替未完成问题伪造新回答', (t) => {
  const { dir, repo, reopen } = fixture(t);
  const record = repo.get('consult-one');
  const turns = [{ question: '已完成的问题', answer: answer() }, { question: '尚未完成的新问题' }];
  record.turns = structuredClone(turns);
  record.error = '上次资料读取失败，请重试。';
  record.run = running();
  assert.equal(repo.begin('consult-one'), true);
  const restored = reopen().find('CONSULT-ONE')!;
  assert.equal(restored.busy, false);
  assert.equal(restored.interrupted, true);
  assert.equal(restored.run!.status, 'interrupted');
  assert.equal(restored.error, record.error);
  assert.deepEqual(restored.turns, turns);
  assert.equal(Object.hasOwn(restored.turns.at(-1)!, 'answer'), false);
  const persisted = JSON.parse(readFileSync(join(dir, 'consult-one.json'), 'utf8'));
  assert.equal(persisted.error, '上次资料读取失败，请重试。');
  assert.deepEqual(persisted.turns, turns);
  assert.deepEqual(persisted, restored);
  assert.deepEqual(reopen().find('consult-one'), restored);
});

test('重启保留运行进度并持久化任务中断和结束时间', (t) => {
  const { dir, repo, reopen } = fixture(t);
  const run = running();
  repo.get('consult-one').run = run;
  repo.begin('consult-one');
  const record = reopen().find('CONSULT-ONE')!;
  assert.equal(record.busy, false);
  assert.equal(record.interrupted, true);
  assert.equal(record.run!.status, 'interrupted');
  assert.equal(record.run!.id, run.id);
  assert.equal(record.run!.phase, run.phase);
  assert.equal(record.run!.sequence, run.sequence);
  assert.equal(record.run!.startedAt, run.startedAt);
  assert.ok(record.run!.endedAt);
  assert.equal(record.run!.endedAt, record.updatedAt);
  assert.equal(record.run!.updatedAt, record.updatedAt);
  assert.deepEqual(reopen().find('consult-one'), record);
  assert.deepEqual(readdirSync(dir), ['consult-one.json']);
});

test('重启恢复写入失败不缓存虚假空闲状态，存储恢复后可重试', (t) => {
  const { dir, repo, reopen } = fixture(t);
  repo.get('consult-one').run = running();
  repo.begin('consult-one');
  const path = join(dir, 'consult-one.json');
  const savedText = readFileSync(path, 'utf8');
  const loaded = reopen();
  const resumeWrites = failWrites(t, dir);
  assert.throws(() => loaded.find('CONSULT-ONE'), SessionStorageError);
  assert.throws(() => loaded.get('consult-one'), SessionStorageError);
  assert.equal(readFileSync(path, 'utf8'), savedText);
  resumeWrites();
  const record = loaded.find('consult-one')!;
  assert.equal(record.busy, false);
  assert.equal(record.interrupted, true);
  assert.equal(record.run!.status, 'interrupted');
  assert.deepEqual(reopen().find('consult-one'), record);
});

test('损坏或结构错误的文件明确报错且任何写入入口都不覆盖原文件', (t) => {
  const { dir, repo } = fixture(t);
  const blank = structuredClone(repo.get('sample-one'));
  const malformed: unknown[] = [
    null, [], {}, { ...blank, schema: 2 }, { ...blank, turns: {} },
    { ...blank, turns: [null] }, { ...blank, turns: [{ question: 1 }] },
    { ...blank, turns: [{ question: '', answer: null }] },
    { ...blank, turns: [{ question: '', answer: {} }] },
    { ...blank, turns: [{ question: '', answer: { ...answer(), questions: [1] } }] },
    { ...blank, calls: {} }, { ...blank, calls: [null] }, { ...blank, calls: [{}] },
    { ...blank, busy: 'false' }, { ...blank, interrupted: 1 }, { ...blank, updatedAt: null },
    { ...blank, error: {} }, { ...blank, run: null }, { ...blank, run: {} },
    { ...blank, busy: true, run: { ...running(), status: 'unknown' } },
  ];
  const texts = ['{broken', ...malformed.map((value) => JSON.stringify(value))];
  for (const [index, text] of texts.entries()) {
    const id = `broken-${index}`;
    const path = join(dir, `${id}.json`);
    writeFileSync(path, text);
    for (const operation of [
      () => repo.find(id), () => repo.get(id), () => repo.save(id),
      () => repo.begin(id), () => repo.finish(id), () => repo.appendCall(id, call('test')),
    ]) assert.throws(operation, SessionStorageError);
    assert.equal(readFileSync(path, 'utf8'), text);
  }
  assert.ok(readdirSync(dir).every((name) => name.endsWith('.json')));
});

test('读取超过 12MB 的文件在解析前失败，并保留原文件', (t) => {
  const { dir, repo } = fixture(t);
  const path = join(dir, 'consult-one.json');
  const contents = Buffer.alloc(MAX_FILE_BYTES + 1, 0x20);
  contents[0] = 0x7b;
  writeFileSync(path, contents);
  assert.throws(() => repo.find('consult-one'), SessionStorageError);
  assert.throws(() => repo.get('CONSULT-ONE'), SessionStorageError);
  assert.throws(() => repo.save('consult-one'), SessionStorageError);
  assert.deepEqual(readFileSync(path), contents);
  assert.deepEqual(readdirSync(dir), ['consult-one.json']);
});

test('保存上限按 UTF-8 字节计算，恰好 12MB 可写，超限恢复内存和磁盘', (t) => {
  const { dir, repo, reopen } = fixture(t);
  const record = repo.get('consult-one');
  record.turns.push({ question: '' });
  const overhead = Buffer.byteLength(JSON.stringify(record));
  record.turns[0].question = 'a'.repeat(MAX_FILE_BYTES - overhead);
  repo.save('consult-one');
  const path = join(dir, 'consult-one.json');
  assert.equal(statSync(path).size, MAX_FILE_BYTES);
  assert.equal(reopen().find('consult-one')!.turns[0].question.length, MAX_FILE_BYTES - overhead);
  record.turns[0].question += 'a';
  assert.throws(() => repo.save('consult-one'), SessionStorageError);
  assert.equal(record.turns[0].question.length, MAX_FILE_BYTES - overhead);
  record.turns[0].question = '中'.repeat(Math.floor(MAX_FILE_BYTES / 3));
  assert.ok(record.turns[0].question.length < MAX_FILE_BYTES);
  assert.throws(() => repo.save('consult-one'), SessionStorageError);
  assert.equal(record.turns[0].question.length, MAX_FILE_BYTES - overhead);
  assert.equal(statSync(path).size, MAX_FILE_BYTES);
  assert.deepEqual(readdirSync(dir), ['consult-one.json']);
});

test('首次保存超限不创建记录，序列化失败也恢复原记录', (t) => {
  const { dir, repo, reopen } = fixture(t);
  repo.get('consult-one').turns.push({ question: 'a'.repeat(MAX_FILE_BYTES) });
  assert.throws(() => repo.save('consult-one'), SessionStorageError);
  assert.equal(repo.find('consult-one'), undefined);
  assert.equal(reopen().find('consult-one'), undefined);
  assert.deepEqual(readdirSync(dir), []);
  const record = repo.get('consult-one');
  repo.save('consult-one');
  const saved = structuredClone(record);
  Reflect.set(record, 'circular', record);
  assert.throws(() => repo.save('consult-one'), SessionStorageError);
  assert.equal(repo.find('consult-one'), record);
  assert.deepEqual(record, saved);
});

test('存储路径不可写时抛出 SessionStorageError，错误不暴露本机路径', (t) => {
  const { dir } = fixture(t);
  const occupied = join(dir, 'occupied');
  writeFileSync(occupied, 'file');
  const repo = new ConsultRepository(occupied);
  assert.throws(() => repo.begin('consult-one'), (error: unknown) => {
    assert.ok(error instanceof SessionStorageError);
    assert.ok(!error.message.includes(dir));
    assert.ok(!error.message.includes('occupied'));
    return true;
  });
});

test('单例复用 globalThis，导入不写盘，目录支持环境变量与默认位置', (t) => {
  const { dir } = fixture(t);
  assert.equal((globalThis as unknown as { __zx_consult_repository: ConsultRepository }).__zx_consult_repository, consultRepository);
  const moduleUrl = new URL('../lib/consult-store.ts', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { existsSync, readFileSync } from 'node:fs';
    import { join } from 'node:path';
    const directory = process.env.ZHIXUAN_CONSULT_DIR || join(process.cwd(), 'data', 'private', 'consultations');
    const first = await import(${JSON.stringify(moduleUrl)});
    assert.equal(existsSync(directory), false);
    const second = await import(${JSON.stringify(moduleUrl)} + '?singleton-check');
    assert.equal(first.consultRepository, second.consultRepository);
    const record = first.consultRepository.get('CONSULT-One');
    record.turns.push({ question: '仅在本机保存' });
    first.consultRepository.save('consult-one');
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'consult-one.json'), 'utf8')), record);
  `;
  for (const override of [join(dir, 'custom'), '']) {
    const result = spawnSync(process.execPath, [
      '--experimental-strip-types', '--input-type=module', '--eval', script,
    ], { cwd: dir, env: { ...process.env, ZHIXUAN_CONSULT_DIR: override }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  }
  const saved = JSON.parse(readFileSync(join(dir, 'data', 'private', 'consultations', 'consult-one.json'), 'utf8')) as SavedConsult;
  assert.deepEqual(saved.turns, [{ question: '仅在本机保存' }]);
});
