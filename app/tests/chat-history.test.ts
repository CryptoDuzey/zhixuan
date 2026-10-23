// Contract fixed before implementation: disk is authoritative; reads never repair/write records.
// User-aligned revision: default 40, limit 1..200 (original 30/100 verified first).
// GET /api/chats?kind=agent|consult&limit=1..200&cursor=<opaque>
// -> { items: [{id,kind,title,updatedAt,busy}], nextCursor?: string }, newest first.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { SessionRepository } from '../lib/session-store.ts';
import { ConsultRepository } from '../lib/consult-store.ts';

const library = () => import('../lib/chat-history.ts');
const route = () => import('../app/api/chats/route.ts');
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'zhixuan-chat-history-'));
  const directories = { agent: join(directory, 'sessions'), consult: join(directory, 'consultations') };
  mkdirSync(directories.agent); mkdirSync(directories.consult);
  t.after(() => {
    const target = resolve(directory);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep), 'Delete only this test temporary directory');
    rmSync(target, { recursive: true, force: true });
  });
  const agent = new SessionRepository(directories.agent, () => ({ modelId: '', modelName: '' }));
  const consult = new ConsultRepository(directories.consult);
  return { directory, directories, agent, consult };
}
const keys = ['busy', 'id', 'kind', 'title', 'updatedAt'];
function diskTime(directory: string, id: string, time: string) {
  const file = join(directory, `${id}.json`);
  const record = JSON.parse(readFileSync(file, 'utf8'));
  record.updatedAt = time;
  writeFileSync(file, JSON.stringify(record));
}

test('真实仓库落盘后重新列表，两类同ID保留各自标题和状态，只返回约定字段', async t => {
  const { directories, agent, consult } = fixture(t);
  agent.appendMessage('SHARED-ONE', { role: 'user', text: '  通勤\n 写稿  ' });
  agent.get('shared-one').session.evidence = [{ text: 'PRIVATE_EVIDENCE', docPath: 'C:/private/secret' }] as never;
  agent.begin('shared-one');
  consult.get('shared-one').turns.push({ question: '咨询价格', answer: { reply: 'PRIVATE_REPLY', recommendations: [], evidence: [] } });
  consult.save('shared-one');
  diskTime(directories.agent, 'shared-one', '2026-10-22T08:00:00.000Z');
  diskTime(directories.consult, 'shared-one', '2026-10-22T09:00:00.000Z');
  const original = readFileSync(join(directories.agent, 'shared-one.json'), 'utf8');
  const { listChats } = await library();
  const result = await listChats({}, directories);
  assert.deepEqual(result.items, [
    { id: 'shared-one', kind: 'consult', title: '咨询价格', updatedAt: '2026-10-22T09:00:00.000Z', busy: false },
    { id: 'shared-one', kind: 'agent', title: '通勤 写稿', updatedAt: '2026-10-22T08:00:00.000Z', busy: true },
  ]);
  for (const row of result.items) assert.deepEqual(Object.keys(row).sort(), keys);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_') && !JSON.stringify(result).includes('C:/'));
  assert.equal(readFileSync(join(directories.agent, 'shared-one.json'), 'utf8'), original, 'Listing must not call find() and mark saved busy records interrupted');
  // A subsequent disk edit wins over repository's existing cache.
  diskTime(directories.agent, 'shared-one', '2026-10-23T09:00:00.000Z');
  assert.equal((await listChats({}, directories)).items[0].kind, 'agent');
});

test('游标在同时间、跨类型、删除上一页尾项后仍无重复；过滤绑定游标', async t => {
  const { directories, agent, consult } = fixture(t);
  for (const id of ['chat-one', 'chat-two', 'chat-three']) {
    agent.appendMessage(id, { role: 'user', text: id });
    consult.get(id).turns.push({ question: id }); consult.save(id);
    for (const directory of Object.values(directories)) diskTime(directory, id, '2026-10-22T09:00:00.000Z');
  }
  const { listChats } = await library();
  const all = await listChats({ limit: 100 }, directories);
  const page1 = await listChats({ limit: 2 }, directories);
  assert.equal(page1.items.length, 2); assert.ok(page1.nextCursor);
  const page2 = await listChats({ limit: 2, cursor: page1.nextCursor }, directories);
  const page3 = await listChats({ limit: 2, cursor: page2.nextCursor }, directories);
  assert.deepEqual([...page1.items, ...page2.items, ...page3.items], all.items);
  assert.equal(page3.nextCursor, undefined);
  const tail = page1.items.at(-1)!;
  // Unlink only one known test-owned file; no recursive production changes.
  const { unlinkSync } = await import('node:fs');
  unlinkSync(join(directories[tail.kind], `${tail.id}.json`));
  assert.deepEqual((await listChats({ limit: 2, cursor: page1.nextCursor }, directories)).items, page2.items);
  await assert.rejects(listChats({ kind: 'consult', cursor: page1.nextCursor }, directories), /分页参数无效/);
  assert.ok((await listChats({ kind: 'consult' }, directories)).items.every(row => row.kind === 'consult'));
});

