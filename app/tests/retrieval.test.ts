import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { retrieveKnowledge, readKnowledgeDocument } from '../lib/retrieval.ts';
import { cancelRun, createRun, RunStoppedError, withRun } from '../lib/agent-runtime.ts';
import { GET } from '../app/api/knowledge/document/route.ts';

const id = 'a'.repeat(24);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const passage = { id, title: '产品事实', path: 'P1-产品参数库/Windows/产品事实.md',
  preview: '屏幕：14英寸', sha256: sha('屏幕：14英寸'), score: 0.8 };
const payload = (items: unknown[] = [passage]) => ({
  source: '本地已下载知识库', retrievalScope: 'all-indexed-documents',
  onlineUsed: false, strategy: 'hybrid', scannedLocalFiles: 1522,
  indexFingerprint: 'b'.repeat(64), items,
});
const fake = (body: unknown): typeof fetch => async () => Response.json(body);
const metadata = (item: unknown = passage) => ({
  source: '本地已下载知识库', indexFingerprint: 'b'.repeat(64), indexStale: false, item,
});

test('混合查询走全库接口，50条窗口、非穷尽标记与原文链接均明确', async () => {
  let seen = '';
  const result = await retrieveKnowledge('全库搜索出差办公', { fetch: async (url) => {
    seen = String(url);
    return Response.json(payload());
  } });
  const url = new URL(seen);
  assert.equal(url.pathname, '/rag/search');
  assert.equal(url.searchParams.get('top_k'), '50');
  assert.equal(url.searchParams.get('strategy'), 'hybrid');
  assert.equal(url.searchParams.get('q'), '全库搜索出差办公');
  assert.equal(result.status, 'ready');
  assert.equal(result.scannedFiles, 1522);
  assert.equal(result.exhaustive, false);
  assert.equal(result.items[0].documentUrl, `/api/knowledge/document?id=${id}`);
  assert.match(result.message, /不代表全部匹配/);
});

test('服务失败、恶意错误和无效JSON只显示固定中文，不泄漏内部内容', async () => {
  for (const request of [
    async () => { throw new Error('private-key-secret'); },
    async () => new Response('private-key-secret', { status: 503 }),
    async () => new Response('private-key-secret'),
  ]) {
    const result = await retrieveKnowledge('用途', { fetch: request });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.returned, 0);
    assert.deepEqual(result.items, []);
    assert.doesNotMatch(JSON.stringify(result), /private-key/);
    assert.match(result.message, /不能视为已完成整库搜索/);
  }
});

test('畸形范围、伪在线、过量返回和危险文档信息均不能伪装成功', async () => {
  for (const body of [
    { ...payload(), onlineUsed: true },
    { ...payload(), scannedLocalFiles: -1 },
    { ...payload(), retrievalScope: 'some' },
    { ...payload(), indexFingerprint: undefined },
    payload(Array.from({ length: 51 }, () => passage)),
    payload([{ ...passage, id: '../private' }]),
    payload([{ ...passage, path: '../private.md' }]),
    payload([{ ...passage, path: 'C:/private.md' }]),
    payload([{ ...passage, path: 'readme.html' }]),
    payload([{ ...passage, sha256: '' }]),
  ]) assert.equal((await retrieveKnowledge('用途', { fetch: fake(body) })).status, 'unavailable');
});

test('空结果保持已搜索与0命中的区别，问题长度限制1000字', async () => {
  for (const query of ['字'.repeat(1300), '😀'.repeat(1000), '𠮷'.repeat(1001), `${'字'.repeat(999)}😀额外`]) {
    let seen = '';
    const result = await retrieveKnowledge(` ${query} `, { fetch: async (url) => {
      seen = String(url);
      return Response.json(payload([]));
    } });
    const sent = new URL(seen).searchParams.get('q')!;
    assert.equal(sent, Array.from(query).slice(0, 1000).join(''));
    assert.equal(Array.from(sent).length, 1000);
    assert.equal(result.query, sent);
    assert.equal(result.status, 'ready');
    assert.equal(result.returned, 0);
    assert.equal(result.items.length, 0);
  }
});

