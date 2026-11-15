import test from 'node:test';
import assert from 'node:assert/strict';
import { steps, jitter, decodeSimcc } from './pose-model-study.mjs';
const frame = (x, y, score = 1) => Array.from({ length: 17 }, () => ({ x, y, score }));
test('identical input metric is zero, insufficient valid joints stays unmeasured', () => {
  assert.deepEqual(steps([frame(3, 4), frame(3, 4)]), { validPairs: 1, meanPx: 0, maxPx: 0 });
  assert.equal(steps([frame(0, 0, 0.2), frame(0, 0, 0.2)]).meanPx, null);
});
test('metric uses max visible selected COCO joint, not RMS or face points', () => {
  const a = frame(0, 0),
    b = frame(3, 4);
  b[0].x = 1000;
  b[12] = { x: 0, y: 10, score: 1 };
  assert.equal(steps([a, b]).meanPx, 10);
});
test('still RMS is measured about each joint mean', () => {
  assert.equal(jitter([frame(-3, -4), frame(3, 4)]).rmsPx, 5);
});
test('SimCC inverse crop maps peaks to native pixel centre with padding', () => {
  const x = new Float32Array(17 * 384),
    y = new Float32Array(17 * 512);
  for (let k = 0; k < 17; k++) {
    x[k * 384 + 192] = 0.9;
    y[k * 512 + 256] = 0.8;
  }
  const p = decodeSimcc(x, y, [0, 0, 192, 256])[5];
  assert.equal(p.x, 96);
  assert.equal(p.y, 128);
  assert.ok(Math.abs(p.score - 0.8) < 1e-6);
});