test('损坏JSON、错误结构、无效时间、临时文件和目录均跳过，缺失目录为空且不创建', async t => {
  const { directory, directories, agent } = fixture(t);
  agent.appendMessage('valid-one', { role: 'user', text: '有效会话' });
  const base = JSON.parse(readFileSync(join(directories.agent, 'valid-one.json'), 'utf8'));
  writeFileSync(join(directories.agent, 'broken-one.json'), '{broken');
  writeFileSync(join(directories.agent, 'wrong-one.json'), JSON.stringify({ schema: 1, updatedAt: new Date().toISOString() }));
  writeFileSync(join(directories.agent, 'bad-time.json'), JSON.stringify({ ...base, updatedAt: 'tomorrow' }));
  writeFileSync(join(directories.agent, 'bad-busy.json'), JSON.stringify({ ...base, busy: 'yes' }));
  writeFileSync(join(directories.consult, 'wrong-consult.json'), JSON.stringify({ ...base, turns: [{ question: 3 }] }));
  writeFileSync(join(directories.agent, 'valid-one.json.xyz.tmp'), '{broken');
  mkdirSync(join(directories.agent, 'nested-one.json'));
  const { listChats } = await library();
  assert.deepEqual((await listChats({}, directories)).items.map(row => row.id), ['valid-one']);
  assert.equal(readFileSync(join(directories.agent, 'broken-one.json'), 'utf8'), '{broken');
  const absent = { agent: join(directory, 'absent-a'), consult: join(directory, 'absent-c') };
  assert.deepEqual(await listChats({}, absent), { items: [] });
  assert.ok(!readdirSync(directory).includes('absent-a'));
});

test('文件名沿用ID校验、大小写归一、不读其他文件及超大记录', async t => {
  const { directories, agent } = fixture(t);
  agent.appendMessage('normal-one', { role: 'user', text: '普通记录' });
  const content = readFileSync(join(directories.agent, 'normal-one.json'));
  for (const filename of ['short.json', 'not session.json', 'secret.env', 'file.json.tmp']) writeFileSync(join(directories.agent, filename), content);
  writeFileSync(join(directories.agent, 'UPPER-ONE.JSON'), content);
  writeFileSync(join(directories.agent, 'oversize-one.json'), content);
  truncateSync(join(directories.agent, 'oversize-one.json'), 12 * 1024 * 1024 + 1);
  const { listChats } = await library();
  assert.deepEqual((await listChats({}, directories)).items.map(row => row.id).sort(), ['normal-one', 'upper-one']);
});

test('不跟随指向其他目录的会话文件链接', async t => {
  const { directories, agent } = fixture(t);
  agent.appendMessage('outside-one', { role: 'user', text: '外部记录' });
  try { symlinkSync(join(directories.agent, 'outside-one.json'), join(directories.consult, 'linked-one.json'), 'file'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('系统未授权创建文件链接'); return; } throw error; }
  const { listChats } = await library();
  assert.equal((await listChats({ kind: 'consult' }, directories)).items.length, 0);
});

test('Windows目录联接不能让列表越出绑定目录', async t => {
  const { directory, directories, agent } = fixture(t);
  agent.appendMessage('outside-one', { role: 'user', text: '外部记录' });
  const { listChats } = await library();
  const link = join(directory, 'linked-directory');
  symlinkSync(directories.agent, link, 'junction');
  assert.deepEqual(await listChats({ kind: 'agent' }, { ...directories, agent: link }), { items: [] });
});

