import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  armElevationDeg,
  outlineJitter,
  percentile,
  regressions,
  scoreboard,
  segmentFrames,
  summarise,
} from './ar-eval-lib.mjs';
import { captureSteps, perStep } from './ar-eval-steps.mjs';
import { upsertScoreTable } from './ar-eval-lib.mjs';

const lm = (armUp = false) => {
  const l = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 1 }));
  l[11] = { x: 100, y: 100, visibility: 1 };
  l[12] = { x: 0, y: 100, visibility: 1 };
  l[23] = { x: 100, y: 300, visibility: 1 };
  l[24] = { x: 0, y: 300, visibility: 1 };
  l[13] = armUp ? { x: 200, y: 100, visibility: 1 } : { x: 100, y: 200, visibility: 1 };
  l[14] = { x: 0, y: 200, visibility: 1 };
  return l;
};
const frame = (i, over = {}) => ({
  t: i * 40,
  yawRaw: 0,
  yawDrawn: 0,
  depthDrawn: 2,
  status: 'drawn',
  fade: 0,
  backView: false,
  alignRmsPx: 10,
  collarFired: false,
  armBeforePx: 30,
  armAfterPx: 10,
  glueResidualPx: 1,
  glueCapBound: 0,
  glueFrames: i,
  totalMs: 30,
  lm: lm(),
  ...over,
});

test('percentile interpolates', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([], 0.5), null);
});

test('arm elevation: hanging arm is 0 deg, horizontal arm is 90 deg', () => {
  assert.ok(Math.abs(armElevationDeg(lm(), 'L')) < 1e-6);
  assert.ok(Math.abs(armElevationDeg(lm(true), 'L') - 90) < 1e-6);
});

test('segmentation: facing, arms, turning, untracked', () => {
  const frames = [
    frame(0),
    frame(1, { lm: lm(true) }),
    frame(2, { yawRaw: 45 }),
    frame(3, { lm: null }),
  ];
  assert.deepEqual(segmentFrames(frames), ['facing', 'arms', 'turning', 'untracked']);
});

test('a steady facing recording passes yaw and scale targets and reports fps from timestamps', () => {
  const frames = Array.from({ length: 50 }, (_, i) => frame(i));
  const s = summarise(frames);
  const b = scoreboard(s);
  assert.equal(b.facingYawAbsMeanDeg.pass, true);
  assert.equal(b.scaleStepP95Pct.value, 0);
  assert.equal(b.trackedFps.value, 25);
  assert.equal(b.keypointResidualPx.value, null);
  assert.equal(scoreboard(summarise(frames.slice(0, 10))).trackedFps.value, 25);
  assert.equal(scoreboard(summarise(frames.slice(0, 10))).facingYawSdDeg.value, null);
});

test('scale step is |dz|/z in percent', () => {
  const frames = [frame(0), frame(1, { depthDrawn: 2.02 }), frame(2, { depthDrawn: 2.02 })];
  const s = summarise(frames);
  assert.ok(Math.abs(s.segments.facing.scaleStepPct.p95 - 0.99 * 0.95 * 1) < 0.2);
  assert.equal(scoreboard(s).scaleStepP95Pct.pass, false);
});

test('outline jitter counts only standing frames', () => {
  const frames = Array.from({ length: 6 }, (_, i) =>
    frame(i, { outline: { lShoulder: [i % 2, 0], rShoulder: [0, 0], lHip: [0, 0], rHip: [0, 0] } }),
  );
  const labels = frames.map(() => 'facing');
  const speeds = frames.map(() => 1);
  const j = outlineJitter(frames, labels, speeds);
  assert.equal(j.frames, 5);
  assert.equal(j.meanPxPerFrame, 0.25);
  assert.equal(
    outlineJitter(
      frames,
      frames.map(() => 'arms'),
      speeds,
    ).frames,
    0,
  );
});

test('regressions flag worse metrics only', () => {
  const prev = { uncoveredPct: { value: 1, pass: true }, trackedFps: { value: 30, pass: true } };
  const next = { uncoveredPct: { value: 3, pass: false }, trackedFps: { value: 31, pass: true } };
  assert.deepEqual(
    regressions(prev, next).map((r) => r.metric),
    ['uncoveredPct'],
  );
});

