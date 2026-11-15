import test from 'node:test';
import assert from 'node:assert/strict';
import {
  syntheticGrid,
  collarLabel,
  summarize,
  monotonicity,
  leadHold,
  extractRow,
  rowsCsv,
} from './collar-sweep.mjs';

test('synthetic grid covers 9 heights, 6 BMI targets and a common-weight control, both sexes', () => {
  const rows = syntheticGrid();
  assert.equal(rows.length, 126);
  assert.deepEqual(
    [...new Set(rows.map((r) => r.height_cm))],
    [155, 160, 165, 170, 175, 180, 185, 190, 195],
  );
  assert.equal(new Set(rows.map((r) => `${r.sex}:${r.height_cm}:${r.weight_kg}`)).size, 126);
  assert.ok(rows.every((r) => r.weight_kg >= 30 && r.weight_kg <= 200));
  assert.equal(
    new Set(rows.filter((r) => r.series === 'fixed-weight').map((r) => r.weight_kg)).size,
    1,
  );
  assert.ok(
    rows
      .filter((r) => r.series === 'fixed-weight')
      .every(
        (r) =>
          r.weight_kg / (r.height_cm / 100) ** 2 >= 18.5 &&
          r.weight_kg / (r.height_cm / 100) ** 2 <= 30,
      ),
  );
});
test('collar labels keep inclusive 0/2/4 boundaries and unavailable separate', () => {
  const c = { tight: 0, snug: 2, regular: 4 };
  assert.deepEqual(
    [-1, 0, 0.001, 2, 2.001, 4, 4.001, null, NaN].map((x) => collarLabel(x, c)),
    ['tight', 'tight', 'snug', 'snug', 'regular', 'regular', 'roomy', 'unknown', 'unknown'],
  );
});
test('summary excludes fixed-weight controls and never silently drops unknown cases', () => {
  const input = { sex: 'male', series: 'bmi' };
  const r = summarize([
    { input, collarLabel: 'tight' },
    { input, collarLabel: 'unknown' },
    { input: { ...input, series: 'fixed-weight' }, collarLabel: 'snug' },
  ])[1];
  assert.equal(r.total, 2);
  assert.equal(r.known, 1);
  assert.equal(r.shareAll, 0.5);
  assert.equal(r.shareKnown, 1);
});
test('monotonic comparisons separate weight, fixed BMI and fixed-weight axes', () => {
  const row = (h, w, b, n, series = 'bmi') => ({
    input: { sex: 'male', height_cm: h, weight_kg: w, target_bmi: b, series },
    neckCm: n,
  });
  const r = monotonicity([
    row(160, 50, 20, 34),
    row(160, 60, 25, 33),
    row(165, 54.5, 20, 35),
    row(160, 71.2, null, 36, 'fixed-weight'),
    row(165, 71.2, null, 35.5, 'fixed-weight'),
  ]);
  assert.equal(r.comparisons, 3);
  assert.equal(r.decreases.length, 2);
  assert.deepEqual(
    r.decreases.map((r) => r.axis),
    ['weight-at-height', 'height-at-fixed-weight'],
  );
});
test('hold announcements latch; quoted future release does not clear; explicit lift does', () => {
  const begin = '2026-11-15 03:20 lead: USER TEST NOW — FULL HOLD. Wait for "lead: HOLD lifted".';
  assert.equal(leadHold(begin), true);
  assert.equal(leadHold(begin + '\n2026-11-15 03:25 lead: HOLD lifted.'), false);
  assert.equal(
    leadHold(
      '2026-11-15 03:20 lead: USER TEST of /studio.html NOW — FULL HOLD. Wait for "lead: HOLD lifted".',
    ),
    true,
  );
  assert.equal(
    leadHold('2026-11-15 03:10 lead: USER TEST feedback: the layout needs work.'),
    false,
  );
});
test('row neck derives from exact collar ease, not the unrelated body neck_base value', () => {
  const zone = {
    metric: 'collar_inner_ease_cm',
    value_cm: -1.25,
    status: 'tight',
    explanation: 'estimated neck',
  };
  const row = extractRow(
    { sex: 'male', height_cm: 170, weight_kg: 70 },
    {
      body_id: 'a',
      converged: true,
      warnings: [],
      residuals: {},
      measurements: { neck_base: { value_cm: 90 } },
    },
    { fit_id: 'b', recommended_size: 'M', sizes: { S: { zones: { collar: zone } } } },
    { sizes: { S: { collar_inner: { value_cm: 35 } } } },
    { tight: 0, snug: 2, regular: 4 },
  );
  assert.equal(row.neckCm, 36.25);
  assert.equal(row.neckBaseCm, 90);
  assert.equal(row.collarLabel, 'tight');
  assert.equal(row.sizes.M.zones.chest, null);
});
test('CSV preserves zero measurements, unknowns and escaping in recommendation text', () => {
  const r = {
    input: {
      series: 'bmi',
      sex: 'female',
      height_cm: 160,
      weight_kg: 50,
      target_bmi: 20,
      actual_bmi: 19.53125,
    },
    converged: true,
    neckCm: 35,
    neckBaseCm: 34,
    collarEaseCm: 0,
    collarLabel: 'tight',
    collarStatus: 'tight',
    recommended: 'S "check"',
    sizes: {
      S: { zones: { collar: { value_cm: 0, status: 'tight', metric: 'collar_inner_ease_cm' } } },
    },
  };
  const csv = rowsCsv([r]);
  assert.equal(csv.split('\n').length, 3);
  assert.ok(csv.includes('"S ""check"""'));
  assert.ok(csv.includes('"0","tight","collar_inner_ease_cm"'));
  assert.equal(csv.split('\n')[0].split(',').length, 67);
});