test('恶意游标不参与文件定位，过滤时不读取另一端目录', async t => {
  const { directory, directories, agent } = fixture(t);
  agent.appendMessage('normal-one', { role: 'user', text: '正常问题' });
  const { listChats } = await library();
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const cursor of [
    encode({ v: 1, filter: null, id: '../secret', kind: 'agent', updatedAt: '2026-10-22T09:00:00.000Z' }),
    encode({ v: 1, filter: null, id: 'normal-one', kind: 'other', updatedAt: '2026-10-22T09:00:00.000Z' }),
    encode({ v: 1, filter: null, id: 'normal-one', kind: 'agent', updatedAt: 'tomorrow' }),
    encode({ v: 1, filter: null, id: 'normal-one', kind: 'agent', updatedAt: '2026-10-22T09:00:00.000Z', path: directory }),
    'a'.repeat(513),
  ]) await assert.rejects(listChats({ cursor }, directories), /分页参数无效/);
  const occupied = join(directory, 'occupied'); writeFileSync(occupied, 'not a directory');
  assert.equal((await listChats({ kind: 'agent' }, { ...directories, consult: occupied })).items.length, 1);
});

test('标题仅取首个用户问题，整理空白、限制80字并隐藏本机路径；不从证据和回复取标题', async t => {
  const { directories, agent, consult } = fixture(t);
  agent.appendMessage('title-one', { role: 'assistant', text: 'PRIVATE_ASSISTANT' });
  agent.appendMessage('title-one', { role: 'user', text: '查看 C:\\Users\\alice\\secret.txt 和 /Users/alice/secret.txt\n' + '汉'.repeat(100) });
  consult.save('empty-one');
  const { listChats } = await library();
  const rows = (await listChats({}, directories)).items;
  const title = rows.find(row => row.id === 'title-one')!.title;
  assert.ok([...title].length <= 80);
  assert.ok(!title.includes('alice') && !title.includes('PRIVATE_') && !title.includes('secret.txt'));
  assert.equal(rows.find(row => row.id === 'empty-one')!.title, '新咨询');
});

test('GET读取各端现有目录，固定返回契约、默认40条、最大200条，拒绝错误参数和目录参数', async t => {
  const { directories, agent, consult } = fixture(t);
  const previous = [process.env.ZHIXUAN_SESSION_DIR, process.env.ZHIXUAN_CONSULT_DIR];
  process.env.ZHIXUAN_SESSION_DIR = directories.agent; process.env.ZHIXUAN_CONSULT_DIR = directories.consult;
  t.after(() => {
    for (const [index, key] of ['ZHIXUAN_SESSION_DIR', 'ZHIXUAN_CONSULT_DIR'].entries()) {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }
  });
  for (let n = 0; n < 41; n++) agent.appendMessage(`history-${n}`, { role: 'user', text: `问题${n}` });
  consult.get('consult-one').turns.push({ question: '咨询记录' }); consult.save('consult-one');
  const { GET } = await route();
  const response = await GET(new Request('http://localhost/api/chats'));
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control')!, /no-store/);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['items', 'nextCursor']);
  assert.equal(body.items.length, 40); assert.ok(body.nextCursor);
  const filtered = await GET(new Request('http://localhost/api/chats?kind=consult&limit=200'));
  assert.deepEqual((await filtered.json()).items.map((row: { id: string }) => row.id), ['consult-one']);
  for (const query of ['kind=other', 'kind=', 'kind=agent&kind=consult', 'limit=0', 'limit=201', 'limit=-1', 'limit=1.5', 'limit=1e2', 'cursor=../../secret', 'filesystempath=C:/secret', 'offset=20', 'limit=1&limit=2']) {
    const failed = await GET(new Request(`http://localhost/api/chats?${query}`));
    assert.equal(failed.status, 400, query);
    assert.ok(!JSON.stringify(await failed.json()).includes(directories.agent));
  }
  const after = await GET(new Request(`http://localhost/api/chats?limit=100&cursor=${encodeURIComponent(body.nextCursor)}`));
  assert.equal((await after.json()).items.length, 2);
});

test('目录不可读取时返回通用错误，不暴露本机路径且不创建新文件', async t => {
  const { directory } = fixture(t);
  const occupied = join(directory, 'occupied-file'); writeFileSync(occupied, 'not a directory');
  const previous = process.env.ZHIXUAN_SESSION_DIR;
  process.env.ZHIXUAN_SESSION_DIR = occupied;
  t.after(() => { if (previous === undefined) delete process.env.ZHIXUAN_SESSION_DIR; else process.env.ZHIXUAN_SESSION_DIR = previous; });
  const { GET } = await route();
  const response = await GET(new Request('http://localhost/api/chats?kind=agent'));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: '暂时无法读取历史对话，请稍后重试。' });
});
