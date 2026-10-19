import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { GET, POST } from '../app/api/settings/route.ts';
import { chat, getLlmCalls } from '../lib/llm.ts';
import { fetchModelGateway, getModelSettings, normalizeBaseUrl } from '../lib/model-settings.ts';

// Isolate persisted settings and use fake credentials. No real gateway requests.
const originalDirectory = process.cwd();
const originalEnvironment = {
  OPENAI_NEXT_API_KEY: process.env.OPENAI_NEXT_API_KEY,
  LLM_BASE_URL: process.env.LLM_BASE_URL,
  LLM_MODELS: process.env.LLM_MODELS,
};
const directory = mkdtempSync(join(tmpdir(), 'model-settings-'));
process.chdir(directory);
after(() => {
  process.chdir(originalDirectory);
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});
beforeEach(() => {
  process.env.OPENAI_NEXT_API_KEY = 'offline-server-key';
  process.env.LLM_BASE_URL = 'https://gateway.example/v1/chat/completions';
  process.env.LLM_MODELS = 'fallback-a,fallback-b';
  rmSync(join(directory, 'data'), { recursive: true, force: true });
  getLlmCalls().length = 0;
});

function request(body?: unknown, headers: Record<string, string> = {}, url = 'http://localhost:3100/api/settings') {
  return new Request(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { host: new URL(url).host, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('GET exposes only public fields and never the key', async () => {
  const response = await GET(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    baseUrl: 'https://gateway.example/v1', model: 'fallback-a', configured: true,
  });
  delete process.env.OPENAI_NEXT_API_KEY;
  assert.equal((await (await GET(request())).json()).configured, false);
});

test('base URL accepts both endpoint forms, HTTPS and loopback HTTP', () => {
  for (const suffix of ['/v1', '/v1/', '/v1/chat/completions', '/v1/chat/completions/']) {
    assert.equal(normalizeBaseUrl(`https://gateway.example${suffix}`), 'https://gateway.example/v1');
  }
  for (const host of ['localhost', '127.0.0.1', '127.0.0.2', '[::1]']) {
    assert.equal(normalizeBaseUrl(`http://${host}:9000/v1`), `http://${host}:9000/v1`);
  }
  for (const value of [
    'http://gateway.example/v1', 'http://192.168.1.2/v1', 'ftp://gateway.example/v1',
    'https://user:secret@gateway.example/v1', 'https://gateway.example/v1?key=secret',
    'https://gateway.example/v1?', 'https://gateway.example/v1#secret', 'invalid-secret',
  ]) {
    assert.throws(() => normalizeBaseUrl(value), (error: Error) => !error.message.includes('secret'));
  }
});

test('settings reject non-loopback hosts and cross-origin POSTs before any gateway call', async (t) => {
  const transport = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });
  for (const url of ['http://evil.example/api/settings', 'http://192.168.1.2/api/settings']) {
    assert.equal((await GET(request(undefined, {}, url))).status, 403);
    assert.equal((await POST(request({ action: 'models' }, {}, url))).status, 403);
  }
  const rejectedHeaders: Record<string, string>[] = [
    { origin: 'https://evil.example' }, { origin: 'null' }, { origin: 'http://localhost:3101' },
    { origin: 'http://127.0.0.1:3100' }, { host: 'evil.example' }, { 'sec-fetch-site': 'cross-site' },
  ];
  for (const headers of rejectedHeaders) {
    assert.equal((await POST(request({ action: 'models' }, headers))).status, 403);
  }
  assert.equal(transport.mock.callCount(), 0);
});

test('models uses the real list format once, reuses blank keys, and puts GPT first', async (t) => {
  const transport = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'https://gateway.example/v1/models');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer offline-server-key');
    assert.equal(init?.redirect, 'error');
    return Response.json({ data: [
      { id: 'claude-a' }, { id: 'gpt-b' }, { id: 'gpt-a' }, { id: 'gpt-b' },
      { id: '' }, { id: 5 }, { id: 'offline-server-key' },
    ] });
  });
  const response = await POST(request({ action: 'models', apiKey: '   ' }, { origin: 'http://localhost:3100' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { models: ['gpt-a', 'gpt-b', 'claude-a'] });
  assert.equal(transport.mock.callCount(), 1);
});

test('models also accepts a gateway returning a direct array of IDs', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json([{ id: 'claude-a' }, { id: 'vendor/gpt-a' }]));
  assert.deepEqual(await (await POST(request({ action: 'models' }))).json(), { models: ['vendor/gpt-a', 'claude-a'] });
});

