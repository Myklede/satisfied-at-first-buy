import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, compare, velocityLag, correlation } from './track-compare.mjs';
const frame = (t, x = 0, score = 1) => ({
  tMs: t,
  keypoints: Array.from({ length: 17 }, (_, k) => ({ x: x + k * 10, y: k, score })),
});
test('known 3-4 px offset gives mean/p95 5; missing confidence counts dropout', () => {
  const a = frame(0),
    b = frame(0);
  for (const p of b.keypoints) {
    p.x += 3;
    p.y += 4;
  }
  const r = compare([a], [b], [{ startMs: 0, endMs: 100 }])[0];
  assert.equal(r.meanPx, 5);
  assert.equal(r.p95Px, 5);
  assert.equal(
    compare([a], [frame(0, 0, 0)], [{ startMs: 0, endMs: 100 }])[0].dropoutObservations,
    1,
  );
});
test('bilateral swapped indices are flagged', () => {
  const a = frame(0),
    b = frame(0);
  for (const [l, r] of [
    [5, 6],
    [7, 8],
    [9, 10],
  ])
    [b.keypoints[l], b.keypoints[r]] = [b.keypoints[r], b.keypoints[l]];
  assert.equal(compare([a], [b], [{ startMs: 0, endMs: 100 }])[0].swapCandidates, 1);
});
test('source timestamps required; wall clock is rejected', () =>
  assert.throws(() => canonical({ frames: [{ t: 1 }] }), /Source timestamp/));
test('null/constant signal is unmeasured, sparse cadence cannot certify lag', () => {
  assert.equal(correlation(Array(12).fill(1), Array(12).fill(1)), null);
  assert.equal(velocityLag([frame(0), frame(200)], [frame(0), frame(200)], 30).lagFrames, null);
});
test('velocity cross-correlation recovers a known two-frame delay', () => {
  const ref = Array.from({ length: 100 }, (_, i) =>
    frame((i * 1000) / 30, 20 * Math.sin(i * 0.31) + 9 * Math.sin(i * 0.73)),
  );
  const obs = ref.map((f) => ({ ...f, tMs: f.tMs + (2 * 1000) / 30 }));
  assert.equal(velocityLag(ref, obs, 30).lagFrames, 2);
});
test('constant directional velocity has no identifiable lag', () => {
  const a = Array.from({ length: 100 }, (_, i) => frame((i * 1000) / 30, i * 3));
  assert.equal(velocityLag(a, a, 30).lagFrames, null);
});
test('weak reference is unscorable, not an observed-track dropout', () => {
  const r = compare([frame(0, 0, 0)], [frame(0)], [{ startMs: 0, endMs: 100 }])[0];
  assert.equal(r.dropoutObservations, 0);
  assert.equal(r.referenceDropoutObservations, 1);
  assert.equal(r.meanPx, null);
});
test('hidden drawn coordinates never become observations; confidence comes from the log', () => {
  const f = {
    videoMs: 0,
    status: 'no-video',
    fade: 0,
    lm: Array.from({ length: 33 }, () => ({ x: 1, y: 2, visibility: 0.8 })),
    drawnPoints: { lShoulder: [1, 2] },
  };
  assert.equal(canonical({ frames: [f] }, true)[0].keypoints[5], null);
  f.status = 'drawn';
  assert.equal(canonical({ frames: [f] }, true)[0].keypoints[5].score, 0.8);
});