test('capture v1 validates ordered video-relative windows, preserves repeated labels and half-open boundaries', () => {
  const steps = captureSteps({
    format: 'satisfy-capture',
    version: 1,
    steps: [
      { name: 'facing', startMs: 0, endMs: 1000 },
      { name: 'facing', startMs: 1000, endMs: 2000 },
      { name: 'arms raised', startMs: 2500, endMs: 3000 },
    ],
  });
  const rows = perStep(
    [
      frame(0, { videoMs: 0 }),
      frame(1, { videoMs: 999 }),
      frame(2, { videoMs: 1000 }),
      frame(3, { videoMs: 2100 }),
    ],
    steps,
  );
  assert.deepEqual(
    rows.map((r) => r.observedFrames),
    [2, 1, 0],
  );
  assert.equal(rows[2].alignment.p50, null);
  assert.equal(rows[2].scoreboard.arFps.pass, null);
  assert.throws(() => captureSteps({ format: 'satisfy-capture', version: 2, steps: [] }));
  assert.throws(() =>
    captureSteps({
      format: 'satisfy-capture',
      version: 1,
      steps: [{ name: 'x', startMs: 4, endMs: 3 }],
    }),
  );
  assert.throws(() =>
    captureSteps({
      format: 'satisfy-capture',
      version: 1,
      steps: [
        { name: 'x', startMs: 0, endMs: 2 },
        { name: 'y', startMs: 1, endMs: 3 },
      ],
    }),
  );
});

test('back score needs a labelled hold and counts only a DRAWN back view (hidden fails)', () => {
  // F5 2026-11-14: a faded/hidden jacket on the back is not "handled" (defect atlas D2).
  const frames = Array.from({ length: 40 }, (_, i) =>
    frame(i, { videoMs: i * 40, backView: true, fade: i < 38 ? 0 : 1 }),
  );
  assert.equal(scoreboard(summarise(frames)).backHandledPct.value, null);
  const [step] = perStep(
    frames,
    captureSteps({
      schema: 'satisfy-capture',
      version: 1,
      steps: [{ name: 'back hold', startMs: 0, endMs: 2000 }],
    }),
  );
  assert.equal(step.scoreboard.backHandledPct.value, 95);
  assert.equal(step.scoreboard.backHandledPct.pass, true);
  frames[0].fade = 0.94;
  assert.equal(perStep(frames, [step])[0].scoreboard.backHandledPct.pass, false);
  assert.equal(
    perStep(frames, [{ ...step, expectedBack: false }])[0].scoreboard.backHandledPct.value,
    null,
  );
});

test('post-finisher coverage excludes turned/faded frames and never uses person-mask fallback', () => {
  // CX-TRY's show_back step includes turns and a hold, not eight seconds of back truth.
  const [turn] = captureSteps({
    schema: 'satisfy-capture',
    version: 1,
    steps: [{ name: 'show_back', startMs: 0, endMs: 8000 }],
  });
  assert.equal(turn.expectedBack, false);
  const frames = Array.from({ length: 40 }, (_, i) =>
    frame(i, {
      uncoveredPct: 0,
      frontalUncoveredPct: i < 10 ? 3 : null,
      finisherMainThreadMs: 4,
      arFps: 23,
    }),
  );
  const b = scoreboard(summarise(frames));
  assert.equal(b.frontalUncoveredPct.value, 3);
  assert.equal(b.frontalUncoveredPct.pass, false);
  assert.equal(b.finisherMainThreadMs.pass, true);
  assert.equal(b.arFps.pass, false);
  frames.forEach((f) => {
    f.fade = 0.5;
  });
  assert.equal(scoreboard(summarise(frames)).frontalUncoveredPct.value, null);
});

test('score table updates preserve history and per-step sections, with one source/commit row', () => {
  const history = '# V5\n| old | legacy | video:cam | 3.52 ok |\n';
  const score = scoreboard(summarise(Array.from({ length: 40 }, (_, i) => frame(i))));
  const input = { commit: 'abc+wip', date: 'now', source: 'video:a', score };
  let text = upsertScoreTable(history, input) + '\n### Per-step details\n| back | 95 |\n';
  text = upsertScoreTable(text, { ...input, source: 'video:b' });
  text = upsertScoreTable(text, input);
  // A formatter can pad cells; rerunning still updates the existing row/header.
  text = text
    .replace('| commit |', '| commit       |')
    .replace('| abc+wip | now | video:a |', '| abc+wip       | now | video:a       |');
  text = upsertScoreTable(text, input);
  assert.equal(text.split('| abc+wip | now | video:a |').length - 1, 1);
  assert.equal(text.split('| abc+wip | now | video:b |').length - 1, 1);
  assert.ok(text.startsWith(history));
  assert.ok(text.endsWith('### Per-step details\n| back | 95 |\n'));
  assert.ok(text.indexOf('| abc+wip | now | video:b |') < text.indexOf('<!-- cxday-score:end -->'));
});
