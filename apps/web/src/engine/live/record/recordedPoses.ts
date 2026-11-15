// Recorded-sequence pipeline (agent V3): the LiveFrame stream of a recording window → the `poses`
// a MoveBaker bakes. Pure, no DOM.
//
// Rules (prompt 14, motion contract "never invent"):
//  - A DOF is used only where the tracker estimated it (confidence ≥ the live preview's
//    livePose.MIN_DOF_CONFIDENCE, so the replay moves the DOFs the user saw moving live). A DOF
//    estimated in too few frames, or missing for longer than RECORD.maxGapMs, is held at the
//    body's neutral value for the whole move: it is left out of every pose, and the body service
//    fills a left-out DOF with the body's neutral, as for a preset keyframe. The trace says which.
//  - A frame where a kept DOF was not estimated is skipped as a whole. The service then bridges the
//    gap by its smoothstep between the two measured neighbours, at most RECORD.maxGapMs long.
//  - No smoothing here: LiveFrame.pose is already filtered by the tracker's One Euro filter
//    (packages/vision PosePipeline, POSE_FILTER_PARAMS), the only smoothing we use.
//  - pelvis_drop_m is never sent: the rig always solves it (feet on the floor).
//  - No left/right swap: the poses are the person's true pose, like the live posed scene
//    (livePose.ts); a mirror is display only. Readouts are therefore the person's own sides.
import { ANATOMICAL_DOFS, POSE_LIMITS } from '@satisfy/vision';
import type { AnatomicalPose } from '../../motion/rig.ts';
import type { LiveFrame } from '../contract.ts';
import { MIN_DOF_CONFIDENCE } from '../livePose.ts';
import { RECORD } from './config.ts';

/** One pose of a recorded move. `t` in ms from the first pose (the LiveFrame.t clock). */
export type RecordedPose = { t: number; pose: AnatomicalPose };

/** The DOFs a recording can drive (contract order); pelvis_drop_m is solved by the rig. */
export const RECORDED_DOFS: readonly string[] = ANATOMICAL_DOFS.filter(
  (d) => d !== 'pelvis_drop_m',
);

export type RecordingTrace = {
  /** LiveFrames in the window, and those with a pose. */
  frames: number;
  tracked: number;
  /** Poses produced (frames where every kept DOF was estimated). */
  used: number;
  /** DOFs driven by the recording. */
  kept: string[];
  /** DOFs held at the body's neutral value for the whole move, and why. */
  neutral: { dof: string; share: number; longestGapMs: number }[];
  /** Longest stretch between two used poses (or the window edges), ms. */
  longestGapMs: number;
  /** Span of the produced poses, ms. */
  durationMs: number;
  /** Values outside the anatomical limits that were clamped (should be none: the tracker clamps). */
  clamped: number;
  /** Fastest joint motion between two produced poses, deg/s (plausibility gate), and where. */
  peakJointSpeed: { degS: number; joint: string; atMs: number };
  /** One short English line for the screen. */
  message: string;
};

export class RecordingError extends Error {
  constructor(
    message: string,
    readonly trace: Partial<RecordingTrace>,
  ) {
    super(message);
    this.name = 'RecordingError';
  }
}

export type RecordedPosesOptions = {
  /** Only frames with startMs ≤ t ≤ endMs (LiveFrame.t). Default: all. */
  startMs?: number;
  endMs?: number;
  minConfidence?: number;
  keepShare?: number;
  maxGapMs?: number;
  maxJointSpeedDegS?: number;
};

const LABELS: Record<string, string> = {
  trunk_flexion: 'forward bend',
  trunk_lateral: 'side bend',
  trunk_twist: 'trunk twist',
  shoulder_L_plane: 'left arm direction',
  shoulder_L_elevation: 'left arm raise',
  shoulder_L_axial: 'left arm rotation',
  shoulder_R_plane: 'right arm direction',
  shoulder_R_elevation: 'right arm raise',
  shoulder_R_axial: 'right arm rotation',
  elbow_L_flexion: 'left elbow',
  elbow_R_flexion: 'right elbow',
  hip_L_flexion: 'left hip',
  hip_R_flexion: 'right hip',
  knee_L_flexion: 'left knee',
  knee_R_flexion: 'right knee',
};

