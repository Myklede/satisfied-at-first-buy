import { describe, expect, it } from 'vitest';
import { easeAzimuth, shortestAngle } from './orbit';

describe('orbit helpers', () => {
  it('takes the shortest way round', () => {
    expect(shortestAngle(0, 0.5)).toBeCloseTo(0.5);
    expect(shortestAngle(3, -3)).toBeCloseTo(2 * Math.PI - 6);
    expect(shortestAngle(-3, 3)).toBeCloseTo(6 - 2 * Math.PI);
    expect(Math.abs(shortestAngle(Math.PI, -Math.PI))).toBeCloseTo(0);
  });

  it('eases toward the front and snaps at the end', () => {
    let az = 2.5;
    for (let i = 0; i < 200 && az !== 0; i++) az = easeAzimuth(az, 0, 1 / 60);
    expect(az).toBe(0);
    expect(Math.abs(easeAzimuth(1, 0, 1 / 60))).toBeLessThan(1);
    expect(easeAzimuth(0.001, 0, 1 / 60)).toBe(0);
  });
});
