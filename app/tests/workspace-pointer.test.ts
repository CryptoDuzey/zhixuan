import test from 'node:test';
import assert from 'node:assert/strict';
import { workspacePointerSplit } from '../app/components/workspace-split.ts';

const left = (width: number, split: number) => Math.max(280, Math.min(width - 12 - 360, (width - 12) * split / 100));
test('420 width/minimum/grab/movement samples map pointer back to the same layout', () => {
  let count = 0;
  for (const width of [861, 900, 1000, 1012, 1029, 1200, 1440]) for (const split of [28, 40, 64])
    for (const grab of [0, 5, 6, 11.999]) for (const move of [-2000, -1, 0, 1, 2000]) {
      const start = left(width, split), available = width - 12;
      const expected = Math.max(Math.max(280, 0.28 * available), Math.min(Math.min(available - 360, 0.64 * available), start + move));
      const next = workspacePointerSplit(width, start + grab + move, grab);
      assert.ok(next !== undefined);
      assert.ok(next >= 28 - 1e-8 && next <= 64 + 1e-8);
      assert.ok(Math.abs(left(width, next) - expected) < 0.1);
      count++;
    }
  assert.equal(count, 420);
});
test('six pixel drag is six pixels, independent of grab position', () => {
  for (const grab of [0, 5, 6, 12]) {
    const next = workspacePointerSplit(1280, left(1280, 40) + grab + 6, grab)!;
    assert.ok(Math.abs(left(1280, next) - left(1280, 40) - 6) < 0.01);
  }
});
test('narrow, invalid geometry and invalid grab never produce a preference', () => {
  for (const width of [0, 860, NaN, Infinity]) assert.equal(workspacePointerSplit(width, 500, 6), undefined);
  for (const grab of [-1, 13, NaN]) assert.equal(workspacePointerSplit(1280, 500, grab), undefined);
  assert.equal(workspacePointerSplit(1280, Infinity, 6), undefined);
});
