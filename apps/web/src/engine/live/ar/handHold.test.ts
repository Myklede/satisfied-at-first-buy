import { describe, expect, it } from 'vitest';
import type { ImageLandmark } from '../contract';
import { HAND_HOLD_MS, HandHold, tucked, type Capsule } from './handHold';

const lm = (wrists: Record<number, [number, number, number]>) => {
  const l: ImageLandmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  for (const [i, [x, y, v]] of Object.entries(wrists)) l[Number(i)] = { x, y, visibility: v };
  return l;
};
const cap = (x: number, y: number, radius = 20): Capsule => ({
  a: [x, y],
  b: [x, y + 40],
  radius,
  depth: 1.2,
});

describe('hand-capsule hold (F3, D3 flicker)', () => {
  it('keeps a vanished capsule while its wrist is tracked, moved with the wrist', () => {
    const h = new HandHold();
    expect(h.update(0, [cap(100, 200)], lm({ 15: [100, 200, 0.9] }))).toHaveLength(1);
    // Knuckles lost: no capsule from the compositor, wrist still seen (0.4) and moved by 5 px.
    const held = h.update(70, [], lm({ 15: [105, 202, 0.4] }));
    expect(held).toHaveLength(1);
    expect(held[0].a).toEqual([105, 202]);
    expect(held[0].b).toEqual([105, 242]);
    // Beyond the hold, or with the wrist lost, it is gone.
    expect(h.update(70 + HAND_HOLD_MS + 1, [], lm({ 15: [105, 202, 0.4] }))).toHaveLength(0);
    const h2 = new HandHold();
    h2.update(0, [cap(100, 200)], lm({ 15: [100, 200, 0.9] }));
    expect(h2.update(50, [], lm({ 15: [100, 200, 0.05] }))).toHaveLength(0);
  });

  it('limits the radius step between frames', () => {
    const h = new HandHold();
    h.update(0, [cap(100, 200, 20)], lm({ 15: [100, 200, 0.9] }));
    const [c] = h.update(33, [cap(100, 200, 40)], lm({ 15: [100, 200, 0.9] }));
    expect(c.radius).toBeCloseTo(24, 9);
  });

  it('handles both hands independently', () => {
    const h = new HandHold();
    h.update(0, [cap(100, 200), cap(300, 200)], lm({ 15: [100, 200, 0.9], 16: [300, 200, 0.9] }));
    const out = h.update(33, [cap(300, 200)], lm({ 15: [100, 200, 0.3], 16: [300, 200, 0.9] }));
    expect(out).toHaveLength(2);
  });
});

describe('tucked hands (F3, D3 specks)', () => {
  it('a wrist against the other upper arm gets no capsule; a free hand keeps it', () => {
    // Shoulders 11 (300,200) / 12 (100,200), elbows 13 (320,320) / 14 (80,320): span 200.
    const base = {
      11: [300, 200, 0.9],
      12: [100, 200, 0.9],
      13: [320, 320, 0.9],
      14: [80, 320, 0.9],
    } as Record<number, [number, number, number]>;
    const h = new HandHold();
    // Left wrist (15) at (95, 290): 15 px from the right upper arm (12 -> 14): tucked.
    const crossed = lm({ ...base, 15: [95, 290, 0.9] });
    expect(tucked(crossed, 0)).toBe(true);
    expect(h.update(0, [cap(95, 290)], crossed)).toHaveLength(0);
    // In front of the chest, far from both upper arms: kept.
    const free = lm({ ...base, 15: [200, 300, 0.9] });
    expect(tucked(free, 0)).toBe(false);
    expect(h.update(33, [cap(200, 300)], free)).toHaveLength(1);
  });
});
