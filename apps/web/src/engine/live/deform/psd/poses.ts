// Key poses for the pose-space correctives (agent V7), in motion-contract degrees
// (prompts/motion-contract.md). Arm poses are mirror-symmetric (the same numbers on both sides,
// which the contract's side-normalised angles make mirror images): each sample then teaches the
// left half of the jacket its response to the left arm and the right half to the right arm, and
// the run time drives each half by its own arm (features.ts leftMask). Trunk poses keep the arms
// at the neutral stand. Chains are baked in priority order (most important first), each starting
// from the relaxed neutral drape: the person's relaxed arms (the user's "sleeves splay" report)
// and the raised arms (hem lift) first.
import type { AnatomicalPose } from '../../../motion/rig.ts';
import { PSD } from './config.ts';

/**
 * One key pose. mirror: the sample is used twice, as baked and as its mirror image (features.ts
 * mirrorPose / mirrorField), so a one-arm chain on the right teaches the left arm as well.
 */
export type KeyPose = { id: string; kind: 'arm' | 'trunk'; pose: AnatomicalPose; mirror?: boolean };
export type PsdChain = { id: string; poses: KeyPose[] };

/** Both arms with the same side-normalised angles (plane, elevation, axial, elbow flexion). */
export function arms(plane: number, elevation: number, axial: number, elbow: number) {
  const out: AnatomicalPose = {};
  for (const s of ['L', 'R']) {
    out[`shoulder_${s}_plane`] = plane;
    out[`shoulder_${s}_elevation`] = elevation;
    out[`shoulder_${s}_axial`] = axial;
    out[`elbow_${s}_flexion`] = elbow;
  }
  return out;
}

const arm = (id: string, plane: number, elevation: number, axial: number, elbow: number) =>
  ({ id, kind: 'arm', pose: arms(plane, elevation, axial, elbow) }) as KeyPose;
const trunk = (id: string, pose: AnatomicalPose) => ({ id, kind: 'trunk', pose }) as KeyPose;
/** One arm only (the other stays at the stand). */
const oneArm = (
  side: 'L' | 'R',
  id: string,
  plane: number,
  elevation: number,
  axial: number,
  elbow: number,
) =>
  ({
    id,
    kind: 'arm',
    pose: {
      [`shoulder_${side}_plane`]: plane,
      [`shoulder_${side}_elevation`]: elevation,
      [`shoulder_${side}_axial`]: axial,
      [`elbow_${side}_flexion`]: elbow,
    },
  }) as KeyPose;
const oneArmChain = (side: 'L' | 'R'): PsdChain => ({
  id: `one-arm-${side}`,
  poses: [
    oneArm(side, `one-100-${side}`, 35, 100, 0, 10),
    oneArm(side, `one-up-${side}`, 40, 175, 0, 8),
    oneArm(side, `one-forward-${side}`, 90, 90, 0, 20),
  ],
});

/**
 * The training chains, most important first: relaxed arms after ~10 s of bake, the raised arms
 * after ~20 s (two workers). Plane/axial at low elevations take the display stand's values
 * (7 / −8 deg), as the live pose does there (livePose GIMBAL_LO_DEG). Asymmetric poses are baked
 * on both sides: a mirrored field is not a faithful stand-in (measured on parka S: mirror(lean
 * right) vs the baked lean left differs by 1.18 cm mean, 3.84 cm p95; twist 0.93 / 3.26 cm).
 */
export const TRAINING_CHAINS: PsdChain[] = [
  {
    // Relaxed arms (livePose ARMS_DOWN 5 / 8 deg) and elbows bent at the sides.
    id: 'hang',
    poses: [arm('relaxed', 7, 5, -8, 8), arm('elbows-90', 7, 10, -8, 90)],
  },
  {
    // Raise in the scapular plane to reach_up_both's end pose (plane 40, elevation 170).
    id: 'raise',
    poses: [
      arm('raise-60', 35, 60, 0, 10),
      arm('raise-100', 35, 100, 0, 10),
      arm('raise-140', 40, 140, 0, 10),
      arm('reach-up', 40, 170, 0, 10),
    ],
  },
  // One arm up (reach_up_one's arm without its lean) and one arm forward, each side.
  oneArmChain('R'),
  oneArmChain('L'),
  {
    // cross_arms (symmetric mean of its 65 / 55 deg elevations) and a hug.
    id: 'cross',
    poses: [arm('cross', 110, 60, -30, 115), arm('hug', 100, 80, 0, 60)],
  },
  {
    // The hug family (arms forward and across, below the elevation fade): where the cuff sits on
    // the forearm depends on elbow flexion and elevation here, and the hug / cross samples alone
    // let the sleeves ride up too far (hug-wide holes, docs/STATUS-psd.md). Corners of plane
    // 95-105, elevation 65-85, elbow 60-105; the hold-outs hug-wide and hug-hold lie inside.
    id: 'hug',
    poses: [
      arm('hug-low-wide', 95, 65, 0, 60),
      arm('hug-low-tight', 100, 65, 0, 105),
      arm('hug-high-tight', 105, 85, 0, 100),
      arm('hug-mid-wide', 105, 75, 0, 70),
    ],
  },
  {
    // Between the scapular (35-40) and forward (90) planes.
    id: 'diagonal',
    poses: [arm('diag-100', 65, 100, 0, 15), arm('diag-150', 65, 150, 0, 15)],
  },
  {
    // Forward raise; reach_forward's end pose (plane 90, elevation 80, elbows 25).
    id: 'front',
    poses: [
      arm('front-45', 90, 45, 0, 15),
      arm('reach-forward', 90, 80, 0, 25),
      arm('front-120', 90, 120, 0, 15),
    ],
  },
  {
    // Hands on hips, then arms forward with the elbows bent (phone, steering wheel).
    id: 'bent',
    poses: [arm('hips', -30, 50, 80, 110), arm('forward-bent', 90, 90, 0, 90)],
  },
  {
    // Sideways abduction (plane 0).
    id: 'side',
    poses: [arm('side-70', 0, 70, 0, 10), arm('side-130', 0, 130, 0, 10)],
  },
  {
    // Small trunk twist and lean both ways, arms at the stand.
    id: 'trunk',
    poses: [
      trunk('twist-left', { trunk_twist: 25 }),
      trunk('twist-right', { trunk_twist: -25 }),
      trunk('lean-right', { trunk_lateral: 12 }),
      trunk('lean-left', { trunk_lateral: -12 }),
    ],
  },
];

