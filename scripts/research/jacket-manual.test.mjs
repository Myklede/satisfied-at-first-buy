import test from 'node:test';
import assert from 'node:assert/strict';
import { geometryRatios } from './jacket-manual.mjs';
test('manual outline ratios and reading bounds preserve units and forearm projection', () => {
  const p = Array.from({ length: 17 }, () => ({ x: 0, y: 0, score: 1 }));
  p[5].x = 100;
  p[7] = { x: 0, y: 0, score: 1 };
  p[9] = { x: 0, y: 100, score: 1 };
  p[11].y = 100;
  p[12].y = 100;
  const r = geometryRatios(p, {
    shoulderEdges: [0, 200],
    chestEdges: [0, 150],
    hemY: 120,
    hemErrorPx: 4,
    edgeErrorPx: 3,
    sleeveEdges: {
      left: [
        [0, 70],
        [40, 70],
      ],
    },
  });
  assert.equal(r.shoulderWidth.ratio, 2);
  assert.equal(r.shoulderWidth.readingBound, 0.06);
  assert.equal(r.hemHeight.ratio, 0.2);
  assert.equal(r.sleeveWidth.left.ratio, 0.4);
  assert.equal(r.sleeveWidth.right, null);
});
test('unavailable shoulders are rejected rather than inventing a body scale', () =>
  assert.throws(() => geometryRatios([], { edgeErrorPx: 3 }), /shoulder/));
