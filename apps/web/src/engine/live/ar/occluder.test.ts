import { describe, expect, it } from 'vitest';
import { occluderIndex } from './occluder';

describe('AR body occluder', () => {
  it('keeps torso and arm skin, drops hands and legs', () => {
    // 6 vertices: 0–2 on the spine, 3 half hand / half forearm, 4 on a finger, 5 on a thigh.
    const bones = ['spine01', 'lowerarm01.L', 'finger2-1.L', 'upperleg01.L'];
    const rig = {
      bones,
      influences: 2,
      vertexCount: 6,
      skinIndices: Uint16Array.from([0, 0, 0, 0, 0, 0, 1, 2, 2, 2, 3, 3]),
      skinWeights: Float32Array.from([1, 0, 1, 0, 1, 0, 0.6, 0.4, 1, 0, 1, 0]),
      faces: Uint32Array.from([0, 1, 2, 0, 1, 3, 1, 3, 4, 2, 5, 0]),
    };
    expect(Array.from(occluderIndex(rig))).toEqual([0, 1, 2, 0, 1, 3]);
  });
});
