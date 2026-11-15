import test from 'node:test';
import assert from 'node:assert/strict';
import { compareMetric, comparisons } from './tryon-validate-compare.mjs';
test('missing and withheld values never report success', () => {
  assert.equal(compareMetric({ valueCm: 3, uncertaintyCm: 1 }, null).withinUncertainty, null);
  assert.equal(compareMetric(null, { value: 0 }).realCm, null);
});
test('numerical overlap is distinct from comparable accuracy', () => {
  const r = compareMetric({ valueCm: 10, uncertaintyCm: 3 }, { value: 12 });
  assert.equal(r.deltaCm, 2);
  assert.equal(r.numericalOverlap, true);
  assert.equal(r.withinUncertainty, null);
  assert.equal(r.status, 'descriptive-only');
  assert.equal(
    compareMetric({ valueCm: 10, uncertaintyCm: 1 }, { value: 12 }, { compatible: true })
      .withinUncertainty,
    false,
  );
});
test('never assigns parka physics to puffer or exposes a failed bake', () => {
  const real = {
    products: ['parka', 'puffer'].map((jacket) => ({
      jacket,
      moves: [{ move: 'cross_arms', hemRise: { valueCm: 2, uncertaintyCm: 1 }, cuffRideUp: {} }],
    })),
  };
  const physics = {
    garment: { style: 'FB7675-100 parka' },
    moves: [
      {
        id: 'cross_arms',
        sleeveGate: { valid: false },
        physics: { peak: { hemRiseFrontCm: { value: 5 } } },
      },
    ],
  };
  const r = comparisons(real, physics, null);
  assert.ok(r.rows.every((x) => x.simCm === null));
  assert.equal(r.rows.find((x) => x.jacket === 'puffer').physicsStatus, 'missing move/product');
});

test('partial evidence shows available physics without inventing real values', () => {
  const p = {
    garment: { style: 'FB7675-100' },
    moves: [
      {
        id: 'cross_arms',
        sleeveGate: { valid: true },
        physics: { peak: { hemRiseFrontCm: { value: 5 } } },
      },
    ],
  };
  const s = {
    observation: { jacket: 'puffer', move: 'reach_up_both', valueCm: 12, uncertaintyCm: null },
  };
  const r = comparisons(null, p, null, s);
  const parka = r.rows.find((x) => x.jacket === 'parka' && x.metric === 'hemRise');
  assert.equal(parka.simCm, 5);
  assert.equal(parka.realCm, null);
  assert.equal(parka.deltaCm, null);
  const puffer = r.rows.find((x) => x.jacket === 'puffer' && x.metric === 'frontExposure');
  assert.equal(puffer.realCm, 12);
  assert.equal(puffer.simCm, null);
  assert.equal(r.sources.real, false);
  assert.equal(r.sources.supplementalExposure, true);
});
