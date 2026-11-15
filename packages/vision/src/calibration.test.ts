import { describe, expect, it } from 'vitest';
import current from '../calibration/current.json';
import {
  MIN_SIGMA_CM,
  PAIR_SCHEMA,
  UNCALIBRATED,
  UNCALIBRATED_GIRTH_SIGMA_REL,
  applyCalibration,
  fitCalibrationEntry,
  fitCalibrationSet,
  parseCalibrationPair,
  parseCalibrationSet,
  type CalibrationEntry,
} from './calibration';

const prior: CalibrationEntry = UNCALIBRATED.entries.chest_cm;

describe('calibration set', () => {
  it('committed current.json parses', () => {
    const set = parseCalibrationSet(current);
    expect(set.id).toMatch(/^[a-z0-9]/);
  });

  it('uncalibrated default is identity with non-zero sigma for every measurement', () => {
    for (const e of Object.values(UNCALIBRATED.entries)) {
      expect(e.a).toBe(1);
      expect(e.b).toBe(0);
      expect(e.sigma_cm + e.sigma_rel).toBeGreaterThan(0);
    }
    const r = applyCalibration(UNCALIBRATED, 'chest_cm', 100, 0);
    expect(r.value_cm).toBe(100);
    expect(r.sigma_cm).toBeCloseTo(100 * UNCALIBRATED_GIRTH_SIGMA_REL, 10);
    expect(r.calibrated).toBe(false);
  });

  it('combines calibration sigma and scan spread in quadrature, never below the floor', () => {
    const set = parseCalibrationSet({
      id: 'fit-test',
      entries: {
        chest_cm: {
          a: 1.1,
          b: -5,
          sigma_cm: 3,
          sigma_rel: 0,
          n_points: 6,
          n_persons: 6,
          source: 't',
        },
      },
    });
    const r = applyCalibration(set, 'chest_cm', 100, 4 / 1.1);
    expect(r.value_cm).toBeCloseTo(105, 10);
    expect(r.sigma_cm).toBeCloseTo(5, 10);
    expect(r.calibrated).toBe(true);
    const tiny = parseCalibrationSet({
      id: 'fit-tiny',
      entries: {
        hip_cm: { a: 1, b: 0, sigma_cm: 0.01, sigma_rel: 0, n_points: 9, n_persons: 9, source: '' },
      },
    });
    expect(applyCalibration(tiny, 'hip_cm', 90, 0).sigma_cm).toBe(MIN_SIGMA_CM);
    // missing entries fall back to the uncalibrated default
    expect(set.entries.waist_cm).toEqual(UNCALIBRATED.entries.waist_cm);
  });

  it('rejects unknown fields, bad ids and implausible coefficients', () => {
    expect(() => parseCalibrationSet({ id: 'x', entries: {}, extra: 1 })).toThrow(/unknown field/);
    expect(() => parseCalibrationSet({ id: '../etc', entries: {} })).toThrow(/id/);
    expect(() =>
      parseCalibrationSet({
        id: 'x',
        entries: { chest_cm: { a: 3, b: 0, sigma_cm: 1, sigma_rel: 0, n_points: 1, n_persons: 1 } },
      }),
    ).toThrow(/a must/);
    expect(() =>
      parseCalibrationSet({
        id: 'x',
        entries: { chest_cm: { a: 1, b: 0, sigma_cm: 0, sigma_rel: 0, n_points: 1, n_persons: 1 } },
      }),
    ).toThrow(/both be 0/);
  });
});

describe('fitting', () => {
  it('returns the prior without points', () => {
    expect(fitCalibrationEntry([], prior)).toEqual(prior);
  });

  it('fits only an offset with fewer than five people and keeps the prior sigma', () => {
    const e = fitCalibrationEntry(
      [
        { person_id: 'p1', raw: 100, tape: 97 },
        { person_id: 'p1', raw: 102, tape: 97 },
      ],
      prior,
    );
    expect(e.a).toBe(1);
    expect(e.b).toBeCloseTo(-4, 10);
    // residuals +1, −1 → SD √2
    expect(e.sigma_cm).toBeCloseTo(Math.hypot(prior.sigma_cm, Math.SQRT2), 10);
    expect(e.sigma_rel).toBe(prior.sigma_rel);
    expect(e.n_persons).toBe(1);
  });

  it('fits slope and offset by least squares with five or more people', () => {
    // tape = 0.9·raw + 4 exactly, plus ±0.5 alternating noise
    const pts = [80, 90, 100, 110, 120, 130].map((raw, i) => ({
      person_id: `p${i}`,
      raw,
      tape: 0.9 * raw + 4 + (i % 2 ? 0.5 : -0.5),
    }));
    const e = fitCalibrationEntry(pts, prior);
    // closed-form OLS on these points
    const n = pts.length;
    const mx = pts.reduce((s, p) => s + p.raw, 0) / n;
    const my = pts.reduce((s, p) => s + p.tape, 0) / n;
    const sxx = pts.reduce((s, p) => s + (p.raw - mx) ** 2, 0);
    const sxy = pts.reduce((s, p) => s + (p.raw - mx) * (p.tape - my), 0);
    expect(e.a).toBeCloseTo(sxy / sxx, 12);
    expect(e.b).toBeCloseTo(my - (sxy / sxx) * mx, 10);
    expect(e.sigma_rel).toBe(0);
    expect(e.sigma_cm).toBeGreaterThan(0.4);
    expect(e.sigma_cm).toBeLessThan(0.8);
  });

  it('parses pair records and fits a set from them', () => {
    const pair = parseCalibrationPair({
      schema: PAIR_SCHEMA,
      person_id: 'p01',
      captured_at: '2026-11-12T10:00:00Z',
      height_cm: 175,
      sex: 'male',
      calibration_used: 'uncalibrated',
      setup: { model: 'heavy' },
      frames: { front: 40, side: 38 },
      raw: { chest_cm: 101, shoulder_width_cm: 44 },
      raw_spread: { chest_cm: 0.8 },
      tape: { chest_cm: 98, shoulder_width_cm: null },
      notes: '',
    });
    const set = fitCalibrationSet([pair], 'fit-20261112-n1', '2026-11-12');
    expect(set.entries.chest_cm.b).toBeCloseTo(-3, 10);
    expect(set.entries.chest_cm.n_points).toBe(1);
    expect(set.entries.shoulder_width_cm).toEqual(UNCALIBRATED.entries.shoulder_width_cm);
    expect(() => parseCalibrationPair({ ...pair, person_id: 'Jane Doe' })).toThrow(/person_id/);
    expect(() => parseCalibrationPair({ ...pair, height_cm: 300 })).toThrow(/height_cm/);
    expect(() => parseCalibrationPair({ ...pair, surprise: true })).toThrow(/unknown field/);
  });
});
