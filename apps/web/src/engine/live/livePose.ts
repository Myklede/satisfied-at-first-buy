// Pure helpers between the tracker's AnatomicalPose and the rig: confidence gating and quality.
// No left/right swaps: the posed scene is the person's true pose; mirroring is display only. Degrees, prompts/motion-contract.md.
import { OneEuroFilter, type OneEuroParams } from '@satisfy/vision';
import type { AnatomicalPose } from '../motion/rig.ts';

/**
 * Sagittal mirror of a pose: swap L and R, negate lateral and twist (Python
 * AnatomicalPose.mirrored). NOT used by the engine: the posed scene is always the true pose and
 * mirroring is display only (lead decision 13:55). Kept as a pure helper for the record module.
 */
export function mirrorPose(pose: AnatomicalPose): AnatomicalPose {
  const out: AnatomicalPose = {};
  for (const [key, value] of Object.entries(pose)) {
    if (key.includes('_L_')) out[key.replace('_L_', '_R_')] = value;
    else if (key.includes('_R_')) out[key.replace('_R_', '_L_')] = value;
    else out[key] = value;
  }
  if ('trunk_lateral' in out) out.trunk_lateral = -out.trunk_lateral;
  if ('trunk_twist' in out) out.trunk_twist = -out.trunk_twist;
  return out;
}

/**
 * Confidence below this = "not estimated" (contract): the DOF takes its fallback value. The vision
 * estimator caps humeral axial rotation at 0.3 and trunk twist at 0.4 as single-camera
 * observability bounds (AXIAL_MAX_CONFIDENCE, TWIST_MAX_CONFIDENCE) and itself holds values below
 * 0.05 (HOLD_BELOW_CONFIDENCE); a hidden joint (legs out of a head-to-hips frame) reads ~0.
 * 0.1 keeps the capped-but-measured DOFs and drops the unseen ones. Heuristic.
 */
export const MIN_DOF_CONFIDENCE = 0.1;

/**
 * Keeps the DOFs the tracker estimated with enough confidence; every other DOF takes `fallback`
 * (the body's neutral display pose), never an invented value. pelvis_drop_m is always solved by
 * the rig, so it is dropped here.
 */
export function gatePose(
  pose: AnatomicalPose,
  confidence: Partial<Record<string, number>>,
  fallback: AnatomicalPose,
  minConfidence = MIN_DOF_CONFIDENCE,
): { pose: AnatomicalPose; estimated: string[] } {
  const out: AnatomicalPose = {};
  const estimated: string[] = [];
  for (const [key, neutral] of Object.entries(fallback)) {
    if (key === 'pelvis_drop_m') continue;
    const value = pose[key];
    if (Number.isFinite(value) && (confidence[key] ?? 0) >= minConfidence) {
      out[key] = value;
      estimated.push(key);
    } else out[key] = neutral;
  }
  return { pose: out, estimated };
}

/** Mean confidence over the upper-body DOFs the mirror needs (0..1), for the quality bar. */
export function trackingQuality(confidence: Partial<Record<string, number>>): number {
  const keys = [
    'trunk_flexion',
    'trunk_lateral',
    'shoulder_L_elevation',
    'shoulder_R_elevation',
    'shoulder_L_plane',
    'shoulder_R_plane',
    'elbow_L_flexion',
    'elbow_R_flexion',
  ];
  let sum = 0;
  for (const k of keys) sum += Math.max(0, Math.min(1, confidence[k] ?? 0));
  return sum / keys.length;
}

/** A DOF that drops below confidence keeps its last measured value this long (ms). Heuristic. */
export const HOLD_MS = 400;
/** …then eases to the body's neutral value over this long (ms, smoothstep). Heuristic. */
export const RELEASE_MS = 700;

