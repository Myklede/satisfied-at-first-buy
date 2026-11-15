import { describe, expect, it } from 'vitest';
import type { ImageLandmark } from '../contract';
import { PoseStabilizer, bodyScale } from './poseStabilizer';

/** A synthetic standing skeleton (px): the right arm raised overhead, the left arm down. */
function skeleton(dx = 0, dy = 0): ImageLandmark[] {
  const l: ImageLandmark[] = Array.from({ length: 33 }, () => ({
    x: 640,
    y: 300,
    visibility: 0.99,
  }));
  const set = (i: number, x: number, y: number, v = 0.99) =>
    (l[i] = { x: x + dx, y: y + dy, visibility: v });
  set(0, 660, 120);
  set(11, 750, 220); // left shoulder (image right)
  set(12, 570, 210); // right shoulder
  set(13, 760, 375);
  set(14, 545, 75); // right elbow, raised
  set(15, 770, 500);
  set(16, 620, 0, 0.9); // right wrist overhead
  set(17, 772, 530);
  set(19, 768, 535);
  set(21, 765, 520);
  set(18, 625, -30, 0.85);
  set(20, 615, -32, 0.85);
  set(22, 618, -20, 0.85);
  set(23, 720, 500);
  set(24, 600, 500);
  return l;
}

describe('PoseStabilizer (f1stab)', () => {
  it('passes a still or smoothly moving person through unchanged (no added latency)', () => {
    const s = new PoseStabilizer();
    for (let i = 0; i < 30; i++) {
      const raw = skeleton(i * 6, Math.sin(i / 3) * 2); // walking sideways at ~90 px/s
      const out = s.update(i * 66, raw, null);
      expect(out.held).toEqual([]);
      expect(out.landmarks2d![16].x).toBe(raw[16].x);
    }
  });

  it('holds a one-frame arm hypothesis switch (venue 18.05 s: the raised arm flashed down)', () => {
    const s = new PoseStabilizer();
    for (let i = 0; i < 5; i++) s.update(i * 66, skeleton(), null);
    const glitch = skeleton();
    glitch[14] = { x: 553, y: 245, visibility: 0.98 }; // elbow drops 170 px, upper arm 135 → 59 px
    glitch[16] = { x: 614, y: 212, visibility: 0.87 };
    const out = s.update(5 * 66, glitch, null);
    expect(out.held).toEqual(expect.arrayContaining([14, 16]));
    expect(out.landmarks2d![14].y).toBeCloseTo(75, 6);
    expect(out.landmarks2d![16].y).toBeCloseTo(0, 6);
    // The next frame is back on the raised arm: accepted as it is.
    const next = skeleton();
    next[14] = { x: 550, y: 83, visibility: 0.98 };
    const after = s.update(6 * 66, next, null);
    expect(after.held).toEqual([]);
    expect(after.landmarks2d![14].y).toBe(83);
  });

  it('accepts a real fast arm drop once it repeats (one frame late at most)', () => {
    const s = new PoseStabilizer();
    for (let i = 0; i < 5; i++) s.update(i * 66, skeleton(), null);
    const down = skeleton();
    down[14] = { x: 553, y: 245, visibility: 0.98 };
    down[16] = { x: 614, y: 212, visibility: 0.87 };
    expect(s.update(5 * 66, down, null).held.length).toBeGreaterThan(0);
    const again = s.update(6 * 66, down, null);
    expect(again.held).toEqual([]);
    expect(again.landmarks2d![14].y).toBe(245);
  });

  it('holds a whole-frame jump and a left/right swap, accepts them when they persist', () => {
    const s = new PoseStabilizer();
    for (let i = 0; i < 5; i++) s.update(i * 66, skeleton(), null);
    const swapped = skeleton();
    [swapped[11], swapped[12]] = [swapped[12], swapped[11]];
    const out = s.update(5 * 66, swapped, null);
    expect(out.frameHeld).toBe('swap');
    expect(out.landmarks2d![11].x).toBeCloseTo(750, 6);
    // Persisting (a real re-detection): accepted on the next frame.
    expect(s.update(6 * 66, swapped, null).frameHeld).toBeNull();
    const t = new PoseStabilizer();
    for (let i = 0; i < 5; i++) t.update(i * 66, skeleton(), null);
    expect(t.update(5 * 66, skeleton(400, 0), null).frameHeld).toBe('centre');
  });

  it('never holds longer than maxHoldMs', () => {
    const s = new PoseStabilizer({ ...new PoseStabilizer().params, maxHoldMs: 150 });
    for (let i = 0; i < 5; i++) s.update(i * 66, skeleton(), null);
    let heldRun = 0,
      longest = 0;
    for (let i = 5; i < 20; i++) {
      // Alternating hypotheses every frame never repeat, but no hold outlasts maxHoldMs.
      const g = skeleton();
      g[14] = { x: 553, y: i % 2 ? 245 : 300, visibility: 0.98 };
      heldRun = s.update(i * 66, g, null).held.includes(14) ? heldRun + 1 : 0;
      longest = Math.max(longest, heldRun);
    }
    expect(longest * 66).toBeLessThanOrEqual(150 + 66);
  });

  it('scale: shoulder span or shoulder-to-hip distance, whichever is larger', () => {
    expect(bodyScale(skeleton())).toBeGreaterThan(280);
  });
});
