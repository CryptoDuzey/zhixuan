import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CallLog, LocalDoc, ReadResult } from '../lib/ima.ts';

type ImaClient = typeof import('../lib/ima.ts');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const requests: string[] = [];
const gates = new Map<string, { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }>();
const indexDoc: LocalDoc = {
  id: 'indexed-text', title: '产品事实.md', path: '模拟知识库/测试型号/产品事实.md',
  bytes: 12, sha256: 'offline-fixture',
};
let indexStatus = 200;
let indexDisconnected = false;
let indexItems: unknown = [{ ...indexDoc, path: indexDoc.path.replaceAll('/', '\\') }];
let base: string;
let moduleId = 0;

const server = createServer(async (request, response) => {
  const url = new URL(request.url!, 'http://mock.invalid');
  requests.push(`${url.pathname}${url.search}`);
  if ((url.pathname === '/documents' && indexDisconnected) || url.searchParams.get('q') === 'disconnect') {
    request.socket.destroy();
    return;
  }
  if (url.pathname === '/documents') {
    response.writeHead(indexStatus, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ items: indexItems }));
    return;
  }
  if (url.pathname === '/search') {
    const query = url.searchParams.get('q');
    response.writeHead(query === 'http-failure' ? 503 : 200, { 'content-type': 'application/json' });
    response.end(query === 'invalid-json' ? '{' : JSON.stringify(query === 'http-failure'
      ? { onlineError: { kind: 'upstream', code: 503 } }
      : { total: 1, onlineMatches: 1, query }));
    return;
  }
  if (url.pathname === '/document') {
    const id = url.searchParams.get('id')!;
    const gate = gates.get(id);
    if (gate) {
      gate.started.resolve();
      await gate.release.promise;
    }
    if (id === 'disconnect') {
      request.socket.destroy();
      return;
    }
    if (id === 'http-failure' || id === 'quota') {
      response.writeHead(id === 'quota' ? 429 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: {
        kind: id === 'quota' ? 'daily_quota' : 'upstream',
        code: id === 'quota' ? 220021 : 503,
        message: '模拟读取失败',
      } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(`模拟正文:${id}`);
    return;
  }
  response.writeHead(404);
  response.end();
});

before(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  requests.length = 0;
  gates.clear();
  indexStatus = 200;
  indexDisconnected = false;
  indexItems = [{ ...indexDoc, path: indexDoc.path.replaceAll('/', '\\') }];
});

after(async () => {
  for (const gate of gates.values()) gate.release.resolve();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
});

async function freshClient(): Promise<ImaClient> {
  // BASE 在模块加载时确定：先指定随机本地端口，再动态导入独立实例。
  // 仅临时替换这个非密钥配置；不读取任何设置文件或私有密钥。
  const savedBase = process.env.IMA_BASE;
  process.env.IMA_BASE = base;
  try {
    return await import(new URL(`../lib/ima.ts?scope-test=${++moduleId}`, import.meta.url).href);
  } finally {
    if (savedBase === undefined) delete process.env.IMA_BASE;
    else process.env.IMA_BASE = savedBase;
  }
}

function doc(id: string, label = `${id}.md`): LocalDoc {
  return { id, title: label, path: `模拟知识库/${label}`, bytes: 1, sha256: 'offline-fixture' };
}

function hold(id: string) {
  const gate = { started: deferred(), release: deferred() };
  gates.set(id, gate);
  return gate;
}

function collect(entries: CallLog[]) {
  return (entry: CallLog) => { entries.push(entry); };
}

