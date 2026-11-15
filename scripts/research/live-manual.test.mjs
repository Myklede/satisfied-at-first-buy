import test from 'node:test';
import assert from 'node:assert/strict';
import { cuffRatio } from './live-manual.mjs';
import { poseState, windowLag, trackHealth } from './live-summary.mjs';
test('reviewed cuff projection keeps source-to-AR x scale and forearm units', () => {
  const p = Array.from({ length: 17 }, () => ({ x: 0, y: 0, score: 0 }));
  p[7] = { x: 100, y: 100, score: 1 };
  p[9] = { x: 100, y: 200, score: 1 };
  const r = cuffRatio(p, 'left', [(100 * 959) / 960, 225], 5);
  assert.equal(r.ratio, 0.25);
  assert.equal(r.readingBound, 0.05);
  assert.equal(cuffRatio(p, 'right', [0, 0], 5), null);
});
test('absent reference and constant movement do not invent a motion event or lag', () => {
  assert.equal(poseState({ keypoints: null }), 'untracked');
  assert.equal(windowLag([], [], 64).frames, null);
});
test('pose candidates distinguish raised and crossed arms with confident shoulders', () => {
  const p = Array.from({ length: 17 }, () => ({ x: 150, y: 150, score: 1 }));
  p[5] = { x: 200, y: 100, score: 1 };
  p[6] = { x: 100, y: 100, score: 1 };
  p[9] = { x: 200, y: 70, score: 1 };
  p[10] = { x: 100, y: 70, score: 1 };
  const f = { keypoints: p, width: 400, box: [0, 0, 300, 300] };
  assert.equal(poseState(f), 'both-arms-up');
  p[10].y = 200;
  assert.equal(poseState(f), 'one-arm-up');
  p[9] = { x: 80, y: 200, score: 1 };
  p[10] = { x: 220, y: 200, score: 1 };
  assert.equal(poseState(f), 'crossed-hands');
});
test('cuff velocity correlation recovers synthetic delay while retaining its validity warning', () => {
  const period = 64;
  const xy = (i) => [200 + 50 * Math.sin(i * 0.43), 150 + 40 * Math.cos(i * 0.31)];
  const refs = Array.from({ length: 60 }, (_, i) => {
    const p = Array.from({ length: 17 }, () => null);
    const [x, y] = xy(i);
    p[9] = { x, y, score: 1 };
    p[10] = { x: x + 100, y: y + 20, score: 1 };
    return { tMs: i * period, keypoints: p };
  });
  const obs = Array.from({ length: 60 }, (_, i) => {
    const [x, y] = xy(i - 2);
    return {
      tMs: i * period,
      cuffs: { left: { renderedEndpoint: [x, y] }, right: { renderedEndpoint: [x + 100, y + 20] } },
    };
  });
  const result = windowLag(refs, obs, period);
  assert.equal(result.frames, 2);
  assert.equal(result.acceptedAsOnset, false);
});
test('reference availability keeps dropouts and logo-only boxes explicit', () => {
  const health = trackHealth([
    { tMs: 0, width: 1280, height: 720, valid: false, keypoints: null, box: null },
    {
      tMs: 33,
      width: 1280,
      height: 720,
      valid: false,
      keypoints: null,
      box: [1140, 580, 1200, 650],
    },
  ]);
  assert.equal(health.validReferenceFrames, 0);
  assert.equal(health.referenceDropouts, 2);
  assert.equal(health.shouldersScorable, 0);
  assert.equal(health.primaryBoxesWhollyInsideLogo, 1);
});
