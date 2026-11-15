// One baked recorded move (contract.ts BakedMove): the true cloth simulation of the user's own
// motion on their body, from the existing motion bake (bake.ts) of the custom frames. Playback
// drives the posed scene with the baked body drivers and the simulated cloth positions; every
// readout is computed from the bake by the existing metrics (metrics.ts) and has basis 'physics'.
import type { ClothAsset } from '../../../api.ts';
import type { BakedMotion } from '../../motion/bake.ts';
import { DEFAULT_WAISTBAND, MOTION_FIT, type Waistband } from '../../motion/config.ts';
import {
  RESTRICTION_ZONES,
  summarise,
  type RestrictionZone,
  type SizeMotionSummary,
} from '../../motion/metrics.ts';
import {
  anchorFrame,
  frameMatrices,
  type MotionAnchors,
  type MotionFrames,
  type MotionRig,
} from '../../motion/rig.ts';
import type {
  BakedMove,
  LivePosedScene,
  LiveStatus,
  LiveTryOnState,
  LiveZone,
  ZoneReadout,
} from '../contract.ts';
import { LIVE_ZONES, zoneStretchCm, type PreviewTapes, type StaticZone } from '../readouts.ts';
import { RECORD } from './config.ts';
import type { Subdivision } from './subdivision.ts';

/**
 * What playback needs from the posed scene beyond the contract: V1's LiveAvatar implements both
 * (driver matrices + bone world poses for the body and joints, then the simulated jacket).
 */
export interface DrivablePosedScene extends LivePosedScene {
  setDrivers(drivers: ArrayLike<number>, world?: Float64Array): void;
  setJacketPositions(positions: ArrayLike<number>): void;
}

export const isDrivable = (scene: LivePosedScene): scene is DrivablePosedScene =>
  typeof (scene as Partial<DrivablePosedScene>).setDrivers === 'function' &&
  typeof (scene as Partial<DrivablePosedScene>).setJacketPositions === 'function';

/** Restriction zones (metrics.ts) read for each live zone's "fabric at its limit" status. */
const RESTRICTION_OF: Record<LiveZone, RestrictionZone[]> = {
  shoulder: ['shoulders'],
  chest: ['front', 'back'],
  bicep: ['armpit', 'sleeves'],
  sleeve: ['sleeves', 'elbow'],
  hem: ['front', 'back'],
  collar: ['collar/hood'],
};

/**
 * Bone world poses from the driver skinning matrices: every bone follows its driver rigidly
 * (FORMAT.md), so W_b = T_d · R_b with T_d = W_d · R_d⁻¹. Exact for the drivers themselves.
 * `drivers` (18·12, 3×4 row-major), out (B·16, 4×4 row-major).
 */
export function worldFromDrivers(rig: MotionRig, drivers: ArrayLike<number>, out: Float64Array) {
  const R = rig.restWorld;
  for (let b = 0; b < rig.bones.length; b++) {
    const t = rig.driverOfBone[b] * 12,
      r = b * 16,
      o = b * 16;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 4; j++)
        out[o + i * 4 + j] =
          drivers[t + i * 4] * R[r + j] +
          drivers[t + i * 4 + 1] * R[r + 4 + j] +
          drivers[t + i * 4 + 2] * R[r + 8 + j] +
          drivers[t + i * 4 + 3] * R[r + 12 + j];
    out[o + 12] = 0;
    out[o + 13] = 0;
    out[o + 14] = 0;
    out[o + 15] = 1;
  }
  return out;
}

/**
 * Sanity gate on the simulation: did each sleeve stay on its arm? The cuff can ride up the
 * forearm, but a cuff that rode up, or ended up away from the wrist, by more than the body's own
 * forearm (elbow → wrist joint at frame 0) has left the forearm: the cloth lost the arm, and the
 * numbers of that bake are physically impossible. They are never shown.
 */
export type SleeveCheck = {
  valid: boolean;
  /** One short English line when invalid (for the screen). */
  reason: string | null;
  /** First frame and side that failed. */
  frame: number | null;
  side: 'L' | 'R' | null;
  forearmCm: { L: number; R: number };
  maxRideUpCm: { L: number; R: number };
  /** Largest distance of the cuff ring centroid from the wrist joint, cm. */
  maxCuffToWristCm: { L: number; R: number };
};