test('并行请求交错完成时日志各归其主，scope 外调用仅进全局日志', async (t) => {
  const ima = await freshClient();
  const a: CallLog[] = [];
  const b: CallLog[] = [];
  const gateA = hold('parallel-a');
  const gateB = hold('parallel-b');
  t.after(() => { gateA.release.resolve(); gateB.release.resolve(); });
  const first = ima.withCallScope(collect(a), async () => {
    await ima.readLocalText(doc('parallel-a'));
    await ima.searchLocal('query-a');
    return 'result-a';
  });
  const second = ima.withCallScope(collect(b), async () => {
    await ima.readLocalImage(doc('parallel-b', 'parallel-b.png'));
    await ima.searchOnline('query-b');
    return 'result-b';
  });
  await Promise.all([gateA.started.promise, gateB.started.promise]);
  await ima.searchLocal('outside-during');
  gateB.release.resolve();
  assert.equal(await second, 'result-b');
  assert.equal(a.length, 0);
  gateA.release.resolve();
  assert.equal(await first, 'result-a');
  await ima.searchOnline('outside-after');
  assert.deepEqual(a.map((entry) => [entry.op, entry.target]), [
    ['read', doc('parallel-a').path], ['search', 'query-a'],
  ]);
  assert.deepEqual(b.map((entry) => [entry.op, entry.target]), [
    ['image', doc('parallel-b', 'parallel-b.png').path], ['search', 'query-b'],
  ]);
  assert.equal(ima.getCallLog().length, 6);
  assert.ok([...a, ...b].every((entry) => entry.ok && entry.cacheHit === undefined));
  assert.ok(ima.getCallLog().some((entry) => entry.target === 'outside-during'));
  assert.ok(ima.getCallLog().some((entry) => entry.target === 'outside-after'));
});

test('嵌套 scope 只通知当前回调，成功或失败退出后恢复外层及无 scope 上下文', async () => {
  const ima = await freshClient();
  const outer: CallLog[] = [];
  const inner: CallLog[] = [];
  const failure = new Error('task failure');
  await ima.withCallScope(collect(outer), async () => {
    await ima.searchLocal('outer-before');
    assert.equal(await ima.withCallScope(collect(inner), async () => {
      await ima.searchLocal('inner-success');
      return 42;
    }), 42);
    await assert.rejects(ima.withCallScope(collect(inner), async () => {
      await ima.searchLocal('inner-failure');
      throw failure;
    }), (error) => error === failure);
    await ima.searchLocal('outer-after');
  });
  await assert.rejects(ima.withCallScope(collect(inner), () => { throw failure; }), (error) => error === failure);
  await ima.searchLocal('outside');
  assert.deepEqual(outer.map((entry) => entry.target), ['outer-before', 'outer-after']);
  assert.deepEqual(inner.map((entry) => entry.target), ['inner-success', 'inner-failure']);
  assert.equal(ima.getCallLog().length, 5);
});

test('索引、文本、图片和在线读取命中缓存也如实记入当前 scope，不增加 HTTP 请求', async () => {
  const ima = await freshClient();
  const textDoc = doc('cached-text');
  const imageDoc = doc('cached-image', 'cached-image.png');
  const index = await ima.loadLocalIndex();
  const text = await ima.readLocalText(textDoc);
  const image = await ima.readLocalImage(imageDoc);
  const online = await ima.readOnline('cached-online', '首次在线标签');
  assert.equal(index[0].path, indexDoc.path);
  const originalRequests = [...requests];
  assert.equal(originalRequests.length, 4);
  const entries: CallLog[] = [];
  await ima.withCallScope(collect(entries), async () => {
    assert.equal(await ima.loadLocalIndex(), index);
    assert.equal(await ima.findLocal('测试型号', '产品事实'), index[0]);
    assert.equal(await ima.readLocalText(textDoc), text);
    assert.equal(await ima.readLocalImage(imageDoc), image);
    assert.equal(await ima.readOnline('cached-online', '本次在线标签'), online);
    // 同一缓存被以不同操作消费时，日志使用本次操作和标签。
    assert.equal(await ima.readOnline('cached-online', '本次图片标签', 'image'), online);
  });
  assert.deepEqual(requests, originalRequests);
  assert.deepEqual(entries.map((entry) => [entry.op, entry.target]), [
    ['documents', '/documents'], ['documents', '/documents'],
    ['read', textDoc.path], ['image', imageDoc.path],
    ['read', '本次在线标签'], ['image', '本次图片标签'],
  ]);
  assert.ok(entries.every((entry) => entry.ok && entry.cacheHit === true && entry.note?.includes('缓存命中')));
  assert.ok(entries.every((entry) => !('text' in entry) && !('readAt' in entry)));
  assert.equal(entries[2].bytes, text.bytes!.length);
  assert.equal(entries[3].bytes, image.bytes!.length);
  assert.equal(entries[4].source, 'ima 在线 API');
  assert.equal(entries[5].bytes, online.bytes!.length);
  assert.equal(ima.getCallLog().length, 10);
});