/** Hysteresis of the per-DOF gate: a DOF starts being measured at ENTER and stops below LEAVE. */
export const GATE_ENTER = 0.15;
export const GATE_LEAVE = 0.07;
/** Confidence at which a measured DOF follows the raw value fully (below: proportionally slower). */
export const GATE_FULL = 0.25;
/**
 * Arm elevation and elbow flexion stay well defined with the arm hanging, but the vision estimator
 * multiplies their confidence by the HIP landmarks' quality (torso frame), which is low when the
 * kiosk camera frames head to hips. A much lower gate keeps them measured there instead of
 * falling back to a stand (user report: relaxed or pressed arms splayed out). Heuristic.
 */
export const ARM_GATE = { enter: 0.04, leave: 0.02, full: 0.12 };
const ARM_DOF = /^(shoulder_[LR]_elevation|elbow_[LR]_flexion)$/;
/** The live fallback for the arms: hanging down, elbows nearly straight (not the A-pose stand). */
export const ARMS_DOWN = { elevationDeg: 5, elbowDeg: 8 };

/**
 * The neutral the LIVE avatar falls back to: the body's display stand (on which the jacket was
 * built) with the arms hanging down instead of the display A-pose (27 deg elevation).
 */
export function liveNeutral(display: AnatomicalPose): AnatomicalPose {
  return {
    ...display,
    shoulder_L_elevation: ARMS_DOWN.elevationDeg,
    shoulder_R_elevation: ARMS_DOWN.elevationDeg,
    elbow_L_flexion: ARMS_DOWN.elbowDeg,
    elbow_R_flexion: ARMS_DOWN.elbowDeg,
  };
}
/**
 * ISB Y-X-Y gimbal: with the arm hanging (elevation → 0) the plane of elevation and the axial
 * rotation are undefined (only their sum turns the arm about its long axis), and the tracker's
 * values there are noise that twists the relaxed arm. Below GIMBAL_LO_DEG of elevation both take
 * the neutral display pose's values; above GIMBAL_HI_DEG they are fully measured; smoothstep in
 * between. Heuristic, from the user's relaxed-arm jitter report (2026-11-13).
 */
export const GIMBAL_LO_DEG = 15;
export const GIMBAL_HI_DEG = 35;

/**
 * Slew limit per DOF (deg/s): a step faster than this between two frames is a tracker spike, not
 * a body motion, and is limited to this rate. Above the fastest everyday motions: arm raises
 * reach 200–400 deg/s (POSE_FILTER_PARAMS note in packages/vision), elbow flexion in fast
 * reaching ~500 deg/s; trunk bending is far slower. Heuristic.
 */
export const SLEW_DEG_S: Record<string, number> = {
  trunk_flexion: 150,
  trunk_lateral: 120,
  trunk_twist: 150,
  shoulder_plane: 600,
  shoulder_elevation: 600,
  shoulder_axial: 600,
  elbow_flexion: 800,
  hip_flexion: 300,
  knee_flexion: 400,
};
/**
 * Output One Euro filter (Casiez et al. CHI '12) after the pipeline's own: a lower minimum cutoff
 * for the mirror, whose relaxed arms showed ~1 deg/frame of residual noise on the kiosk camera;
 * beta keeps fast moves responsive. Heuristic, tuned on cam-tshirt / cam-parka.
 */
export const OUTPUT_FILTER: Record<'trunk' | 'limb', OneEuroParams> = {
  trunk: { minCutoff: 0.5, beta: 0.02, dCutoff: 1 },
  // beta 0.1 (was 0.03): fast arm moves open the filter fully (lag), rest stays at 0.7 Hz.
  limb: { minCutoff: 0.7, beta: 0.1, dCutoff: 1 },
};
const sideless = (dof: string) => dof.replace(/_[LR]_/, '_');

/**
 * Trunk deadbands. A single RGB camera reads trunk twist (and much of forward flexion) only from
 * MediaPipe's per-joint depth, so standing square to the camera reads several degrees of noise,
 * which turned the jacket back and forth (user report, 2026-11-13). A trunk DOF stays at the
 * neutral stand until it leaves the band by `engage` degrees for `holdMs`, and returns to neutral
 * once back within `release` for `holdMs`; the output filter then smooths the transition.
 * Heuristics: twist 15 deg (lead's spec), lateral and flexion smaller (image-plane / larger moves).
 */