const SIDES = ['L', 'R'] as const;

function closedRing(path: number[] | undefined) {
  if (!path || path.length < 3) return null;
  return path[0] === path[path.length - 1] ? path.slice(0, -1) : path;
}

/** Distance of each side's cuff ring centroid from its wrist joint, cm, at frame f. */
export function cuffToWristCm(
  bake: Pick<BakedMotion, 'positions' | 'particles'>,
  frames: MotionFrames,
  cuffs: Record<'L' | 'R', number[]>,
  f: number,
) {
  const joints = anchorFrame(frames, 'joints', f),
    p = bake.positions,
    base = f * bake.particles * 3;
  const out = { L: 0, R: 0 };
  SIDES.forEach((side, s) => {
    const ids = cuffs[side];
    let x = 0,
      y = 0,
      z = 0;
    for (const i of ids) {
      x += p[base + i * 3] / ids.length;
      y += p[base + i * 3 + 1] / ids.length;
      z += p[base + i * 3 + 2] / ids.length;
    }
    out[side] = Math.hypot(x - joints[s * 3], y - joints[s * 3 + 1], z - joints[s * 3 + 2]) * 100;
  });
  return out;
}

export function checkSleeves(
  bake: Pick<BakedMotion, 'positions' | 'particles' | 'metrics' | 'frameCount' | 'fps'>,
  frames: MotionFrames,
  asset: Pick<ClothAsset, 'paths'>,
): SleeveCheck {
  const cuffL = closedRing(asset.paths.cuff_L),
    cuffR = closedRing(asset.paths.cuff_R);
  const j0 = anchorFrame(frames, 'joints', 0);
  // anchor_order joints: wrist.L, wrist.R, lowerarm01.L (elbow), lowerarm01.R.
  const length = (w: number, e: number) =>
    Math.hypot(
      j0[w * 3] - j0[e * 3],
      j0[w * 3 + 1] - j0[e * 3 + 1],
      j0[w * 3 + 2] - j0[e * 3 + 2],
    ) * 100;
  const forearmCm = { L: length(0, 2), R: length(1, 3) };
  const check: SleeveCheck = {
    valid: true,
    reason: null,
    frame: null,
    side: null,
    forearmCm,
    maxRideUpCm: { L: 0, R: 0 },
    maxCuffToWristCm: { L: 0, R: 0 },
  };
  const neutral = bake.metrics[0].cuffBeyondWristCm;
  for (let f = 0; f < bake.frameCount; f++) {
    const cuff = bake.metrics[f].cuffBeyondWristCm;
    const away = cuffL && cuffR ? cuffToWristCm(bake, frames, { L: cuffL, R: cuffR }, f) : null;
    for (const side of SIDES) {
      const ride = Math.max(0, neutral[side] - cuff[side]);
      check.maxRideUpCm[side] = Math.max(check.maxRideUpCm[side], ride);
      if (away) check.maxCuffToWristCm[side] = Math.max(check.maxCuffToWristCm[side], away[side]);
      const lost =
        !Number.isFinite(ride) ||
        ride > forearmCm[side] ||
        (away !== null && away[side] > forearmCm[side]);
      if (lost && check.valid) {
        check.valid = false;
        check.frame = f;
        check.side = side;
        const arm = side === 'L' ? 'left' : 'right';
        check.reason =
          `The simulated ${arm} sleeve came off the arm ${(f / bake.fps).toFixed(1)} s into the move ` +
          `(cuff ${Math.max(ride, away?.[side] ?? 0).toFixed(0)} cm from the wrist), so this physics ` +
          'replay is not shown.';
      }
    }
  }
  return check;
}

export type RecordedBakeTimings = {
  /** Motion data and garment loaded (0 when already loaded). */
  loadMs: number;
  /** Custom frames computed by the body service (request → response). */
  framesMs: number;
  /** Worker bake (relax, if not cached, + motion), as bake.ts measures it. */
  bakeMs: number;
  relaxCached: boolean;
  /** Recording handed over → BakedMove ready. */
  totalMs: number;
  /** Worker relax (0 when cached) and motion phases, ms, and the mean solver step. */
  relaxMs?: number;
  motionMs?: number;
  meanStepMs?: number;
  /** Motion solver steps, frames simulated, and the subdivision used (subdivision.ts). */
  steps?: number;
  simulatedFrames?: number;
  subdivision?: Subdivision;
};