test('混合结果含图片时保留有效文字；图片路径不当作事实或可读原文', async () => {
  const result = await retrieveKnowledge('出差配图', { fetch: fake(payload([
    passage, { ...passage, id: 'c'.repeat(24), path: 'P3-图片库/产品.png', preview: 'P3-图片库/产品.png' },
  ])) });
  assert.equal(result.status, 'ready');
  assert.equal(result.returned, 1);
  assert.equal(result.items[0].id, id);
});

test('限时和正文实际字节限制有效，不接受虚假Content-Length绕过', async () => {
  const timeout = await retrieveKnowledge('用途', { timeoutMs: 10, fetch: async (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('missing timeout')), 500);
      init!.signal!.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    }) });
  assert.equal(timeout.status, 'unavailable');
  const oversized = await retrieveKnowledge('用途', { fetch: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-length': '1' } }) });
  assert.equal(oversized.status, 'unavailable');
});

test('检索请求和正文读取继承任务取消，不降级为检索不可用或返回迟到结果', async (t) => {
  for (const phase of ['request', 'body', 'late-response']) {
    await t.test(phase, { timeout: 2000 }, async (t) => {
      const run = createRun();
      const key = `retrieval-cancel-${phase}`;
      const progress: string[] = [];
      let signal!: AbortSignal;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => { started = resolve; });
      let release!: (response: Response) => void;
      t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
        assert.equal(init?.redirect, 'error');
        signal = init!.signal!;
        assert.ok(signal instanceof AbortSignal);
        if (phase === 'body') {
          return new Response(new ReadableStream({
            start(controller) {
              signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
              started();
            },
          }));
        }
        return new Promise<Response>((resolve, reject) => {
          release = resolve;
          if (phase === 'request') signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          started();
        });
      });
      let operation!: ReturnType<typeof retrieveKnowledge>;
      const task = withRun(key, run, (event) => { progress.push(event.status); }, () => {
        operation = retrieveKnowledge('任务取消测试', { base: 'https://retrieval.invalid', timeoutMs: 1000 });
        return operation;
      }, { timeoutMs: 1000 });
      const stopped = assert.rejects(task, (error: unknown) => error instanceof RunStoppedError && error.status === 'cancelled');
      t.after(() => { cancelRun(key, run.id); release?.(Response.json(payload())); });
      await ready;
      assert.equal(signal.aborted, false);
      const retrievalStopped = assert.rejects(operation, (error: unknown) => error === signal.reason);
      assert.equal(cancelRun(key, run.id), true);
      assert.equal(signal.aborted, true);
      if (phase === 'late-response') release(Response.json(payload()));
      await Promise.all([stopped, retrievalStopped]);
      assert.deepEqual(progress, ['started']);
    });
  }
});

test('文档元数据请求和原文请求都继承任务取消，不再继续读取或返回原文', async (t) => {
  for (const phase of ['index', 'document', 'body']) {
    await t.test(phase, { timeout: 2000 }, async (t) => {
      const run = createRun();
      const key = `document-cancel-${phase}`;
      const paths: string[] = [];
      const signals: AbortSignal[] = [];
      let started!: () => void;
      const ready = new Promise<void>((resolve) => { started = resolve; });
      t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        const signal = init!.signal!;
        assert.ok(signal instanceof AbortSignal);
        signals.push(signal);
        if (phase !== 'index' && path === '/document/meta') return Response.json(metadata());
        if (phase === 'body') {
          return new Response(new ReadableStream({
            start(controller) {
              signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
              started();
            },
          }));
        }
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          started();
        });
      });
      let operation!: ReturnType<typeof readKnowledgeDocument>;
      const task = withRun(key, run, () => {}, () => {
        operation = readKnowledgeDocument(id, { base: 'https://retrieval.invalid', timeoutMs: 1000 });
        return operation;
      }, { timeoutMs: 1000 });
      const stopped = assert.rejects(task, (error: unknown) => error instanceof RunStoppedError && error.status === 'cancelled');
      t.after(() => { cancelRun(key, run.id); });
      await ready;
      assert.ok(signals.every((signal) => !signal.aborted));
      const documentStopped = assert.rejects(operation, (error: unknown) => error === signals.at(-1)?.reason);
      assert.equal(cancelRun(key, run.id), true);
      await Promise.all([stopped, documentStopped]);
      assert.ok(signals.every((signal) => signal.aborted && signal.reason instanceof RunStoppedError
        && signal.reason.status === 'cancelled'));
      assert.deepEqual(paths, phase === 'index' ? ['/document/meta'] : ['/document/meta', '/document']);
    });
  }
});

