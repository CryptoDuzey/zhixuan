import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { SessionRepository, SessionStorageError } from '../lib/session-store.ts';
import type { RunState } from '../lib/agent-runtime.ts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'zhixuan-session-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const create = () => ({ modelId: '', modelName: '' });
  return { dir, repo: new SessionRepository(dir, create), reopen: () => new SessionRepository(dir, create) };
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
    id: 'run-one', status: 'running', phase: '核验稿件',
    startedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:01.000Z',
    sequence: 7, cancelRequested: false,
  };
}

test('Windows瞬时EPERM只重试原子替换，不删除旧稿或重复写临时文件', { skip: process.platform !== 'win32' }, (t) => {
  const { dir, repo, reopen } = fixture(t);
  const record = repo.get('transient-rename');
  record.session.modelName = '原稿'; repo.save('transient-rename');
  const original = fs.renameSync;
  let attempts = 0;
  const mocked = t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
    if (String(args[0]).startsWith(dir + sep) && attempts++ === 0) throw Object.assign(new Error('temporary lock'), { code: 'EPERM' });
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  record.session.modelName = '已保存的新稿';
  repo.save('transient-rename');
  assert.equal(attempts, 2);
  assert.equal(reopen().get('transient-rename').session.modelName, '已保存的新稿');
  assert.equal(readdirSync(dir).filter(name => name.endsWith('.tmp')).length, 0);
});

test('非EPERM的原子替换失败只尝试一次，永久EPERM有界回滚', (t) => {
  const { dir, repo, reopen } = fixture(t);
  const record = repo.get('permanent-rename');
  record.session.modelName = '已保存原稿'; repo.save('permanent-rename');
  let code = 'ENOSPC', attempts = 0;
  const original = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
    if (String(args[0]).startsWith(dir + sep)) { attempts++; throw Object.assign(new Error('unavailable'), { code }); }
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  record.session.modelName = '不能提交';
  assert.throws(() => repo.save('permanent-rename'), SessionStorageError);
  assert.equal(attempts, 1);
  code = 'EPERM'; attempts = 0;
  record.session.modelName = '仍不能提交';
  assert.throws(() => repo.save('permanent-rename'), SessionStorageError);
  assert.equal(attempts, process.platform === 'win32' ? 4 : 1);
  assert.equal(reopen().get('permanent-rename').session.modelName, '已保存原稿');
});

test('对话、稿件和核验版本实际落盘，新进程仓库可恢复', (t) => {
  const { dir, repo, reopen } = fixture(t);
  const record = repo.get('session-one');
  record.session.modelId = 'd14';
  record.session.modelName = 'MateBook D 14';
  record.session.draft = { version: 2, platform: '朋友圈', modelId: 'd14', modelName: 'MateBook D 14', title: '给带电脑上课的人', lead: '', body: '先核对课程软件', cta: '以官网规格页为准', tags: [], images: [], claims: [] };
  record.session.report = { draftVersion: 2, status: 'pass', issues: [], verifiedClaimIds: [], verifiedImageIds: [], checkedAt: new Date().toISOString() };
  repo.appendMessage('session-one', { role: 'user', text: '写给大学生' });
  repo.appendMessage('session-one', { role: 'assistant', kind: 'clarify', text: '哪个平台？', options: ['朋友圈'] });
  const restored = reopen().find('session-one')!;
  assert.equal(restored.session.draft?.version, 2);
  assert.equal(restored.session.report?.draftVersion, 2);
  assert.equal(restored.messages[1].options?.[0], '朋友圈');
  assert.equal(restored.busy, false);
  assert.deepEqual(readdirSync(dir), ['session-one.json']);
});

test('同一任务互斥，不同会话可并行；完成后才可继续', (t) => {
  const { repo } = fixture(t);
  assert.equal(repo.begin('session-one'), true);
  assert.equal(repo.begin('session-one'), false);
  assert.equal(repo.begin('session-two'), true);
  repo.finish('session-one');
  assert.equal(repo.begin('session-one'), true);
});