test('test makes one small request and does not return raw gateway content', async (t) => {
  const transport = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'https://gateway.example/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'gpt-test');
    assert.ok(body.max_tokens <= 32);
    return Response.json({ choices: [{ message: { content: 'OK offline-server-key' } }] });
  });
  const response = await POST(request({ action: 'test', model: 'gpt-test' }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.model, 'gpt-test');
  assert.equal(typeof body.message, 'string');
  assert.ok(!JSON.stringify(body).includes('offline-server-key'));
  assert.equal(transport.mock.callCount(), 1);
  assert.throws(() => readFileSync(join(directory, 'data/private/model-settings.json')));
});

test('gateway errors do not leak upstream bodies or trigger retries', async (t) => {
  const transport = t.mock.method(globalThis, 'fetch', async () => new Response('secret upstream offline-server-key', { status: 401 }));
  const response = await POST(request({ action: 'test', model: 'gpt-test' }));
  const body = await response.json();
  assert.equal(response.status, 401);
  assert.equal(body.ok, false);
  assert.equal(body.model, 'gpt-test');
  assert.match(body.message, /401/);
  assert.ok(!JSON.stringify(body).includes('offline-server-key'));
  assert.ok(!JSON.stringify(body).includes('secret upstream'));
  assert.equal(transport.mock.callCount(), 1);
});

test('malformed JSON, invalid payloads and missing keys fail without network access', async (t) => {
  const transport = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });
  const malformed = new Request('http://localhost:3100/api/settings', {
    method: 'POST', headers: { host: 'localhost:3100', 'content-type': 'application/json' }, body: '{',
  });
  assert.equal((await POST(malformed)).status, 400);
  for (const body of [null, [], { action: 'unknown' }, { action: 'save', apiKey: 12 }, { action: 'test', model: '\nkey' }]) {
    assert.equal((await POST(request(body))).status, 400);
  }
  delete process.env.OPENAI_NEXT_API_KEY;
  assert.equal((await POST(request({ action: 'models' }))).status, 400);
  assert.equal(transport.mock.callCount(), 0);
});

test('keys cannot be placed into public model or URL fields', async (t) => {
  const transport = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });
  for (const body of [
    { action: 'test', model: 'offline-server-key' },
    { action: 'save', baseUrl: 'https://gateway.example/offline-server-key' },
    { action: 'save', apiKey: 'new-key', model: 'new-key' },
    { action: 'save', apiKey: 'key\ninjection' },
  ]) {
    const response = await POST(request(body));
    assert.equal(response.status, 400);
    assert.ok(!(await response.text()).includes('offline-server-key'));
  }
  assert.equal(transport.mock.callCount(), 0);
});

test('invalid gateway JSON and empty model replies have safe errors', async (t) => {
  let gatewayBody: Response = new Response('not JSON offline-server-key');
  const transport = t.mock.method(globalThis, 'fetch', async () => gatewayBody);
  for (const response of [
    new Response('not JSON offline-server-key'), Response.json(null),
    Response.json({ choices: [{ message: { content: '' } }] }),
  ]) {
    gatewayBody = response;
    const result = await POST(request({ action: 'test', model: 'gpt-test' }));
    assert.equal(result.status, 502);
    assert.ok(!(await result.text()).includes('offline-server-key'));
  }
  gatewayBody = Response.json({ error: 'offline-server-key' });
  const response = await POST(request({ action: 'models' }));
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('offline-server-key'));
  assert.equal(transport.mock.callCount(), 4);
});

test('timeouts abort one request and do not leak network exception details', async (t) => {
  const transport = t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('offline-server-key aborted')), { once: true });
  }));
  await assert.rejects(fetchModelGateway(getModelSettings(), 'models', {}, 5), (error: Error & { status?: number }) => {
    assert.equal(error.status, 504);
    assert.ok(!error.message.includes('offline-server-key'));
    return true;
  });
  assert.equal(transport.mock.callCount(), 1);
});