export const TRUNK_DEADBAND: Record<string, { engage: number; release: number; holdMs: number }> = {
  trunk_twist: { engage: 15, release: 8, holdMs: 300 },
  trunk_lateral: { engage: 6, release: 3, holdMs: 300 },
  trunk_flexion: { engage: 10, release: 5, holdMs: 300 },
};
/** Heavier output filter for the trunk twist (depth-only, noisiest). Heuristic. */
export const TWIST_FILTER: OneEuroParams = { minCutoff: 0.3, beta: 0.01, dCutoff: 1 };
/**
 * Lateral lean beyond this is shown only once sustained for LATERAL_SUSTAIN_MS: turning on the
 * spot made the tracker read brief 7–15 deg leans (user diagnostics 14:44). Heuristic.
 */
export const LATERAL_MAX_DEG = 15;
export const LATERAL_SUSTAIN_MS = 1000;

class Deadband {
  private engaged = false;
  private since?: number;
  constructor(private spec: { engage: number; release: number; holdMs: number }) {}
  reset() {
    this.engaged = false;
    this.since = undefined;
  }
  /** The value when engaged, otherwise the neutral value. */
  apply(t: number, value: number, rest: number) {
    const dev = Math.abs(value - rest);
    const crossing = this.engaged ? dev < this.spec.release : dev > this.spec.engage;
    if (crossing) {
      this.since ??= t;
      if (t - this.since >= this.spec.holdMs) {
        this.engaged = !this.engaged;
        this.since = undefined;
      }
    } else this.since = undefined;
    return this.engaged ? value : rest;
  }
}

const smoothstep = (lo: number, hi: number, x: number) => {
  const k = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return k * k * (3 - 2 * k);
};

/**
 * Stillness lock (agent V6, lead 2026-11-13 ~20:30; user: "when I stand still the jacket keeps
 * moving, it looks fake"). Runs LAST on the pose the avatar shows (after the smoother and V2's
 * screen fit), so the mirror and the AR rig get the same, truly constant pose at rest.
 * Per group (trunk, each arm, the legs), on top of a One Euro filter with a low minimum cutoff:
 * - engage: once every DOF of the group has stayed within `engageShare` × its band of where it
 *   was for `engageMs`, the group locks at the MEAN of its raw values over that window (unbiased:
 *   locking at the still-converging filter held the trunk 0.5 deg off its deadbanded 0 for good),
 *   easing the shown value onto it once over `lockEaseMs`;
 * - while locked the output is exactly constant;
 * - release (real motion): the frame any raw DOF leaves `rawReleaseShare` x its band around the
 *   lock (a decisive move: no onset lag), or its filtered value leaves the band (a slow drift;
 *   the filter keeps noise out), easing from the lock to the filtered value over `releaseEaseMs`.
 *   Measured on the 15:18 still stretches: the raw final pose strays up to 1.2-1.5 deg
 *   (elevation) and 1.8-2.5 deg (elbow) from its median, so a raw-only test at 1x the band
 *   released on noise (jacket 0.90 mm/frame at rest instead of 0).
 * Bands: ~2.5x the per-frame noise RMS of the final pose measured on still stretches of the
 * user's live sessions (data/reference-photos/live-diag, 15:18: shoulder elevation 0.64-0.68,
 * elbow flexion 0.81-0.96, axial 0.09-0.39 deg/frame; trunk 0 after its deadbands, raw 0.2-0.75).
 * Plane and axial rotation, unmeasured at rest (gimbal fade), get the raw estimator's 1.1-1.9.
 */