test('重启前未完成任务恢复为中断，不会永久忙碌或伪造成功', (t) => {
  const { repo, reopen } = fixture(t);
  repo.begin('session-one');
  repo.appendMessage('session-one', { role: 'user', text: '生成公众号' });
  const record = reopen().find('session-one')!;
  assert.equal(record.busy, false);
  assert.equal(record.interrupted, true);
  assert.equal(record.session.report, undefined);
  assert.equal(reopen().find('session-one')?.interrupted, true);
});

test('调用日志随对应会话保存，不混入其他会话', (t) => {
  const { repo, reopen } = fixture(t);
  const base = { at: new Date().toISOString(), op: 'read' as const, ok: true };
  repo.appendCall('session-one', { ...base, target: 'product-one' });
  repo.appendCall('session-two', { ...base, target: 'product-two' });
  assert.deepEqual(reopen().find('session-one')?.calls.map((c) => c.target), ['product-one']);
  assert.deepEqual(reopen().find('session-two')?.calls.map((c) => c.target), ['product-two']);
});

test('损坏记录保留原文件，不悄悄换成空白会话', (t) => {
  const { dir, repo } = fixture(t);
  const path = join(dir, 'session-one.json');
  writeFileSync(path, '{broken');
  assert.throws(() => repo.find('session-one'), SessionStorageError);
  assert.throws(() => repo.get('session-one'), SessionStorageError);
  assert.equal(readFileSync(path, 'utf8'), '{broken');
});

test('无效编号不能越出私密目录', (t) => {
  const { repo, dir } = fixture(t);
  for (const id of ['../secret', '..\\secret', 'a/b', 'short', 'a'.repeat(65)]) {
    assert.throws(() => repo.get(id), SessionStorageError);
  }
  assert.deepEqual(readdirSync(dir), []);
});

test('磁盘写入失败不留下永远忙碌的任务，错误不暴露路径', (t) => {
  const { dir } = fixture(t);
  const occupied = join(dir, 'occupied');
  writeFileSync(occupied, 'file');
  const repo = new SessionRepository(occupied, () => ({ modelId: '', modelName: '' }));
  assert.throws(() => repo.begin('session-one'), (error: unknown) => {
    assert.ok(error instanceof SessionStorageError);
    assert.ok(!error.message.includes(dir));
    return true;
  });
});

test('空白记录不创建文件，消息保留最近80条', (t) => {
  const { dir, repo, reopen } = fixture(t);
  assert.equal(repo.find('session-one'), undefined);
  assert.deepEqual(readdirSync(dir), []);
  for (let i = 0; i < 85; i++) repo.appendMessage('session-one', { role: 'user', text: `message-${i}` });
  const messages = reopen().find('session-one')!.messages;
  assert.equal(messages.length, 80);
  assert.equal(messages[0].text, 'message-5');
});

test('大小写编号共用内存、任务锁和小写文件名，不会误判为重启中断', (t) => {
  const { dir, repo, reopen } = fixture(t);
  const record = repo.get('SESSION-One');
  assert.equal(repo.get('session-one'), record);
  assert.equal(repo.begin('SESSION-One'), true);
  assert.equal(repo.begin('session-one'), false);
  repo.appendMessage('SESSION-ONE', { role: 'user', text: '第一条消息' });
  repo.appendMessage('session-one', { role: 'assistant', text: '第二条消息' });
  repo.appendCall('SESSION-One', { at: '', op: 'read', target: 'own-document', ok: true });
  assert.equal(record.interrupted, false);
  repo.finish('Session-One');
  assert.deepEqual(readdirSync(dir), ['session-one.json']);
  const restored = reopen().find('SESSION-ONE')!;
  assert.deepEqual(restored.messages.map((m) => m.text), ['第一条消息', '第二条消息']);
  assert.deepEqual(restored.calls.map((c) => c.target), ['own-document']);
  assert.equal(restored.busy, false);
});

