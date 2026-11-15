// Step subdivision for recorded moves that are faster than the presets (agent V3).
//
// The cloth solver re-poses the body once per solver step (the asset's dt = 1/60 s, two steps per
// 30 fps frame) and then runs its substeps against that fixed pose. A limb that moves further in
// one step than the fabric's clearance around it can pass straight through the sleeve
// (tunnelling): the sleeve then stays behind and the arm comes out bare. Every preset was baked
// and validated with at most 3.04 cm of joint travel per step (reach_up_one, wrist peak 1.83 m/s on
// the reference body; reach_up_both 2.63 cm, cross_arms 2.26 cm; wrists and elbows, measured by V3
// on the .cache/motion-fit frames).
// A recorded move whose wrists or elbows travel further per step is baked with dt / k so that its
// per-step travel stays inside that validated range. Same solver, same compliances (XPBD), only a
// smaller step: the result is a finer simulation of the same motion, not a slower motion.
import { anchorFrame, type MotionFrames } from '../../motion/rig.ts';

export const SUBDIVISION = {
  /**
   * Largest joint travel per solver step baked at the default step, m. Measured by V3 at k = 1
   * on the user's body, parka S (record/tools/bakeNode.mjs): the presets (<= 3.04 cm), the user's
   * recorded cross arms (3.1 cm) and synthetic double-arm raises at 3.37 and 3.50 cm keep both
   * sleeves on; raises at 3.70 and 3.90 cm lose a sleeve at k = 1 and keep it at k = 2.
   * (Was 3.1 cm; lead-approved <= 20 s plan.)
   */
  stepTravelLimitM: 0.035,
  /** Cost cap: at most this many times more solver steps (bake time grows with it). */
  maxFactor: 4,
} as const;

/** Joint centres tracked (anchor_order joints): wrist.L, wrist.R, elbow L, elbow R. */
const JOINTS = ['wrist.L', 'wrist.R', 'elbow.L', 'elbow.R'] as const;

/** Largest per-frame travel of the wrist and elbow joint centres in the first `upTo` frames, m. */
export function peakJointTravel(frames: MotionFrames, upTo = frames.count) {
  let best = { travelM: 0, frame: 0, joint: JOINTS[0] as string };
  for (let f = 1; f < Math.min(upTo, frames.count); f++) {
    const a = anchorFrame(frames, 'joints', f - 1),
      b = anchorFrame(frames, 'joints', f);
    for (let j = 0; j < JOINTS.length; j++) {
      const d = Math.hypot(
        b[j * 3] - a[j * 3],
        b[j * 3 + 1] - a[j * 3 + 1],
        b[j * 3 + 2] - a[j * 3 + 2],
      );
      if (d > best.travelM) best = { travelM: d, frame: f, joint: JOINTS[j] };
    }
  }
  return best;
}

export type Subdivision = {
  /** Solver steps per default step (1 = the presets' dt). */
  factor: number;
  /** Solver override for the worker (undefined when factor = 1). */
  config: Record<string, number> | undefined;
  /** Peak joint speed of the move, m/s, and where. */
  peakSpeedMs: number;
  peakJoint: string;
  peakFrame: number;
  /** Peak joint travel per solver step with the chosen factor, m. */
  stepTravelM: number;
  /** True when even maxFactor leaves the per-step travel above the validated limit. */
  capped: boolean;
};

/** The step subdivision a move needs, for an asset whose solver step is `dt` seconds. */
export function subdivisionFor(frames: MotionFrames, dt: number, upTo = frames.count): Subdivision {
  const peak = peakJointTravel(frames, upTo);
  const stepsPerFrame = Math.max(1, Math.round(1 / (frames.fps * dt))); // bake.ts perFrame
  const travel = peak.travelM / stepsPerFrame;
  const needed = Math.max(1, Math.ceil(travel / SUBDIVISION.stepTravelLimitM - 1e-9));
  const factor = Math.min(SUBDIVISION.maxFactor, needed);
  return {
    factor,
    config: factor > 1 ? { dt: dt / factor } : undefined,
    peakSpeedMs: peak.travelM * frames.fps,
    peakJoint: peak.joint,
    peakFrame: peak.frame,
    stepTravelM: travel / factor,
    capped: needed > SUBDIVISION.maxFactor,
  };
}
