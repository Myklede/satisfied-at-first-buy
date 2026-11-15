import { describe, expect, it } from 'vitest';
import { StillnessLock } from './livePose';

describe('shared mirror still decision', () => {
  it('holds all pose values exactly and releases immediately without a local ease', () => {
    const lock = new StillnessLock();
    const first = { trunk_flexion: 3, shoulder_L_elevation: 12, knee_L_flexion: 0 };
    expect(lock.apply(0, first, { still: true })).toEqual(first);
    expect(
      lock.apply(5000, { trunk_flexion: 8, shoulder_L_elevation: 30 }, { still: true }),
    ).toEqual(first);
    expect(lock.lockedGroups).toEqual(['trunk', 'armL', 'legs']);
    const moved = { trunk_flexion: 9, shoulder_L_elevation: 31 };
    expect(lock.apply(5033, moved, { still: false })).toEqual(moved);
    expect(lock.lockedGroups).toEqual([]);
    expect(lock.apply(5066, moved, { still: true })).toEqual(moved);
  });

  it('snapshots inputs and outputs; reset drops the old anchor', () => {
    const lock = new StillnessLock();
    const pose = { trunk_flexion: 1 };
    const output = lock.apply(0, pose, { still: true });
    pose.trunk_flexion = output.trunk_flexion = 7;
    expect(lock.apply(100, pose, { still: true }).trunk_flexion).toBe(1);
    lock.reset();
    expect(lock.apply(200, pose, { still: true }).trunk_flexion).toBe(7);
  });
});