export const STILLNESS = {
  groups: {
    trunk: ['trunk_flexion', 'trunk_lateral', 'trunk_twist'],
    armL: ['shoulder_L_plane', 'shoulder_L_elevation', 'shoulder_L_axial', 'elbow_L_flexion'],
    armR: ['shoulder_R_plane', 'shoulder_R_elevation', 'shoulder_R_axial', 'elbow_R_flexion'],
    legs: ['hip_L_flexion', 'hip_R_flexion', 'knee_L_flexion', 'knee_R_flexion'],
  } as Record<string, string[]>,
  /** Release band per DOF (deg, side-less names). */
  band: {
    trunk_flexion: 2,
    trunk_lateral: 2,
    trunk_twist: 2,
    shoulder_plane: 4,
    shoulder_elevation: 1.8,
    shoulder_axial: 4,
    elbow_flexion: 2.4,
    hip_flexion: 2,
    knee_flexion: 2,
  } as Record<string, number>,
  engageMs: 250,
  engageShare: 0.5,
  rawReleaseShare: 1.6,
  lockEaseMs: 150,
  /** A locked DOF whose filtered value stays more than engageShare x its band off the lock for
   * this long (a small real change below the band) re-centres the lock once, eased. Judged. */
  recenterMs: 1500,
  releaseEaseMs: 80,
  /** Underneath: low minimum cutoff at rest; beta opens it fully on real motion (deg/s). */
  filter: { minCutoff: 0.4, beta: 0.05, dCutoff: 1 } as OneEuroParams,
};

type LockGroup = {
  locked: boolean;
  anchor: Map<string, number>;
  /** Raw sums over the engage window (the lock's value is their mean). */
  sum: Map<string, number>;
  count: number;
  lockFrom: Map<string, number> | null;
  lockStart: number;
  offSince: number | null;
  windowStart: number;
  windowRef: Map<string, number>;
  easeFrom: Map<string, number> | null;
  easeStart: number;
  shown: Map<string, number>;
};

export class StillnessLock {
  private filters = new Map<string, OneEuroFilter>();
  private groups = new Map<string, LockGroup>();
  private sharedAnchor: AnatomicalPose | null = null;

  reset() {
    this.filters.clear();
    this.groups.clear();
    this.sharedAnchor = null;
  }

  /** The groups locked after the last apply (diagnostics). */
  get lockedGroups() {
    if (this.sharedAnchor)
      return Object.entries(STILLNESS.groups)
        .filter(([, keys]) => keys.some((key) => Number.isFinite(this.sharedAnchor![key])))
        .map(([name]) => name);
    return [...this.groups].filter(([, g]) => g.locked).map(([name]) => name);
  }

