import { describe, expect, it } from 'vitest';
import { TurnHeading } from './turnHeading';

const DEG = Math.PI / 180;
const P = { blendFromDeg: 20, blendToDeg: 45, maxJumpDeg: 70, persistMs: 300, agreeDeg: 5 };

describe('TurnHeading (f1turn)', () => {
  it('near facing draws the front solve, once turned the world yaw, smooth in between', () => {
    const h = new TurnHeading(P);
    expect(h.update(0, 2 * DEG, 9 * DEG, false) / DEG).toBeCloseTo(4, 6); // kept within agreeDeg of the world
    const mid = h.update(33, 25 * DEG, 32 * DEG, false) / DEG;
    expect(mid).toBeGreaterThan(25);
    expect(mid).toBeLessThan(32);
    expect(h.update(66, -50 * DEG, -60 * DEG, false) / DEG).toBeCloseTo(-60, 6);
  });

  it('follows the world yaw through the side onto the back (venue trace)', () => {
    const h = new TurnHeading(P);
    const world = [67, 88, 98, 117, 142, 163, -177, -170];
    const front = [52, 64, 72, 70, 49, 42, 20, 26];
    let t = 0,
      out = 0;
    for (let i = 0; i < world.length; i++)
      out = h.update((t += 70), front[i] * DEG, world[i] * DEG, i >= 3);
    expect(out / DEG).toBeCloseTo(-170, 6);
  });

  it('holds a label flip; takes it only when the back detector agrees (or within a hemisphere, when it persists)', () => {
    const h = new TurnHeading(P);
    h.update(0, 0, 5 * DEG, false);
    // Flip to the back for one frame, no back-view evidence: held.
    expect(Math.abs(h.update(33, 0, 175 * DEG, false))).toBeLessThan(10 * DEG);
    expect(h.debug!.held).toBe(true);
    expect(Math.abs(h.update(66, 0, 6 * DEG, false))).toBeLessThan(10 * DEG);
    // Confirmed by the detector: taken at once.
    expect(Math.abs(h.update(99, 0, 178 * DEG, true)) / DEG).toBeGreaterThan(170);
    // A jump into the other hemisphere is never taken on persistence alone (a label flip).
    const g = new TurnHeading(P);
    g.update(0, 0, 0, false);
    let last = 0;
    for (let t = 33; t <= 1000; t += 33) last = g.update(t, 0, 179 * DEG, false);
    expect(Math.abs(last) / DEG).toBeLessThan(10);
    // A big jump within the same hemisphere is taken once it persists.
    const k = new TurnHeading(P);
    k.update(0, 0, 0, false);
    for (let t = 33; t <= 400; t += 33) last = k.update(t, 0, -80 * DEG, false);
    expect(last / DEG).toBeCloseTo(-80, 6);
  });

  it('flipGuard (f1yawfast): a left/right mirror on the back is held although the detector says back', () => {
    // live5 look job 3b81cd 44.43-44.60 s: world yaw 112 -> -115 -> 119 on a back view.
    const run = (flipGuard: boolean) => {
      const h = new TurnHeading(P);
      h.flipGuard = flipGuard;
      const out: number[] = [];
      [108, 110, 112, -115, 119, 105].forEach((w, i) =>
        out.push(h.update(i * 66, 0, w * DEG, true) / DEG),
      );
      return out;
    };
    expect(run(false)[3]).toBeCloseTo(-115, 6);
    const on = run(true);
    expect(on[3]).toBeCloseTo(112, 6);
    expect(on[4]).toBeCloseTo(119, 6);
    // A same-hemisphere jump that persists is still taken.
    const k = new TurnHeading(P);
    k.flipGuard = true;
    let last = 0;
    k.update(0, 0, 100 * DEG, true);
    for (let t = 33; t <= 400; t += 33) last = k.update(t, 0, -100 * DEG, true);
    expect(last / DEG).toBeCloseTo(-100, 6);
  });

  it('a solve that disagrees with a facing world yaw is pulled to within agreeDeg', () => {
    const h = new TurnHeading(P);
    // Arms up: the solve reads 37° while the world yaw says 3°.
    expect(h.update(0, 37 * DEG, 3 * DEG, false) / DEG).toBeCloseTo(8, 6);
    expect(h.update(33, -20 * DEG, 3 * DEG, false) / DEG).toBeCloseTo(-2, 6);
    expect(h.update(66, 0, 6 * DEG, false) / DEG).toBeCloseTo(1, 6);
  });

  it('without world landmarks: the front yaw, mirrored on a detected back', () => {
    const h = new TurnHeading(P);
    expect(h.update(0, 10 * DEG, null, false) / DEG).toBeCloseTo(10, 6);
    expect(h.update(33, 10 * DEG, null, true) / DEG).toBeCloseTo(170, 6);
  });
});