/** Groups that read as one word on screen when every member is held (e.g. legs out of frame). */
const GROUPS: [string, string[]][] = [
  ['legs', ['hip_L_flexion', 'hip_R_flexion', 'knee_L_flexion', 'knee_R_flexion']],
  ['arm rotation', ['shoulder_L_axial', 'shoulder_R_axial']],
];

/** Screen labels of the held DOFs, complete groups first as one word. */
export function heldLabels(dofs: readonly string[]) {
  const rest = new Set(dofs);
  const out: string[] = [];
  for (const [label, members] of GROUPS)
    if (members.every((m) => rest.has(m))) {
      out.push(label);
      for (const m of members) rest.delete(m);
    }
  for (const dof of dofs) if (rest.has(dof)) out.push(LABELS[dof] ?? dof);
  return out;
}

const DEG = Math.PI / 180;

/**
 * Fastest joint motion between consecutive poses, deg/s. Arms: the angle between the humerus
 * directions (motion contract ISB convention: (sin e sin p, -cos e, sin e cos p)), when plane and
 * elevation are both driven, else the elevation rate. Elbows and trunk: their angle rates.
 */
export function peakJointSpeed(poses: readonly RecordedPose[]) {
  let best = { degS: 0, joint: '', atMs: 0 };
  const humerus = (p: AnatomicalPose, s: 'L' | 'R') => {
    const e = p[`shoulder_${s}_elevation`],
      pl = p[`shoulder_${s}_plane`];
    if (e === undefined || pl === undefined) return null;
    return [
      Math.sin(e * DEG) * Math.sin(pl * DEG),
      -Math.cos(e * DEG),
      Math.sin(e * DEG) * Math.cos(pl * DEG),
    ];
  };
  for (let i = 1; i < poses.length; i++) {
    const a = poses[i - 1].pose,
      b = poses[i].pose,
      dt = (poses[i].t - poses[i - 1].t) / 1000;
    if (!(dt > 0)) continue;
    const consider = (joint: string, deg: number) => {
      if (deg / dt > best.degS) best = { degS: deg / dt, joint, atMs: poses[i].t };
    };
    for (const s of ['L', 'R'] as const) {
      const ha = humerus(a, s),
        hb = humerus(b, s);
      if (ha && hb) {
        const dot = Math.max(-1, Math.min(1, ha[0] * hb[0] + ha[1] * hb[1] + ha[2] * hb[2]));
        consider(`${s === 'L' ? 'left' : 'right'} arm`, Math.acos(dot) / DEG);
      } else {
        const key = `shoulder_${s}_elevation`;
        if (a[key] !== undefined && b[key] !== undefined)
          consider(`${s === 'L' ? 'left' : 'right'} arm`, Math.abs(b[key] - a[key]));
      }
    }
    for (const dof of ['elbow_L_flexion', 'elbow_R_flexion', 'trunk_flexion', 'trunk_lateral']) {
      if (a[dof] !== undefined && b[dof] !== undefined)
        consider(LABELS[dof] ?? dof, Math.abs(b[dof] - a[dof]));
    }
  }
  return best;
}

/** Longest interval (ms) between consecutive times, counting the window edges. */
export function longestGap(times: readonly number[], start: number, end: number) {
  let longest = 0,
    previous = start;
  for (const t of times) {
    longest = Math.max(longest, t - previous);
    previous = t;
  }
  return Math.max(longest, end - previous);
}

