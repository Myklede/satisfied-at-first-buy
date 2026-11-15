import { describe, expect, it } from 'vitest';
import type { Rgb } from './colour';
import { SKIN_CHROMA } from './config';
import { faceNormal, fitFaceLight, smoothLight, type Vec3 } from './light';

/** A face crop's skin samples shaded by a0 + ax·nx + ay·ny (grey albedo). */
function face(a0: number, ax: number, ay: number, noise = 0) {
  const out: { n: Vec3; c: Rgb }[] = [];
  let seed = 3;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * noise;
  for (let j = 0; j < 16; j++)
    for (let i = 0; i < 16; i++) {
      const n = faceNormal(((i + 0.5) / 16) * 2 - 1, ((j + 0.5) / 16) * 2 - 1);
      const y = Math.max(0, a0 + ax * n[0] + ay * n[1] + rand());
      out.push({ n, c: [y * 1.5, y, y * 0.7] });
    }
  return out;
}

describe('scene light from the face (SH L1)', () => {
  it('a window on the image right lights the face from +x', () => {
    const l = fitFaceLight(face(0.25, 0.12, 0, 0.01))!;
    expect(l.dir[0]).toBeGreaterThan(0.6);
    expect(Math.abs(l.dir[1])).toBeLessThan(0.1);
    expect(l.confidence).toBeGreaterThan(0.5);
  });
  it('a ceiling light lights it from +y (image up); the left window from −x', () => {
    expect(fitFaceLight(face(0.25, 0, 0.1))!.dir[1]).toBeGreaterThan(0.6);
    expect(fitFaceLight(face(0.25, -0.12, 0))!.dir[0]).toBeLessThan(-0.6);
  });
  it('flat light: frontal direction, no confidence; too few samples: none', () => {
    const flat = fitFaceLight(face(0.25, 0, 0))!;
    expect(flat.dir).toEqual([0, 0, 1]);
    expect(flat.confidence).toBe(0);
    expect(fitFaceLight(face(0.25, 0.1, 0).slice(0, 10))).toBeNull();
  });
  it('ambient keeps the skin chroma; smoothing moves partway and stays unit length', () => {
    const l = fitFaceLight(face(0.25, 0.12, 0))!;
    // The skin (1.5, 1, 0.7) over its own chroma: the illuminant's r/g = 1.5 / SKIN_CHROMA r/g.
    expect(l.ambientRGB[0] / l.ambientRGB[1]).toBeCloseTo(1.5 / SKIN_CHROMA[0], 3);
    const left = fitFaceLight(face(0.25, -0.12, 0))!;
    const s = smoothLight(l, left, 0.5, 3);
    expect(s.dir[0]).toBeLessThan(l.dir[0]);
    expect(Math.hypot(...s.dir)).toBeCloseTo(1, 6);
  });
});
