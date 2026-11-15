import { describe, expect, it } from 'vitest';
import type { GarmentFitResponse, GarmentSpec, SizeFit } from '../api';
import { hasMeasurement, summarize, type BoardEntry } from './board';
import { contrastSize, predictions, reasonLine, sortSizes, storeLink } from './fitSummary';
import { guidanceText } from './scanText';
import {
  cmToFtIn,
  formatLength,
  formatPlusMinus,
  formatSigned,
  ftInToCm,
  kgToLb,
  lbToKg,
  parseYou,
} from './units';

const zone = (metric: string, value_cm: number, extra: object = {}) => ({
  metric,
  value_cm,
  status: 'fit' as const,
  explanation: '',
  estimated: false,
  ...extra,
});
const size = (name: string, shoulder: number, estimated = false): SizeFit => ({
  size: name,
  zones: {
    shoulder: zone('shoulder_offset_cm', shoulder),
    sleeve: zone('sleeve_offset_cm', 3.1),
    hem: zone('inner_ease_cm', 3.9, { position_vs_hip_cm: -18.9 }),
    chest: zone('inner_ease_cm', 0.5),
  },
  score: 1,
  coverage: 1,
  estimated,
  geometry_available: true,
  missing_fields: [],
  anchors: {},
  polylines: {},
  warnings: [],
});
const fit = (recommended: string | null): GarmentFitResponse =>
  ({
    sizes: { S: size('S', 6.9), M: size('M', 8.8, true), XS: size('XS', 5) },
    recommended_size: recommended,
  }) as unknown as GarmentFitResponse;

describe('units', () => {
  it('converts exactly and round-trips', () => {
    expect(ftInToCm(5, 9)).toBeCloseTo(175.26, 2);
    expect(cmToFtIn(175.26)).toEqual({ ft: 5, inches: 9 });
    expect(lbToKg(kgToLb(65))).toBeCloseTo(65, 10);
    expect(kgToLb(1)).toBeCloseTo(2.20462, 4);
  });
  it('formats both unit systems with the chosen one first', () => {
    expect(formatLength(6.9, 'metric')).toBe('6.9 cm (2.7 in)');
    expect(formatLength(-6.9, 'imperial')).toBe('2.7 in (6.9 cm)');
    expect(formatSigned(-2.54, 'imperial')).toBe('−1.0 in');
    expect(formatSigned(0.01, 'metric')).toBe('0.0 cm');
    expect(formatPlusMinus(101.6, 2.54, 'imperial')).toBe('40.0 ± 1.0 in');
  });
  it('parses the form into API units with friendly ranges', () => {
    const base = { heightCm: '', weightKg: '', heightFt: '', heightIn: '', weightLb: '' };
    expect(
      parseYou({ ...base, units: 'imperial', heightFt: '5', heightIn: '9', weightLb: '150' }),
    ).toEqual({ ok: true, height_cm: 175.3, weight_kg: 68 });
    expect(parseYou({ ...base, units: 'metric', heightCm: '172', weightKg: '65' })).toEqual({
      ok: true,
      height_cm: 172,
      weight_kg: 65,
    });
    const bad = parseYou({ ...base, units: 'imperial', heightFt: '8', weightLb: '20' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.height).toMatch(/between 4 ft 0 in and 7 ft 2 in/);
      expect(bad.weight).toMatch(/between 67 and 440 lb/);
    }
    expect(
      parseYou({ ...base, units: 'imperial', heightFt: '5', heightIn: '12', weightLb: '150' }).ok,
    ).toBe(false);
    expect(parseYou({ ...base, units: 'metric', heightCm: 'abc', weightKg: '65' }).ok).toBe(false);
  });
});

describe('fit summary', () => {
  it('reads predictions from the computed zones only', () => {
    expect(predictions(size('S', 6.9))).toEqual({
      shoulder_seam: 6.9,
      cuff_vs_wrist: 3.1,
      hem_vs_hip: -18.9,
    });
    expect(predictions(undefined)).toEqual({
      shoulder_seam: null,
      cuff_vs_wrist: null,
      hem_vs_hip: null,
    });
  });
  it('writes a one-line reason with both units and flags estimates', () => {
    expect(reasonLine(fit('S'), 'metric')).toBe(
      'S: shoulder seam drops 6.9 cm (2.7 in) past your shoulder bone',
    );
    expect(reasonLine(fit('M'), 'imperial')).toMatch(/^M: .*3\.5 in.*\(estimated size grade\)$/);
    expect(reasonLine(fit(null), 'metric')).toMatch(/No size could be recommended/);
  });
  it('orders sizes and picks a contrast size', () => {
    expect(sortSizes(['M', 'XS', '2XL', 'S'])).toEqual(['XS', 'S', 'M', '2XL']);
    expect(contrastSize(fit('S'))).toBe('M');
    expect(contrastSize(fit('M'))).toBe('S');
    expect(contrastSize(fit(null))).toBeNull();
  });
  it('labels store links truthfully, never size-specific URLs', () => {
    const amazon = storeLink({ url: 'https://www.amazon.com/dp/B0C9TQTNYH' } as GarmentSpec, 'M');
    expect(amazon).toEqual({
      store: 'Amazon',
      isAmazon: true,
      label: 'Open on Amazon in size M',
      note: 'Choose size M on the page.',
    });
    const ebay = storeLink({ url: 'https://www.ebay.com/itm/278055652565' } as GarmentSpec, 'S');
    expect(ebay?.label).toBe('Open store page (eBay)');
    expect(storeLink({ url: 'http://www.amazon.com/x' } as GarmentSpec, 'S')).toBeNull();
    expect(storeLink({ url: 'https://evil.example/amazon.com' } as GarmentSpec, 'S')).toBeNull();
  });
});

describe('accuracy board', () => {
  const entry = (shoulder: [number, number | null] | null): BoardEntry => ({
    version: 1,
    sex: 'male',
    height_cm: 172,
    product_style: 'FB7675-100',
    size: 'S',
    scanned: false,
    shoulder_seam: shoulder && { predicted_cm: shoulder[0], measured_cm: shoulder[1] },
    cuff_vs_wrist: null,
    hem_vs_hip: null,
  });
  it('computes MAE and bias over measured pairs only', () => {
    const summary = summarize([entry([7, 5]), entry([2, 4]), entry([3, null]), entry(null)]);
    expect(summary.shoulder_seam).toEqual({ n: 2, maeCm: 2, biasCm: 0 });
    expect(summary.hem_vs_hip).toEqual({ n: 0, maeCm: null, biasCm: null });
  });
  it('requires at least one measurement to store', () => {
    expect(hasMeasurement(entry([3, null]))).toBe(false);
    expect(hasMeasurement(entry([3, 1]))).toBe(true);
  });
});

describe('scan guidance text', () => {
  it('turns issues into one short instruction, most important first', () => {
    expect(
      guidanceText({ stage: 'front', ok: false, issues: ['moving', 'too_close'], progress: 0 }),
    ).toBe('Step back until your whole body is visible');
    expect(guidanceText({ stage: 'side', ok: false, issues: ['not_side_on'], progress: 0 })).toBe(
      'Turn to your left, side-on to the camera',
    );
    expect(guidanceText({ stage: 'front', ok: true, issues: [], progress: 0.5 })).toBe(
      'Hold still…',
    );
  });
});