export function recordedPoses(
  frames: readonly LiveFrame[],
  options: RecordedPosesOptions = {},
): { poses: RecordedPose[]; trace: RecordingTrace } {
  const min = options.minConfidence ?? MIN_DOF_CONFIDENCE,
    keepShare = options.keepShare ?? RECORD.keepShare,
    maxGap = options.maxGapMs ?? RECORD.maxGapMs;
  const window = frames
    .filter(
      (f) =>
        Number.isFinite(f.t) &&
        (options.startMs === undefined || f.t >= options.startMs) &&
        (options.endMs === undefined || f.t <= options.endMs),
    )
    .slice()
    .sort((a, b) => a.t - b.t);
  const tracked = window.filter((f) => f.pose !== null);
  if (window.length < 2 || tracked.length < 2)
    throw new RecordingError('No one was tracked during the recording. Try again.', {
      frames: window.length,
      tracked: tracked.length,
    });
  const start = window[0].t,
    end = window[window.length - 1].t;
  const lostMs = longestGap(
    tracked.map((f) => f.t),
    start,
    end,
  );
  if (lostMs > maxGap)
    throw new RecordingError(
      `Lost you for ${(lostMs / 1000).toFixed(1)} s during the recording. Try again.`,
      { frames: window.length, tracked: tracked.length, longestGapMs: lostMs },
    );
  const estimated = (f: LiveFrame, dof: string) =>
    Number.isFinite(f.pose![dof]) && (f.confidence[dof] ?? 0) >= min;

  const kept: string[] = [];
  const neutral: RecordingTrace['neutral'] = [];
  for (const dof of RECORDED_DOFS) {
    const times = tracked.filter((f) => estimated(f, dof)).map((f) => f.t);
    const share = times.length / tracked.length;
    const gap = times.length ? longestGap(times, start, end) : end - start;
    if (share >= keepShare && gap <= maxGap) kept.push(dof);
    else neutral.push({ dof, share, longestGapMs: gap });
  }
  const usable = kept.length ? tracked.filter((f) => kept.every((d) => estimated(f, d))) : [];
  const gap = usable.length
    ? longestGap(
        usable.map((f) => f.t),
        start,
        end,
      )
    : end - start;
  const base = { frames: window.length, tracked: tracked.length, kept, neutral };
  if (!kept.length || usable.length < 2)
    throw new RecordingError('Your arms and body were not tracked well enough. Try again.', base);
  if (gap > maxGap)
    throw new RecordingError(
      `Your arms were not tracked for ${(gap / 1000).toFixed(1)} s during the recording. Try again.`,
      { ...base, longestGapMs: gap },
    );

  let clamped = 0;
  const t0 = usable[0].t;
  const poses = usable.map((f) => {
    const pose: AnatomicalPose = {};
    for (const dof of kept) {
      const [low, high] = POSE_LIMITS[dof as keyof typeof POSE_LIMITS];
      const value = f.pose![dof];
      const applied = Math.min(high, Math.max(low, value));
      if (applied !== value) clamped++;
      pose[dof] = applied;
    }
    return { t: f.t - t0, pose };
  });
  const durationMs = poses[poses.length - 1].t;
  // Plausibility: a limb that jumps faster than a person can move it was lost by the tracker
  // (e.g. an arm overhead). Baking that would make the cloth lose the sleeve; refuse it here.
  const speed = peakJointSpeed(poses);
  if (speed.degS > (options.maxJointSpeedDegS ?? RECORD.maxJointSpeedDegS))
    throw new RecordingError(
      `The camera lost your ${speed.joint} for a moment (it jumped at ${Math.round(speed.degS)} deg/s, ` +
        `${(speed.atMs / 1000).toFixed(1)} s in). Try again with your hands and elbows in view.`,
      { ...base, used: poses.length, durationMs, peakJointSpeed: speed },
    );
  const held = heldLabels(neutral.map((n) => n.dof));
  const message = held.length
    ? `Recorded ${(durationMs / 1000).toFixed(1)} s. Not tracked, so kept at rest: ${held.join(', ')}.`
    : `Recorded ${(durationMs / 1000).toFixed(1)} s, every joint tracked.`;
  return {
    poses,
    trace: {
      ...base,
      used: poses.length,
      longestGapMs: gap,
      durationMs,
      clamped,
      peakJointSpeed: speed,
      message,
    },
  };
}
