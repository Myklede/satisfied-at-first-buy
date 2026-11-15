import { describe, expect, it } from 'vitest';
import { STILLNESS, StillnessLock } from './livePose';

/** Deterministic noise in [-1, 1]. */
function noise(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s / 2147483647) * 2 - 1;
  };
}

const FPS = 20;
const rest = { shoulder_L_elevation: 10, elbow_L_flexion: 15, shoulder_R_elevation: 12, elbow_R_flexion: 20, trunk_flexion: 0 };

describe('StillnessLock', () => {
  it('at rest with tracking noise the shown pose becomes exactly constant', () => {
    const lock = new StillnessLock();
    const rnd = noise(3);
    const outs: Record<string, number>[] = [];
    for (let f = 0; f < 80; f++) {
      const pose = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v + 0.7 * rnd()]));
      outs.push(lock.apply((f * 1000) / FPS, pose));
    }
    // After engage (250 ms + the filter settling), every frame is bit-identical.
    const late = outs.slice(20);
    for (const o of late) expect(o).toEqual(late[0]);
    expect(lock.lockedGroups).toEqual(expect.arrayContaining(['armL', 'armR', 'trunk']));
  });

  it('releases on the first frame of a real move (no onset lag) and follows it', () => {
    const lock = new StillnessLock();
    for (let f = 0; f < 30; f++) lock.apply((f * 1000) / FPS, rest);
    expect(lock.lockedGroups).toContain('armL');
    // The left arm rises at 200 deg/s from frame 30.
    let firstInputMove = -1,
      firstOutputMove = -1;
    for (let f = 30; f < 45; f++) {
      const rise = (200 * (f - 29)) / FPS;
      const out = lock.apply((f * 1000) / FPS, { ...rest, shoulder_L_elevation: rest.shoulder_L_elevation + rise });
      if (firstInputMove < 0 && rise > 1) firstInputMove = f;
      if (firstOutputMove < 0 && out.shoulder_L_elevation - rest.shoulder_L_elevation > 1) firstOutputMove = f;
    }
    expect(firstOutputMove - firstInputMove).toBeLessThanOrEqual(1);
    expect(firstOutputMove - firstInputMove).toBeGreaterThanOrEqual(0);
  });

  it('locks without a jump and keeps the other groups locked while one arm moves', () => {
    const lock = new StillnessLock();
    let prev = 0,
      maxStep = 0;
    for (let f = 0; f < 30; f++) {
      const out = lock.apply((f * 1000) / FPS, rest);
      if (f) maxStep = Math.max(maxStep, Math.abs(out.shoulder_R_elevation - prev));
      prev = out.shoulder_R_elevation;
    }
    expect(maxStep).toBeLessThan(1e-9);
    const lockedR = prev;
    for (let f = 30; f < 40; f++) {
      const out = lock.apply((f * 1000) / FPS, { ...rest, elbow_L_flexion: 15 + 8 * (f - 29) });
      expect(out.shoulder_R_elevation).toBe(lockedR);
    }
    expect(lock.lockedGroups).toContain('armR');
    expect(lock.lockedGroups).not.toContain('armL');
  });

  it('bands are about 2.5x the measured per-frame noise (documented values)', () => {
    expect(STILLNESS.band.shoulder_elevation).toBeGreaterThanOrEqual(1.5);
    expect(STILLNESS.band.elbow_flexion).toBeGreaterThanOrEqual(2);
    expect(STILLNESS.engageMs).toBe(250);
    expect(STILLNESS.releaseEaseMs).toBeLessThanOrEqual(80);
  });
});

describe('StillnessLock anchor', () => {
  it('locks at the mean of the raw values, not at a still-converging filter', () => {
    const lock = new StillnessLock();
    // Trunk flexion stepped from 6 to exactly 0 (a deadband upstream), then held.
    for (let f = 0; f < 3; f++) lock.apply((f * 1000) / FPS, { trunk_flexion: 6 });
    let out: Record<string, number> = {};
    for (let f = 3; f < 40; f++) out = lock.apply((f * 1000) / FPS, { trunk_flexion: 0 });
    expect(lock.lockedGroups).toContain('trunk');
    expect(Math.abs(out.trunk_flexion)).toBeLessThan(0.05);
  });

  it('a small sustained change below the band re-centres the lock once, after recenterMs', () => {
    const lock = new StillnessLock();
    for (let f = 0; f < 10; f++) lock.apply((f * 1000) / FPS, { trunk_flexion: 1.5 });
    const outs: number[] = [];
    for (let f = 10; f < 100; f++) outs.push(lock.apply((f * 1000) / FPS, { trunk_flexion: 0 }).trunk_flexion);
    expect(outs[5]).toBe(1.5); // held (below the band)
    expect(Math.abs(outs[outs.length - 1])).toBeLessThan(0.1); // re-centred
    // and still: the last second is constant
    const tail = outs.slice(-20);
    for (const v of tail) expect(v).toBe(tail[0]);
  });
});