test('原文仅按已登记编号读取并校验摘要，不接受路径或任意文件', async () => {
  const content = '<script>alert(1)</script>\n产品事实';
  const requests: string[] = [];
  const request: typeof fetch = async (url) => {
    requests.push(new URL(String(url)).pathname);
    return String(url).includes('/document/meta')
      ? Response.json(metadata({ ...passage, sha256: sha(content) }))
      : new Response(content);
  };
  assert.equal(await readKnowledgeDocument(id, { fetch: request }), content);
  assert.deepEqual(requests, ['/document/meta', '/document']);
  for (const invalid of ['../private', 'a'.repeat(23), 'A'.repeat(24), `${id}&path=private`]) {
    await assert.rejects(() => readKnowledgeDocument(invalid, { fetch: request }), { status: 400 });
  }
  await assert.rejects(() => readKnowledgeDocument('c'.repeat(24), { fetch: request }), { status: 404 });
});

test('摘要变化、图片及危险路径拒绝查看，网络错误不泄漏内部信息', async () => {
  await assert.rejects(() => readKnowledgeDocument(id, { fetch: async (url) =>
    String(url).includes('/document/meta') ? Response.json(metadata()) : new Response('已变化') }), { status: 409 });
  for (const path of ['image.png', '../private.md']) {
    await assert.rejects(() => readKnowledgeDocument(id, { fetch: fake(metadata({ ...passage, path })) }), { status: 404 });
  }
  await assert.rejects(() => readKnowledgeDocument(id, { fetch: async () => { throw new Error('secret'); } }),
    (e: unknown) => e instanceof Error && !e.message.includes('secret'));
});

test('单份元数据无需整库目录，并拒绝过期、错误来源和错误编号', async () => {
  const content = '屏幕：14英寸';
  const request: typeof fetch = async (url) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.searchParams.get('id'), id);
    assert.notEqual(parsed.pathname, '/documents');
    return parsed.pathname === '/document/meta' ? Response.json(metadata()) : new Response(content);
  };
  assert.equal(await readKnowledgeDocument(id, { fetch: request }), content);
  for (const body of [
    { ...metadata(), indexStale: true },
    { ...metadata(), source: '未知来源' },
    { ...metadata(), indexFingerprint: '' },
  ]) await assert.rejects(() => readKnowledgeDocument(id, { fetch: fake(body) }), { status: 503 });
  await assert.rejects(() => readKnowledgeDocument(id, { fetch: fake(metadata({ ...passage, id: 'c'.repeat(24) })) }), { status: 404 });
  await assert.rejects(() => readKnowledgeDocument(id, { fetch: async () => new Response('internal', { status: 404 }) }), { status: 404 });
});

test('原文实际路由拒绝重复编号及额外参数，并把HTML内容作为纯文字返回', async (t) => {
  for (const query of [`id=${id}&id=${id}`, `id=${id}&path=private`, 'path=private']) {
    assert.equal((await GET(new Request(`http://local/api/knowledge/document?${query}`))).status, 400);
  }
  const content = '<script>malicious()</script>';
  t.mock.method(globalThis, 'fetch', async (url: unknown) => String(url).includes('/document/meta')
    ? Response.json(metadata({ ...passage, sha256: sha(content) })) : new Response(content));
  const response = await GET(new Request(`http://local/api/knowledge/document?id=${id}`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy')!, /sandbox/);
  assert.equal(await response.text(), content);
});
