import { describe, expect, it } from 'vitest';
import {
  averageSrgb,
  containPoint,
  deltaE2000,
  deltaE2000Rgb,
  parseHex,
  rgbToLab,
  toHex,
  type Lab,
} from './colour';

// Sharma, Wu & Dalal (2005), Table 1: a subset of the published test pairs.
const sharma: [Lab, Lab, number][] = [
  [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
  [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
  [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
  [[50, 0, 0], [50, -1, 2], 2.3669],
  [[50, 2.5, 0], [73, 25, -18], 27.1492],
  [[50, 2.5, 0], [61, -5, 29], 22.8977],
  [[50, 2.5, 0], [56, -27, -3], 31.903],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.263],
  [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
];

describe('CIEDE2000', () => {
  it.each(sharma)('matches the published value for %j vs %j', (a, b, expected) => {
    expect(deltaE2000(a, b)).toBeCloseTo(expected, 3);
  });
  it('is symmetric and zero for identical colours', () => {
    const a = rgbToLab([200, 180, 140]),
      b = rgbToLab([190, 175, 150]);
    expect(deltaE2000(a, a)).toBe(0);
    expect(deltaE2000(a, b)).toBeCloseTo(deltaE2000(b, a), 10);
  });
});

describe('sRGB to CIELAB', () => {
  it('maps white, black and mid grey to the known L*', () => {
    expect(rgbToLab([255, 255, 255])[0]).toBeCloseTo(100, 2);
    expect(Math.abs(rgbToLab([255, 255, 255])[1])).toBeLessThan(0.01);
    expect(rgbToLab([0, 0, 0])[0]).toBeCloseTo(0, 6);
    expect(rgbToLab([119, 119, 119])[0]).toBeCloseTo(50, 0);
  });
  it('gives the textbook Lab of sRGB red', () => {
    const [L, a, b] = rgbToLab([255, 0, 0]);
    expect(L).toBeCloseTo(53.24, 1);
    expect(a).toBeCloseTo(80.09, 1);
    expect(b).toBeCloseTo(67.2, 1);
  });
  it('black vs white is about 100', () => {
    expect(deltaE2000Rgb([0, 0, 0], [255, 255, 255])).toBeCloseTo(100, 0);
  });
});

describe('hex helpers', () => {
  it('round-trips and validates', () => {
    expect(toHex(parseHex('#C8B58A'))).toBe('#c8b58a');
    expect(() => parseHex('red')).toThrow();
    expect(toHex([300, -4, 12.4])).toBe('#ff000c');
  });
});

describe('sampling helpers', () => {
  it('averages in linear light and ignores transparent pixels', () => {
    // black + white average to sRGB 188 (linear 0.5), not 128.
    const out = averageSrgb([0, 0, 0, 255, 255, 255, 255, 255, 9, 9, 9, 0]);
    expect(out[0]).toBe(188);
    expect(() => averageSrgb([1, 2, 3, 0])).toThrow();
  });
  it('maps a click through object-fit: contain, rejecting the letterbox', () => {
    const box = { left: 100, top: 50, width: 400, height: 200 };
    const natural = { width: 100, height: 100 }; // drawn 200x200 centred at x 200..400
    expect(containPoint(box, natural, 300, 150)).toEqual({ x: 50, y: 50 });
    expect(containPoint(box, natural, 150, 150)).toBeNull();
    expect(containPoint(box, natural, 200, 50)).toEqual({ x: 0, y: 0 });
    expect(containPoint(box, { width: 0, height: 0 }, 300, 150)).toBeNull();
  });
});