  apply(t: number, pose: AnatomicalPose, shared?: { readonly still: boolean }): AnatomicalPose {
    if (shared) {
      // The engine makes one decision for all views. No local filter, recentering or release
      // ease may keep this layer held after that decision releases in the current frame.
      this.filters.clear();
      this.groups.clear();
      if (!shared.still) {
        this.sharedAnchor = null;
        return { ...pose };
      }
      this.sharedAnchor ??= { ...pose };
      return { ...this.sharedAnchor };
    }
    this.sharedAnchor = null;
    const out: AnatomicalPose = { ...pose };
    const S = STILLNESS;
    for (const [name, dofs] of Object.entries(S.groups)) {
      const keys = dofs.filter((k) => Number.isFinite(pose[k]));
      if (!keys.length) continue;
      const filtered = new Map<string, number>();
      for (const k of keys) {
        let f = this.filters.get(k);
        if (!f) this.filters.set(k, (f = new OneEuroFilter(S.filter)));
        filtered.set(k, f.filter(pose[k], t));
      }
      let g = this.groups.get(name);
      if (!g) {
        g = {
          locked: false,
          anchor: new Map(),
          sum: new Map(),
          count: 0,
          lockFrom: null,
          lockStart: t,
          offSince: null,
          windowStart: t,
          windowRef: new Map(filtered),
          easeFrom: null,
          easeStart: t,
          shown: new Map(filtered),
        };
        this.groups.set(name, g);
      }
      const band = (k: string) => S.band[sideless(k)] ?? 2;
      if (g.locked) {
        const moved = keys.some((k) => {
          const a = g!.anchor.get(k) ?? pose[k];
          return (
            Math.abs(pose[k] - a) > band(k) * S.rawReleaseShare ||
            Math.abs(filtered.get(k)! - a) > band(k)
          );
        });
        if (!moved) {
          // Sustained small offset (below the band): re-centre once on the filtered value.
          const off = keys.some(
            (k) =>
              Math.abs(filtered.get(k)! - (g!.anchor.get(k) ?? filtered.get(k)!)) >
              band(k) * S.engageShare,
          );
          g.offSince = off ? (g.offSince ?? t) : null;
          if (g.offSince !== null && t - g.offSince >= S.recenterMs) {
            g.lockFrom = new Map(g.shown);
            g.lockStart = t;
            g.anchor = new Map(keys.map((k) => [k, filtered.get(k)!]));
            g.offSince = null;
          }
          const e = g.lockFrom ? smoothstep(0, 1, (t - g.lockStart) / S.lockEaseMs) : 1;
          if (e >= 1) g.lockFrom = null;
          for (const k of keys) {
            const a = g.anchor.get(k) ?? pose[k];
            const from = g.lockFrom?.get(k);
            out[k] = from === undefined ? a : from + (a - from) * e;
            g.shown.set(k, out[k]);
          }
          continue;
        }
        // Real motion: release now, easing from what is shown.
        g.locked = false;
        g.lockFrom = null;
        g.easeFrom = new Map(g.shown);
        g.easeStart = t;
        g.windowStart = t;
        g.windowRef = new Map(filtered);
      }
      const ease =
        g.easeFrom && S.releaseEaseMs > 0
          ? smoothstep(0, 1, (t - g.easeStart) / S.releaseEaseMs)
          : 1;
      if (ease >= 1) g.easeFrom = null;
      for (const k of keys) {
        const target = filtered.get(k)!;
        const from = g.easeFrom?.get(k);
        const v = from === undefined ? target : from + (target - from) * ease;
        out[k] = v;
        g.shown.set(k, v);
      }
      // Engage: the whole group has stayed near where it was for engageMs.
      const still = keys.every(
        (k) =>
          Math.abs(filtered.get(k)! - (g!.windowRef.get(k) ?? filtered.get(k)!)) <=
          band(k) * S.engageShare,
      );
      if (!still) {
        g.windowStart = t;
        g.windowRef = new Map(filtered);
        g.sum = new Map();
        g.count = 0;
      }
      for (const k of keys) g.sum.set(k, (g.sum.get(k) ?? 0) + pose[k]);
      g.count++;
      if (still && t - g.windowStart >= S.engageMs && !g.easeFrom) {
        g.locked = true;
        g.offSince = null;
        g.anchor = new Map(keys.map((k) => [k, g!.sum.get(k)! / g!.count]));
        g.lockFrom = new Map(g.shown);
        g.lockStart = t;
      }
    }
    return out;
  }
}

/**
 * Display smoothing for the live avatar under occlusion, bad light, the arm gimbal or a person
 * leaving the frame. Per DOF:
 * - a hysteresis gate (GATE_ENTER / GATE_LEAVE), so a confidence hovering at the threshold does not
 *   flip the DOF between measured and held every frame;
 * - while measured, the output follows the raw value with weight smoothstep(LEAVE, FULL, conf)
 *   (continuous: a doubtful sample moves the arm a little, a confident one fully);
 * - when not measured, the last output holds for HOLD_MS, then eases to the neutral value over
 *   RELEASE_MS;
 * - shoulder plane and axial rotation fade to neutral near the gimbal (GIMBAL_LO/HI_DEG).
 * No value is invented: every output is a measured value, the neutral value, or a blend.
 * `stabilize: false` keeps only hold/release (the previous behaviour, for before/after numbers).
 */
export class PoseSmoother {
  private state = new Map<string, { value: number; t: number; active: boolean }>();
  private filters = new Map<string, OneEuroFilter>();
  private deadbands = new Map<string, Deadband>();
  private lateralSince?: number;
  private lastOut = new Map<string, { value: number; t: number }>();

  constructor(
    private holdMs = HOLD_MS,
    private releaseMs = RELEASE_MS,
    private stabilize = true,
  ) {}