test('保存失败回滚稿件、报告、运行状态和时间，已交给调用方的引用也恢复', (t) => {
  const { dir, repo, reopen } = fixture(t);
  const record = repo.get('session-one');
  const session = record.session;
  session.draft = { version: 1, platform: '朋友圈', modelId: '', modelName: '', title: '原稿', lead: '', body: '原文', cta: '', tags: [], images: [], claims: [] };
  session.report = { draftVersion: 1, status: 'pass', issues: [], verifiedClaimIds: [], verifiedImageIds: [], checkedAt: '' };
  record.run = { ...running(), status: 'completed', endedAt: '2020-01-01T00:00:02.000Z' };
  const run = record.run;
  repo.appendMessage('session-one', { role: 'assistant', text: '已保存', options: ['保留'] });
  const saved = JSON.parse(readFileSync(join(dir, 'session-one.json'), 'utf8'));
  const resumeWrites = failWrites(t, dir);
  session.draft.body = '没有保存的新稿';
  session.draft.version = 2;
  session.report.draftVersion = 2;
  record.messages[0].options!.push('未保存的选项');
  record.run.sequence++;
  record.updatedAt = '2099-01-01T00:00:00.000Z';
  assert.throws(() => repo.save('SESSION-ONE'), SessionStorageError);
  assert.equal(repo.find('session-one'), record);
  assert.equal(record.session, session);
  assert.equal(record.run, run);
  assert.deepEqual(record, saved);
  // 再次失败也必须回到磁盘副本，不能让第一次回滚的对象污染副本。
  session.draft!.body = '再次修改';
  assert.throws(() => repo.save('session-one'), SessionStorageError);
  assert.deepEqual(record, saved);
  assert.deepEqual(reopen().find('session-one'), saved);
  resumeWrites();
  session.draft!.body = '重试成功';
  repo.save('session-one');
  assert.equal(reopen().find('session-one')!.session.draft!.body, '重试成功');
  assert.deepEqual(readdirSync(dir), ['session-one.json']);
});

