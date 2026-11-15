// Body regions for the dynamics' collisions, from the rig's skin weights, with the same
// thresholds the live skinning binds with (garmentSkin.ts): a sleeve particle collides with skin
// of its own arm, a torso or hood particle with the trunk and legs (never an arm: the arms are
// handled as capsules, since they swing through the space beside the torso).
import type { MotionRig } from '../../motion/rig.ts';
import { SLEEVE_ARM_WEIGHT_MIN, TORSO_LIMB_WEIGHT_MAX } from '../garmentSkin.ts';
import { BODY_ARM_L, BODY_ARM_R, BODY_TRUNK } from './types.ts';

export function bodyRegions(rig: MotionRig): Uint8Array {
  const armL = new Set<number>(),
    armR = new Set<number>();
  rig.drivers.forEach((bone, d) => {
    const name = rig.bones[bone];
    if (/^(upperarm01|lowerarm01)\.L$/.test(name)) armL.add(d);
    else if (/^(upperarm01|lowerarm01)\.R$/.test(name)) armR.add(d);
  });
  const K = rig.influences;
  const out = new Uint8Array(rig.vertexCount);
  for (let v = 0; v < rig.vertexCount; v++) {
    let l = 0,
      r = 0;
    for (let k = 0; k < K; k++) {
      const w = rig.skinWeights[v * K + k];
      if (!w) continue;
      const d = rig.vertexDrivers[v * K + k];
      if (armL.has(d)) l += w;
      else if (armR.has(d)) r += w;
    }
    let flags = 0;
    if (l + r < TORSO_LIMB_WEIGHT_MAX) flags |= BODY_TRUNK;
    if (l >= SLEEVE_ARM_WEIGHT_MIN) flags |= BODY_ARM_L;
    if (r >= SLEEVE_ARM_WEIGHT_MIN) flags |= BODY_ARM_R;
    out[v] = flags;
  }
  return out;
}
