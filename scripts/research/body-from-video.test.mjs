import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBodyFitRequest } from './body-from-video.mjs';

test('offline scan uses soft constraints and strips audit metadata without inventing tapes', () => {
  const person = { height_cm: 170, weight_kg: 65, sex: 'female' };
  const r = buildBodyFitRequest(person, {
    chest_cm: { value_cm: 88, sigma_cm: 7, method: 'synthetic ellipse', spread_cm: 2, frames: 12 },
  });
  assert.deepEqual(r.known_measurements, {});
  assert.equal(r.scan_measurements.calibration, 'uncalibrated');
  assert.deepEqual(r.scan_measurements.chest_cm, {
    value_cm: 88,
    sigma_cm: 7,
    method: 'synthetic ellipse',
  });
  assert.equal(r.height_cm, 170);
});
test('out-of-range or fabricated/missing measurements fail before service calls', () => {
  const p = { height_cm: 170, weight_kg: 65, sex: 'male' };
  const v = { value_cm: 88, sigma_cm: 7, method: 'synthetic' };
  assert.throws(() => buildBodyFitRequest({ ...p, height_cm: 0 }, { chest_cm: v }), /person/);
  assert.throws(() => buildBodyFitRequest(p, {}), /No usable/);
  assert.throws(() => buildBodyFitRequest(p, { chin_cm: v }), /Unknown/);
  assert.throws(() => buildBodyFitRequest(p, { chest_cm: { ...v, sigma_cm: 0 } }), /entry/);
  assert.throws(() => buildBodyFitRequest(p, { chest_cm: { ...v, value_cm: NaN } }), /entry/);
});
