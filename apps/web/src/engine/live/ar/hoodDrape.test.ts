import { describe, expect, it } from 'vitest';
import { drapeHood, HOOD_KEEP, HOOD_KEEP_BACK } from './hoodDrape';

/**
 * A standing hood: 5 seam columns behind the neck at y 1.50, z −0.08, each rising to y 1.75 and
 * leaning back to z −0.18 (the bowl round the back of the head).
 */
function standingHood() {
  const pos: number[] = [],
    sigma: number[] = [],
    attach: number[] = [];
  for (let c = 0; c < 5; c++)
    for (let r = 0; r <= 5; r++) {
      pos.push(-0.08 + c * 0.04, 1.5 + r * 0.05, -0.08 - r * 0.02);
      sigma.push(c / 4);
      attach.push(r === 0 ? 1 : 0);
    }
  return { positions: Float32Array.from(pos), sigma, attach };
}

describe('hood drape (F3, U3: the hood lies down)', () => {
  it('keeps the seam, collapses the top to HOOD_KEEP of its height and depth toward the seam', () => {
    const { positions, sigma, attach } = standingHood();
    const before = Float32Array.from(positions);
    const removed = drapeHood(positions, sigma, attach);
    expect(removed).toBeCloseTo(0.25 * (1 - HOOD_KEEP), 6);
    for (let c = 0; c < 5; c++) {
      const seam = c * 6,
        top = c * 6 + 5;
      expect(positions[seam * 3 + 1]).toBe(before[seam * 3 + 1]); // sewn on
      expect(positions[top * 3 + 1]).toBeCloseTo(1.5 + 0.25 * HOOD_KEEP, 6);
      // Depth behind the seam 0.10 -> HOOD_KEEP_BACK of it: never pushed further back (no brim).
      expect(positions[top * 3 + 2]).toBeCloseTo(-0.08 - 0.1 * HOOD_KEEP_BACK, 6);
      expect(positions[top * 3 + 2]).toBeGreaterThan(before[top * 3 + 2]);
      // Still ordered bottom to top (no fold).
      for (let r = 1; r <= 5; r++)
        expect(positions[(c * 6 + r) * 3 + 1]).toBeGreaterThan(positions[(c * 6 + r - 1) * 3 + 1]);
    }
  });

  it('does nothing without a seam', () => {
    const { positions, sigma } = standingHood();
    expect(drapeHood(positions, sigma, new Array(sigma.length).fill(0))).toBe(0);
  });
});
