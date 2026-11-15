import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterSeries,
  similarity,
  imageSignals,
  worldSignals,
  eventMetrics,
  stepResponse,
  wrap,
  evaluate,
  sourceTime,
  reconstruct,
} from './torso-filter-sim.mjs';
test('similarity recovers translation rotation scale without nonrigid degrees of freedom', () => {
  const a = [
      [0, 0],
      [2, 0],
      [0, 3],
      [2, 3],
    ],
    b = a.map(([x, y]) => [10 - 2 * y, 20 + 2 * x]);
  const f = similarity(a, b);
  assert.ok(Math.abs(f.angle - 90) < 1e-9);
  assert.ok(Math.abs(f.logScale - Math.log(2)) < 1e-9);
  assert.ok(f.points.every((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1]) < 1e-8));
  assert.throws(
    () =>
      similarity(
        [
          [0, 0],
          [0, 0],
        ],
        [
          [1, 1],
          [1, 1],
        ],
      ),
    /Degenerate/,
  );
});
test('constant signals do not jitter; angles unwrap across 179/-179 without a full spin', () => {
  for (const spec of [
    { family: 'euro', cutoff: 0.6, beta: 0.03 },
    { family: 'slew', band: 1, slew: 90 },
    { family: 'hold', band: 1, sustainMs: 66, glideMs: 66 },
    { family: 'kalman', acceleration: 40, measurement: 1 },
  ]) {
    const out = filterSeries(
      Array.from({ length: 30 }, (_, i) => ({ t: i * 33, x: 7 })),
      spec,
    );
    assert.ok(out.every((s) => Math.abs(s.y - 7) < 1e-9));
  }
  const y = filterSeries(
    [
      { t: 0, x: 179 },
      { t: 33, x: -179 },
    ],
    { family: 'euro', cutoff: 2, beta: 0.1, period: 360 },
  );
  assert.ok(Math.abs(y[1].y - y[0].y) < 3);
  assert.equal(wrap(361), 1);
});
test('persistent hold rejects alternating spikes but responds to sustained real movement', () => {
  const input = [0, 10, -10, 10, -10, 0, 10, 10, 10, 10, 10].map((x, i) => ({ x, t: i * 50 }));
  const y = filterSeries(input, { family: 'hold', band: 1, sustainMs: 100, glideMs: 33 });
  assert.ok(y.slice(0, 6).every((s) => s.y === 0));
  assert.ok(y.at(-1).y > 9);
  assert.equal(stepResponse({ family: 'raw' }, 10, 50).lag90Ms, 0);
  assert.ok(
    stepResponse({ family: 'hold', band: 1, sustainMs: 200, glideMs: 250 }, 15, 50).lag90Ms >= 700,
  );
});
test('image/world signals have explicit degenerate states and finite neutral trunk angles', () => {
  assert.equal(
    imageSignals([
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ]),
    null,
  );
  assert.equal(worldSignals(null), null);
  const w = Array.from({ length: 33 }, () => [0, 0, 0, 1]);
  w[11] = [1, -2, 0, 1];
  w[12] = [-1, -2, 0, 1];
  w[23] = [1, 0, 0, 1];
  w[24] = [-1, 0, 0, 1];
  const s = worldSignals(w);
  assert.equal(s.flex, 0);
  assert.equal(s.lateral, 0);
  assert.equal(s.twist, 0);
});
test('90-percent timing keeps missing crossings censored and measures known delayed steps', () => {
  const input = Array.from({ length: 21 }, (_, i) => ({
    t: i * 50,
    x: Math.min(10, Math.max(0, (i - 4) * 2)),
    r: Math.min(10, Math.max(0, (i - 4) * 2)),
  }));
  const output = input.map((s, i) => ({ ...s, y: input[Math.max(0, i - 2)].x }));
  const m = eventMetrics(input, output, 0, 1000, 3);
  assert.equal(m.addedLagMs, 100);
  assert.equal(
    eventMetrics(
      input,
      input.map((s) => ({ ...s, y: 0 })),
      0,
      1000,
      3,
    ).censored,
    true,
  );
});
test('reference-conditioned jitter is measured in source units and reported per window', () => {
  const input = Array.from({ length: 100 }, (_, i) => ({
    t: i * 33,
    x: i % 2 ? 1 : -1,
    r: 0,
    quiet: true,
  }));
  const output = filterSeries(input, { family: 'euro', cutoff: 0.6, beta: 0 });
  const m = evaluate(input, output, 1, 5, [['still', 0, 3300]]);
  assert.ok(m.reductionPct > 60);
  assert.ok(m.windows[0].quietSamples > 50);
  assert.equal(m.windows[0].lagMs, null);
});
test('large-motion bypass uses the current input and does not leave a stale filtered tail', () => {
  const a = [
    { t: 0, x: 0 },
    { t: 33, x: 10 },
    { t: 66, x: 20, bypass: true },
    { t: 99, x: 20 },
  ];
  const out = filterSeries(a, { family: 'euro', cutoff: 0.3, beta: 0, motionBypass: true });
  assert.ok(out[1].y < 10);
  assert.equal(out[2].y, 20);
  assert.equal(out[3].y, 20);
});
test('old CFR replay times map to original VFR PTS and incompatible clocks are rejected', () => {
  const clock = { encodedFps: 10, sourceMs: [0, 110, 260, 400] };
  assert.equal(sourceTime(200, clock), 260);
  assert.equal(sourceTime(123, null), 123);
  assert.throws(() => sourceTime(250, clock), /clock/);
});
test('reconstruction pairs native source PTS and excludes weak reference joints', () => {
  const points = [
    [600, 200],
    [400, 200],
    [575, 500],
    [425, 500],
  ];
  const replay = { video: [1280, 720], frames: [] };
  const reference = { frames: [] };
  const clock = { encodedFps: 25, sourceMs: [] };
  for (let i = 0; i < 24; i++) {
    const lm = Array.from({ length: 33 }, () => [0, 0, 0]);
    const keypoints = Array.from({ length: 17 }, () => ({ x: 0, y: 0, score: 0 }));
    [11, 12, 23, 24].forEach((k, j) => {
      lm[k] = [...points[j], 1];
    });
    [5, 6, 11, 12].forEach((k, j) => {
      keypoints[k] = { x: points[j][0], y: points[j][1], score: 1 };
    });
    if (i === 5) keypoints[5].score = 0.64;
    clock.sourceMs.push(i * 33);
    replay.frames.push({ videoMs: i * 40, lm });
    reference.frames.push({ index: i, tMs: i * 33, keypoints });
  }
  const result = reconstruct(replay, reference, clock);
  assert.equal(result.frames.length, 23);
  assert.equal(result.frames.at(-1).t, 23 * 33);
  assert.equal(result.width0, 200);
  assert.ok(result.frames.every((f) => f.t !== 5 * 33));
  assert.throws(
    () => reconstruct(replay, reference, { ...clock, sourceMs: clock.sourceMs.map((t) => t + 1) }),
    /does not match/,
  );
});
