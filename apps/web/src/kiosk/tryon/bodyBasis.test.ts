import { expect, it } from 'vitest';
import { BODY_BASIS, tryOnBody } from './bodyBasis';
import type { ScanFitReport } from '../kioskApi';

const report: ScanFitReport = {
  source: 'webcam_scan',
  calibration: 'uncalibrated',
  weighting: 'uncertainty',
  entries: {},
  overridden_by_tape: [],
  base_body_id: 'a'.repeat(64),
};
it('binds try-on to the scanned fit body rather than the pre-scan base', () => {
  const selected = tryOnBody({ body_id: 'b'.repeat(64) }, report);
  expect(selected.bodyId).toBe('b'.repeat(64));
  expect(selected.bodyId).not.toBe(report.base_body_id);
  expect(BODY_BASIS[selected.bodyBasis]).toBe('Your scanned body');
});
it('labels a skipped scan as a height/weight estimate and retains that fitted body', () => {
  const selected = tryOnBody({ body_id: 'c'.repeat(64) }, null);
  expect(selected.bodyId).toBe('c'.repeat(64));
  expect(BODY_BASIS[selected.bodyBasis]).toBe('Body estimated from height & weight');
});
