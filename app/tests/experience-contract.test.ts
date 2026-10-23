import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { listChats } from '../lib/chat-history.ts';
const ts = createRequire(import.meta.url)('typescript');
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const studio = read('../app/components/Studio.tsx'), consult = read('../app/consult/page.tsx'), history = read('../app/components/ChatHistory.tsx');
// Extract and execute actual function bodies. No React scheduling or layout engine.
function execute(source: string, name: string, state: Record<string, any>) {
  const tree = ts.createSourceFile('review.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: any;
  function walk(n: any) { if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n; ts.forEachChild(n, walk); }
  walk(tree); assert.ok(found);
  const code = ts.transpileModule(found.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = vm.createContext(state); vm.runInContext(code, context);
  return (...args: any[]) => context[name](...args);
}
function events() {
  const state: any = { workspace: false, view: null, receivePreviewEvent: () => true, parseAgentRun: () => undefined,
    setWorkspaceOpen: (v: boolean) => { state.workspace = v; }, setModelProgress() {}, failedRef: { current: false },
    runRef: { current: { updated: false } }, push() {}, setView: (v: any) => { state.view = typeof v === 'function' ? v(state.view) : v; } };
  return { state, event: execute(studio, 'onEvent', state) };
}
test('CONTROL: ordinary chat and clarification keep fresh workspace closed', () => {
  const { state, event } = events();
  event({ type: 'need', need: { intent: 'chat', next_action: 'write' } });
  event({ type: 'need', need: { intent: 'create', next_action: 'clarify' } });
  event({ type: 'done', view: { evidence: [], images: [] } });
  assert.equal(state.workspace, false);
});
test('REGRESSION: failed writing closes empty workspace before next ordinary chat', () => {
  const { state, event } = events();
  event({ type: 'need', need: { intent: 'create', next_action: 'write' } });
  event({ type: 'error', text: '写稿失败' });
  event({ type: 'done', view: { evidence: [], images: [] } });
  event({ type: 'need', need: { intent: 'chat', next_action: 'clarify' } });
  event({ type: 'done', view: { evidence: [], images: [] } });
  assert.equal(state.workspace, false); assert.equal(state.view.draft, undefined);
  assert.match(studio, /\{draft \? <button className="canvas-toggle"/);
});
test('REGRESSION: reset consultation and select new product clear previous platform', () => {
  const state: any = { platform: '朋友圈', selected: null, turns: [{ question: '新问题' }], timer: { current: undefined },
    requests: { current: { cancel() {} } }, clearPreview() {}, generation: { current: 1 }, sid: { current: 'old-id' },
    newStudioId: () => 'new-id', saveId() {}, pending: { current: false }, cancelPending: { current: false },
    saveTurns() {}, writeStorage() {}, browserStorage() {}, CONSULT_SESSION_KEY: 'legacy', field: { current: null }, clearTimeout };
  for (const m of consult.matchAll(/\b(set[A-Z]\w*)\(/g)) state[m[1]] = () => {};
  state.setPlatform = (v: string) => { state.platform = v; };
  state.setSelected = (v: any) => { state.selected = v; };
  execute(consult, 'reset', state)(); execute(consult, 'choose', state)({ creativeModelId: 'd14' }, 0);
  assert.equal(state.platform, '');
});
test('REGRESSION: history appends beyond 200 using the API next page', async t => {
  const root = mkdtempSync(join(tmpdir(), 'experience-review-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  const directories = { agent: join(root, 'agent'), consult: join(root, 'consult') };
  mkdirSync(directories.agent); mkdirSync(directories.consult);
  for (let i = 0; i < 201; i++) writeFileSync(join(directories.agent, `chat-${String(i).padStart(4, '0')}.json`), JSON.stringify({
    schema: 1, session: { modelId: '', modelName: '' }, messages: [{ role: 'user', text: `问题${i}` }], calls: [],
    busy: false, interrupted: false, updatedAt: '2026-10-23T00:00:00.000Z' }));
  const first = await listChats({ kind: 'agent', limit: 200 }, directories);
  assert.equal(first.items.length, 200); assert.ok(first.nextCursor);
  assert.equal((await listChats({ kind: 'agent', limit: 200, cursor: first.nextCursor }, directories)).items.length, 1);
  const state: any = { kind: 'agent', request: { current: null }, failedCursor: { current: undefined },
    consumedCursors: { current: new Set() }, AbortController, encodeURIComponent, Set,
    fetch: async (url: string) => {
      const query = new URL(url, 'http://test').searchParams;
      assert.equal(query.get('cursor'), first.nextCursor);
      assert.equal(query.get('kind'), 'agent');
      return { ok: true, json: async () => listChats({ kind: 'agent', limit: Number(query.get('limit')), cursor: query.get('cursor')! }, directories) };
    }, items: first.items, nextCursor: first.nextCursor, setLoading() {}, setError(v: string) { assert.equal(v, ''); } };
  state.setItems = (update: any) => { state.items = update(state.items); };
  state.setNextCursor = (cursor: string | undefined) => { state.nextCursor = cursor; };
  await execute(history, 'loadPage', state)(first.nextCursor);
  assert.equal(state.items.length, 201);
  assert.equal(new Set(state.items.map((item: any) => item.id)).size, 201);
  assert.equal(state.nextCursor, undefined);
});
test('CONTROL: existing draft remains visible after failed revision and ordinary chat', () => {
  const { state, event } = events();
  const draft = { title: '保留原稿', version: 1 };
  event({ type: 'draft', draft });
  event({ type: 'error', text: '改稿失败' });
  event({ type: 'done', view: { draft, evidence: [], images: [] } });
  event({ type: 'need', need: { intent: 'chat', next_action: 'clarify' } });
  event({ type: 'done', view: { draft, evidence: [], images: [] } });
  assert.equal(state.workspace, true);
  assert.equal(state.view.draft, draft);
});
test('REGRESSION: fractional split stays precise and actual drag handler is connected', () => {
  const state: any = { width: 28, setSplit: (v: number) => { state.width = v; }, writeStorage() {}, browserStorage() {}, String, Math };
  // Preference precision only; clamped pointer geometry is checked separately.
  execute(studio, 'resizeWorkspace', state)(286 / 900 * 100);
  assert.equal(state.width, 31.7778);
  assert.match(studio, /minmax\(280px, \$\{split\}fr\) 12px minmax\(360px/);
  assert.match(studio, /onPointerMove=\{moveWorkspaceDrag\}/);
});
test('CONTROL: resize only saves preference, no model request', () => {
  let saved = '';
  execute(studio, 'resizeWorkspace', { Math, String, setSplit() {}, browserStorage() {}, writeStorage: (_: any, k: string) => { saved = k; } })(50);
  assert.equal(saved, 'zhixuan.workspace.split.v1');
});
