import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installLayerProbe, layerSummary } from './ar-eval-layers.mjs';
test('layer ruler preserves metres->mm and camera gaps without replacing missing data', () => {
  const t = {};
  installLayerProbe(t);
  const a = { jacket: [0, 0, 0, 1, 0, 0], body: [0, 0, 0], glue: { shoulder: [0, 0] } };
  const b = { jacket: [0.002, 0, 0, 1.002, 0, 0], body: [0.004, 0, 0], glue: { shoulder: [2, 0] } };
  const p = t.__arLayerPair(a, b, 2);
  assert.ok(Math.abs(p.mirrorJacketMmPerCameraFrame - 1) < 1e-10);
  assert.equal(p.mirrorBodyMmPerCameraFrame, 2);
  assert.equal(p.gluePxPerCameraFrame, 1);
  assert.equal(t.__arLayerPair(a, b, null).gluePxPerCameraFrame, null);
  assert.equal(t.__arLayerPair({}, {}, 1).mirrorJacketMmPerCameraFrame, null);
});
test('grade drift reports measured variation and never invents missing frames', () => {
  const f = Array.from({ length: 6 }, (_, i) => ({
    videoMs: i * 200,
    lockEngaged: true,
    grade: { exposure: 1 + i * 0.001, gain: [1, 1, 1], lift: 0 },
  }));
  const s = layerSummary(f);
  assert.ok(Math.abs(s.gradeDriftPctPerS.exposure - 0.5) < 1e-10);
  assert.equal(s.engagedFraction, 1);
  assert.equal(s.mirrorJacketMmPerCameraFrame, null);
  assert.equal(layerSummary([]).gradeDriftPctPerS, null);
});