export type RecordedBakedMoveInput = {
  bake: BakedMotion;
  frames: MotionFrames;
  rig: MotionRig;
  anchors: MotionAnchors;
  asset: Pick<ClothAsset, 'paths' | 'landmarks'>;
  /** The static garment fit of this size (GarmentFitResponse zones), for the zone values. */
  staticZones?: Record<string, StaticZone> | null;
  waistband?: Waistband;
  timings?: RecordedBakeTimings;
};

export class RecordedBakedMove implements BakedMove {
  readonly fps: number;
  readonly frameCount: number;
  /** Frames of the recorded window (between the neutral lead-in and lead-out the service adds). */
  readonly recorded: { start: number; end: number };
  /** Peaks over the whole bake (metrics.summarise): exposure, wrist ride-up, restriction. */
  readonly summary: SizeMotionSummary;
  readonly checks: BakedMotion['checks'];
  readonly timings?: RecordedBakeTimings;
  readonly waistband: Waistband;
  /** Sanity gate: invalid when a sleeve lost its arm (readouts are then empty, never shown). */
  readonly sleeves: SleeveCheck;
  private input?: RecordedBakedMoveInput;
  private drivers: Float64Array;
  private world: Float64Array;
  private tapes: PreviewTapes;
  private ring: { front: number; back: number; left: number; right: number };
  private cache = new Map<
    number,
    Pick<LiveTryOnState, 'zones' | 'exposureCm' | 'sleeveRideUpCm'>
  >();

  constructor(input: RecordedBakedMoveInput) {
    const { bake, frames, rig, anchors, asset } = input;
    // The bake may stop before the move's last frame (the unplayed neutral lead-out).
    if (bake.frameCount > frames.count || bake.frameCount < 1)
      throw new Error('The bake does not match the frames of the move');
    this.input = input;
    this.fps = bake.fps;
    this.frameCount = bake.frameCount;
    const hold = frames.motion.hold;
    const last = this.frameCount - 1;
    this.recorded = {
      start: Math.min(last, Math.max(0, Math.round(hold.start_s * this.fps))),
      end: Math.min(last, Math.max(0, Math.round(hold.end_s * this.fps))),
    };
    this.summary = bake.summary;
    this.checks = bake.checks;
    this.timings = input.timings;
    this.waistband = input.waistband ?? DEFAULT_WAISTBAND;
    this.sleeves = checkSleeves(bake, frames, asset);
    this.drivers = new Float64Array(rig.drivers.length * 12);
    this.world = new Float64Array(rig.bones.length * 16);
    const seamL = asset.landmarks.seam_L,
      seamR = asset.landmarks.seam_R;
    this.tapes = {
      paths: asset.paths,
      seams: seamL !== undefined && seamR !== undefined ? [seamL, seamR] : null,
    };
    const index = anchors.ring_index;
    this.ring = {
      front: index.front_centre ?? 0,
      back: index.back_centre ?? anchors.ring_samples / 2,
      left: index.left_side ?? anchors.ring_samples / 4,
      right: index.right_side ?? (3 * anchors.ring_samples) / 4,
    };
  }

  private get data() {
    if (!this.input) throw new Error('This baked move was disposed');
    return this.input;
  }

  /** The raw bake and frames (diagnostics and renders). */
  get bakedMotion() {
    return this.data.bake;
  }
  get motionFrames() {
    return this.data.frames;
  }

  private frame(index: number) {
    if (!Number.isFinite(index)) throw new Error('Invalid frame index');
    return Math.max(0, Math.min(this.frameCount - 1, Math.floor(index)));
  }

  /** Simulated cloth positions of frame i (N·3, metres, scene frame). */
  clothPositions(index: number) {
    const { bake } = this.data,
      f = this.frame(index),
      n = bake.particles * 3;
    return bake.positions.subarray(f * n, (f + 1) * n);
  }

  /** Body drivers (18·12) and bone world poses (B·16) of frame i, in internal buffers. */
  bodyFrame(index: number) {
    const { frames, rig } = this.data;
    frameMatrices(frames, this.frame(index), this.drivers);
    worldFromDrivers(rig, this.drivers, this.world);
    return { drivers: this.drivers, world: this.world };
  }

