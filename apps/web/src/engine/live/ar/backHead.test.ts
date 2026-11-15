import { describe, expect, it } from 'vitest';
import type { ImageLandmark } from '../contract';
import { backHeadCapsule, HEAD_OF_EARS } from './backHead';

const lm = (points: Record<number, [number, number, number]>) => {
  const l: ImageLandmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  for (const [i, [x, y, v]] of Object.entries(points)) l[Number(i)] = { x, y, visibility: v };
  return l;
};

describe('back-view head capsule (F3)', () => {
  it('only in back views', () => {
    const l = lm({ 7: [380, 100, 0.8], 8: [420, 100, 0.8] });
    expect(backHeadCapsule(l, false, 0)).toBeNull();
    expect(backHeadCapsule(l, false, 60)).toBeNull();
    expect(backHeadCapsule(l, true, 0)).not.toBeNull();
    expect(backHeadCapsule(l, false, -150)).not.toBeNull();
  });

  it('round the head from the ears: centred, nape covered, radius from the ear spacing', () => {
    const c = backHeadCapsule(lm({ 7: [380, 100, 0.8], 8: [420, 100, 0.8] }), true, 180)!;
    const r = HEAD_OF_EARS * 40;
    expect(c.a[0]).toBeCloseTo(400, 6);
    expect(c.b[0]).toBeCloseTo(400, 6);
    expect(c.a[1]).toBeLessThan(100);
    expect(c.b[1]).toBeGreaterThan(100);
    // Bottom of the capsule (the nape) ~1.4 head radii below the ears.
    expect(c.b[1] + c.radius - 100).toBeCloseTo(0.35 * r + 1.1 * r, 6);
  });

  it('falls back to the shoulders when the ears are not seen', () => {
    const c = backHeadCapsule(
      lm({ 7: [0, 0, 0.1], 8: [0, 0, 0.1], 11: [500, 300, 0.9], 12: [300, 300, 0.9] }),
      true,
      180,
    )!;
    expect(c.a[0]).toBeCloseTo(400, 6);
    expect((c.a[1] + c.b[1]) / 2).toBeLessThan(300 - 0.4 * 200);
    expect(backHeadCapsule(lm({}), true, 180)).toBeNull();
  });
});
