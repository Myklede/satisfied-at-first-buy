import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yawStats } from './ar-judge-yaw.mjs';

test('held mid-turn frames and the largest step are found', () => {
  const yaws = [0, 5, 5, 5, 5, 62, 75, 80, 80];
  const f = yaws.map((y, k) => ({ videoMs: k * 66, yawDeg: y, depthM: 2 }));
  const s = yawStats(f);
  assert.equal(s.maxStepDeg, 57);
  assert.equal(s.heldFrames, 0); // 5 deg is below the mid-turn band
  assert.equal(s.holdBeforeMaxStep, 3); // sat at 5 deg for 3 gaps, then +57
  const g = [-70, -60, -45, -45, -45, -45, -10, 0].map((y, k) => ({ videoMs: k * 66, yawDeg: y }));
  assert.equal(yawStats(g).heldFrames, 2);
});
