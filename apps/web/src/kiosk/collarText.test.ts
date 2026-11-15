import { describe, expect, it } from 'vitest';
import type { SizeFit } from '../api';
import { collarLine } from './fitSummary';

const size = (overrides: object = {}) =>
  ({
    zones: {
      collar: {
        metric: 'collar_inner_ease_cm',
        status: 'tight',
        value_cm: 2,
        estimated: true,
        explanation:
          'Collar: slightly snug at the neck; inner tape minus neck section is +2.0 cm. Based on one measured collar.',
        ...overrides,
      },
    },
  }) as unknown as SizeFit;

describe('collar result text', () => {
  it('keeps the API classification and computed ease, with the calibration limits visible', () => {
    const text = collarLine(size(), 'metric');
    expect(text).toContain('Collar: slightly snug at the neck (+2.0 cm ease; estimated neck).');
    expect(text).toContain(
      'One collar measured; other sizes not measured; thresholds uncalibrated.',
    );
    expect(collarLine(size(), 'imperial')).toContain('+0.8 in ease');
    // The UI does not reinterpret the service's classification using a second cutoff.
    expect(collarLine(size({ value_cm: 3 }), 'metric')).toContain('slightly snug');
  });

  it('preserves the actual reason for an unknown zone, including an unreliable neck section', () => {
    expect(
      collarLine(
        size({
          status: 'unknown',
          value_cm: null,
          explanation: 'Collar: not measured for this size; no neck-fit claim',
        }),
        'metric',
      ),
    ).toBe('Collar: not measured for this size.');
    const text = collarLine(
      size({
        status: 'unknown',
        value_cm: null,
        explanation: 'Collar: body neck estimate unavailable; the neck section is unreliable',
      }),
      'metric',
    );
    expect(text).toBe('Collar: body neck estimate unavailable.');
    expect(text).not.toContain('ease');
    expect(text).not.toContain('not measured');
  });

  it('keeps the API jaw-cap qualification visible in the main label', () => {
    const text = collarLine(
      size({
        explanation:
          'Collar: slightly snug at the neck (estimated neck near its base, capped below jaw); the requested height extends outside the validated neck surface',
      }),
      'metric',
    );
    expect(text).toContain('estimated neck near its base, capped below jaw');
    expect(text).toContain('+2.0 cm ease');
    expect(text).toContain('thresholds uncalibrated');
  });

  it('makes no fit claim for absent, unrecognised or non-finite data', () => {
    expect(collarLine(undefined, 'metric')).toBeNull();
    expect(collarLine({ zones: {} } as SizeFit, 'metric')).toBeNull();
    expect(collarLine(size({ metric: 'something_else' }), 'metric')).toBe(
      'Collar: estimate unavailable.',
    );
    expect(collarLine(size({ value_cm: NaN }), 'metric')).toBe('Collar: estimate unavailable.');
  });
});
