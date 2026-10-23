// Run from app: node --experimental-strip-types tests/agent-local-evidence.live.mjs
// Real POST -> default handleMessage; no HTTP listener, model mocks, or generated images.
import { readdir, readFile, realpath, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const root = fileURLToPath(new URL('../../', import.meta.url));
const kb = await realpath(path.join(root, 'kb/华为PC全板块深度知识库_v7'));
const out = process.env.AGENT_EFFECTS_OUT ? path.resolve(process.env.AGENT_EFFECTS_OUT) : path.join(root, 'output/iterations/verifier-coverage-guard-v2-20261021');
if (await readFile(path.join(out, 'agent-effects.json')).then(() => true, () => false)) throw new Error('Refusing to overwrite an earlier effect test');
await mkdir(out, { recursive: true });
const stamp = randomUUID();
process.env.IMA_BASE = 'http://127.0.0.1:8765';
process.env.ZHIXUAN_SESSION_DIR = path.join(out, 'agent-local-sessions', stamp);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const docs = new Map();
async function index(folder) {
  const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(folder, entry.name);
    const resolved = await realpath(full);
    const relativeCheck = path.relative(kb, resolved);
    if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) throw new Error('Unsafe KB path');
    if (entry.isDirectory()) { await index(full); continue; }
    if (!entry.isFile()) continue;
    const relative = path.relative(kb, full).split(path.sep).join('/');
    const bytes = await readFile(full);
    const id = sha(relative).slice(0, 24);
    if (docs.has(id)) throw new Error('Duplicate document ID');
    docs.set(id, { id, title: entry.name, path: relative, bytes: bytes.length, sha256: sha(bytes), source: '本地已下载知识库' });
  }
}
const report = {
  label: '真实模型+真实本地文件，通过进程内测试传输；并非服务/网页端到端',
  transport: '直接调用真实 POST 并实时消费应用 SSE ReadableStream；POST 调用默认 handleMessage；无监听端口',
  startedAt: new Date().toISOString(), repeats: 1,
  limitations: ['单次样本，规则判定不能替代人工语义评审', '没有验证真实 HTTP、浏览器或网络断线行为', '本地传输只实现 documents/document，未覆盖搜索服务及图片显示'],
  cases: [],
};
if (process.env.AGENT_FS_DIAGNOSTICS === '1') {
  report.storageFailures = [];
  for (const operation of ['writeFileSync', 'renameSync', 'mkdirSync']) {
    const original = fs[operation];
    fs[operation] = function (...args) {
      try { return Reflect.apply(original, fs, args); }
      catch (error) {
        report.storageFailures.push({ operation, code: error.code, syscall: error.syscall,
          pathLength: String(args[0]).length, bytes: operation === 'writeFileSync' ? Buffer.byteLength(args[1]) : undefined });
        throw error;
      }
    };
  }
  syncBuiltinESMExports();
}
let saveQueue = Promise.resolve();
function save() {
  const contents = JSON.stringify(report, null, 2);
  saveQueue = saveQueue.then(async () => {
    const target = path.join(out, 'agent-effects.json');
    await writeFile(`${target}.tmp`, contents);
    await rename(`${target}.tmp`, target);
  });
  return saveQueue;
}
await save();
await index(kb);
report.index = { files: docs.size, fingerprint: sha(`[${[...docs.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(d => `[${JSON.stringify(d.path)}, ${JSON.stringify(d.sha256)}]`).join(', ')}]`) };
const scope = new AsyncLocalStorage();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const item = scope.getStore();
  if (url.origin !== 'http://127.0.0.1:8765') {
    // Do not inspect/log credentials, headers, request bodies or API URLs.
    if (item) item.network.realFetch++;
    if (/multimodal-generation|images\/generations/.test(url.pathname)) {
      if (item) item.network.imageGenerationAttempts++;
      throw new Error('Image generation forbidden by this test');
    }
    return realFetch(input, init);
  }
  init?.signal?.throwIfAborted();
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (method !== 'GET') throw new Error('Read-only transport');
  if (item) item.network.localRequests.push({ route: url.pathname, id: url.searchParams.get('id') });
  if (url.pathname === '/documents') {
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? docs.size);
    const items = [...docs.values()].slice(offset, offset + limit);
    return Response.json({ source: '本地已下载知识库', indexMode: 'snapshot', indexFingerprint: report.index.fingerprint, indexedAt: report.startedAt, indexStale: false, total: docs.size, offset, limit, hasMore: offset + items.length < docs.size, nextOffset: offset + items.length < docs.size ? offset + items.length : null, items });
  }
  if (url.pathname === '/document') {
    const doc = docs.get(url.searchParams.get('id'));
    if (!doc) return Response.json({ error: 'DOCUMENT_NOT_FOUND' }, { status: 404 });
    const full = await realpath(path.join(kb, doc.path));
    const rel = path.relative(kb, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Unsafe KB path');
    const bytes = await readFile(full);
    if (sha(bytes) !== doc.sha256) throw new Error('KB changed during test');
    return new Response(bytes, { headers: { 'content-length': String(bytes.length), 'content-type': /\.(md|txt|csv)$/i.test(doc.path) ? 'text/plain; charset=utf-8' : 'application/octet-stream' } });
  }
  // Never connect to the rejected local service, including unsupported routes.
  throw new Error('Unsupported in-process KB route');
};

