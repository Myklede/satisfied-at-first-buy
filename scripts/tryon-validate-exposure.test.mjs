import test from 'node:test';
import assert from 'node:assert/strict';
import { exposure } from './tryon-validate-exposure.mjs';
test('visible gap is computed and missing temporal coverage stays unknown', () => {
  const r = exposure(
    {
      observations: [
        { t: 1, hemY: 100, waistbandY: 150 },
        { t: 2, hemY: 100, waistbandY: 170 },
      ],
      pixelErrorPerEdge: 4,
    },
    5,
    0.1,
  );
  assert.equal(r.valueCm, 12);
  assert.ok(Math.abs(r.partialSensitivityCm - 4.8) < 1e-12);
  assert.equal(r.uncertaintyCm, null);
  assert.equal(r.componentsCm.timestamp, null);
  assert.throws(() => exposure({ observations: [{ t: 1, hemY: 200, waistbandY: 100 }] }, 5, 0.1));
});
