// Which posed-body triangles may hide the jacket in the AR view (agent V2). Pure.
//
// The body is drawn depth-only so the jacket's inside (back panel through the neck opening,
// sleeve interiors at the cuffs) hides behind it, like on the real person. Hands and legs are left
// out: they lie OUTSIDE the jacket, so a posed hand that is a few cm off the real one punched a
// hand-shaped hole into a long coat's side panel (seen on the parka video, .cache/v2 crops), and
// the preview-skinned thighs clipped the hem. Real hands in front of the jacket are handled by the
// hand occluder (landmarks + person mask), which follows the real pixels.
import type { MotionRig } from '../../motion/rig';

/** Bones whose skin does not hide the jacket in AR (hands, legs). */
export const NON_OCCLUDING_BONE = /^(wrist|finger|metacarpal|upperleg|lowerleg|foot|toe)/;
/** A vertex is left out when at least this share of its skin weight is on those bones. */
export const NON_OCCLUDING_WEIGHT = 0.5;

/** Triangle index (into the rig's vertices) of the occluding part of the body. */
export function occluderIndex(
  rig: Pick<
    MotionRig,
    'bones' | 'skinIndices' | 'skinWeights' | 'influences' | 'vertexCount' | 'faces'
  >,
) {
  const excluded = new Uint8Array(rig.bones.length);
  rig.bones.forEach((name, b) => {
    if (NON_OCCLUDING_BONE.test(name)) excluded[b] = 1;
  });
  const keep = new Uint8Array(rig.vertexCount);
  const K = rig.influences;
  for (let v = 0; v < rig.vertexCount; v++) {
    let w = 0;
    for (let k = 0; k < K; k++)
      if (excluded[rig.skinIndices[v * K + k]]) w += rig.skinWeights[v * K + k];
    keep[v] = w < NON_OCCLUDING_WEIGHT ? 1 : 0;
  }
  const out: number[] = [];
  const f = rig.faces;
  for (let t = 0; t < f.length; t += 3)
    if (keep[f[t]] && keep[f[t + 1]] && keep[f[t + 2]]) out.push(f[t], f[t + 1], f[t + 2]);
  return Uint32Array.from(out);
}