const { POST } = await import('../app/api/agent/route.ts');
const { sessionRepository } = await import('../lib/store.ts');
const { cancelRun } = await import('../lib/agent-runtime.ts');
const { getLlmCalls } = await import('../lib/llm.ts');
const sessionId = () => `local-${randomUUID()}`;
const creativeId = sessionId();
const specs = [
  { name: '普通问候与需求聊天', id: sessionId(), text: '你好，我想给新生做内容，但还没确定角度。先和我聊聊怎么了解他们的需求，不要现在写稿，也不用让我先选型号。', kind: 'chat' },
  { name: 'Pro S版本事实问答', id: sessionId(), text: '只依据现有知识库回答：HUAWEI MateBook Pro S 标准屏版和典藏版的重量、厚度分别是多少？请保留版本和实际配置限定，不要写营销稿。', kind: 'versions' },
  { name: '不支持的续航保证问答', id: sessionId(), text: 'HUAWEI MateBook Pro S 能保证连续重度办公20小时不充电吗？请直接回答能不能保证及资料依据，不写营销稿。', kind: 'battery' },
  { name: 'D14学生创作', id: creativeId, text: '为 HUAWEI MateBook D 14 给刚开学的大学生写一篇朋友圈文案，从整理课程资料和写小组报告切入，正文150到250字，语气像学长建议，少堆参数。只用现有图库，不生成图；没有合适图可以交文字。只依据本型号资料，不保证未经核实的软件适配和续航。', kind: 'create' },
  { name: '同会话自然改稿', id: creativeId, text: '这版有点像广告。改得像学长在宿舍聊天，开头用“开学第二周”，只聚焦小组报告，正文缩到120字以内，去掉参数堆砌，保留必要限定。只用现有图库，不生成图。', kind: 'revise' },
];
let activeSpecs = specs;
if (process.env.AGENT_REVISE_REPLAY) {
  const source = JSON.parse(await readFile(process.env.AGENT_REVISE_REPLAY, 'utf8'));
  const failedRevision = source.cases.find(item => item.name === '同会话自然改稿');
  if (!failedRevision?.before?.session?.draft || !failedRevision.input) throw new Error('Missing fixed revision input');
  activeSpecs = Array.from({ length: 3 }, (_, index) => {
    const id = sessionId();
    const saved = sessionRepository.get(id);
    Object.assign(saved, structuredClone(failedRevision.before), { busy: false, interrupted: false });
    delete saved.run;
    sessionRepository.save(id);
    return { name: `固定失败改稿回放${index + 1}`, id, text: failedRevision.input, kind: 'revise' };
  });
  report.repeats = 3;
  report.replay = 'Same saved pre-revision session and original instruction; no replacement of the 120-character criterion';
} else if (process.env.AGENT_EFFECTS_FILTER) {
  const selected = specs.find(item => item.kind === process.env.AGENT_EFFECTS_FILTER);
  if (!selected) throw new Error('Unknown effect scenario');
  activeSpecs = Array.from({ length: 3 }, (_, index) => ({ ...selected, id: sessionId(), name: `${selected.name}${index + 1}` }));
  report.repeats = 3;
}
report.criteria = {
  common: 'HTTP响应200、done completed且busy=false、无error、至少一次真实模型请求、捕获model_progress；不得生成图',
  chat: '有自然回复，无草稿或强制型号澄清',
  versions: '回复同时含798/825克、11.9/12.2毫米、标准屏/典藏版和实际配置限定',
  battery: '明确不能保证/无依据，不能作20小时保证',
  create: 'D14草稿150至250字、学生场景、核验报告版本匹配、引用有效、仅图库图片；至少两个非空预览先于done',
  revise: '同一完整持久会话，版本加一、正文变化且不超120字、以开学第二周开头、小组报告场景、重新核验、图库图片不变；至少两个预览先于done',
};
if (process.env.AGENT_FACT_BOUNDARY_GATES === '1') report.criteria.factBoundary = '不把接口存在推成少带转接器/屏幕推成更顺；不为指定产品虚构半天或一天一充计划；并逐条人工读评';
await save();
async function run(spec) {
  const started = Date.now();
  const item = { name: spec.name, input: spec.text, sessionId: spec.id, status: 'running', network: { realFetch: 0, imageGenerationAttempts: 0, localRequests: [] }, events: [], checks: {} };
  report.cases.push(item);
  await save();
  return scope.run(item, async () => {
    let timer;
    const previous = sessionRepository.find(spec.id);
    item.before = previous ? structuredClone(previous) : null;
    try {
      const response = await POST(new Request('http://in-process.invalid/api/agent', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ sessionId: spec.id, message: spec.text }) }));
      item.httpStatus = response.status;
      timer = setTimeout(() => { const rec = sessionRepository.find(spec.id); if (rec?.run) cancelRun(spec.id, rec.run.id); }, spec.kind === 'create' ? 160000 : 110000);
      if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream')) throw new Error('POST did not return successful SSE response');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = frame.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n');
          if (data) item.events.push({ receivedMs: Date.now() - started, ...JSON.parse(data) });
        }
        if (done) break;
      }
      if (buffer.trim()) throw new Error('Incomplete SSE frame');
      const record = sessionRepository.find(spec.id);
      item.after = structuredClone(record);
      const state = record?.session;
      const final = item.events.findLast(e => e.type === 'done');
      const doneIndex = item.events.findIndex(e => e.type === 'done');
      const previews = item.events.filter((e, n) => n < doneIndex && e.type === 'model_preview' && e.status === 'generating' && e.text?.trim());
      const reply = item.events.filter(e => e.type === 'notice').map(e => e.text).join('\n');
      item.output = { reply, draft: state?.draft, report: state?.report };
      Object.assign(item.checks, { response: response.status === 200, completed: final?.run?.status === 'completed' && record?.busy === false, noError: !item.events.some(e => e.type === 'error'), realModel: item.network.realFetch > 0, progress: item.events.some(e => e.type === 'model_progress'), noGeneration: item.network.imageGenerationAttempts === 0 && !(state?.supplementaryImages?.length) });
      if (spec.kind === 'chat') Object.assign(item.checks, { naturalReply: reply.trim().length > 10, noDraft: !state?.draft, noClarify: !item.events.some(e => e.type === 'clarify') });
      if (spec.kind === 'versions') Object.assign(item.checks, { weights: /798/.test(reply) && /825/.test(reply), thickness: /11\.9/.test(reply) && /12\.2/.test(reply), versions: /标准屏/.test(reply) && /典藏/.test(reply), qualification: /实际|配置|销售版本|测量/.test(reply) });
      if (spec.kind === 'battery') Object.assign(item.checks, { refusesGuarantee: /不能保证|无法保证|不保证|不能承诺|无法承诺|没有.*依据|没有.*支持|无.*依据/.test(reply), noPositiveGuarantee: !/(?:可以|能够|能|可)保证.{0,12}20小时/.test(reply) });
      if (spec.kind === 'battery' && process.env.AGENT_FACT_BOUNDARY_GATES === '1') {
        item.checks.noInventedChargingPlan = !/(?:按|规划|建议).{0,20}(?:半天|一天一充)|(?:半天|一天).{0,8}一充/.test(reply);
      }
      if (['create', 'revise'].includes(spec.kind)) {
        const draft = state?.draft;
        const evidenceIds = new Set(state?.evidence?.map(e => e.id));
        const imageIds = new Set(state?.images?.map(i => i.id));
        Object.assign(item.checks, { hasDraft: !!draft?.body?.trim(), rightModel: /D\s*14/i.test(state?.modelName ?? ''), currentReport: !!state?.report && state.report.draftVersion === draft?.version, claimsBound: !!draft?.claims?.length && draft.claims.every(c => c.factIds.length && c.factIds.every(id => evidenceIds.has(id))), onlyCatalogImages: !!draft && draft.images.every(i => imageIds.has(i.imageId)), multiplePreviewsBeforeDone: previews.length >= 2, studentScene: /小组|报告|课程|学生/.test(draft?.body ?? '') });
        item.qualityIssues = state?.report?.issues ?? [];
        if (process.env.AGENT_FACT_BOUNDARY_GATES === '1') item.checks.noUnsupportedEffects = !/(?:能|可以|会).{0,4}少带转接器|少(?:带|用|折腾).{0,6}转接|(?:文档|表格).{0,8}更顺/.test(draft?.body ?? '');
        if (spec.kind === 'create') item.checks.bodyLength = !!draft && [...draft.body].length >= 150 && [...draft.body].length <= 250;
        else Object.assign(item.checks, { priorDraft: !!item.before?.session?.draft, versionAdvanced: draft?.version === (item.before?.session?.draft?.version ?? -2) + 1, changed: draft?.body !== item.before?.session?.draft?.body, shortBody: !!draft && [...draft.body].length <= 120, requestedOpening: /^开学第二周/.test(draft?.body?.trim() ?? ''), imagesRetained: JSON.stringify(draft?.images) === JSON.stringify(item.before?.session?.draft?.images) });
      }
      item.previewCount = previews.length;
      item.status = Object.values(item.checks).every(Boolean) ? 'passed' : 'failed';
    } catch (error) {
      item.status = 'failed';
      // Intentionally retain only error class, never raw network/config error text.
      item.failure = { kind: error?.name ?? 'Error' };
      item.after = structuredClone(sessionRepository.find(spec.id) ?? null);
    } finally {
      clearTimeout(timer);
      // The global call log overlaps under concurrency; per-case authoritative counts come from emitted tool events.
      item.modelCalls = { started: item.events.filter(e => e.type === 'tool' && e.tool === 'model' && e.status === 'started').length, completed: item.events.filter(e => e.type === 'tool' && e.tool === 'model' && e.status === 'completed').length, failed: item.events.filter(e => e.type === 'tool' && e.tool === 'model' && e.status === 'failed').length };
      item.ms = Date.now() - started;
      process.stdout.write(`${item.name} ${item.status === 'passed' ? '成功' : '失败'} ${item.ms}ms\n`);
      await save();
    }
  });
}
try {
  if (process.env.AGENT_REVISE_REPLAY || process.env.AGENT_EFFECTS_FILTER) {
    for (const item of activeSpecs) await run(item);
    report.executionErrors = [];
  } else {
    const outcomes = await Promise.allSettled(specs.slice(0, 4).map(run));
    report.executionErrors = outcomes.filter(x => x.status === 'rejected').map(() => 'scenario recording failed');
    await run(specs[4]);
  }
} finally {
  globalThis.fetch = realFetch;
  report.endedAt = new Date().toISOString();
  report.modelCalls = getLlmCalls().map(({ model, purpose, ok, ms, attempt }) => ({ model, purpose, ok, ms, attempt }));
  report.passed = report.cases.length === activeSpecs.length && report.cases.every(c => c.status === 'passed') && !report.executionErrors?.length;
  await save();
  if (!report.passed) process.exitCode = 1;
}
