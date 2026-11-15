import { describe, expect, it } from 'vitest';
import { PANEL } from '../../garmentSurface';
import { collarFrame, lowerCollarFront } from './collarFit';

/** A funnel collar: rings of 16 vertices, radius 7 cm about (0, 0), from y 1.40 to 1.48 m. */
function funnel(rows = 5) {
  const pos: number[] = [],
    panels: number[] = [];
  for (let r = 0; r < rows; r++)
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * Math.PI;
      pos.push(0.07 * Math.sin(a), 1.4 + (0.08 * r) / (rows - 1), 0.07 * Math.cos(a));
      panels.push(r === 0 ? PANEL.frontL : PANEL.collar);
    }
  const ring = (r: number) => Array.from({ length: 16 }, (_, k) => r * 16 + k);
  return {
    positions: Float32Array.from(pos),
    panels,
    paths: { neckline: ring(0), collar_top: ring(rows - 1) },
  };
}

describe('collar front fit (F3, D7)', () => {
  it('finds the funnel: centre, front base and top heights', () => {
    const { positions, paths } = funnel();
    const f = collarFrame(positions, paths)!;
    expect(f.cx).toBeCloseTo(0, 6);
    expect(f.cz).toBeCloseTo(0, 6);
    expect(f.base).toBeCloseTo(1.4, 5);
    expect(f.top).toBeCloseTo(1.48, 5);
  });

  it('lowers the collar top by the drop all round, keeps the seam', () => {
    const { positions, panels, paths } = funnel();
    const before = Float32Array.from(positions);
    const d = lowerCollarFront(positions, panels, paths, 0.03);
    expect(d).toBeCloseTo(0.03, 9);
    const top = 4 * 16;
    expect(positions[top * 3 + 1]).toBeCloseTo(1.45, 5); // k = 0: centre front, top row
    // The same drop all round: the side (k 4) and the back (k 8) too (the hood's seam translates).
    expect(positions[(top + 4) * 3 + 1]).toBeCloseTo(1.45, 5);
    expect(positions[(top + 8) * 3 + 1]).toBeCloseTo(1.45, 5);
    for (let k = 0; k < 16; k++) expect(positions[k * 3 + 1]).toBe(before[k * 3 + 1]); // seam
    // Monotone: every column still rises from the seam to the top.
    for (let k = 0; k < 16; k++)
      for (let r = 1; r < 5; r++)
        expect(positions[(r * 16 + k) * 3 + 1]).toBeGreaterThan(
          positions[((r - 1) * 16 + k) * 3 + 1],
        );
  });

  it('never squashes past maxShare of the collar height, and ignores no-drop', () => {
    const { positions, panels, paths } = funnel();
    expect(lowerCollarFront(positions, panels, paths, 0.2)).toBeCloseTo(0.95 * 0.08, 6);
    const again = funnel();
    expect(lowerCollarFront(again.positions, again.panels, again.paths, -0.01)).toBe(0);
    expect(lowerCollarFront(again.positions, again.panels, {}, 0.02)).toBe(0);
  });
});
