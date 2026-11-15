import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installRestProbe, restSummary, restWindowsFor } from './ar-eval-rest.mjs';
import { scoreboard, summarise } from './ar-eval-lib.mjs';

function layer(dx = 0, colour = 120) {
  const width = 24,
    height = 24,
    alphas = new Uint8Array(width * height * 4),
    rgb = new Uint8Array(width * height * 4);
  for (let y = 4; y < 20; y++)
    for (let x = 4 + dx; x < 20 + dx; x++) {
      const i = (y * width + x) * 4;
      alphas[i + 2] = 255;
      rgb[i] = rgb[i + 1] = rgb[i + 2] = colour;
      rgb[i + 3] = 255;
    }
  return { width, height, alphas, colour: rgb, scale: 2 };
}
const window = { id: 'still', name: 'facing_relaxed', startMs: 0, endMs: 600 };
function frames({ lag = 1, moving = true, rotation = 0 } = {}) {
  return Array.from({ length: 14 }, (_, i) => ({
    t: i * 100,
    videoMs: i * 100,
    cameraFrameIndex: i,
    status: 'drawn',
    fade: 0,
    backView: false,
    yawRaw: 0,
    yawDrawn: 0,
    depthDrawn: 2,
    drawnRotationDeg: [i % 2 ? rotation : -rotation, 0, 0],
    lm: Array.from({ length: 33 }, () => ({ x: moving && i >= 6 ? 10 : 0, y: 0, visibility: 1 })),
    restMeasurements: [
      {
        id: 'still',
        pair: i > 0 && i < 6 ? { outlinePx: 0, flicker8bit: 0, cameraFrameDelta: 1 } : null,
        fromRestOutlinePx: lag !== null && i >= 6 + lag ? 1 : 0,
      },
    ],
  }));
}
test('pixel pair measures unchanged and translated final-alpha silhouettes; flicker stays numeric-only', () => {
  const target = {};
  installRestProbe(target);
  const same = target.__arRestPair(layer(), layer());
  assert.equal(same.outlinePx, 0);
  assert.equal(same.flicker8bit, 0);
  assert.ok(Math.abs(target.__arRestPair(layer(), layer(1)).outlinePx - 2) < 0.05);
  assert.ok(Math.abs(target.__arRestPair(layer(), layer(0, 122)).flicker8bit - 2) < 1e-10);
  const empty = layer();
  empty.alphas.fill(0);
  assert.equal(target.__arRestPair(empty, empty).outlinePx, null);
  assert.equal(target.__arRestPair(empty, empty).flicker8bit, null);
});
test('lead still windows and capture cue labels are independent of engine detection', () => {
  assert.deepEqual(restWindowsFor('cam-parka.mp4')[0].startMs, 1500);
  assert.equal(restWindowsFor('other.webm').length, 0);
  assert.equal(restWindowsFor('other.webm', [window])[0].startMs, 0);
});
test('rest targets and one-frame onset lag score a measured response', () => {
  const summary = summarise(frames(), { restWindows: [window] });
  const b = scoreboard(summary);
  assert.equal(b.restOutlinePxPerFrame.pass, true);
  assert.equal(b.restRotationRmsDeg.pass, true);
  assert.equal(b.restScaleStepP95Pct.pass, true);
  assert.equal(b.restMotionOnsetLagFrames.value, 1);
  assert.equal(b.restMotionOnsetLagFrames.pass, true);
  assert.equal(b.restFlicker8bit.value, 0);
  assert.equal(b.restFlicker8bit.pass, null);
});
test('rotation RMS wraps angles; real rest noise above target is a failure', () => {
  const f = frames();
  f.forEach((r, i) => {
    r.drawnRotationDeg = [i % 2 ? 179.9 : -179.9, 0, 0];
  });
  assert.ok(Math.abs(restSummary(f, [window]).rotationRmsDeg - 0.1) < 1e-9);
  assert.equal(
    scoreboard(summarise(frames({ rotation: 0.25 }), { restWindows: [window] })).restRotationRmsDeg
      .pass,
    false,
  );
});
test('a held jacket cannot buy stillness by withholding the first moving frames', () => {
  const late = scoreboard(summarise(frames({ lag: 2 }), { restWindows: [window] }));
  assert.equal(late.restMotionOnsetLagFrames.value, 2);
  assert.equal(late.restMotionOnsetLagFrames.pass, false);
  const stuck = scoreboard(summarise(frames({ lag: null }), { restWindows: [window] }));
  assert.equal(stuck.restMotionOnsetLagFrames.value, null);
  assert.equal(stuck.restMotionOnsetLagFrames.pass, false);
  assert.equal(
    scoreboard(summarise(frames({ moving: false }), { restWindows: [window] }))
      .restMotionOnsetLagFrames.pass,
    null,
  );
});
test('missing/lost rest observations never become a zero-noise PASS', () => {
  const f = frames();
  f.slice(0, 4).forEach((r) => {
    r.status = 'lost';
    r.drawnRotationDeg = null;
  });
  const b = scoreboard(summarise(f, { restWindows: [window] }));
  assert.equal(b.restOutlinePxPerFrame.value, null);
  assert.equal(b.restRotationRmsDeg.pass, null);
});

test('ruler: 1.0 source px per camera frame, skipped observations stay in camera units', () => {
  const target = {};
  installRestProbe(target);
  const a = layer(),
    b = layer(1);
  a.scale = b.scale = 1;
  assert.ok(Math.abs(target.__arRestPair(a, b).outlinePx - 1) <= 0.05);
  const f = frames();
  f.forEach((r, i) => {
    r.cameraFrameIndex = 2 * i;
    r.restMeasurements[0].fromRestOutlinePx *= 10;
    r.depthDrawn = 2 / 1.005 ** (2 * i);
    r.drawnRotationDeg = [i % 2 ? 0.5 : -0.5, 0, 0];
    if (r.restMeasurements[0].pair)
      r.restMeasurements[0].pair = { outlinePx: 2, cameraFrameDelta: 2, flicker8bit: 0 };
  });
  const result = restSummary(f, [window]).windows[0];
  assert.equal(result.outlinePxPerFrame, 1);
  assert.equal(result.outlinePxPerObservation, 2);
  assert.ok(Math.abs(result.rotationRmsDeg - 0.5) < 1e-9);
  assert.ok(Math.abs(result.scaleStepP95Pct - 0.5) < 1e-9);
  assert.equal(result.motionOnset.lagFrames, 2);
  assert.equal(result.motionOnset.lagObservations, 1);
  assert.equal(result.motionOnset.pass, false);
});
test('missing camera frame identities are N/A, never relabelled observations', () => {
  const f = frames();
  f.forEach((r) => {
    delete r.cameraFrameIndex;
    delete r.restMeasurements[0].pair?.cameraFrameDelta;
  });
  const result = restSummary(f, [window]);
  assert.equal(result.outlinePxPerFrame, null);
  assert.equal(result.scaleStepP95Pct, null);
  assert.equal(result.motionOnsetPass, null);
});