  applyFrame(index: number, scene: LivePosedScene) {
    if (!isDrivable(scene))
      throw new Error('Physics playback needs a posed scene with setDrivers / setJacketPositions');
    const { drivers, world } = this.bodyFrame(index);
    scene.setDrivers(drivers, world);
    scene.setJacketPositions(this.clothPositions(index));
  }

  /**
   * Hem height above the waistband (metrics.hemAboveWaistband, cm) at the front centre, back
   * centre and the higher side, at frame i; `rise` is the change from frame 0 (the neutral
   * pose). Unfloored; NaN where the hem has left that side of the body.
   */
  hem(index: number, waistband: Waistband = this.waistband) {
    const { bake } = this.data;
    const at = (f: number) => {
      const v = bake.metrics[f].hemAboveCm[waistband];
      return {
        front: v[this.ring.front],
        back: v[this.ring.back],
        sides: Math.max(v[this.ring.left], v[this.ring.right]),
      };
    };
    const now = at(this.frame(index)),
      neutral = at(0);
    return {
      aboveCm: now,
      riseCm: {
        front: now.front - neutral.front,
        back: now.back - neutral.back,
        sides: now.sides - neutral.sides,
      },
    };
  }

  readouts(index: number): Pick<LiveTryOnState, 'zones' | 'exposureCm' | 'sleeveRideUpCm'> {
    const f = this.frame(index);
    const hit = this.cache.get(f);
    if (hit) return hit;
    // A bake whose sleeve lost the arm has no physical readouts.
    if (!this.sleeves.valid) return { zones: [], exposureCm: null, sleeveRideUpCm: null };
    const { bake } = this.data;
    const m = bake.metrics[f],
      m0 = bake.metrics[0];
    // Exposure and ride-up exactly as metrics.summarise reduces them, for this one frame.
    const floor = (cm: number) => (Number.isFinite(cm) && cm > MOTION_FIT.exposureFloorCm ? cm : 0);
    const hem = m.hemAboveCm[this.waistband];
    const wrist = summarise(bake.size, [m0, m]).wrist;
    const out = {
      zones: this.zones(f),
      exposureCm: {
        front: floor(hem[this.ring.front]),
        back: floor(hem[this.ring.back]),
        sides: Math.max(floor(hem[this.ring.left]), floor(hem[this.ring.right])),
      },
      sleeveRideUpCm: { left: wrist.L.rideUp, right: wrist.R.rideUp },
    };
    this.cache.set(f, out);
    return out;
  }

  /**
   * Physics zones. Value: the static ease minus how far the SIMULATED jacket's tape for that zone
   * is stretched compared with the neutral frame (the preview's formula, readouts.ts, on the
   * cloth simulation instead of the skinned jacket); null without a static value. Status 'tight'
   * when that ease is negative or the zone's fabric reached its stretch limit (metrics.restriction),
   * otherwise the static status ('unknown' without one).
   */
  private zones(f: number): ZoneReadout[] {
    const { bake, staticZones } = this.data;
    const stretch = zoneStretchCm(this.tapes, this.clothPositions(0), this.clothPositions(f));
    const share = (frame: number, z: RestrictionZone) => {
      const s = bake.metrics[frame].zones[RESTRICTION_ZONES.indexOf(z)];
      return s && s.edges ? s.atLimit / s.edges : 0;
    };
    const out: ZoneReadout[] = [];
    for (const zone of LIVE_ZONES) {
      const restricted = RESTRICTION_OF[zone].some(
        (z) => share(f, z) - share(0, z) > RECORD.restrictedShareRise,
      );
      const z = staticZones?.[zone];
      const s = stretch[zone];
      let valueCm: number | null = null,
        status: LiveStatus = restricted ? 'tight' : (z?.status ?? 'unknown');
      if (z?.value_cm != null && s !== undefined) {
        valueCm = z.value_cm - Math.max(0, s);
        if (valueCm < 0) status = 'tight';
      }
      out.push({ zone, valueCm, status, basis: 'physics' });
    }
    return out;
  }

  dispose() {
    this.input = undefined;
    this.cache.clear();
  }
}
