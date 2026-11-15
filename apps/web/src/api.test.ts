import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  capabilitiesSchema,
  fitSchema,
  garmentFitSchema,
  landmarksSchema,
  productSchema,
} from './api';

afterEach(() => vi.unstubAllGlobals());
describe('runtime API validation', () => {
  const product = {
    product_id: 'a'.repeat(64),
    url: 'https://example.com/jacket',
    brand: 'Test',
    category: 'jacket',
    chart_type: 'garment',
    unit: 'cm',
    owned_size: 'S',
    sizes: { S: {} },
    fabric: { composition: 'Synthetic fixture' },
    notes: '',
    title: 'Fixture',
    style: 'fixture',
    colourway: 'fixture',
    construction: 'set_in',
    fit_intent: 'regular',
    loft_cm: 0,
    loft_uncertainty_cm: 0,
    hem_elastic: false,
    body_chart_type: 'body',
  };
  const tape = (value_cm: number) => ({
    value_cm,
    source: 'tape_measured',
    source_detail: 'test fixture',
  });
  it('accepts measured collar tapes and their absence without inventing another size', () => {
    expect(productSchema.safeParse(product).success).toBe(true);
    const result = productSchema.parse({
      ...product,
      sizes: {
        S: { collar_inner: tape(35), collar_height: tape(8) },
        M: {},
      },
    });
    expect(result.sizes.S).toMatchObject({ collar_inner: tape(35), collar_height: tape(8) });
    expect(result.sizes.M).not.toHaveProperty('collar_inner');
  });
  it('rejects invalid new collar fields at the runtime boundary', () => {
    for (const field of ['collar_inner', 'collar_height']) {
      for (const value of [
        tape(-1),
        tape(0),
        tape(NaN),
        tape(Infinity),
        { ...tape(8), source: 'invented' },
        { ...tape(8), injected: true },
      ]) {
        expect(
          productSchema.safeParse({ ...product, sizes: { S: { [field]: value } } }).success,
        ).toBe(false);
      }
    }
  });
  it('matches paired, exact, physically bounded collar tape validation', () => {
    const valid = { collar_inner: tape(35), collar_height: tape(8) };
    const accepted = (size: unknown) =>
      productSchema.safeParse({ ...product, sizes: { S: size } }).success;
    expect(accepted({ collar_inner: null, collar_height: null })).toBe(true);
    expect(accepted({ collar_inner: tape(10), collar_height: tape(1) })).toBe(true);
    expect(accepted({ collar_inner: tape(100), collar_height: tape(30) })).toBe(true);
    for (const patch of [
      { collar_height: null },
      { collar_inner: null },
      { collar_inner: tape(9.99) },
      { collar_inner: tape(100.01) },
      { collar_height: tape(0.99) },
      { collar_height: tape(30.01) },
      { collar_inner: { ...tape(35), source: 'retailer_chart' } },
      { collar_inner: { ...tape(35), min_cm: 34, max_cm: 36 } },
      {
        collar_inner: {
          value_cm: null,
          min_cm: 34,
          max_cm: 36,
          source: 'tape_measured',
          source_detail: 'Fixture',
        },
      },
      { collar_height: { ...tape(8), uncertainty_cm: 8 } },
    ])
      expect(accepted({ ...valid, ...patch })).toBe(false);
    expect(accepted({ ...valid, collar_height: { ...tape(8), uncertainty_cm: 0.1 } })).toBe(true);
  });
  it('validates the collar fit zone and rejects non-finite or unknown zone data', () => {
    const collar = {
      value_cm: 2,
      lower_cm: 2,
      upper_cm: 2,
      metric: 'collar_inner_ease_cm',
      status: 'tight',
      explanation: 'Slightly snug; single calibration point',
      estimated: false,
    };
    const fit = (zone: unknown) => ({
      fit_id: 'a'.repeat(64),
      body_id: 'b'.repeat(64),
      product_id: 'c'.repeat(64),
      sizes: {
        S: {
          size: 'S',
          zones: { collar: zone },
          score: null,
          coverage: 0,
          estimated: false,
          geometry_available: false,
          missing_fields: [],
          anchors: {},
          polylines: {},
          warnings: [],
        },
      },
      recommended_size: null,
      explanation: 'Fixture',
      layer_cm: 0,
      preference: 'regular',
      loft_cm: null,
      loft_uncertainty_cm: 0,
      heatmap_tight_cm: 0.5,
      heatmap_loose_cm: 3,
      note: 'Fixture',
    });
    expect(garmentFitSchema.safeParse(fit(collar)).success).toBe(true);
    expect(garmentFitSchema.safeParse(fit({ ...collar, value_cm: NaN })).success).toBe(false);
    expect(
      garmentFitSchema.safeParse(fit({ ...collar, status: 'certainly-perfect' })).success,
    ).toBe(false);
    expect(garmentFitSchema.safeParse(fit({ ...collar, injected: 1 })).success).toBe(false);
  });
  it('accepts capabilities and rejects unknown fields', () => {
    const data = {
      phenotype_labels: ['height'],
      shape_reference_supported: true,
      shape_references: ['neutral'],
      measurements: ['stature'],
      default_density_kg_m3: 1010,
    };
    expect(capabilitiesSchema.safeParse(data).success).toBe(true);
    expect(capabilitiesSchema.safeParse({ ...data, injected: 1 }).success).toBe(false);
  });
  it('rejects invalid hashes, NaN and wrong frames', () => {
    expect(fitSchema.safeParse({ body_id: '../etc/passwd', mass_kg: NaN }).success).toBe(false);
    expect(
      landmarksSchema.safeParse({
        coordinate_frame: 'centimetres Z-up',
        landmarks: {},
        girth_polylines: {},
      }).success,
    ).toBe(false);
    expect(
      landmarksSchema.safeParse({
        coordinate_frame: 'metres Y-up +Z-front A-pose',
        landmarks: { head: [0, 1.7] },
        girth_polylines: {},
      }).success,
    ).toBe(false);
  });
  it('validates fetched responses instead of blindly casting', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ wrong: 'schema' }) }),
    );
    await expect(api.capabilities()).rejects.toThrow('invalid response');
  });
  it('reports an expired body and rejects path traversal before fetch', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal('fetch', fetch);
    expect(() => api.landmarks('../oops')).toThrow('Invalid body ID');
    expect(fetch).not.toHaveBeenCalled();
    await expect(api.landmarks('a'.repeat(64))).rejects.toThrow('expired');
  });
});