test('save persists locally, never returns a key, and chat immediately uses it', async (t) => {
  const response = await POST(request({
    action: 'save', baseUrl: 'https://saved.example/v1/chat/completions', apiKey: 'offline-saved-key', model: 'gpt-saved',
  }));
  assert.equal(response.status, 200);
  const publicSettings = await response.json();
  assert.ok(!JSON.stringify(publicSettings).includes('offline-saved-key'));
  const saved = JSON.parse(readFileSync(join(directory, 'data/private/model-settings.json'), 'utf8'));
  assert.equal(saved.apiKey, 'offline-saved-key');
  assert.equal(getModelSettings().model, 'gpt-saved');
  const transport = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'https://saved.example/v1/chat/completions');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer offline-saved-key');
    assert.equal(JSON.parse(String(init?.body)).model, 'gpt-saved');
    return Response.json({ choices: [{ message: { content: 'saved reply' } }] });
  });
  assert.deepEqual(await chat([{ role: 'user', content: 'hi' }], { purpose: 'offline settings test' }), { text: 'saved reply', model: 'gpt-saved' });
  assert.equal(transport.mock.callCount(), 1);
  await POST(request({ action: 'save', model: 'gpt-updated', apiKey: '' }));
  assert.equal(getModelSettings().apiKey, 'offline-saved-key');
  assert.equal(getModelSettings().model, 'gpt-updated');
  assert.deepEqual(await (await GET(request())).json(), { baseUrl: 'https://saved.example/v1', model: 'gpt-updated', configured: true });
  // A fresh process must recover from the saved file without access to this module's state.
  const moduleUrl = pathToFileURL(join(originalDirectory, 'lib/model-settings.ts')).href;
  const restarted = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
    `import { getModelSettings, publicModelSettings } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(publicModelSettings(getModelSettings())));`,
  ], { cwd: directory, encoding: 'utf8', env: { ...process.env, OPENAI_NEXT_API_KEY: '' } });
  assert.equal(restarted.status, 0);
  assert.deepEqual(JSON.parse(restarted.stdout), { baseUrl: 'https://saved.example/v1', model: 'gpt-updated', configured: true });
});

test('saved model leads the unchanged environment fallback chain', async () => {
  await POST(request({ action: 'save', model: 'gpt-preferred' }));
  assert.deepEqual(getModelSettings().models, ['gpt-preferred', 'fallback-a', 'fallback-b']);
});

test('chat keeps two attempts per model and advances through the environment fallback chain', async (t) => {
  const attempted: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    const model = JSON.parse(String(init?.body)).model;
    attempted.push(model);
    if (model === 'fallback-a') return new Response('offline-server-key upstream body', { status: 503 });
    return Response.json({ choices: [{ message: { content: 'fallback works' } }] });
  });
  assert.deepEqual(await chat([{ role: 'user', content: 'hi' }], { purpose: 'offline fallback test' }), {
    text: 'fallback works', model: 'fallback-b',
  });
  assert.deepEqual(attempted, ['fallback-a', 'fallback-a', 'fallback-b']);
  assert.ok(!JSON.stringify(getLlmCalls()).includes('offline-server-key'));
  assert.ok(!JSON.stringify(getLlmCalls()).includes('upstream body'));
});

test('LLM failure logs never store raw network errors or gateway bodies', async (t) => {
  const transport = t.mock.method(globalThis, 'fetch', async () => { throw new Error('secret upstream offline-server-key'); });
  await assert.rejects(chat([{ role: 'user', content: 'hi' }], { purpose: 'offline failure test', models: ['fallback-a'] }), (error: Error) => {
    assert.ok(!error.message.includes('offline-server-key'));
    assert.ok(!error.message.includes('secret upstream'));
    return true;
  });
  assert.equal(transport.mock.callCount(), 2);
  assert.ok(!JSON.stringify(getLlmCalls()).includes('offline-server-key'));
  assert.ok(!JSON.stringify(getLlmCalls()).includes('secret upstream'));
});

test('quota failures stop after one call and expose only an actionable safe message', async (t) => {
  const transport = t.mock.method(globalThis, 'fetch', async () => Response.json({
    error: { code: 'pre_consume_token_quota_failed', message: '令牌[offline-server-key]额度不足 secret upstream' },
  }, { status: 403 }));
  await assert.rejects(chat([{ role: 'user', content: '实际产品问题' }], { purpose: 'quota test' }),
    (error: Error & { code?: string; status?: number }) => {
      assert.equal(error.status, 403);
      assert.equal(error.code, 'quota_exhausted');
      assert.match(error.message, /额度不足.*模型设置/);
      assert.doesNotMatch(error.message, /offline-server-key|secret upstream/);
      return true;
    });
  assert.equal(transport.mock.callCount(), 1);
  assert.equal(getLlmCalls().length, 1);
  assert.doesNotMatch(JSON.stringify(getLlmCalls()), /offline-server-key|secret upstream/);
});

test('model permission rejection advances without retrying the same model', async (t) => {
  const attempted: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const model = JSON.parse(String(init?.body)).model;
    attempted.push(model);
    return model === 'fallback-a' ? Response.json({ error: { code: 'model_not_allowed' } }, { status: 403 })
      : Response.json({ choices: [{ message: { content: 'allowed model reply' } }] });
  });
  const result = await chat([{ role: 'user', content: 'hello' }], { purpose: 'permission test' });
  assert.equal(result.model, 'fallback-b');
  assert.deepEqual(attempted, ['fallback-a', 'fallback-b']);
});
