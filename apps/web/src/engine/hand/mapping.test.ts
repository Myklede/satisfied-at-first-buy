import { describe, expect, it } from 'vitest';
import {
  cursorState,
  ndcToPixels,
  percentile,
  pinchPoint,
  selectPatch,
  toViewport,
  vertexAdjacency,
} from './mapping';
import { clampLength, stepToward } from './pullDriver';

describe('hand mapping', () => {
  it('maps the centred active box to the whole viewport and clamps outside it', () => {
    expect(toViewport({ x: 0.35, y: -0.35 }, 0.7)).toEqual({ x: 0.5, y: -0.5 });
    expect(toViewport({ x: 0.7, y: 0.9 }, 0.7)).toEqual({ x: 1, y: 1 });
    expect(toViewport({ x: -2, y: 0 }, 0.7).x).toBe(-1);
    expect(() => toViewport({ x: 0, y: 0 }, 0)).toThrow();
  });

  it('converts NDC to pixels with y down', () => {
    expect(ndcToPixels({ x: -1, y: 1 }, 200, 100)).toEqual({ x: 0, y: 0 });
    expect(ndcToPixels({ x: 1, y: -1 }, 200, 100)).toEqual({ x: 200, y: 100 });
  });

  it('pinch point is the thumb/index tip midpoint', () => {
    const lm = Array.from({ length: 21 }, () => ({ x: 0, y: 0 }));
    lm[4] = { x: 0.2, y: 0.4 };
    lm[8] = { x: 0.4, y: 0 };
    const p = pinchPoint(lm);
    expect(p.x).toBeCloseTo(0.3, 12);
    expect(p.y).toBeCloseTo(0.2, 12);
  });

  it('selects a connected patch with smooth weights and skips a near but unconnected layer', () => {
    // Two 5×5 sheets 1 cm apart (front and back layer), spacing 1 cm.
    const pos: number[] = [],
      tri: number[] = [];
    for (let layer = 0; layer < 2; layer++)
      for (let j = 0; j < 5; j++)
        for (let i = 0; i < 5; i++) pos.push(i * 0.01, j * 0.01, layer * 0.01);
    for (let layer = 0; layer < 2; layer++)
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 4; i++) {
          const a = layer * 25 + j * 5 + i;
          tri.push(a, a + 1, a + 6, a, a + 6, a + 5);
        }
    const adj = vertexAdjacency(tri, 50);
    const centre = 12; // (2, 2) on the front layer
    const { ids, weights } = selectPatch(pos, adj, [centre], [0.02, 0.02, 0], 0.015, 0.35);
    expect(ids).toContain(centre);
    expect(ids.every((i) => i < 25)).toBe(true); // back layer (1 cm away) not grabbed
    expect(ids.length).toBe(9); // centre + 4 at 1 cm + 4 at 1.41 cm
    expect(weights[ids.indexOf(centre)]).toBe(1);
    const corner = weights[ids.indexOf(6)];
    expect(corner).toBeGreaterThanOrEqual(0.35);
    expect(corner).toBeLessThan(weights[ids.indexOf(7)]);
  });

  it('cursor state priorities', () => {
    const base = { grabbing: false, resisting: false, missed: false, grabProgress: 0 };
    expect(cursorState(base)).toBe('open');
    expect(cursorState({ ...base, grabProgress: 0.5 })).toBe('confirming');
    expect(cursorState({ ...base, missed: true, grabProgress: 1 })).toBe('missed');
    expect(cursorState({ ...base, grabbing: true })).toBe('grabbing');
    expect(cursorState({ ...base, grabbing: true, resisting: true })).toBe('resisting');
  });

  it('percentile', () => {
    expect(percentile([3, 1, 2, 4], 50)).toBe(2.5);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([], 50)).toBeNaN();
  });

  it('target rate limit and reach cap', () => {
    expect(stepToward([0, 0, 0], [0.1, 0, 0], 0.02)).toEqual([0.02, 0, 0]);
    expect(stepToward([0, 0, 0], [0.01, 0, 0], 0.02)).toEqual([0.01, 0, 0]);
    const c = clampLength([0.03, 0.04, 0], 0.025);
    expect(Math.hypot(...c)).toBeCloseTo(0.025, 12);
    expect(clampLength([0.01, 0, 0], 0.025)).toEqual([0.01, 0, 0]);
  });
});
