import { expect, it } from 'vitest';
import { toFitRequest, assumptionSummary, storageRows } from './profile';
it('onboards in either unit system with explicit model assumptions', () => {
  const imperial = toFitRequest(true, 70, 160, 'male', null);
  expect(imperial.height_cm).toBe(177.8);
  expect(assumptionSummary(imperial)).toContain('chest estimated by Anny');
  expect(assumptionSummary(toFitRequest(false, 170, 60, 'female', 85))).toContain('chest tape 85');
  for (const [imperial, height, weight, sex, chest] of [
    [false, NaN, 60, 'male', null],
    [false, 170, 300, 'male', null],
    [false, 170, 60, '', null],
    [false, 170, 60, 'male', 0],
  ] as const)
    expect(() => toFitRequest(imperial, height, weight, sex, chest)).toThrow();
});
it('stored profile disclosure includes canonical defaults, choices, dates and exact original strings', () => {
  const rows = storageRows({
    saved_on: '2026-11-13',
    fit_request: { height_cm: 177.8, density_kg_m3: 1010 },
    choices: { layer: 't-shirt' },
    entry: { weight: '160.00' },
  });
  expect(rows).toContainEqual(['entry / weight', '160.00']);
  expect(rows).toContainEqual(['fit request / density kg m3', '1010']);
  expect(rows).toContainEqual(['choices / layer', 't-shirt']);
  expect(rows).toContainEqual(['saved on', '2026-11-13']);
});