/**
 * Hold-out poses for validation (never trained on). Each is solved from the neutral drape with a
 * ramp of at least 1 s and a longer hold (tools/psdNode.mjs), then compared with the prediction.
 */
export const HOLDOUT_POSES: { id: string; pose: AnatomicalPose }[] = [
  { id: 'raise-mid', pose: arms(60, 120, 0, 30) },
  { id: 'raise-low', pose: arms(20, 75, 0, 40) },
  { id: 'hug-wide', pose: arms(95, 70, 0, 80) },
  // Added with the hug chain (round 5), never trained on.
  { id: 'hug-hold', pose: arms(102, 75, 0, 90) },
  // Round 6: a third hug hold-out, never trained on.
  { id: 'hug-hold-2', pose: arms(99, 73, 0, 84) },
  { id: 'relaxed-bent', pose: arms(7, 8, -8, 45) },
  { id: 'front-high-bent', pose: arms(90, 100, 0, 60) },
  {
    id: 'cross-arms-preset',
    pose: {
      shoulder_L_plane: 110,
      shoulder_L_elevation: 65,
      shoulder_L_axial: -30,
      elbow_L_flexion: 115,
      shoulder_R_plane: 110,
      shoulder_R_elevation: 55,
      shoulder_R_axial: -30,
      elbow_R_flexion: 115,
    },
  },
  {
    id: 'reach-up-one',
    pose: {
      shoulder_R_plane: 40,
      shoulder_R_elevation: 175,
      shoulder_R_axial: 0,
      elbow_R_flexion: 8,
      trunk_lateral: -10,
    },
  },
  { id: 'twist-arms', pose: { ...arms(60, 45, 0, 30), trunk_twist: 15 } },
];

const ANGLE_DOFS = [
  'trunk_flexion',
  'trunk_lateral',
  'trunk_twist',
  'shoulder_L_plane',
  'shoulder_L_elevation',
  'shoulder_L_axial',
  'shoulder_R_plane',
  'shoulder_R_elevation',
  'shoulder_R_axial',
  'elbow_L_flexion',
  'elbow_R_flexion',
] as const;

/** Largest angle change (deg) between two poses, missing DOFs at the neutral's value. */
export function largestChange(a: AnatomicalPose, b: AnatomicalPose, neutral: AnatomicalPose) {
  let out = 0;
  for (const dof of ANGLE_DOFS) {
    const x = a[dof] ?? neutral[dof] ?? 0,
      y = b[dof] ?? neutral[dof] ?? 0;
    out = Math.max(out, Math.abs(x - y));
  }
  return out;
}

export type ChainSchedule = {
  /** The custom-motion request (POST /motion/{body_id}/custom/frames.bin; t in s). */
  request: { fps: number; poses: { t: number; pose: AnatomicalPose }[] };
  /** Per key pose: the time (s) its particles are recorded, at the end of its hold. */
  sampleTimes: number[];
  /** Simulated motion, s (the last sample's time). */
  durationS: number;
};

/**
 * Keyframe timing of a chain from the neutral stand: per key pose a smoothstep ramp at the
 * presets' validated speed (PSD.rampDegPerS, at least PSD.minRampS) and a hold of `settleS`, all
 * on the bake's frame grid (1 / PSD.bakeFps).
 */
export function scheduleChain(
  poses: AnatomicalPose[],
  neutral: AnatomicalPose,
  settleS: number = PSD.settleS,
  minRampS: number = PSD.minRampS,
): ChainSchedule {
  const grid = 1 / PSD.bakeFps;
  const snap = (s: number) => Math.ceil(s / grid - 1e-9) * grid;
  const round = (s: number) => Math.round(s * 1e6) / 1e6;
  const out: ChainSchedule['request']['poses'] = [{ t: 0, pose: {} }];
  const sampleTimes: number[] = [];
  let t = 0,
    previous: AnatomicalPose = {};
  for (const pose of poses) {
    const ramp = snap(Math.max(minRampS, largestChange(previous, pose, neutral) / PSD.rampDegPerS));
    t = round(t + ramp);
    out.push({ t, pose });
    t = round(t + snap(settleS));
    out.push({ t, pose });
    sampleTimes.push(t);
    previous = pose;
  }
  if (t > PSD.maxChainS) throw new Error(`Chain lasts ${t.toFixed(1)} s (max ${PSD.maxChainS} s)`);
  // fps: the declared input rate only bounds the sample count on the service; 30 = its output.
  return { request: { fps: 30, poses: out }, sampleTimes, durationS: t };
}
