import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const script = fileURLToPath(new URL('./knowledge-server.mjs', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const image = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex');
const verifiedSnapshot = (binding, extra = {}) => ({
  service: 'ima-local-rag', apiVersion: 2, ready: true, indexStale: false,
  files: binding.files, fingerprint: binding.indexFingerprint,
  verification: 'full-content-per-request', ...extra,
});

async function temporary(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhixuan-adapter-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function launch(root, port, overrides = {}) {
  const env = { ...process.env, IMA_LOCAL_PORT: String(port) };
  // Tests never inherit a real hybrid service or upstream credentials.
  for (const name of ['ZHIXUAN_RAG_BASE', 'ZHIXUAN_REQUEST_TIMEOUT_MS',
    'ZHIXUAN_RAG_MAX_CONCURRENT', 'ZHIXUAN_LOCAL_MAX_CONCURRENT', 'ZHIXUAN_MAX_UPSTREAM_BYTES']) delete env[name];
  Object.assign(env, overrides);
  if (root === undefined) delete env.ZHIXUAN_KB_DIR;
  else env.ZHIXUAN_KB_DIR = root;
  // A marker verifies that errors do not dump unrelated environment values.
  env.ZHIXUAN_TEST_SECRET = 'do-not-print-fixture-secret';
  const child = spawn(process.execPath, [script], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
  return { child, closed, output: () => output };
}

async function expectExit(started) {
  const timer = setTimeout(() => started.child.kill(), 3000);
  try {
    const result = await started.closed;
    assert.notEqual(result.code, null, `startup did not fail promptly: ${result.output}`);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(t, extra = async () => {}, env = {}) {
  const dir = await temporary(t);
  const root = path.join(dir, 'knowledge');
  await mkdir(path.join(root, 'P1', '型号甲'), { recursive: true });
  await mkdir(path.join(root, 'P1', '型号乙'), { recursive: true });
  await writeFile(path.join(root, 'P1', '型号甲', '产品事实.md'), '型号甲：独有词琥珀，支持 HarmonyOS。\n资料日期：2026-10-19。');
  await writeFile(path.join(root, 'P1', '型号乙', '产品事实.md'), '型号乙：独有词青瓷，不得与型号甲混淆。');
  await writeFile(path.join(root, '封面.png'), image);
  await writeFile(path.join(root, '数据.json'), '{"name":"测试资料"}');
  await extra(root, dir);
  const port = await freePort();
  const processInfo = launch(root, port, env);
  t.after(async () => {
    if (processInfo.child.exitCode === null) processInfo.child.kill();
    await processInfo.closed;
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 500; i++) {
    if (processInfo.child.exitCode !== null) break;
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) { ready = true; break; }
    } catch { /* The child is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(ready, `fixture did not start: ${processInfo.output()}`);
  const get = (route, options = {}) => fetch(`${base}${route}`, { ...options, signal: options.signal ?? AbortSignal.timeout(5000) });
  const entries = async () => (await (await get('/documents')).json()).items;
  return { root, dir, get, entries, processInfo, base };
}

test('启动错误使用可读提示，不输出目录、堆栈或凭证', async (t) => {
  const dir = await temporary(t);
  const file = path.join(dir, 'not-a-folder');
  await writeFile(file, 'fixture');
  for (const [label, root, port, expected] of [
    ['未配置', undefined, 8765, /ZHIXUAN_KB_DIR/],
    ['缺目录', path.join(dir, 'missing-private-folder'), 8765, /目录不存在/],
    ['非目录', file, 8765, /不是文件夹/],
    ['非法端口', dir, 'invalid-port', /端口/],
    ['端口带空格', dir, ' ', /端口/],
  ]) {
    await t.test(label, async () => {
      const started = launch(root, port);
      const result = await expectExit(started);
      assert.notEqual(result.code, 0);
      assert.match(result.output, expected);
      assert.ok(!result.output.includes(dir), 'must not expose the absolute root');
      assert.doesNotMatch(result.output, /do-not-print-fixture-secret|^\s+at\s/m);
    });
  }
});

test('健康信息明确本地读取和搜索能力', async (t) => {
  const { get } = await fixture(t);
  const response = await get('/health');
  const health = await response.json();
  assert.equal(health.service, 'zhixuan-local-knowledge');
  assert.equal(health.files, 4);
  assert.equal(health.source, '本地已下载知识库');
  assert.equal(health.capabilities.online, false);
  assert.equal(health.capabilities.rag, false);
  assert.equal(health.indexMode, 'snapshot');
  assert.ok(Date.parse(health.indexedAt));
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('目录完整，编号稳定，同名文件分开，摘要对应原文', async (t) => {
  const { root, entries, get } = await fixture(t);
  const items = await entries();
  assert.equal(items.length, 4);
  assert.equal(items.filter((x) => x.title === '产品事实.md').length, 2);
  assert.equal(new Set(items.map((x) => x.id)).size, 4);
  for (const item of items) {
    assert.equal(item.id, hash(item.path).slice(0, 24));
    assert.equal(item.sha256, hash(await readFile(path.join(root, item.path))));
    assert.equal(item.full, undefined);
    assert.equal(item.path.includes('\\'), false);
    assert.equal(path.isAbsolute(item.path), false);
  }
  assert.deepEqual((await (await get('/documents')).json()).items, items);
});

test('正文和图片保持原字节、摘要及正确类型', async (t) => {
  const { root, entries, get } = await fixture(t);
  for (const item of await entries()) {
    const response = await get(`/document?id=${item.id}`);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(path.join(root, item.path)));
    const type = item.path.endsWith('.png') ? 'image/png'
      : item.path.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
    assert.equal(response.headers.get('content-type'), type);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('拒绝路径穿越与异常编号，仍可读取正常正文', async (t) => {
  const { get, entries, dir } = await fixture(t);
  await writeFile(path.join(dir, 'outside-secret.txt'), 'outside-secret-fixture');
  for (const id of ['../outside-secret.txt', '..\\outside-secret.txt', '%2e%2e/outside-secret.txt', '/etc/passwd', 'C:\\private.txt', 'unknown']) {
    const response = await get(`/document?id=${encodeURIComponent(id)}`);
    assert.equal(response.status, 404);
    assert.ok(!(await response.text()).includes('outside-secret-fixture'));
  }
  assert.equal((await get('/document?path=../outside-secret.txt')).status, 400);
  const valid = (await entries())[0].id;
  assert.equal((await get(`/document?id=${valid}&id=${valid}`)).status, 400);
  assert.equal((await get(`/document?id=${valid}`)).status, 200);
});

test('搜索正文、路径和多个条件；明确总数和分页，没有暗中截断', async (t) => {
  const { get } = await fixture(t, async (root) => {
    for (let i = 0; i < 45; i++) await writeFile(path.join(root, `多页-${i}.txt`), '分页独有词');
  });
  const body = await (await get(`/search?q=${encodeURIComponent('琥珀')}`)).json();
  assert.equal(body.total, 1);
  assert.ok(body.items[0].path.includes('型号甲'));
  assert.deepEqual(body.items[0].matches, ['content']);
  const multi = await (await get(`/search?q=${encodeURIComponent('型号甲 HarmonyOS')}`)).json();
  assert.equal(multi.total, 1);
  const byPath = await (await get(`/search?q=${encodeURIComponent('产品事实')}`)).json();
  assert.equal(byPath.total, 2);
  const complete = await (await get(`/search?q=${encodeURIComponent('分页独有词')}`)).json();
  assert.equal(complete.items.length, 45);
  assert.equal(complete.hasMore, false);
  const first = await (await get(`/search?q=${encodeURIComponent('分页独有词')}&limit=40`)).json();
  assert.equal(first.total, 45);
  assert.equal(first.items.length, 40);
  assert.equal(first.hasMore, true);
  const second = await (await get(`/search?q=${encodeURIComponent('分页独有词')}&offset=40`)).json();
  assert.equal(second.total, 45);
  assert.equal(second.items.length, 5);
  assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.items, ...second.items].map((x) => x.id)).size, 45);
  assert.equal((await (await get('/search?q=NO_SUCH_CONTENT')).json()).total, 0);
});

test('非法搜索条件明确报错；在线请求不伪报成功', async (t) => {
  const { get } = await fixture(t);
  for (const route of [
    '/search', '/search?q=%20', `/search?q=${'a'.repeat(201)}`,
    '/search?q=x&limit=0', '/search?q=x&limit=201', '/search?q=x&offset=-1',
    '/search?q=x&offset=1.5', '/search?q=x&mode=invalid', '/search?q=x&q=y',
  ]) assert.equal((await get(route)).status, 400, route);
  const online = await (await get('/search?mode=online&q=HarmonyOS')).json();
  assert.equal(online.onlineError.code, 'ONLINE_UNSUPPORTED');
  assert.equal(online.onlineMatches, 0);
  assert.deepEqual(online.items, []);
});

test('文件改变或删除会明确报错，不返回旧摘要配新正文，也不导致进程崩溃', async (t) => {
  const { get, entries, root } = await fixture(t);
  const doc = (await entries()).find((x) => x.path.includes('型号甲'));
  await writeFile(path.join(root, doc.path), '已变更的正文：琥珀');
  const changed = await get(`/document?id=${doc.id}`);
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).error.code, 'INDEX_STALE');
  const search = await get(`/search?q=${encodeURIComponent('琥珀')}`);
  assert.equal(search.status, 409);
  await rm(path.join(root, doc.path));
  const deleted = await get(`/document?id=${doc.id}`);
  assert.equal(deleted.status, 409);
  assert.equal((await deleted.json()).error.code, 'INDEX_STALE');
  assert.equal((await get('/health')).status, 200);
  const unaffected = (await entries()).find((x) => x.path.includes('型号乙'));
  assert.equal((await get(`/document?id=${unaffected.id}`)).status, 200);
});

test('初始目录链接不建索引；运行时目录替换为外部链接后拒绝读取和搜索', async (t) => {
  const { get, entries, root, dir } = await fixture(t, async (root, dir) => {
    const outside = path.join(dir, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, '产品事实.md'), '琥珀 outside-secret-fixture');
    await symlink(outside, path.join(root, '外部目录'), process.platform === 'win32' ? 'junction' : 'dir');
  });
  assert.equal((await entries()).some((x) => x.path.includes('外部目录')), false);
  const doc = (await entries()).find((x) => x.path.includes('型号甲'));
  const folder = path.join(root, 'P1', '型号甲');
  await rm(folder, { recursive: true });
  await symlink(path.join(dir, 'outside'), folder, process.platform === 'win32' ? 'junction' : 'dir');
  const response = await get(`/document?id=${doc.id}`);
  assert.equal(response.status, 409);
  assert.ok(!(await response.text()).includes('outside-secret-fixture'));
  assert.equal((await get(`/search?q=${encodeURIComponent('琥珀')}`)).status, 409);
});

test('根目录失效时健康和正文都报错；方法和路由错误不影响后续请求', async (t) => {
  const { get, entries, root } = await fixture(t);
  assert.equal((await get('/document', { method: 'POST' })).status, 405);
  assert.equal((await get('/missing')).status, 404);
  const id = (await entries())[0].id;
  await rm(root, { recursive: true });
  assert.equal((await get('/health')).status, 503);
  assert.equal((await get('/documents')).status, 503);
  assert.equal((await get(`/document?id=${id}`)).status, 503);
});

test('端口已占用时清楚退出，不影响占用者', async (t) => {
  const dir = await temporary(t);
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const started = launch(dir, blocker.address().port);
  const result = await expectExit(started);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /端口已被占用/);
  assert.doesNotMatch(result.output, /EADDRINUSE|^\s+at\s/m);
  assert.equal(blocker.listening, true);
});

test('混合检索未配置时明确不可用，不能假装完成语义检索', async (t) => {
  const { get } = await fixture(t);
  const response = await get('/rag/search?q=test');
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.reasonCode, 'RAG_NOT_CONFIGURED');
  assert.equal(body.status, 'unavailable');
  assert.deepEqual(body.citations, []);
});

test('混合检索绑定全库指纹，并核对每条结果的真实原文', async (t) => {
  let binding;
  let source;
  let result;
  let mutate = 'none';
  const backend = createHttpServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') {
      res.end(JSON.stringify({
        service: 'ima-local-rag', ready: true, indexStale: false,
        files: binding.files, fingerprint: mutate === 'binding' ? 'other-library' : binding.indexFingerprint,
      }));
      return;
    }
    const entry = { ...result, number: 1, citationId: 1,
      ...(mutate === 'preview' ? { preview: 'wrong-but-plausible-fact' } : {}) };
    const answer = req.url.startsWith('/answer?');
    const quote = entry.preview;
    const claim = mutate === 'claim' ? 'invented-fact-with-a-real-citation' : quote;
    res.end(JSON.stringify({
      verifiedSnapshot: verifiedSnapshot(binding, mutate === 'binding' ? { fingerprint: 'other-library' } : {}),
      strategy: 'hybrid', indexFingerprint: binding.indexFingerprint, onlineUsed: false,
      totalCandidates: binding.files, results: [entry], returned: 1,
      ...(answer ? {
        status: 'answered', answer: `${claim}[1]`, claims: [{ citationIds: [1], text: claim, kind: 'source_fact' }],
        conditions: [],
        citations: [entry], evidenceSufficient: true, generationModelUsed: false, answerType: 'extractive',
      } : {}),
    }));
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => { backend.closeAllConnections(); return new Promise((resolve) => backend.close(resolve)); });
  const { get, entries, root } = await fixture(t, undefined, {
    ZHIXUAN_RAG_BASE: `http://127.0.0.1:${backend.address().port}`,
  });
  binding = await (await get('/health')).json();
  const doc = (await entries()).find((entry) => entry.path.includes('型号甲'));
  source = await readFile(path.join(root, doc.path), 'utf8');
  result = { ...doc, preview: source, start: 0, end: Array.from(source).length };
  const search = await get('/rag/search?q=test&top_k=50&strategy=hybrid');
  assert.equal(search.status, 200);
  const body = await search.json();
  assert.equal(body.retrievalScope, 'all-indexed-documents');
  assert.equal(body.scannedLocalFiles, 4);
  assert.equal(body.strategy, 'hybrid');
  assert.deepEqual(body.items, body.results);
  assert.deepEqual(body.resultWindow, { maximumTopK: 50, returned: 1, paginationSupported: false, exhaustive: false });
  assert.equal((await get(body.items[0].documentUrl)).status, 200);
  assert.equal((await get('/rag/answer?q=test')).status, 200);
  mutate = 'claim';
  const unsupported = await get('/rag/answer?q=test');
  assert.equal(unsupported.status, 503);
  assert.equal((await unsupported.json()).reasonCode, 'UPSTREAM_UNAVAILABLE');
  mutate = 'binding';
  const mismatch = await get('/rag/search?q=test');
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).reasonCode, 'RAG_INDEX_MISMATCH');
  mutate = 'preview';
  const fabricated = await get('/rag/search?q=test');
  assert.equal(fabricated.status, 409);
  assert.equal((await fabricated.json()).reasonCode, 'INDEX_STALE');
  assert.equal((await get('/health')).status, 200);
});

test('混合检索配置只接受本机地址，配置错误不泄露内容', async (t) => {
  const dir = await temporary(t);
  for (const target of ['https://example.com', 'http://user:secret@127.0.0.1:1234/', 'http://127.0.0.1:1234/private?q=secret']) {
    const result = await expectExit(launch(dir, 8765, { ZHIXUAN_RAG_BASE: target }));
    assert.notEqual(result.code, 0);
    assert.match(result.output, /ZHIXUAN_RAG_BASE/);
    assert.doesNotMatch(result.output, /secret|private|example.com/);
  }
});

test('混合片段与短答统一指向原文字符位置，兼容换行和非BMP字符', async (t) => {
  let binding;
  let doc;
  const source = '开头🧭\r\n型号甲：琥珀🧪。\r限定条件：仅此型号。\r\n';
  const backend = createHttpServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') {
      return res.end(JSON.stringify({
        service: 'ima-local-rag', ready: true, indexStale: false,
        files: binding.files, fingerprint: binding.indexFingerprint,
      }));
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const answer = url.pathname === '/answer';
    const strategy = url.searchParams.get('strategy') || 'hybrid';
    const upstreamText = answer || strategy === 'exact' ? source.replace(/\r\n|\r/g, '\n') : source;
    const characters = Array.from(upstreamText);
    const start = characters.indexOf('型');
    const end = characters.length;
    const entry = { ...doc, start, end, preview: characters.slice(start, end).join(''), number: 1, citationId: 1 };
    const quote = entry.preview.trim();
    res.end(JSON.stringify({
      verifiedSnapshot: verifiedSnapshot(binding),
      strategy, indexFingerprint: binding.indexFingerprint, onlineUsed: false,
      totalCandidates: binding.files, returned: 1, results: [entry],
      ...(answer ? {
        status: 'answered', answer: `${quote}[1]`, claims: [{ text: quote, citationIds: [1], kind: 'source_fact' }],
        conditions: [],
        citations: [entry], evidenceSufficient: true, generationModelUsed: false, answerType: 'extractive',
      } : {}),
    }));
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => { backend.closeAllConnections(); return new Promise((resolve) => backend.close(resolve)); });
  const { get, entries } = await fixture(t, async (root) => {
    await writeFile(path.join(root, '换行.md'), source);
  }, { ZHIXUAN_RAG_BASE: `http://127.0.0.1:${backend.address().port}` });
  binding = await (await get('/health')).json();
  doc = (await entries()).find((entry) => entry.path === '换行.md');
  for (const route of ['/rag/answer?q=test', '/rag/search?q=test&strategy=exact', '/rag/search?q=test&strategy=hybrid']) {
    const response = await get(route);
    const body = await response.json();
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(body)}`);
    const original = Array.from(source);
    for (const result of [...body.results, ...(body.citations ?? [])]) {
      assert.equal(result.start, original.indexOf('型'));
      assert.equal(result.end, original.length);
      assert.equal(result.preview, original.slice(result.start, result.end).join(''));
      assert.equal(result.offsetEncoding, 'unicode-code-points');
      assert.equal(result.newlineMode, 'original');
    }
  }
});

test('混合检索并发有上限，繁忙与上游故障清楚返回且能够恢复', async (t) => {
  let binding;
  let hold = true;
  let fail = false;
  const held = [];
  const health = () => ({
    service: 'ima-local-rag', ready: true, indexStale: false,
    files: binding.files, fingerprint: binding.indexFingerprint,
  });
  const search = () => ({
    verifiedSnapshot: verifiedSnapshot(binding),
    strategy: 'hybrid', indexFingerprint: binding.indexFingerprint, onlineUsed: false,
    totalCandidates: binding.files, results: [], returned: 0,
  });
  const backend = createHttpServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (hold) { held.push({ res, probe: req.url === '/health' }); return; }
    if (req.url === '/health') {
      return res.end(JSON.stringify(health()));
    }
    if (fail) return res.end('private-upstream-error-do-not-reflect');
    res.end(JSON.stringify(search()));
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => { backend.closeAllConnections(); return new Promise((resolve) => backend.close(resolve)); });
  const { get } = await fixture(t, undefined, {
    ZHIXUAN_RAG_BASE: `http://127.0.0.1:${backend.address().port}`,
  });
  binding = await (await get('/health')).json();
  const active = Array.from({ length: 8 }, () => get('/rag/search?q=test'));
  // Always observe pending requests, including when an earlier assertion fails.
  const completed = Promise.allSettled(active);
  for (let attempt = 0; attempt < 100 && held.length < 8; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(held.length, 8);
  const overload = await get('/rag/search?q=test', { headers: { 'x-request-id': 'test-busy-1234' } });
  assert.equal(overload.status, 503);
  assert.equal(overload.headers.get('retry-after'), '1');
  const busy = await overload.json();
  assert.equal(busy.reasonCode, 'BUSY');
  assert.equal(busy.requestId, 'test-busy-1234');
  assert.equal(busy.retryable, true);
  assert.equal((await get('/health')).status, 200);
  const probe = get('/rag/health');
  const probeCompleted = Promise.allSettled([probe]);
  for (let attempt = 0; attempt < 100 && held.length < 9; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(held.length, 9, 'health probe has a slot separate from queries');
  assert.equal((await get('/rag/health')).status, 503, 'health probes also have a bound');
  hold = false;
  for (const { res, probe } of held) res.end(JSON.stringify(probe ? health() : search()));
  assert.equal((await probeCompleted)[0].value.status, 200);
  for (const result of await completed) {
    assert.equal(result.status, 'fulfilled');
    assert.equal(result.value.status, 200);
    await result.value.arrayBuffer();
  }
  fail = true;
  const failed = await get('/rag/search?q=test');
  assert.equal(failed.status, 502);
  const error = await failed.text();
  assert.equal(JSON.parse(error).reasonCode, 'UPSTREAM_INVALID_RESPONSE');
  assert.ok(!error.includes('private-upstream-error'));
  fail = false;
  assert.equal((await get('/rag/search?q=test')).status, 200);
});

async function ragFixture(t, env = {}, extra) {
  const state = { binding: null, handler: null, calls: [], results: [], healthExtra: {}, resultExtra: {} };
  const backend = createHttpServer((req, res) => {
    state.calls.push({ url: req.url, requestId: req.headers['x-request-id'] });
    if (state.handler?.(req, res)) return;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') return res.end(JSON.stringify({
      service: 'ima-local-rag', ready: true, indexStale: false,
      files: state.binding.files, fingerprint: state.binding.indexFingerprint, ...state.healthExtra,
    }));
    res.end(JSON.stringify({
      verifiedSnapshot: verifiedSnapshot(state.binding),
      strategy: 'hybrid', indexFingerprint: state.binding.indexFingerprint, onlineUsed: false,
      totalCandidates: state.binding.files, returned: state.results.length, results: state.results, ...state.resultExtra,
    }));
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => { backend.closeAllConnections(); return new Promise((resolve) => backend.close(resolve)); });
  const context = await fixture(t, extra, {
    ...env, ZHIXUAN_RAG_BASE: `http://127.0.0.1:${backend.address().port}`,
  });
  state.binding = await (await context.get('/health')).json();
  return { ...context, state, backend };
}

async function until(predicate, label) {
  for (let i = 0; i < 150; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test('每次查询直接验证本次全库绑定，不预先重复健康全扫；旧响应及错误绑定均拒绝', async (t) => {
  const { get, state } = await ragFixture(t);
  for (const route of ['/rag/search?q=test&top_k=50', '/rag/search?q=absent&strategy=exact']) {
    state.resultExtra = { strategy: route.includes('exact') ? 'exact' : 'hybrid' };
    const response = await get(route);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.verifiedSnapshot, verifiedSnapshot(state.binding));
    assert.deepEqual(body.results, []);
  }
  assert.equal(state.calls.length, 2, 'one upstream request per query, including empty results');
  assert.ok(state.calls.every((call) => call.url.startsWith('/search?')));
  state.resultExtra = {};
  for (const [binding, status, reason] of [
    [undefined, 502, 'UPSTREAM_INVALID_RESPONSE'],
    [null, 502, 'UPSTREAM_INVALID_RESPONSE'],
    [verifiedSnapshot(state.binding, { service: 'other-service' }), 502, 'UPSTREAM_INVALID_RESPONSE'],
    [verifiedSnapshot(state.binding, { apiVersion: 1 }), 502, 'UPSTREAM_INVALID_RESPONSE'],
    [verifiedSnapshot(state.binding, { verification: 'cached' }), 502, 'UPSTREAM_INVALID_RESPONSE'],
    [verifiedSnapshot(state.binding, { indexStale: undefined }), 502, 'UPSTREAM_INVALID_RESPONSE'],
    [verifiedSnapshot(state.binding, { files: String(state.binding.files) }), 409, 'RAG_INDEX_MISMATCH'],
    [verifiedSnapshot(state.binding, { fingerprint: 'other-library' }), 409, 'RAG_INDEX_MISMATCH'],
    [verifiedSnapshot(state.binding, { indexStale: true }), 409, 'RAG_INDEX_MISMATCH'],
    [verifiedSnapshot(state.binding, { ready: false }), 503, 'RAG_NOT_READY'],
  ]) {
    state.resultExtra = { verifiedSnapshot: binding };
    const response = await get('/rag/search?q=test');
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.reasonCode, reason);
    assert.deepEqual(body.results, []);
  }
  for (const status of ['answered', 'clarify', 'insufficient_evidence']) {
    state.resultExtra = {
      status, answer: '需要更多依据。', citations: [], claims: [], conditions: [], evidenceSufficient: false,
      verifiedSnapshot: verifiedSnapshot(state.binding, { fingerprint: 'other-library' }),
    };
    assert.equal((await get('/rag/answer?q=test')).status, 409, status);
  }
  state.resultExtra = {};
  assert.equal((await get('/rag/search?q=test')).status, 200);
  assert.equal((await get('/rag/health')).status, 200);
  assert.equal(state.calls.filter((call) => call.url === '/health').length, 1);
});

function rawGet(base, route, headers = {}, data) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(base, { method: 'GET', path: route, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (part) => chunks.push(part));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('raw request timed out')));
    req.end(data);
  });
}

test('目录分页可收齐全库；非法分页不被静默忽略', async (t) => {
  const { get } = await fixture(t, async (root) => {
    for (let i = 0; i < 43; i++) await writeFile(path.join(root, `分页-${i}.txt`), 'fixture');
  });
  const all = await (await get('/documents')).json();
  const seen = [];
  let next = 0;
  do {
    const page = await (await get(`/documents?limit=7&offset=${next}`)).json();
    assert.equal(page.total, 47);
    assert.equal(page.offset, next);
    assert.equal(page.hasMore, page.nextOffset !== null);
    seen.push(...page.items);
    next = page.nextOffset;
  } while (next !== null);
  assert.deepEqual(seen, all.items);
  assert.equal(new Set(seen.map((x) => x.id)).size, 47);
  assert.deepEqual((await (await get('/documents?limit=7&offset=1000')).json()).items, []);
  for (const route of ['/documents?limit=0', '/documents?limit=201', '/documents?offset=-1',
    '/documents?offset=1.5', '/documents?limit=2&limit=2', '/documents?anything=1']) {
    assert.equal((await get(route)).status, 400, route);
  }
});

test('地址、正文和参数严格验证；错误统一包含请求编号且不回显私密内容', async (t) => {
  const { get, base } = await fixture(t);
  for (const route of ['/health?x=1', '/document?id=x&unknown=1', '/search?q=x&limit=1&limit=2',
    '/rag/health?q=x', '/rag/search?q=x&top_k=51', '/rag/search?q=x&top_k=01&top_k=1',
    '/rag/search?q=x&strategy=other', '/rag/search?q=x&unknown=1',
    '/rag/answer?q=x&strategy=hybrid', '/rag/search?q=%00', `/rag/search?q=${'x'.repeat(1001)}`]) {
    const res = await get(route, { headers: { 'x-request-id': 'contract-test-123' } });
    assert.equal(res.status, 400, route);
    const body = await res.json();
    assert.equal(body.requestId, 'contract-test-123');
    assert.equal(res.headers.get('x-request-id'), body.requestId);
    assert.equal(body.error.code, body.reasonCode);
    assert.equal(body.status, 'unavailable');
    assert.equal(body.abstained, true);
    assert.equal(body.evidenceSufficient, false);
    assert.deepEqual(body.claims, []);
    assert.deepEqual(body.citations, []);
    assert.deepEqual(body.results, []);
  }
  for (const route of ['/health?x=%GG', '/health?x=%FF', '//private-host/health',
    'http://private-host/health', '/health#private-fragment']) {
    const res = await rawGet(base, route);
    assert.equal(res.status, 400, route);
    assert.equal(JSON.parse(res.text).reasonCode, 'INVALID_REQUEST');
    assert.ok(!res.text.includes('private-'));
  }
  const withBody = await rawGet(base, '/health', { 'content-length': '1' }, 'x');
  assert.equal(withBody.status, 400);
  assert.equal(withBody.headers.connection, 'close');
  const tooLong = await rawGet(base, `/search?q=${'a'.repeat(16400)}`);
  assert.equal(tooLong.status, 414);
  assert.equal(JSON.parse(tooLong.text).reasonCode, 'REQUEST_TOO_LARGE');
  const generated = await get('/missing', { headers: { 'x-request-id': 'bad.id' } });
  const generatedBody = await generated.json();
  assert.notEqual(generatedBody.requestId, 'bad.id');
  assert.equal(generated.headers.get('x-request-id'), generatedBody.requestId);
  assert.equal((await get('/health')).status, 200);
});

test('运行配置拒绝非整数或越界数值，错误不打印环境内容', async (t) => {
  const dir = await temporary(t);
  for (const [name, value] of [
    ['ZHIXUAN_REQUEST_TIMEOUT_MS', '60001'], ['ZHIXUAN_REQUEST_TIMEOUT_MS', '1.5'],
    ['ZHIXUAN_RAG_MAX_CONCURRENT', '0'], ['ZHIXUAN_RAG_MAX_CONCURRENT', '33'],
    ['ZHIXUAN_LOCAL_MAX_CONCURRENT', ' '], ['ZHIXUAN_LOCAL_MAX_CONCURRENT', '33'],
    ['ZHIXUAN_MAX_UPSTREAM_BYTES', '2097153'], ['ZHIXUAN_MAX_UPSTREAM_BYTES', 'secret-invalid'],
  ]) {
    const result = await expectExit(launch(dir, 8765, { [name]: value }));
    assert.notEqual(result.code, 0);
    assert.ok(result.output.includes(name));
    assert.ok(!result.output.includes(dir));
    assert.doesNotMatch(result.output, /secret-invalid|do-not-print-fixture-secret|^\s+at\s/m);
  }
});

test('上游坏数据、超大响应和跳转均被拒绝，后续正常请求可恢复', async (t) => {
  const { get, state, base } = await ragFixture(t, { ZHIXUAN_MAX_UPSTREAM_BYTES: '1024' });
  let redirectedHits = 0;
  const target = createHttpServer((req, res) => { redirectedHits++; res.end('unexpected'); });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  t.after(() => { target.closeAllConnections(); return new Promise((resolve) => target.close(resolve)); });
  const cases = [
    ['type', 502, 'UPSTREAM_INVALID_RESPONSE', (res) => { res.setHeader('content-type', 'text/html'); res.end('private-error'); }],
    ['json', 502, 'UPSTREAM_INVALID_RESPONSE', (res) => { res.end('private-error'); }],
    ['array', 502, 'UPSTREAM_INVALID_RESPONSE', (res) => { res.end('[]'); }],
    ['null', 502, 'UPSTREAM_INVALID_RESPONSE', (res) => { res.end('null'); }],
    ['utf8', 502, 'UPSTREAM_INVALID_RESPONSE', (res) => { res.end(Buffer.from([0xff])); }],
    ['length', 502, 'UPSTREAM_RESPONSE_TOO_LARGE', (res) => { res.setHeader('content-length', '3000'); res.end('x'.repeat(3000)); }],
    ['stream', 502, 'UPSTREAM_RESPONSE_TOO_LARGE', (res) => { res.write('{"x":"'); res.write('x'.repeat(3000)); res.end('"}'); }],
    ['redirect', 502, 'UPSTREAM_REDIRECT', (res) => { res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/private-target` }); res.end(); }],
    ['upstream400', 400, 'INVALID_ARGUMENT', (res) => { res.writeHead(400); res.end('private-error'); }],
    ['upstream409', 409, 'RAG_INDEX_MISMATCH', (res) => { res.writeHead(409); res.end('private-error'); }],
    ['upstream429', 503, 'UPSTREAM_BUSY', (res) => { res.writeHead(429); res.end('private-error'); }],
    ['upstream503', 503, 'UPSTREAM_BUSY', (res) => { res.writeHead(503); res.end('private-error'); }],
    ['upstream500', 503, 'UPSTREAM_UNAVAILABLE', (res) => { res.writeHead(500); res.end('private-error'); }],
  ];
  for (const [label, status, reason, send] of cases) {
    state.handler = (req, res) => {
      if (req.url === '/health') return false;
      res.setHeader('content-type', 'application/json');
      send(res);
      return true;
    };
    const response = await get('/rag/search?q=test');
    assert.equal(response.status, status, label);
    const text = await response.text();
    assert.equal(JSON.parse(text).reasonCode, reason, label);
    assert.ok(!text.includes('private-'), label);
    assert.equal((await get('/health')).status, 200);
  }
  assert.equal(redirectedHits, 0);
  state.handler = (req, res) => {
    if (req.url !== '/health') return false;
    res.setHeader('content-type', 'application/json');
    res.write('{"x":"');
    res.end('x'.repeat(66000));
    return true;
  };
  assert.equal((await (await get('/rag/health')).json()).reasonCode, 'UPSTREAM_RESPONSE_TOO_LARGE');
  state.handler = null;
  assert.equal((await get('/rag/search?q=test')).status, 200);
  const disconnected = await rawGet(base, '/rag/search?q=test');
  assert.equal(disconnected.status, 200);
});

test('健康状态区分配置与最近核验；不向外传递上游配置和路径', async (t) => {
  const { get, state } = await ragFixture(t);
  let health = await (await get('/health')).json();
  assert.equal(health.rag.configured, true);
  assert.equal(health.rag.status, 'unverified');
  assert.equal(health.rag.checkedAt, null);
  state.healthExtra = { config: { secret: 'private-secret' }, root: 'private-root' };
  const probe = await get('/rag/health', { headers: { 'x-request-id': 'probe-test-123' } });
  assert.equal(probe.status, 200);
  const probeText = await probe.text();
  assert.ok(!probeText.includes('private-'));
  assert.equal(JSON.parse(probeText).probeScope, 'snapshot-and-query-service');
  assert.equal(state.calls.at(-1).requestId, 'probe-test-123');
  health = await (await get('/health')).json();
  assert.equal(health.rag.status, 'ready');
  assert.equal(health.rag.scope, 'last-observation-only');
  assert.ok(Date.parse(health.rag.checkedAt));
  state.healthExtra = { ready: false };
  const notReady = await get('/rag/health');
  assert.equal(notReady.status, 503);
  assert.equal((await notReady.json()).reasonCode, 'RAG_NOT_READY');
  assert.equal((await (await get('/health')).json()).rag.status, 'unavailable');
  state.healthExtra = { files: 1 };
  assert.equal((await get('/rag/health')).status, 409);
  assert.equal((await (await get('/health')).json()).rag.status, 'mismatch');
  state.healthExtra = {};
  assert.equal((await get('/rag/health')).status, 200);
  assert.equal((await (await get('/health')).json()).rag.status, 'ready');
});

test('健康探测、查询响应头和流式正文均受总超时约束，超时后释放容量', async (t) => {
  const { get, state } = await ragFixture(t, {
    ZHIXUAN_REQUEST_TIMEOUT_MS: '600', ZHIXUAN_RAG_MAX_CONCURRENT: '1',
  });
  for (const phase of ['health', 'headers', 'body']) {
    let disconnected = false;
    state.handler = (req, res) => {
      if (phase !== 'health' && req.url === '/health') return false;
      res.once('close', () => { disconnected = true; });
      if (phase === 'body') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"results":');
      }
      return true;
    };
    const started = performance.now();
    const response = await get(phase === 'health' ? '/rag/health' : '/rag/search?q=test');
    assert.equal(response.status, 504, phase);
    const body = await response.json();
    assert.equal(body.reasonCode, 'UPSTREAM_TIMEOUT');
    assert.equal(body.retryable, true);
    assert.equal(response.headers.get('retry-after'), '1');
    assert.ok(performance.now() - started < 2500);
    await until(() => disconnected, `${phase} upstream cancellation`);
    state.handler = null;
    await until(async () => (await (await get('/health')).json()).runtime.activeRag === 0, 'released timeout slot');
    assert.equal((await get('/rag/search?q=test')).status, 200);
  }
  const health = await (await get('/health')).json();
  assert.equal(health.runtime.timedOut, 3);
  assert.equal(health.runtime.activeRag, 0);
});

test('调用者断连会取消上游并释放槽位，本地健康仍可用', async (t) => {
  const { get, state } = await ragFixture(t, { ZHIXUAN_RAG_MAX_CONCURRENT: '1' });
  let entered = false;
  let disconnected = false;
  state.handler = (req, res) => {
    if (req.url === '/health') return false;
    entered = true;
    res.once('close', () => { disconnected = true; });
    return true;
  };
  const cancel = new AbortController();
  const pending = get('/rag/search?q=test', { signal: cancel.signal });
  const completed = Promise.allSettled([pending]);
  await until(() => entered, 'pending upstream request');
  assert.equal((await get('/health')).status, 200);
  cancel.abort();
  assert.equal((await completed)[0].status, 'rejected');
  await until(() => disconnected, 'upstream disconnected');
  await until(async () => (await (await get('/health')).json()).runtime.activeRag === 0, 'released cancelled slot');
  state.handler = null;
  assert.equal((await get('/rag/search?q=test')).status, 200);
  const health = await (await get('/health')).json();
  assert.equal(health.runtime.cancelled, 1);
  assert.equal(health.runtime.activeRag, 0);
});

test('结果范围、数量与去重均被核对；图片只检索路径，不冒充识别内容', async (t) => {
  const { get, entries, root, state } = await ragFixture(t);
  const doc = (await entries()).find((x) => x.path.includes('型号甲'));
  const source = await readFile(path.join(root, doc.path), 'utf8');
  const result = { ...doc, preview: source, start: 0, end: Array.from(source).length,
    root: 'private-root', token: 'private-token', documentUrl: 'http://private-host' };
  state.results = [result];
  let body = await (await get('/rag/search?q=test')).json();
  assert.equal(body.results[0].documentUrl, `/document?id=${doc.id}`);
  assert.ok(!JSON.stringify(body).includes('private-'));
  for (const override of [{ totalCandidates: 1 }, { returned: 2 }, { onlineUsed: true },
    { strategy: 'vector' }, { results: [result, result], returned: 2 }]) {
    state.resultExtra = override;
    const response = await get('/rag/search?q=test');
    assert.equal(response.status, 502);
    assert.equal((await response.json()).reasonCode, 'UPSTREAM_INVALID_RESPONSE');
  }
  state.resultExtra = {};
  const imageDoc = (await entries()).find((x) => x.path.endsWith('.png'));
  state.results = [{ ...imageDoc, preview: imageDoc.path, start: 0, end: 0 }];
  body = await (await get('/rag/search?q=test')).json();
  assert.equal(body.results[0].textIndexed, false);
  assert.equal(body.results[0].imageContentAnalyzed, false);
  state.results[0].preview = 'invented visual description';
  assert.equal((await get('/rag/search?q=test')).status, 409);
  state.results[0].preview = '';
  state.resultExtra = { strategy: 'exact' };
  assert.equal((await get('/rag/search?q=test&strategy=exact')).status, 200);
  const citation = { ...imageDoc, preview: imageDoc.path, start: 0, end: 0, number: 1, citationId: 1 };
  state.results = [citation];
  state.resultExtra = {
    status: 'answered', answer: `${imageDoc.path}[1]`, claims: [{ text: imageDoc.path, citationIds: [1], kind: 'source_fact' }],
    citations: [citation], conditions: [], evidenceSufficient: true, generationModelUsed: false, answerType: 'extractive',
  };
  const imageAnswer = await get('/rag/answer?q=test');
  assert.equal(imageAnswer.status, 502);
  assert.deepEqual((await imageAnswer.json()).claims, []);
});

test('原文片段边界兼容空片段、换行与表情，越过字符末尾明确拒绝', async (t) => {
  const source = '🧭\r\nA\rB\n🧪C';
  const { get, entries, state } = await ragFixture(t, {}, async (root) => {
    await writeFile(path.join(root, '字符边界.txt'), source);
  });
  const doc = (await entries()).find((x) => x.path === '字符边界.txt');
  const original = Array.from(source);
  for (const strategy of ['hybrid', 'exact']) {
    const upstream = Array.from(strategy === 'exact' ? source.replace(/\r\n|\r/g, '\n') : source);
    const boundaries = strategy === 'exact' ? [0, 1, 3, 4, 5, 6, 7, 8, 9] : original.map((_, i) => i).concat(original.length);
    state.resultExtra = { strategy };
    for (const [start, end] of [[0, 0], [0, 1], [1, 2], [2, 5], [5, upstream.length], [upstream.length, upstream.length]]) {
      state.results = [{ ...doc, start, end, preview: upstream.slice(start, end).join('') }];
      const response = await get(`/rag/search?q=test&strategy=${strategy}`);
      assert.equal(response.status, 200, `${strategy}:${start}-${end}`);
      const result = (await response.json()).results[0];
      assert.equal(result.start, boundaries[start]);
      assert.equal(result.end, boundaries[end]);
      assert.equal(result.preview, original.slice(boundaries[start], boundaries[end]).join(''));
    }
    state.results = [{ ...doc, start: 0, end: upstream.length + 1, preview: upstream.join('') }];
    assert.equal((await get(`/rag/search?q=test&strategy=${strategy}`)).status, 409);
  }
});

test('上游连接失败时明确不可用，随后恢复服务即可再次查询', async (t) => {
  const { get, state } = await ragFixture(t);
  state.handler = (req, res) => { res.destroy(); return true; };
  const response = await get('/rag/search?q=test');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).reasonCode, 'UPSTREAM_UNAVAILABLE');
  assert.equal((await get('/health')).status, 200);
  state.handler = null;
  assert.equal((await get('/rag/search?q=test')).status, 200);
});

test('超出最终传输上限时明确失败，不截断后伪报成功', async (t) => {
  const source = 'x'.repeat(1100000);
  const { get, entries, state } = await ragFixture(t, {}, async (root) => {
    await writeFile(path.join(root, '长资料.txt'), source);
  });
  const doc = (await entries()).find((x) => x.path === '长资料.txt');
  state.results = [{ ...doc, preview: source, start: 0, end: source.length }];
  const response = await get('/rag/search?q=test');
  assert.equal(response.status, 413, 'upstream fits 2 MiB, results + items exceed the adapter response bound');
  const body = await response.json();
  assert.equal(body.reasonCode, 'RESPONSE_TOO_LARGE');
  assert.deepEqual(body.results, []);
  assert.equal((await get(`/document?id=${doc.id}`)).status, 200);
});

test('来源累计回读有内存预算，超限拒绝且释放查询容量', async (t) => {
  const { get, entries, state } = await ragFixture(t, {}, async (root) => {
    const content = Buffer.alloc(33 * 1024 * 1024);
    await writeFile(path.join(root, 'large-a.bin'), content);
    await writeFile(path.join(root, 'large-b.bin'), content);
  });
  state.results = (await entries()).filter((x) => x.path.endsWith('.bin'))
    .map((doc) => ({ ...doc, preview: doc.path, start: 0, end: 0 }));
  const response = await get('/rag/search?q=test');
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.reasonCode, 'EVIDENCE_TOO_LARGE');
  assert.deepEqual(body.results, []);
  state.results = [];
  assert.equal((await get('/rag/search?q=test')).status, 200);
  const health = await (await get('/health')).json();
  assert.equal(health.runtime.activeRag, 0);
  assert.equal(health.limits.maxEvidenceBytes, 64 * 1024 * 1024);
});

test('单份超大文件在读取前拒绝，不静默跳过后宣称完整建库', async (t) => {
  const dir = await temporary(t);
  const filename = path.join(dir, 'too-large-private.bin');
  await writeFile(filename, '');
  await truncate(filename, 64 * 1024 * 1024 + 1);
  const result = await expectExit(launch(dir, await freePort()));
  assert.notEqual(result.code, 0);
  assert.match(result.output, /单份资料超过读取上限/);
  assert.ok(!result.output.includes(dir));
  assert.ok(!result.output.includes('too-large-private'));
});

test('按编号读取元数据只返回登记字段，并与原文摘要一致', async (t) => {
  const { get, entries, root } = await fixture(t);
  const health = await (await get('/health')).json();
  for (const doc of await entries()) {
    const response = await get(`/document/meta?id=${doc.id}`, { headers: { 'x-request-id': 'metadata-test-123' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.requestId, 'metadata-test-123');
    assert.equal(response.headers.get('x-request-id'), body.requestId);
    assert.equal(body.indexFingerprint, health.indexFingerprint);
    assert.equal(body.indexMode, 'snapshot');
    assert.equal(body.indexStale, false);
    assert.deepEqual(body.item, doc);
    assert.deepEqual(Object.keys(body.item).sort(), ['bytes', 'id', 'path', 'sha256', 'source', 'title']);
    assert.equal(body.items, undefined);
    assert.ok(!JSON.stringify(body).includes(root));
    const original = Buffer.from(await (await get(`/document?id=${doc.id}`)).arrayBuffer());
    assert.equal(hash(original), body.item.sha256);
    assert.equal(original.length, body.item.bytes);
  }
  for (const route of ['/document/meta', '/document/meta?id=', '/document/meta?id=x&id=x',
    '/document/meta?id=x&path=private', '/document/meta?path=private', '/document/meta?id=x&limit=1']) {
    const response = await get(route);
    assert.equal(response.status, 400, route);
    assert.deepEqual((await response.json()).items, []);
  }
  for (const id of ['f'.repeat(24), 'UNKNOWN', '../private-secret', 'C:\\private-secret']) {
    const response = await get(`/document/meta?id=${encodeURIComponent(id)}`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.reasonCode, 'DOCUMENT_NOT_FOUND');
    assert.equal(body.item, undefined);
    assert.ok(!JSON.stringify(body).includes('private-secret'));
  }
});

test('元数据不能以旧摘要证明已变化、删除或外链替换的来源', async (t) => {
  const { get, entries, root, dir } = await fixture(t);
  const docs = await entries();
  const changed = docs.find((doc) => doc.path.includes('型号甲'));
  const deleted = docs.find((doc) => doc.path.endsWith('.json'));
  const linked = docs.find((doc) => doc.path.includes('型号乙'));
  await writeFile(path.join(root, changed.path), 'changed-private-source');
  await rm(path.join(root, deleted.path));
  const outside = path.join(dir, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, '产品事实.md'), 'private-external-source');
  await rm(path.join(root, 'P1', '型号乙'), { recursive: true });
  await symlink(outside, path.join(root, 'P1', '型号乙'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const doc of [changed, deleted, linked]) {
    const response = await get(`/document/meta?id=${doc.id}`);
    assert.equal(response.status, 409);
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(body.reasonCode, 'INDEX_STALE');
    assert.equal(body.item, undefined);
    assert.ok(!text.includes('private-'));
    assert.ok(!text.includes(doc.sha256));
  }
  assert.equal((await get('/health')).status, 200);
});

test('整份目录超过2MiB时单份元数据与原文仍可读取，也可显式分页', async (t) => {
  const { get, base } = await fixture(t, async (root) => {
    const names = Array.from({ length: 1600 }, (_, i) => `${'资'.repeat(205)}-${String(i).padStart(4, '0')}.txt`);
    for (let i = 0; i < names.length; i += 32) {
      const completed = await Promise.allSettled(names.slice(i, i + 32).map((name) => writeFile(path.join(root, name), 'fixture')));
      for (const result of completed) assert.equal(result.status, 'fulfilled');
    }
  });
  const complete = await get('/documents');
  assert.equal(complete.status, 413);
  assert.equal((await complete.json()).reasonCode, 'RESPONSE_TOO_LARGE');
  const first = await (await get('/documents?limit=200&offset=0')).json();
  assert.equal(first.total, 1604);
  assert.equal(first.items.length, 200);
  assert.equal(first.nextOffset, 200);
  assert.equal(first.hasMore, true);
  const id = hash('数据.json').slice(0, 24);
  const metadata = await get(`/document/meta?id=${id}`);
  assert.equal(metadata.status, 200);
  const text = await metadata.text();
  assert.ok(Buffer.byteLength(text) < 2048);
  const doc = JSON.parse(text).item;
  const original = await (await get(`/document?id=${id}`)).text();
  assert.equal(hash(original), doc.sha256);
  assert.equal(doc.path, '数据.json');
  assert.ok(base.startsWith('http://127.0.0.1:'));
});

test('1000字中文和非BMP问题均完整转发，1001字符在适配器拒绝', async (t) => {
  const { get, state, base } = await ragFixture(t);
  state.handler = (req, res) => {
    if (req.url === '/health' || !req.url.startsWith('/answer?')) return false;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      verifiedSnapshot: verifiedSnapshot(state.binding),
      strategy: 'hybrid', indexFingerprint: state.binding.indexFingerprint, onlineUsed: false,
      totalCandidates: state.binding.files, returned: 0, results: [], citations: [], claims: [],
      status: 'insufficient_evidence', answer: '资料不足。', evidenceSufficient: false, conditions: [],
    }));
    return true;
  };
  for (const query of ['中'.repeat(1000), '🧪'.repeat(1000), '𠀀'.repeat(1000), '中🧪 '.repeat(333) + '文']) {
    assert.equal(Array.from(query).length, 1000);
    for (const endpoint of ['search', 'answer']) {
      const route = `/rag/${endpoint}?top_k=50&q=${encodeURIComponent(query)}${endpoint === 'search' ? '&strategy=hybrid' : ''}`;
      const response = await get(route);
      assert.equal(response.status, 200, `${endpoint}:${Buffer.byteLength(route)}`);
      await response.arrayBuffer();
      const upstream = new URL(state.calls.at(-1).url, base);
      assert.equal(upstream.pathname, `/${endpoint}`);
      assert.equal(upstream.searchParams.get('q'), query, 'no silent truncation or re-encoding loss');
    }
  }
  for (const query of ['中'.repeat(1001), '🧪'.repeat(1001)]) {
    const calls = state.calls.length;
    const response = await get(`/rag/search?q=${encodeURIComponent(query)}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).reasonCode, 'INVALID_REQUEST');
    assert.equal(state.calls.length, calls);
  }
  const response = await rawGet(base, `/rag/search?q=${'a'.repeat(16400)}`);
  assert.equal(response.status, 414);
  assert.equal(JSON.parse(response.text).reasonCode, 'REQUEST_TOO_LARGE');
  const health = await (await get('/health')).json();
  assert.equal(health.limits.maxUrlBytes, 16384);
  assert.equal(health.limits.maxHeaderBytes, 24576);
});