test('多个 scope 同时消费已有缓存，分别记录本次标签，不复制缓存创建者日志', async () => {
  const ima = await freshClient();
  const creator: CallLog[] = [];
  const a: CallLog[] = [];
  const b: CallLog[] = [];
  const cached = await ima.withCallScope(collect(creator), () => ima.readLocalText(doc('shared-cache', 'creator')));
  await Promise.all([
    ima.withCallScope(collect(a), () => ima.readLocalText(doc('shared-cache', 'consumer-a'))),
    ima.withCallScope(collect(b), () => ima.readLocalImage(doc('shared-cache', 'consumer-b'))),
  ]);
  assert.equal(requests.length, 1);
  assert.equal(creator.length, 1);
  assert.equal(creator[0].cacheHit, undefined);
  assert.deepEqual(a.map((entry) => [entry.op, entry.target, entry.cacheHit]), [['read', doc('shared-cache', 'consumer-a').path, true]]);
  assert.deepEqual(b.map((entry) => [entry.op, entry.target, entry.cacheHit]), [['image', doc('shared-cache', 'consumer-b').path, true]]);
  assert.equal(a[0].bytes, cached.bytes!.length);
});

test('共享进行中的 Promise 不把发起者日志归给等待者，等待后的实际缓存消费单独记录', async (t) => {
  const ima = await freshClient();
  const a: CallLog[] = [];
  const b: CallLog[] = [];
  const gate = hold('shared-promise');
  t.after(() => gate.release.resolve());
  let shared!: Promise<ReadResult>;
  const creator = ima.withCallScope(collect(a), async () => {
    shared = ima.readLocalText(doc('shared-promise', 'creator'));
    return shared;
  });
  await gate.started.promise;
  const consumer = ima.withCallScope(collect(b), async () => {
    const result = await shared;
    assert.equal(b.length, 0, '仅等待外部 Promise 不产生本请求的知识库读取');
    assert.equal(await ima.readLocalText(doc('shared-promise', 'consumer')), result);
  });
  gate.release.resolve();
  await Promise.all([creator, consumer]);
  assert.deepEqual(a.map((entry) => [entry.target, entry.cacheHit]), [[doc('shared-promise', 'creator').path, undefined]]);
  assert.deepEqual(b.map((entry) => [entry.target, entry.cacheHit]), [[doc('shared-promise', 'consumer').path, true]]);
  assert.equal(requests.length, 1);
});

test('scope 外创建的共享 Promise 被 scope 等待时，原读取仍只归全局', async (t) => {
  const ima = await freshClient();
  const gate = hold('outside-promise');
  t.after(() => gate.release.resolve());
  const shared = ima.readLocalText(doc('outside-promise'));
  await gate.started.promise;
  const entries: CallLog[] = [];
  const consumer = ima.withCallScope(collect(entries), async () => {
    await shared;
    await ima.searchLocal('own-query');
  });
  gate.release.resolve();
  await consumer;
  assert.deepEqual(entries.map((entry) => entry.target), ['own-query']);
  assert.equal(ima.getCallLog().length, 2);
});

