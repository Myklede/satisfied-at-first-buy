import { describe, expect, it } from 'vitest';
import type { GarmentFitResponse } from '../../api';
import {
  buildVerdict,
  labelFor,
  recommendedSize,
  signedCm,
  sizeLabel,
  VerdictError,
  verdictLine,
} from './verdict';

type Zone = GarmentFitResponse['sizes'][string]['zones'][string];
const ease = (value: number, status: Zone['status']): Zone => ({
  value_cm: value,
  metric: 'inner_ease_cm',
  status,
  explanation: '',
  estimated: false,
});
const offset = (zone: 'shoulder' | 'sleeve', value: number, status: Zone['status']): Zone => ({
  value_cm: value,
  metric: `${zone}_offset_cm`,
  status,
  explanation: '',
  estimated: false,
});

/** Test fixture shaped like POST /fit/garment (values are test inputs, not product data). */
function fixture(
  recommended: string | null,
  overrides: Record<string, Partial<Record<string, Zone>>> = {},
): GarmentFitResponse {
  const size = (name: string, chest: number, status: Zone['status']) => ({
    size: name,
    zones: {
      chest: ease(chest, status),
      hem: ease(chest - 4, 'fit'),
      bicep: ease(5, 'fit'),
      shoulder: offset('shoulder', 2, 'fit'),
      sleeve: offset('sleeve', 1.5, 'fit'),
      collar: {
        metric: 'collar_inner_ease_cm',
        status: 'unknown' as const,
        explanation: '',
        estimated: false,
      },
      ...overrides[name],
    },
    score: 1,
    coverage: 1,
    estimated: name !== 'S',
    geometry_available: true,
    missing_fields: [],
    anchors: {},
    polylines: {},
    warnings: [],
  });
  return {
    fit_id: 'a'.repeat(64),
    body_id: 'b'.repeat(64),
    product_id: 'c'.repeat(64),
    sizes: {
      XS: size('XS', -1, 'tight'),
      S: size('S', 4, 'fit'),
      M: size('M', 9, 'relaxed'),
      L: size('L', 16, 'too_big'),
    },
    recommended_size: recommended,
    explanation: '',
    layer_cm: 0.3,
    preference: 'regular',
    loft_cm: 1,
    loft_uncertainty_cm: 0.3,
    heatmap_tight_cm: 0.5,
    heatmap_loose_cm: 3,
    note: '',
  };
}

describe('Fit Lab verdict (selects the service numbers, never computes one)', () => {
  it('copies each zone value and maps statuses to tight/good/loose', () => {
    const v = buildVerdict('FB7675-100', fixture('S'), { layerCm: 0.3, preference: 'regular' });
    expect(v.recommended).toBe('S');
    expect(v.recommendedBasis).toBe('service');
    expect(v.sizes.S).toMatchObject({
      chest: 4,
      hem: 0,
      shoulder: 2,
      sleeve: 1.5,
      bicep: 5,
      label: 'good',
    });
    expect(v.sizes.M.label).toBe('loose'); // larger than the recommendation, chest relaxed
    expect(v.sizes.L.label).toBe('loose'); // too_big
    expect(v.sizes.M.estimated).toBe(true);
    expect(v.heatmapTightCm).toBe(0.5);
    expect(v.fitId).toBe('a'.repeat(64));
  });

  it('labels by the service ranking, checked against its zone flags', () => {
    const z = (status: 'tight' | 'fit' | 'relaxed' | 'too_big') => ({
      valueCm: 1,
      status,
      metric: 'inner_ease_cm',
    });
    // The recommended size is 'good' even with a flagged zone (its numbers stay on screen).
    expect(labelFor('M', [z('tight'), z('too_big')], 'M')).toBe('good');
    expect(labelFor('S', [z('tight'), z('too_big')], 'M')).toBe('tight');
    expect(labelFor('L', [z('fit'), z('too_big')], 'M')).toBe('loose');
    expect(labelFor('L', [z('relaxed')], 'M')).toBe('loose');
    // Smaller but nothing tight: the zone rule decides (here too_big sleeves → loose).
    expect(labelFor('S', [z('fit'), z('too_big')], 'M')).toBe('loose');
    // No service recommendation: the zone rule.
    expect(labelFor('M', [z('fit'), z('relaxed')], null)).toBe('good');
  });

  it('any tight zone makes the size tight, over too_big', () => {
    expect(
      sizeLabel([
        { valueCm: 1, status: 'too_big', metric: 'inner_ease_cm' },
        { valueCm: -1, status: 'tight', metric: 'inner_ease_cm' },
      ]),
    ).toBe('tight');
    expect(sizeLabel([{ valueCm: null, status: 'unknown', metric: 'x' }])).toBeNull();
  });

  it('ignores a zone in another metric (not garment-minus-body ease)', () => {
    const fit = fixture('S', {
      S: { chest: { ...ease(3, 'tight'), metric: 'body_chart_distance_cm' } },
    });
    const v = buildVerdict('FB7675-100', fit, { layerCm: 0.3, preference: 'regular' });
    expect(Number.isNaN(v.sizes.S.chest)).toBe(true);
    expect(v.sizes.S.zones.chest.status).toBe('unknown');
    expect(v.sizes.S.label).toBe('good');
  });

  it('recommends like the kiosk: the service size, else the first S/M/L with geometry', () => {
    expect(recommendedSize(fixture('M'))).toEqual({ size: 'M', basis: 'service' });
    expect(recommendedSize(fixture('XS'))).toEqual({ size: 'S', basis: 'nearest-studio-size' });
    expect(recommendedSize(fixture('XL'))).toEqual({ size: 'L', basis: 'nearest-studio-size' });
    expect(recommendedSize(fixture(null))).toEqual({ size: 'S', basis: 'first-with-geometry' });
  });

  it('refuses a fit without one of S/M/L', () => {
    const fit = fixture('S');
    delete fit.sizes.L;
    expect(() => buildVerdict('DQ4920-206', fit, { layerCm: 0.3, preference: 'regular' })).toThrow(
      VerdictError,
    );
  });

  it('formats signed centimetres and one line per size', () => {
    expect(signedCm(3.44)).toBe('+3.4 cm');
    expect(signedCm(-1)).toBe('−1.0 cm');
    expect(signedCm(0.01)).toBe('±0.0 cm');
    expect(signedCm(Number.NaN)).toBe('n/a');
    const v = buildVerdict('FB7675-100', fixture('S'), { layerCm: 0.3, preference: 'regular' });
    expect(verdictLine('S', v.sizes.S)).toBe(
      'S: chest +4.0 cm, hem ±0.0 cm, shoulder seam +2.0 cm, cuff +1.5 cm (good)',
    );
  });
});
