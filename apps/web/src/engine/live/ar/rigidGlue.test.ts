import { describe, expect, it } from 'vitest';
import { applySimilarity, armsHanging, fitSimilarity, RIGID, RigidFilter } from './rigidGlue';
import type { Control } from './warp';

const torso = (q: (p: [number, number]) => [number, number]): Control[] =>
  (
    [
      [300, 200],
      [500, 200],
      [320, 450],
      [480, 450],
    ] as [number, number][]
  ).map((p) => ({ p, q: q(p) }));

describe('rigid torso glue (F3, jelly)', () => {
  it('recovers a similarity exactly', () => {
    const a = 0.2,
      s = 1.1;
    const map = (p: [number, number]): [number, number] => [
      40 + s * (Math.cos(a) * p[0] - Math.sin(a) * p[1]),
      -15 + s * (Math.sin(a) * p[0] + Math.cos(a) * p[1]),
    ];
    const t = fitSimilarity(torso(map))!;
    expect(t.s).toBeCloseTo(s, 9);
    expect(t.theta).toBeCloseTo(a, 9);
    const q = applySimilarity(t, [410, 333]);
    const e = map([410, 333]);
    expect(q[0]).toBeCloseTo(e[0], 6);
    expect(q[1]).toBeCloseTo(e[1], 6);
  });

  it('noise on the controls does not bend the layer: one transform for every point', () => {
    let seed = 3;
    const noise = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280 - 0.5) * 4;
    const t = fitSimilarity(torso((p) => [p[0] + 5 + noise(), p[1] + 3 + noise()]))!;
    // Every grid point moves by the same rotation/scale: their relative layout is preserved.
    const a = applySimilarity(t, [300, 200]),
      b = applySimilarity(t, [500, 200]);
    expect(Math.hypot(b[0] - a[0], b[1] - a[1]) / 200).toBeCloseTo(t.s, 9);
  });

  it('the scale only moves beyond the backlash band; still frames hold exactly', () => {
    const f = new RigidFilter();
    const base = fitSimilarity(torso((p) => p))!;
    const first = f.apply(base, 0, false);
    const small = f.apply({ ...base, s: base.s * (1 + RIGID.scaleBand * 0.8) }, 33, false);
    expect(small.s).toBe(first.s);
    const big = f.apply({ ...base, s: base.s * 1.05 }, 66, false);
    expect(big.s).toBeGreaterThan(first.s);
    const held = f.apply({ ...base, q: [base.q[0] + 30, base.q[1]] }, 99, true);
    expect(held).toBe(big);
  });

  it('the width factor is slow and capped', () => {
    const f = new RigidFilter();
    const base = fitSimilarity(torso((p) => p))!;
    f.apply(base, 0, false, 0.5);
    let w = 0;
    for (let i = 1; i <= 60; i++) w = f.apply(base, i * 33, false, 0.5).width;
    expect(w).toBeLessThanOrEqual(RIGID.widthCap + 1e-9);
    expect(w).toBeGreaterThan(RIGID.widthCap * 0.9);
    // Narrowing (a 3D body fuller than the person) may go to widthCapIn.
    const g = new RigidFilter();
    g.apply(base, 0, false, -0.5);
    let n = 0;
    for (let i = 1; i <= 60; i++) n = g.apply(base, i * 33, false, -0.5).width;
    expect(n).toBeGreaterThanOrEqual(-RIGID.widthCapIn - 1e-9);
    expect(n).toBeLessThan(-RIGID.widthCapIn * 0.9);
  });

  it('turned: the frontal size and width hold (J3), unless a big change lasts (walking)', () => {
    const f = new RigidFilter();
    const base = fitSimilarity(torso((p) => p))!;
    const front = f.apply(base, 0, false, 0);
    // In profile the landmarks' torso grows 8 % and the contour asks for more width: held.
    let out = front;
    for (let i = 1; i <= 20; i++)
      out = f.apply({ ...base, s: base.s * 1.08 }, i * 40, false, 0.05, 70);
    expect(out.s).toBe(front.s);
    expect(out.width).toBe(front.width);
    // Seen from the back counts as frontal: the band applies again.
    out = f.apply({ ...base, s: base.s * 1.08 }, 900, false, 0, 175);
    expect(out.s).toBeGreaterThan(front.s);
    // Turned and 20 % off for longer than turnAcceptMs: accepted.
    const g = new RigidFilter();
    g.apply(base, 0, false, 0, 0);
    let late = g.apply({ ...base, s: base.s * 1.2 }, 40, false, 0, -60);
    expect(late.s).toBe(base.s);
    for (let t = 80; t <= 40 + RIGID.turnAcceptMs + 40; t += 40)
      late = g.apply({ ...base, s: base.s * 1.2 }, t, false, 0, -60);
    expect(late.s).toBeGreaterThan(base.s * 1.15);
  });

  it('a fast turn passes position and angle unfiltered (no lag in a turn)', () => {
    const f = new RigidFilter();
    const base = fitSimilarity(torso((p) => p))!;
    f.apply(base, 0, false, 0, 0);
    // Slow: the One Euro smooths a 40 px jump.
    const slow = f.apply({ ...base, q: [base.q[0] + 40, base.q[1]] }, 40, false, 0, 1);
    expect(slow.q[0]).toBeLessThan(base.q[0] + 40);
    // The heading swings 10 deg in 40 ms (250 deg/s): the raw position, at once.
    const fast = f.apply({ ...base, q: [base.q[0] + 80, base.q[1]] }, 80, false, 0, 11);
    expect(fast.q[0]).toBeCloseTo(base.q[0] + 80, 9);
  });

  it('armsHanging: arms by the sides yes; crossed or raised no', () => {
    const pose = (le: number[], lw: number[], re: number[], rw: number[]) => {
      const l = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 1 }));
      l[11] = { x: 500, y: 200, visibility: 1 };
      l[12] = { x: 300, y: 200, visibility: 1 };
      l[13] = { x: le[0], y: le[1], visibility: 1 };
      l[15] = { x: lw[0], y: lw[1], visibility: 1 };
      l[14] = { x: re[0], y: re[1], visibility: 1 };
      l[16] = { x: rw[0], y: rw[1], visibility: 1 };
      return l;
    };
    expect(armsHanging(pose([520, 330], [530, 450], [280, 330], [270, 450]))).toBe(true);
    // crossed: the wrists reach the other side
    expect(armsHanging(pose([520, 330], [330, 320], [280, 330], [470, 320]))).toBe(false);
    // raised: elbows above the shoulders
    expect(armsHanging(pose([600, 150], [700, 100], [200, 150], [100, 100]))).toBe(false);
    // a walking swing: the wrist 0.55 of the span outward still hangs
    expect(armsHanging(pose([560, 330], [610, 440], [280, 330], [270, 450]))).toBe(true);
    expect(armsHanging(null)).toBe(false);
  });
});
