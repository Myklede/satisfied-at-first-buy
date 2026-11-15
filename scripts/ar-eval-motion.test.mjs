import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionOnsets, boundedOnsetScore } from './ar-eval-motion.mjs';
function fixture(gap = 1, lag = 1) {
  return Array.from({ length: 12 }, (_, i) => ({
    videoMs: i * 100,
    cameraFrameIndex: i * gap,
    lm: Array.from({ length: 33 }, (_, k) => ({
      x: k === 12 && i >= 4 ? 10 : 0,
      y: 0,
      visibility: 1,
    })),
    drawnPoints: {
      lShoulder: [0, 0],
      rShoulder: [i >= 4 + lag ? 10 : 0, 0],
      lWrist: [0, 0],
      rWrist: [0, 0],
    },
  }));
}
test('onset probe preserves exact one-frame response and fails a definite two-frame lag', () => {
  assert.equal(motionOnsets(fixture())[0].events[0].lagCameraFrames, 1);
  assert.equal(motionOnsets(fixture())[0].pass, true);
  assert.equal(motionOnsets(fixture(1, 2))[0].pass, false);
});
test('sparse camera sampling cannot certify a one-frame gate; no event stays N/A', () => {
  const e = motionOnsets(fixture(3, 1))[0].events[0];
  assert.deepEqual(e.lagBoundsCameraFrames, [1, 5]);
  assert.equal(e.pass, null);
  assert.equal(motionOnsets(fixture(1, 99))[0].pass, false);
  assert.equal(motionOnsets([])[0].pass, null);
});

test('legacy zero crossing cannot override an unqualified or sparse onset', () => {
  assert.equal(boundedOnsetScore([{ events: [], pass: null }]).pass, null);
  assert.equal(
    boundedOnsetScore([
      { events: [{ lagCameraFrames: 0, lagBoundsCameraFrames: [0, 4] }], pass: null },
    ]).pass,
    null,
  );
});

test('v2 onset ignores landmark noise and measures a sustained move', async () => {
  const { motionOnsetsV2 } = await import('./ar-eval-motion.mjs');
  const lm = (dx) => {
    const a = [];
    a[11] = { x: 100, y: 100, visibility: 1 };
    a[12] = { x: 200 + dx, y: 100, visibility: 1 };
    a[15] = { x: 100, y: 300, visibility: 1 };
    a[16] = { x: 200, y: 300, visibility: 1 };
    return a;
  };
  const frames = Array.from({ length: 40 }, (_, i) => {
    const noise = i % 2 ? 1.5 : -1.5; // 3 px alternating: legacy 2 px probe would fire
    const move = i >= 20 ? 40 : 0;
    const drawnMove = i >= 22 ? 40 : 0; // drawn follows two observations late
    return {
      videoMs: i * 100,
      cameraFrameIndex: i * 3,
      lm: lm(noise + move),
      drawnPoints: {
        lShoulder: [100, 100],
        rShoulder: [200 + drawnMove, 100],
        lWrist: [100, 300],
        rWrist: [200, 300],
      },
    };
  });
  const turn = motionOnsetsV2(frames).find((k) => k.kind === 'turn');
  assert.equal(turn.events.length, 1);
  assert.equal(turn.events[0].inputMs, 2000);
  assert.equal(turn.events[0].lagCameraFrames, 6);
  assert.equal(turn.events[0].pass, false);
});
