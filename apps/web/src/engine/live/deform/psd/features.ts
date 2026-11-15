// Pose features and regional masks for the pose-space correctives (agent V7). Pure, no DOM.
//
// Arm feature (per side, side-normalised by the motion contract: the left arm is mirrored, so
// equal numbers mean mirror-image poses): the humerus direction in the thorax frame,
//   u = (sin e · sin p, −cos e, sin e · cos p)            (prompts/motion-contract.md §2)
// which is continuous through the ISB gimbal at e = 0 (where the plane p is undefined), plus the
// elbow flexion scaled by PSD.elbowScale. Axial rotation is left out: it turns the sleeve about the
// arm's own axis, which the particle's LBS frame already carries. Last, how high the OTHER arm is
// (−cos of its elevation, scaled by PSD.otherArmScale): one raised arm lifts the coat less than
// two, so a side's response depends on both arms (one-arm samples teach it, poses.ts).
// Trunk feature: twist, flexion and lateral bend, scaled by PSD.trunkScaleDeg.
import type { AnatomicalPose } from '../../../motion/rig.ts';
import { PSD } from './config.ts';

export const ARM_FEATURES = 5;
export const TRUNK_FEATURES = 3;
export type Side = 'L' | 'R';
const DEG = Math.PI / 180;

const value = (pose: AnatomicalPose, neutral: AnatomicalPose, dof: string) => {
  const v = pose[dof];
  return v !== undefined && Number.isFinite(v) ? v : (neutral[dof] ?? 0);
};

/** Arm feature of `side` into out[o..o+3]. DOFs missing from `pose` take the neutral's value. */
export function armFeature(
  pose: AnatomicalPose,
  neutral: AnatomicalPose,
  side: Side,
  out: Float64Array = new Float64Array(ARM_FEATURES),
  o = 0,
) {
  const other = side === 'L' ? 'R' : 'L';
  const e = value(pose, neutral, `shoulder_${side}_elevation`) * DEG,
    p = value(pose, neutral, `shoulder_${side}_plane`) * DEG,
    f = value(pose, neutral, `elbow_${side}_flexion`),
    eo = value(pose, neutral, `shoulder_${other}_elevation`) * DEG;
  out[o] = Math.sin(e) * Math.sin(p);
  out[o + 1] = -Math.cos(e);
  out[o + 2] = Math.sin(e) * Math.cos(p);
  out[o + 3] = (PSD.elbowScale * f) / 150;
  out[o + 4] = -PSD.otherArmScale * Math.cos(eo);
  return out;
}

/** The mirror image of a pose: left and right DOFs swapped, twist and lateral bend negated. */
export function mirrorPose(pose: AnatomicalPose): AnatomicalPose {
  const out: AnatomicalPose = {};
  for (const [dof, v] of Object.entries(pose)) {
    const swapped = dof.replace(/_(L|R)_/, (_, s: string) => (s === 'L' ? '_R_' : '_L_'));
    out[swapped] = dof === 'trunk_twist' || dof === 'trunk_lateral' ? -v : v;
  }
  return out;
}

/**
 * Per particle, the particle nearest to its mirror image across X = centreX (the jacket is built
 * left/right symmetric up to the zip overlap; measured nearest-mirror distance: median 0.1 mm,
 * p95 4 mm, max 17 mm on the parka S). For mirroring a one-arm sample to the other side.
 */
export function mirrorMap(bound: ArrayLike<number>, centreX = 0) {
  const n = bound.length / 3;
  const cell = 0.02;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) =>
    `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < n; i++) {
    const k = key(bound[i * 3], bound[i * 3 + 1], bound[i * 3 + 2]);
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  }
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const x = 2 * centreX - bound[i * 3],
      y = bound[i * 3 + 1],
      z = bound[i * 3 + 2];
    const gx = Math.floor(x / cell),
      gy = Math.floor(y / cell),
      gz = Math.floor(z / cell);
    let best = Infinity,
      bi = i;
    for (let r = 1; r <= 4 && best === Infinity; r++)
      for (let a = -r; a <= r; a++)
        for (let b = -r; b <= r; b++)
          for (let c = -r; c <= r; c++) {
            for (const j of grid.get(`${gx + a},${gy + b},${gz + c}`) ?? []) {
              const d =
                (bound[j * 3] - x) ** 2 + (bound[j * 3 + 1] - y) ** 2 + (bound[j * 3 + 2] - z) ** 2;
              if (d < best) {
                best = d;
                bi = j;
              }
            }
          }
    out[i] = bi;
  }
  return out;
}

/** A local field mirrored across X: out_i = diag(−1, 1, 1) · field_map(i). */
export function mirrorField(field: Float32Array, map: Uint32Array) {
  const out = new Float32Array(field.length);
  for (let i = 0; i < map.length; i++) {
    const j = map[i];
    out[i * 3] = -field[j * 3];
    out[i * 3 + 1] = field[j * 3 + 1];
    out[i * 3 + 2] = field[j * 3 + 2];
  }
  return out;
}

/** Trunk feature into out[o..o+2] (0 = the neutral stand). */
export function trunkFeature(
  pose: AnatomicalPose,
  neutral: AnatomicalPose,
  out: Float64Array = new Float64Array(TRUNK_FEATURES),
  o = 0,
) {
  const s = PSD.trunkScaleDeg;
  out[o] = value(pose, neutral, 'trunk_twist') / s.twist;
  out[o + 1] = value(pose, neutral, 'trunk_flexion') / s.flexion;
  out[o + 2] = value(pose, neutral, 'trunk_lateral') / s.lateral;
  return out;
}

const smoothstep = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/**
 * Per particle, how much it follows the LEFT arm's correctives (the right arm's share is 1 − m):
 * smoothstep across the mid-sagittal plane on the neutral X (X = the subject's left), over
 * ±PSD.maskBandM. Sleeves lie far outside the band, so each follows only its own arm.
 * `centreX` is the body's mid-sagittal X (the mean of the neutral particles' X when omitted).
 */
export function leftMask(bound: ArrayLike<number>, centreX?: number, band = PSD.maskBandM) {
  const n = bound.length / 3;
  let c = centreX;
  if (c === undefined) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += bound[i * 3];
    c = n ? sum / n : 0;
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = smoothstep((bound[i * 3] - c + band) / (2 * band));
  return out;
}
