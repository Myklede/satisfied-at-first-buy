import { describe, expect, it } from 'vitest';
import type { ClothAsset } from '../../api';
import { chamberProfile, fabricAux, foldAmplitude } from './fabric';

describe('chamberProfile', () => {
  it('is pinched at stitch lines, full at the centre and symmetric', () => {
    expect(chamberProfile(0.5, 0.5).height).toBeCloseTo(1, 12);
    expect(chamberProfile(0.5, 0.5).slope).toBeCloseTo(0, 12);
    expect(chamberProfile(0, 0.5).height).toBeLessThan(0.25);
    expect(chamberProfile(0.2, 0.5).height).toBeCloseTo(chamberProfile(0.8, 0.5).height, 12);
    const h = 1e-6,
      fd = (chamberProfile(0.3 + h, 0.7).height - chamberProfile(0.3 - h, 0.7).height) / (2 * h);
    expect(chamberProfile(0.3, 0.7).slope).toBeCloseTo(fd, 5);
  });
});

describe('foldAmplitude', () => {
  it('stores the measured excess length in a sine of that amplitude', () => {
    const L = 0.05,
      c = 0.04,
      A = foldAmplitude(c, L, 1);
    // Arc length of A sin(2 pi x / L) over one wavelength, numerically.
    let arc = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const slope = ((A * 2 * Math.PI) / L) * Math.cos((2 * Math.PI * (i + 0.5)) / n);
      arc += (L / n) * Math.sqrt(1 + slope * slope);
    }
    expect(arc / L - 1).toBeCloseTo(c, 2);
    expect(foldAmplitude(0, L, 1)).toBe(0);
    expect(foldAmplitude(0.5, L, 0.002)).toBe(0.002);
  });
});

describe('fabricAux', () => {
  it('measures torso arc from centre back and wraps at the front', () => {
    // One torso ring of 8 vertices: u from CF (index 2) increasing toward the back.
    const n = 8,
      r = 0.15,
      positions: number[] = [],
      uv: number[] = [];
    const step = (2 * Math.PI * r) / n;
    for (let j = 0; j < n; j++) {
      const a = (j * 2 * Math.PI) / n;
      positions.push(r * Math.cos(a), 1, r * Math.sin(a));
      uv.push((j - 2) * step, 0.2);
    }
    const asset = {
      panels: Array(n).fill(2),
      render_uv: uv,
    } as unknown as ClothAsset;
    const aux = fabricAux(asset, positions);
    // Vertex 6 is at the back (z < 0, x = 0): zero arc from CB.
    expect(aux[6 * 3]).toBeCloseTo(0, 6);
    expect(aux[5 * 3]).toBeCloseTo(-step, 6);
    expect(Math.abs(aux[2 * 3])).toBeCloseTo(4 * step, 6);
    expect(aux[2 * 3 + 2]).toBe(2);
  });
});
