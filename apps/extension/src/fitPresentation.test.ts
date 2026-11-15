import { expect, it } from 'vitest';
import { barPosition, rankingBasis, roomValue, zoneStatus, unknownReason } from './fitPresentation';
import type { ZoneView } from './types';
it('uses engine band deltas and reverses body-range distance into room direction', () => {
  const zone: ZoneView = {
    zone: 'chest',
    label: 'Chest',
    status: 'tight',
    value_cm: 1.6,
    value_in: 0.63,
    metric: 'body_chart_distance_cm',
    estimated: true,
    personal_offset_cm: 0,
    text: '',
    display_delta_cm: -1.6,
    display_scale_cm: 1.5,
  };
  expect(roomValue(zone)).toBe(-1.6);
  expect(barPosition(zone)).toBeLessThan(50);
  expect(barPosition({ ...zone, display_delta_cm: 0 })).toBe(50);
  expect(barPosition({ ...zone, display_delta_cm: 3.5 })).toBeGreaterThan(50);
  expect(barPosition({ ...zone, display_scale_cm: null })).toBeNull();
  expect(zoneStatus({ ...zone, adjusted_status: 'too_big' })).toBe('too roomy');
});

it('does not call printed outer chest missing when insulation prevents inner fit', () => {
  const zone = {
    text: 'chart lists outer chest; inner room unknown (insulation not measured)',
  } as ZoneView;
  expect(unknownReason(zone)).toContain('insulation not measured');
  expect(unknownReason(zone)).not.toBe('not in chart');
  expect(unknownReason({ ...zone, text: 'Required garment measurement is absent' })).toBe(
    'not in chart',
  );
});

it('labels the full-engine basis only when the service set it', () => {
  const engine = {
    three_d: {
      product_id: 'a'.repeat(64),
      url: '',
      label: '',
      basis: 'Tape-measured catalogue · full engine',
    },
  };
  expect(rankingBasis(engine)).toBe('Tape-measured catalogue · full engine');
  expect(rankingBasis({ three_d: null })).toBeUndefined();
  const linkOnly = { three_d: { product_id: 'a'.repeat(64), url: '', label: '' } };
  expect(rankingBasis(linkOnly)).toBeUndefined();
});
