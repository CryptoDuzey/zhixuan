import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { listChats } from '../lib/chat-history.ts';
const ts = createRequire(import.meta.url)('typescript');
const code = ts.transpileModule(readFileSync(new URL('../app/components/ChatHistory.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
// Run the entire real component and its rendered callbacks. Only host dialog,
// React hooks and network timing are controlled; no source-pattern assertions.
// This tests state/callback behavior, not browser layout or React scheduling.
function harness() {
  const hooks: any[] = [], effects: any[] = [], calls: any[] = [];
  let index = 0, dirty = true, tree: any, selected = '', created = 0, focused = 0;
  const props: any = { kind: 'agent', activeId: 'chat-000', onSelect: (id: string) => { selected = id; }, onNew: () => { created++; } };
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  const react = {
    useState(initial: any) {
      const i = index++;
      if (!hooks[i]) hooks[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[i].value, (update: any) => {
        const value = typeof update === 'function' ? update(hooks[i].value) : update;
        if (!Object.is(value, hooks[i].value)) { hooks[i].value = value; dirty = true; }
      }];
    },
    useRef(value: any) { const i = index++; return hooks[i] ??= { current: value }; },
    useEffect(setup: any, deps: any[]) {
      const i = index++, old = hooks[i];
      if (!old || deps.some((v, j) => !Object.is(v, old.deps[j]))) {
        effects.push(() => { old?.cleanup?.(); hooks[i] = { deps, setup, cleanup: setup() }; });
      }
    },
  };
  const jsx = (type: any, props: any) => ({ type, props: props ?? {} });
  const exports: any = {};
  vm.runInNewContext(code, { exports, AbortController, Set, encodeURIComponent,
    require: (name: string) => name === 'react' ? react : name === 'react/jsx-runtime' ? { jsx, jsxs: jsx, Fragment: 'fragment' } : {},
    fetch: (url: string, options: any) => new Promise((resolve, reject) => { calls.push({ url, signal: options.signal, resolve, reject }); }),
  });
  function walk(node: any, out: any[] = []): any[] {
    if (Array.isArray(node)) { node.forEach(n => walk(n, out)); return out; }
    if (!node || typeof node !== 'object') return out;
    out.push(node); walk(node.props?.children, out); return out;
  }
  function flush() {
    for (let count = 0; dirty || effects.length; count++) {
      assert.ok(count < 30, 'render must settle');
      if (dirty) {
        dirty = false; index = 0; tree = exports.default(props);
        for (const node of walk(tree)) if (node.props.ref) node.props.ref.current = node.type === 'dialog' ? dialog : { focus() { focused++; } };
      }
      effects.splice(0).forEach(effect => effect());
    }
  }
  const nodes = () => { flush(); return walk(tree); };
  const find = (predicate: (n: any) => boolean) => { const node = nodes().find(predicate); assert.ok(node, 'expected rendered control'); return node; };
  const label = (n: any): string => typeof n === 'string' ? n : Array.isArray(n) ? n.map(label).join('') : n && typeof n === 'object' ? label(n.props?.children) : '';
  const button = (text: string) => find(n => n.type === 'button' && label(n) === text);
  const click = (node: any) => { assert.ok(!node.props.disabled); node.props.onClick({}); flush(); };
  async function settle() { for (let i = 0; i < 3; i++) { await new Promise(resolve => setImmediate(resolve)); flush(); } }
  async function reply(index: number, payload: any, ok = true) { calls[index].resolve({ ok, json: async () => payload }); await settle(); }
  const rows = () => find(n => n.type === 'nav').props.children.filter(Boolean);
  flush();
  return { calls, nodes, find, button, click, label, flush, settle, reply, rows, props,
    open() { click(find(n => n.props['aria-label'] === '历史对话')); },
    cancel() { find(n => n.type === 'dialog').props.onCancel(); flush(); },
    search(value: string) { find(n => n.type === 'input').props.onChange({ target: { value } }); flush(); },
    unmount() { hooks.forEach(h => h.cleanup?.()); },
    get selected() { return selected; }, get created() { return created; }, get focused() { return focused; },
  };
}
const row = (id: string, kind = 'agent', title = id) => ({ id, kind, title, updatedAt: '2026-10-23T00:00:00.000Z', busy: false });

test('real API: both kinds append all 245 records beyond 200; search, selection and new remain usable', async t => {
  const root = mkdtempSync(join(tmpdir(), 'history-pagination-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  const directories = { agent: join(root, 'agent'), consult: join(root, 'consult') };
  for (const kind of ['agent', 'consult'] as const) {
    mkdirSync(directories[kind]);
    for (let i = 0; i < 245; i++) writeFileSync(join(directories[kind], `chat-${String(i).padStart(3, '0')}.json`), JSON.stringify({
      schema: 1, calls: [], busy: false, interrupted: false, updatedAt: '2026-10-23T00:00:00.000Z',
      ...(kind === 'agent' ? { session: { modelId: '', modelName: '' }, messages: [{ role: 'user', text: `chat-${String(i).padStart(3, '0')}` }] } : { turns: [{ question: `chat-${String(i).padStart(3, '0')}` }] }),
    }));
  }
  for (const kind of ['agent', 'consult'] as const) {
    const h = harness(); h.props.kind = kind; h.open();
    for (let page = 0; page < 7; page++) {
      const query = new URL(h.calls[page].url, 'http://test').searchParams;
      assert.equal(query.get('kind'), kind); assert.equal(query.get('limit'), '40');
      if (page) assert.ok(query.get('cursor'));
      const result = await listChats({ kind, limit: 40, ...(query.get('cursor') ? { cursor: query.get('cursor')! } : {}) }, directories);
      await h.reply(page, result);
      assert.equal(h.rows().length, Math.min((page + 1) * 40, 245));
      if (page < 6) h.click(h.button('查看更早对话'));
    }
    assert.equal(new Set(h.rows().map((n: any) => h.label(n))).size, 245);
    assert.ok(!h.nodes().some(n => n.props.className === 'history-more'));
    h.search('chat-244'); assert.equal(h.rows().length, 1);
    h.click(h.rows()[0]); assert.equal(h.selected, 'chat-244'); assert.equal(h.focused, 1);
    h.open(); h.click(h.find(n => n.props.className === 'history-new')); assert.equal(h.created, 1);
    assert.equal(h.calls.at(-1).signal.aborted, true); h.unmount();
  }
});

test('rapid duplicate clicks issue one request; overlap and within-page duplicates append once', async () => {
  const h = harness(); h.open();
  await h.reply(0, { items: [row('chat-000'), row('chat-000')], nextCursor: 'cursor+/?=' });
  assert.equal(h.rows().length, 1);
  const button = h.button('查看更早对话'); button.props.onClick(); button.props.onClick(); h.flush();
  assert.equal(h.calls.length, 2);
  assert.equal(new URL(h.calls[1].url, 'http://test').searchParams.get('cursor'), 'cursor+/?=');
  await h.reply(1, { items: [row('chat-000'), row('chat-001'), row('chat-001')], nextCursor: 'next' });
  assert.equal(h.rows().length, 2);
  button.props.onClick(); h.flush(); assert.equal(h.calls.length, 2, 'stale consumed cursor cannot fetch again');
});

test('failed append retains rows and search; retry repeats same cursor, then appends', async () => {
  const h = harness(); h.open(); await h.reply(0, { items: [row('chat-000')], nextCursor: 'page2' });
  h.search('chat-00'); h.click(h.button('查看更早对话'));
  await h.reply(1, {}, false); assert.equal(h.rows().length, 1);
  h.click(h.button('重试')); assert.equal(h.calls[1].url, h.calls[2].url);
  await h.reply(2, { items: [row('chat-001')] }); assert.equal(h.rows().length, 2);
  assert.equal(h.find(n => n.type === 'input').props.value, 'chat-00');
});

test('initial failure retry starts first page and valid empty page removes more button', async () => {
  const h = harness(); h.open(); h.calls[0].reject(new Error('offline')); await h.settle();
  h.click(h.button('重试')); assert.equal(h.calls[0].url, h.calls[1].url);
  await h.reply(1, { items: [], nextCursor: 'empty-next' }); h.click(h.button('查看更早对话'));
  await h.reply(2, { items: [] }); assert.equal(h.rows().length, 0);
  assert.ok(!h.nodes().some(n => n.props.className === 'history-more'));
});

test('cancel and reopen abort old request; late success/error/finally cannot overwrite new loading or rows', async () => {
  for (const lateFailure of [false, true]) {
    const h = harness(); h.open(); h.cancel(); assert.equal(h.calls[0].signal.aborted, true);
    h.open(); assert.equal(h.calls.length, 2);
    if (lateFailure) { h.calls[0].reject(new Error('late')); await h.settle(); }
    else await h.reply(0, { items: [row('stale-row')], nextCursor: 'stale' });
    assert.equal(h.find(n => n.props.className === 'history-list').props['aria-busy'], true);
    assert.equal(h.rows().length, 0);
    await h.reply(1, { items: [row('new-row')] }); assert.equal(h.rows().length, 1);
    assert.ok(h.label(h.rows()[0]).includes('new-row'));
    assert.ok(!h.nodes().some(n => n.props.role === 'alert'));
  }
});

test('switching kind cancels old page and prevents cross-kind history; unmount aborts request', async () => {
  const h = harness(); h.open(); await h.reply(0, { items: [row('agent-row')], nextCursor: 'agent-page2' });
  h.click(h.button('查看更早对话')); h.props.kind = 'consult';
  // Changing a parent prop causes a render, as React would.
  h.search(''); h.props.activeId = 'consult-row';
  // Force parent render via a changed input before restoring query.
  h.search('x'); h.search('');
  assert.equal(h.calls[1].signal.aborted, true); assert.equal(h.calls.length, 3);
  await h.reply(1, { items: [row('late-agent')] });
  await h.reply(2, { items: [row('consult-row', 'consult'), row('wrong-kind')] });
  assert.equal(h.rows().length, 1); assert.ok(h.label(h.rows()[0]).includes('consult-row'));
  h.cancel(); h.open(); h.unmount(); assert.equal(h.calls.at(-1).signal.aborted, true);
});

test('malformed and cycling cursors preserve previous page and allow retry', async () => {
  for (const nextCursor of ['', 123, 'page2', 'x'.repeat(513)]) {
    const h = harness(); h.open(); await h.reply(0, { items: [row('old-row')], nextCursor: 'page2' });
    h.click(h.button('查看更早对话')); await h.reply(1, { items: [row('bad-row')], nextCursor });
    assert.equal(h.rows().length, 1); assert.ok(h.label(h.rows()[0]).includes('old-row'));
    h.click(h.button('重试')); await h.reply(2, { items: [row('new-row')] }); assert.equal(h.rows().length, 2);
  }
});