test('同一资源在缓存尚未建立时被并发读取，各自的真实 HTTP 调用分别归属且不标缓存命中', async (t) => {
  const ima = await freshClient();
  const gate = hold('concurrent-miss');
  t.after(() => gate.release.resolve());
  const a: CallLog[] = [];
  const b: CallLog[] = [];
  const first = ima.withCallScope(collect(a), () => ima.readLocalText(doc('concurrent-miss', 'request-a')));
  await gate.started.promise;
  const second = ima.withCallScope(collect(b), () => ima.readLocalText(doc('concurrent-miss', 'request-b')));
  gate.release.resolve();
  const results = await Promise.all([first, second]);
  assert.ok(results.every((result) => result.ok));
  assert.equal(requests.length, 2);
  assert.deepEqual(a.map((entry) => [entry.target, entry.cacheHit]), [[doc('concurrent-miss', 'request-a').path, undefined]]);
  assert.deepEqual(b.map((entry) => [entry.target, entry.cacheHit]), [[doc('concurrent-miss', 'request-b').path, undefined]]);
});

test('不同来源即使 id 相同也不共用缓存，各自后续命中记录保留真实来源', async () => {
  const ima = await freshClient();
  const entries: CallLog[] = [];
  await ima.withCallScope(collect(entries), async () => {
    await ima.readLocalText(doc('same-id'));
    await ima.readOnline('same-id', '在线资料');
    await ima.readLocalText(doc('same-id'));
    await ima.readOnline('same-id', '在线资料');
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(entries.map((entry) => [entry.source, entry.cacheHit]), [
    ['本地已下载知识库', undefined], ['ima 在线 API', undefined],
    ['本地已下载知识库', true], ['ima 在线 API', true],
  ]);
});

test('共享失败结果只记录到发起者，等待者不会收到失败日志或伪缓存命中', async () => {
  const ima = await freshClient();
  const a: CallLog[] = [];
  const b: CallLog[] = [];
  const shared = ima.withCallScope(collect(a), () => ima.readLocalText(doc('http-failure')));
  const result = await ima.withCallScope(collect(b), () => shared);
  assert.equal(result.ok, false);
  assert.equal(requests.length, 1);
  assert.equal(a.length, 1);
  assert.equal(a[0].ok, false);
  assert.equal(a[0].cacheHit, undefined);
  assert.deepEqual(b, []);
  assert.equal(ima.getCallLog().length, 1);
});

test('HTTP 读取失败和连接失败分别归属各自请求，保留失败返回值且不缓存失败', async () => {
  const ima = await freshClient();
  const a: CallLog[] = [];
  const b: CallLog[] = [];
  const [httpFailure, disconnected] = await Promise.all([
    ima.withCallScope(collect(a), () => ima.readLocalText(doc('http-failure'))),
    ima.withCallScope(collect(b), () => ima.readLocalImage(doc('disconnect', 'disconnect.png'))),
  ]);
  assert.equal(httpFailure.ok, false);
  assert.equal(httpFailure.error?.code, 503);
  assert.equal(disconnected.ok, false);
  assert.ok(disconnected.error?.message);
  assert.deepEqual(a.map((entry) => [entry.target, entry.ok, entry.cacheHit]), [[doc('http-failure').path, false, undefined]]);
  assert.deepEqual(b.map((entry) => [entry.op, entry.target, entry.ok]), [['image', doc('disconnect', 'disconnect.png').path, false]]);
  await ima.withCallScope(collect(b), () => ima.readLocalText(doc('http-failure', 'retry-label')));
  assert.equal(requests.filter((path) => path === '/document?id=http-failure').length, 2);
  assert.equal(a.length, 1);
  assert.equal(b[1].target, doc('http-failure', 'retry-label').path);
  assert.equal(b[1].cacheHit, undefined);
});

test('搜索的 HTTP 错误和无效 JSON 仍按原接口返回，并记录失败和正确来源', async () => {
  const ima = await freshClient();
  const local: CallLog[] = [];
  const online: CallLog[] = [];
  const [localResult, onlineResult] = await Promise.all([
    ima.withCallScope(collect(local), () => ima.searchLocal('http-failure')),
    ima.withCallScope(collect(online), () => ima.searchOnline('http-failure')),
  ]);
  assert.deepEqual(localResult, { onlineError: { kind: 'upstream', code: 503 } });
  assert.deepEqual(onlineResult, localResult);
  assert.equal(await ima.withCallScope(collect(local), () => ima.searchLocal('invalid-json')), null);
  assert.equal(await ima.withCallScope(collect(online), () => ima.searchOnline('invalid-json')), null);
  assert.ok(local.every((entry) => !entry.ok && entry.mode === 'local' && entry.source === '本地已下载知识库'));
  assert.ok(online.every((entry) => !entry.ok && entry.mode === 'online' && entry.source === 'ima 在线 API'));
  assert.equal(local.length, 2);
  assert.equal(online.length, 2);
});

test('索引及两种搜索连接失败重试后仍只记录到发起 scope，保留原异常', async () => {
  const ima = await freshClient();
  indexDisconnected = true;
  const index: CallLog[] = [];
  const local: CallLog[] = [];
  const online: CallLog[] = [];
  const unrelated: CallLog[] = [];
  await Promise.all([
    assert.rejects(ima.withCallScope(collect(index), () => ima.loadLocalIndex()), /fetch failed/),
    assert.rejects(ima.withCallScope(collect(local), () => ima.searchLocal('disconnect')), /fetch failed/),
    assert.rejects(ima.withCallScope(collect(online), () => ima.searchOnline('disconnect')), /fetch failed/),
    ima.withCallScope(collect(unrelated), () => ima.searchLocal('unrelated')),
  ]);
  for (const entries of [index, local, online]) {
    assert.equal(entries.length, 1);
    assert.equal(entries[0].ok, false);
    assert.equal(entries[0].cacheHit, undefined);
    assert.match(entries[0].note!, /fetch failed/);
  }
  assert.equal(index[0].op, 'documents');
  assert.equal(local[0].mode, 'local');
  assert.equal(online[0].mode, 'online');
  assert.equal(unrelated.length, 1);
  assert.equal(unrelated[0].target, 'unrelated');
  assert.equal(unrelated[0].ok, true);
  assert.equal(requests.filter((path) => path === '/documents').length, 3);
  assert.equal(requests.filter((path) => path === '/search?mode=local&q=disconnect').length, 3);
  assert.equal(requests.filter((path) => path === '/search?mode=online&q=disconnect').length, 3);
  indexDisconnected = false;
  const recovered: CallLog[] = [];
  assert.equal((await ima.withCallScope(collect(recovered), () => ima.loadLocalIndex())).length, 1);
  assert.equal(recovered[0].ok, true);
  assert.equal(recovered[0].cacheHit, undefined);
  assert.equal(index.length, 1);
});

test('空索引与 HTTP 错误记录失败且可重试，索引格式错误仍抛出并归属当前 scope', async () => {
  const ima = await freshClient();
  const entries: CallLog[] = [];
  indexItems = [];
  indexStatus = 503;
  assert.deepEqual(await ima.withCallScope(collect(entries), () => ima.loadLocalIndex()), []);
  indexStatus = 200;
  assert.deepEqual(await ima.withCallScope(collect(entries), () => ima.loadLocalIndex()), []);
  indexItems = {};
  await assert.rejects(ima.withCallScope(collect(entries), () => ima.loadLocalIndex()), TypeError);
  assert.equal(entries.length, 3);
  assert.ok(entries.every((entry) => entry.op === 'documents' && !entry.ok && entry.cacheHit === undefined));
  assert.equal(requests.length, 3);
});

test('索引接口以错误状态返回非空数据时保留原返回及缓存行为，后续日志不把失败改为成功', async () => {
  const ima = await freshClient();
  indexStatus = 503;
  const entries: CallLog[] = [];
  await ima.withCallScope(collect(entries), async () => {
    const index = await ima.loadLocalIndex();
    assert.equal(index.length, 1);
    assert.equal(await ima.loadLocalIndex(), index);
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(entries.map((entry) => [entry.ok, entry.cacheHit]), [[false, undefined], [false, true]]);
});

test('在线额度失败及之后的跳过分别留痕，跳过不冒充缓存或 HTTP 读取，本地读取不受影响', async () => {
  const ima = await freshClient();
  const first: CallLog[] = [];
  const second: CallLog[] = [];
  const failure = await ima.withCallScope(collect(first), () => ima.readOnline('quota', '触发额度失败'));
  assert.equal(failure.ok, false);
  assert.equal(ima.isOnlineQuotaExhausted(), true);
  const skipped = await ima.withCallScope(collect(second), () => ima.readOnline('not-requested', '本请求跳过', 'image'));
  assert.equal(skipped.error?.code, 220021);
  assert.equal(requests.length, 1);
  assert.equal(first.length, 1);
  assert.equal(first[0].target, '触发额度失败');
  assert.equal(second.length, 1);
  assert.equal(second[0].target, '本请求跳过');
  assert.equal(second[0].op, 'image');
  assert.equal(second[0].ok, false);
  assert.equal(second[0].cacheHit, undefined);
  assert.match(second[0].note!, /跳过/);
  assert.equal((await ima.withCallScope(collect(second), () => ima.readLocalText(doc('local-after-quota')))).ok, true);
  assert.equal(second[1].source, '本地已下载知识库');
});

test('sink 得到独立副本；篡改或抛错不影响返回结果，不向全局或别的 scope 泄露回调内容', async () => {
  const ima = await freshClient();
  const privateMarker = 'sink-private-fixture';
  const seen: CallLog[] = [];
  const other: CallLog[] = [];
  const sink = (entry: CallLog) => {
    seen.push(entry);
    entry.target = privateMarker;
    entry.note = privateMarker;
    throw new Error(privateMarker);
  };
  const result = await ima.withCallScope(sink, () => ima.readLocalText(doc('sink-test')));
  assert.equal(result.ok, true);
  assert.equal(seen.length, 1);
  assert.notEqual(seen[0], ima.getCallLog()[0]);
  const original = { ...ima.getCallLog()[0] };
  assert.equal(await ima.withCallScope(sink, () => ima.readLocalText(doc('sink-test'))), result);
  assert.equal((await ima.withCallScope(sink, () => ima.loadLocalIndex())).length, 1);
  assert.equal((await ima.withCallScope(sink, () => ima.searchLocal('sink-search'))).total, 1);
  assert.equal((await ima.withCallScope(sink, () => ima.readLocalText(doc('http-failure')))).ok, false);
  await ima.withCallScope(collect(other), () => ima.searchLocal('other-search'));
  assert.deepEqual(other.map((entry) => entry.target), ['other-search']);
  assert.ok(!JSON.stringify(ima.getCallLog()).includes(privateMarker));
  ima.getCallLog()[0].note = 'global-only-change';
  assert.equal(seen[0].note, privateMarker);
  assert.equal(original.target, doc('sink-test').path);
});

test('全局日志继续限制为最近 500 条，scope 回调收到本次全部记录', async () => {
  const ima = await freshClient();
  await ima.readLocalText(doc('bounded-log'));
  const global = ima.getCallLog();
  const entries: CallLog[] = [];
  await ima.withCallScope(collect(entries), async () => {
    for (let index = 0; index < 505; index++) {
      await ima.readLocalText(doc('bounded-log', `consumer-${index}`));
    }
  });
  assert.equal(ima.getCallLog(), global);
  assert.equal(global.length, 500);
  assert.equal(entries.length, 505);
  assert.equal(global[0].target, doc('bounded-log', 'consumer-5').path);
  assert.equal(entries[0].target, doc('bounded-log', 'consumer-0').path);
  assert.ok(entries.every((entry) => entry.cacheHit === true));
  assert.equal(requests.length, 1);
});