  reset() {
    this.state.clear();
    this.filters.clear();
    this.lastOut.clear();
    for (const d of this.deadbands.values()) d.reset();
  }

  /** `pose` null = nobody tracked in this frame. Returns the pose to display and the live DOFs. */
  update(
    t: number,
    pose: AnatomicalPose | null,
    confidence: Partial<Record<string, number>>,
    neutral: AnatomicalPose,
  ): { pose: AnatomicalPose; estimated: string[]; settled: boolean } {
    const out: AnatomicalPose = {};
    const estimated: string[] = [];
    let settled = true;
    for (const [key, rest] of Object.entries(neutral)) {
      if (key === 'pelvis_drop_m') continue;
      const value = pose?.[key];
      const c = confidence[key] ?? 0;
      const st = this.state.get(key);
      const gate = ARM_DOF.test(key)
        ? ARM_GATE
        : { enter: GATE_ENTER, leave: GATE_LEAVE, full: GATE_FULL };
      const threshold = !this.stabilize ? MIN_DOF_CONFIDENCE : st?.active ? gate.leave : gate.enter;
      if (value !== undefined && Number.isFinite(value) && c >= threshold) {
        const w = this.stabilize && st ? smoothstep(gate.leave, gate.full, c) : 1;
        let next = st ? st.value + (value - st.value) * w : value;
        if (this.stabilize && st) {
          // Slew limit: a spike becomes a fast but continuous motion.
          const max = (SLEW_DEG_S[sideless(key)] ?? 600) * Math.max(0, (t - st.t) / 1000);
          next = st.value + Math.max(-max, Math.min(max, next - st.value));
        }
        this.state.set(key, { value: next, t, active: true });
        out[key] = next;
        estimated.push(key);
        continue;
      }
      if (st) st.active = false;
      if (!st) {
        out[key] = rest;
        continue;
      }
      const age = t - st.t;
      if (age <= this.holdMs) {
        out[key] = st.value;
        settled = false;
        continue;
      }
      const k = Math.min(1, (age - this.holdMs) / this.releaseMs);
      out[key] = st.value + (rest - st.value) * smoothstep(0, 1, k);
      if (k < 1) settled = false;
      else this.state.delete(key);
    }
    if (this.stabilize) {
      for (const [key, spec] of Object.entries(TRUNK_DEADBAND)) {
        if (out[key] === undefined || neutral[key] === undefined) continue;
        let band = this.deadbands.get(key);
        if (!band) this.deadbands.set(key, (band = new Deadband(spec)));
        out[key] = band.apply(t, out[key], neutral[key]);
      }
      const lean = out.trunk_lateral;
      const rest = neutral.trunk_lateral ?? 0;
      if (lean !== undefined && Math.abs(lean - rest) > LATERAL_MAX_DEG) {
        this.lateralSince ??= t;
        if (t - this.lateralSince < LATERAL_SUSTAIN_MS)
          out.trunk_lateral = rest + Math.sign(lean - rest) * LATERAL_MAX_DEG;
      } else this.lateralSince = undefined;
      for (const [key, value] of Object.entries(out)) {
        let f = this.filters.get(key);
        if (!f) {
          f = new OneEuroFilter(
            key === 'trunk_twist'
              ? TWIST_FILTER
              : OUTPUT_FILTER[key.startsWith('trunk') ? 'trunk' : 'limb'],
          );
          this.filters.set(key, f);
        }
        out[key] = f.filter(value, t);
      }
    }
    if (this.stabilize)
      for (const side of ['L', 'R']) {
        const g = smoothstep(GIMBAL_LO_DEG, GIMBAL_HI_DEG, out[`shoulder_${side}_elevation`] ?? 0);
        for (const dof of [`shoulder_${side}_plane`, `shoulder_${side}_axial`]) {
          const rest = neutral[dof];
          if (rest === undefined || out[dof] === undefined) continue;
          out[dof] = rest + (out[dof] - rest) * g;
        }
      }
    return { pose: out, estimated, settled };
  }
}