test('替换原文件失败时保留磁盘原稿、回滚内存并清理临时文件', (t) => {
  const { dir, repo, reopen } = fixture(t);
  const record = repo.get('session-one');
  record.session.modelName = '已保存内容';
  repo.save('session-one');
  const path = join(dir, 'session-one.json');
  const savedText = readFileSync(path, 'utf8');
  const original = fs.renameSync;
  let blocked = true;
  const mocked = t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
    if (blocked && String(args[1]) === path) {
      throw Object.assign(new Error('simulated file locked'), { code: 'EPERM' });
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  record.session.modelName = '未保存内容';
  assert.throws(() => repo.save('SESSION-ONE'), SessionStorageError);
  assert.deepEqual(record, JSON.parse(savedText));
  assert.equal(readFileSync(path, 'utf8'), savedText);
  assert.deepEqual(reopen().find('session-one'), record);
  assert.deepEqual(readdirSync(dir), ['session-one.json']);
  blocked = false;
  record.session.modelName = '重试成功';
  repo.save('session-one');
  assert.equal(reopen().find('session-one')!.session.modelName, '重试成功');
});

test('载入已有文件后保存失败，同样回滚到载入的磁盘副本', (t) => {
  const { dir, repo, reopen } = fixture(t);
  repo.appendMessage('session-one', { role: 'user', text: '原记录' });
  const loaded = reopen();
  const saved = structuredClone(loaded.find('SESSION-ONE')!);
  loaded.get('session-one').session.modelName = '尚未保存';
  failWrites(t, dir);
  assert.throws(() => loaded.save('session-one'), SessionStorageError);
  assert.deepEqual(loaded.find('session-one'), saved);
});

test('首次保存失败移除未保存会话，存储恢复后可以重新开始', (t) => {
  const { dir, repo, reopen } = fixture(t);
  const resumeWrites = failWrites(t, dir);
  repo.get('session-one').session.modelName = '未保存内容';
  assert.throws(() => repo.begin('SESSION-ONE'), SessionStorageError);
  assert.equal(repo.find('session-one'), undefined);
  assert.equal(reopen().find('session-one'), undefined);
  assert.deepEqual(readdirSync(dir), []);
  resumeWrites();
  assert.equal(repo.begin('session-one'), true);
  assert.equal(repo.get('session-one').session.modelName, '');
});

test('已有中断记录启动失败，恢复原来的空闲和中断状态', (t) => {
  const { dir, repo } = fixture(t);
  repo.finish('session-one', true);
  const saved = structuredClone(repo.get('session-one'));
  failWrites(t, dir);
  assert.throws(() => repo.begin('SESSION-ONE'), SessionStorageError);
  assert.deepEqual(repo.find('session-one'), saved);
});

test('追加消息或调用失败，不丢弃原有历史，也不保留未保存条目', (t) => {
  const { dir, repo, reopen } = fixture(t);
  const record = repo.get('session-one');
  record.messages = Array.from({ length: 80 }, (_, i) => ({ role: 'user' as const, text: `message-${i}` }));
  record.calls = Array.from({ length: 500 }, (_, i) => ({ at: '', op: 'read' as const, target: `call-${i}`, ok: true }));
  repo.save('session-one');
  const saved = structuredClone(record);
  failWrites(t, dir);
  assert.throws(() => repo.appendMessage('SESSION-ONE', { role: 'user', text: '未保存消息' }), SessionStorageError);
  assert.deepEqual(record, saved);
  assert.throws(() => repo.appendCall('session-one', { at: '', op: 'read', target: '未保存调用', ok: true }), SessionStorageError);
  assert.deepEqual(record, saved);
  assert.deepEqual(reopen().find('session-one'), saved);
});

test('结束任务保存失败，不把尚未落盘的完成状态提供给后续读取', (t) => {
  const { dir, repo } = fixture(t);
  const record = repo.get('session-one');
  record.run = running();
  repo.begin('session-one');
  const saved = structuredClone(record);
  const resumeWrites = failWrites(t, dir);
  record.run!.status = 'completed';
  record.run!.endedAt = new Date().toISOString();
  assert.throws(() => repo.finish('SESSION-ONE'), SessionStorageError);
  assert.deepEqual(repo.find('session-one'), saved);
  assert.equal(record.busy, true);
  resumeWrites();
  record.run!.status = 'failed';
  repo.finish('session-one', true);
  assert.equal(record.busy, false);
  assert.equal(repo.begin('SESSION-ONE'), true);
});

test('重启恢复正在运行的任务，保留进度并保存中断和结束时间', (t) => {
  const { dir, repo, reopen } = fixture(t);
  const originalRun = running();
  repo.get('session-one').run = originalRun;
  repo.begin('session-one');
  const restored = reopen().find('SESSION-ONE')!;
  assert.equal(restored.busy, false);
  assert.equal(restored.interrupted, true);
  assert.equal(restored.run!.status, 'interrupted');
  assert.equal(restored.run!.id, originalRun.id);
  assert.equal(restored.run!.phase, originalRun.phase);
  assert.equal(restored.run!.sequence, originalRun.sequence);
  assert.equal(restored.run!.startedAt, originalRun.startedAt);
  assert.ok(restored.run!.endedAt);
  assert.equal(restored.run!.endedAt, restored.run!.updatedAt);
  assert.equal(restored.updatedAt, restored.run!.updatedAt);
  assert.deepEqual(reopen().find('session-one'), restored);
  assert.deepEqual(readdirSync(dir), ['session-one.json']);
});

test('重启恢复保存失败时不缓存虚假的空闲状态，磁盘恢复后可以重试', (t) => {
  const { dir, repo, reopen } = fixture(t);
  repo.get('session-one').run = running();
  repo.begin('session-one');
  const loaded = reopen();
  const resumeWrites = failWrites(t, dir);
  assert.throws(() => loaded.find('SESSION-ONE'), SessionStorageError);
  assert.throws(() => loaded.find('session-one'), SessionStorageError);
  resumeWrites();
  const restored = loaded.find('session-one')!;
  assert.equal(restored.busy, false);
  assert.equal(restored.run!.status, 'interrupted');
  assert.ok(restored.run!.endedAt);
  assert.deepEqual(reopen().find('session-one'), restored);
});
