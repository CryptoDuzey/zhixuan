import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { workspacePointerSplit, watchWorkspaceBreakpoint, WORKSPACE_DIVIDER } from '../app/components/workspace-split.ts';
const ts = createRequire(import.meta.url)('typescript');
const source = readFileSync(new URL('../app/components/Studio.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('Studio.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['resizeWorkspace', 'startWorkspaceDrag', 'moveWorkspaceDrag', 'endWorkspaceDrag', 'cancelWorkspaceDrag'];
const bodies: string[] = [];
function walk(n: any) { if (ts.isFunctionDeclaration(n) && names.includes(n.name?.text)) bodies.push(n.getText(tree)); ts.forEachChild(n, walk); }
walk(tree);
assert.equal(bodies.length, 5);
const left = (w: number, s: number) => Math.max(280, Math.min(w - 372, (w - 12) * s / 100));
function fixture(w = 1280, initial = 40, grab = 6) {
  let width = w, split = initial, narrow = false;
  const writes: string[] = [], captures = new Set<number>();
  const listeners = new Set<() => void>();
  const ref = { current: null as any };
  const target = { getBoundingClientRect: () => ({ left: 137 + left(width, split) }),
    setPointerCapture: (id: number) => captures.add(id), hasPointerCapture: (id: number) => captures.has(id),
    releasePointerCapture: (id: number) => { captures.delete(id); } };
  const c = vm.createContext({ Math, Number, String, WORKSPACE_DIVIDER, workspacePointerSplit, workspaceDrag: ref,
    workspaceRef: { current: { getBoundingClientRect: () => ({ left: 137, width }) } }, dividerRef: { current: target },
    window: { matchMedia: () => ({ matches: narrow }) }, setSplit: (s: number) => { split = s; },
    browserStorage() {}, writeStorage(_a: any, _b: any, v: string) { writes.push(v); } });
  vm.runInContext(ts.transpileModule(bodies.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, c);
  assert.match(source, /watchWorkspaceBreakpoint\(media, cancelWorkspaceDrag\)/);
  const cleanup = watchWorkspaceBreakpoint({ get matches() { return narrow; }, addEventListener: (_type, fn) => { listeners.add(fn); }, removeEventListener: (_type, fn) => { listeners.delete(fn); } }, () => c.cancelWorkspaceDrag());
  const startX = 137 + left(width, initial) + grab;
  const event = (dx = 0, id = 1, button = 0) => ({ clientX: startX + dx, pointerId: id, button, currentTarget: target });
  return { c, event, writes, captures, ref, cleanup, split: () => split, narrow: (v: boolean) => { narrow = v; listeners.forEach(fn => fn()); }, width: (v: number) => { width = v; } };
}
test('zero motion and outward attempts at both constrained edges preserve preference', () => {
  for (const [s, dx] of [[28, -50], [64, 50]]) {
    const f = fixture(900, s); f.c.startWorkspaceDrag(f.event());
    f.c.moveWorkspaceDrag(f.event()); f.c.moveWorkspaceDrag(f.event(dx));
    assert.equal(f.writes.length, 0); assert.equal(f.split(), s);
  }
});
test('six pixel movement and reversal execute actual resize with subpixel precision', () => {
  for (const grab of [0, 5, 6, 12]) {
    const f = fixture(1280, 40, grab); f.c.startWorkspaceDrag(f.event());
    f.c.moveWorkspaceDrag(f.event(6)); assert.ok(Math.abs(left(1280, f.split()) - left(1280, 40) - 6) < .01);
    f.c.moveWorkspaceDrag(f.event()); assert.equal(f.split(), 40);
    f.c.moveWorkspaceDrag(f.event(-6)); assert.ok(Math.abs(left(1280, f.split()) - left(1280, 40) + 6) < .01);
  }
});
test('large movement clamps both edges and reversing remains usable', () => {
  for (const w of [861, 900, 1000, 1012, 1029, 1200, 1440]) {
    const f = fixture(w); f.c.startWorkspaceDrag(f.event());
    for (const dx of [-2000, 2000, 1]) {
      f.c.moveWorkspaceDrag(f.event(dx));
      const expected = Math.max(Math.max(280, .28*(w-12)), Math.min(Math.min(w-372,.64*(w-12)),left(w,40)+dx));
      assert.ok(Math.abs(left(w,f.split())-expected)<.01);
    }
  }
});
test('secondary pointer cannot replace, move or end owner capture', () => {
  const f = fixture(); f.c.startWorkspaceDrag(f.event()); f.c.startWorkspaceDrag(f.event(3,2));
  f.c.moveWorkspaceDrag(f.event(20,2)); f.c.endWorkspaceDrag(f.event(20,2));
  assert.equal(f.ref.current.pointerId,1); assert.equal(f.writes.length,0); assert.deepEqual([...f.captures],[1]);
  f.c.moveWorkspaceDrag(f.event(6)); assert.equal(f.writes.length,1);
});
test('up/cancel/lost capture common handler clears state and later movement is ignored', () => {
  for (const lost of [false,true]) {
    const f = fixture(); f.c.startWorkspaceDrag(f.event()); if(lost) f.captures.delete(1);
    f.c.endWorkspaceDrag(f.event()); f.c.endWorkspaceDrag(f.event()); f.c.moveWorkspaceDrag(f.event(6));
    assert.equal(f.ref.current,null); assert.equal(f.captures.size,0); assert.equal(f.writes.length,0);
  }
});
test('narrow viewport or narrow container on move cancels and releases capture', () => {
  for(const viewport of [true,false]) {
    const f=fixture(); f.c.startWorkspaceDrag(f.event()); if(viewport) f.narrow(true); else f.width(860);
    f.c.moveWorkspaceDrag(f.event(6)); assert.equal(f.ref.current,null); assert.equal(f.captures.size,0); assert.equal(f.writes.length,0);
  }
});
test('right button and narrow viewport do not start drag', () => {
  const f=fixture(); f.c.startWorkspaceDrag(f.event(0,1,2)); assert.equal(f.ref.current,null);
  f.narrow(true); f.c.startWorkspaceDrag(f.event()); assert.equal(f.ref.current,null);
});
test('REGRESSION: crossing narrow breakpoint without pointer event invalidates old drag before return', () => {
  const f=fixture(); f.c.startWorkspaceDrag(f.event());
  f.narrow(true); // media query change alone, no pointer event
  f.narrow(false); f.c.moveWorkspaceDrag(f.event(6));
  assert.equal(f.writes.length,0,'old drag must not resume after crossing single-column breakpoint');
});

test('closing workspace removes subscription, releases owner capture and ignores later moves', () => {
  const f = fixture(); f.c.startWorkspaceDrag(f.event()); f.cleanup();
  f.c.moveWorkspaceDrag(f.event(6)); f.narrow(true);
  assert.equal(f.ref.current, null); assert.equal(f.captures.size, 0); assert.equal(f.writes.length, 0);
});
