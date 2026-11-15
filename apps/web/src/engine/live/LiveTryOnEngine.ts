import { SharedStillDetector } from './sharedStillness';
// The live try-on engine (contract.ts LiveTryOn). Composes:
//   LiveSource (camera / video file / recording) → confidence gate → TS rig (liveRig.ts)
//   → LiveAvatar (body + skinned PREVIEW jacket) → MirrorView, and the injected ArRenderer (V2).
// The posed scene is always the person's TRUE pose (no left/right swaps anywhere); mirroring is
// display only: each view flips its final image (setMirrorDisplay, default on), like a mirror.
// "Record a move" delegates to the injected MoveBaker (V3); without one it records the poses
// and says the physics bake is not available yet. Every zone number carries its basis.
import { api, type ClothAsset } from '../../api.ts';
import { clothAsset } from '../motion/MotionClient.ts';
import type { AnatomicalPose } from '../motion/rig.ts';
import type {
  ArRenderer,
  BakedMove,
  LiveFrame,
  LiveSource,
  LiveTryOn,
  LiveTryOnOptions,
  LiveTryOnState,
  MoveBaker,
  ZoneReadout,
} from './contract.ts';
import { CLOSE } from './ar/config.ts';
import { DYNAMICS } from './deform/config.ts';
import { plausibleHeading, rootYawFromWorld, YawFilter } from './deform/heading.ts';
import type { DeformStatus } from './deform/types.ts';
import { LiveAvatar } from './LiveAvatar.ts';
import { TorsoHold } from './torsoHold.ts';
import {
  liveNeutral,
  PoseSmoother,
  SLEW_DEG_S,
  StillnessLock,
  trackingQuality,
} from './livePose.ts';
import { loadLiveRig, type LiveRig } from './liveRig.ts';
import { KioskMirrorView } from './KioskMirrorView.ts';
import { MirrorView } from './MirrorView.ts';
import { previewReadouts, staticReadouts, type StaticZone } from './readouts.ts';
import { isCalibratable, TrackedSource } from './sources/trackedSource.ts';
import { RecordingError, recordedPoses } from './record/recordedPoses.ts';

const ID = /^[a-f0-9]{64}$/;
/** No pose for this long while calibrated = "lost" (heuristic: ~10 camera frames). */
export const LOST_AFTER_MS = 350;
/** Frames in the wrist-travel statistic (1 s at 30 fps). */
const JITTER_WINDOW = 30;
/** The kiosk-look mirror falls back to the light stage if its programs are not ready by then. */
export const KIOSK_LOOK_TIMEOUT_MS = 20000;
/** Turned away: image shoulder span below this share of the recent frontal span (cos 60 deg). */
export const TURNED_SPAN_RATIO = 0.5;
/** Per-frame decay of the remembered frontal shoulder span (~10 s half-life at 30 fps). */
const SPAN_DECAY = 0.9977;
const PROMPTS = ['Tracking is weak', 'Turn back toward', 'Step back a little'];
/** Below this tracking quality the status line asks for more light or more room. Heuristic. */
export const WEAK_TRACKING = 0.3;
/** The neutral stand falls back to the camera's vertical after this long (heuristic). */
export const CALIBRATION_FALLBACK_MS = 10000;
/** State updates to listeners at most this often, except on a phase change. */
const STATE_INTERVAL_MS = 100;

/**
 * Optional on the injected ArRenderer (duck-typed): returns a corrected pose (true sides, contract
 * degrees) for this frame, or null to keep the smoothed one. `scene.fkJoints(pose)` evaluates
 * candidates without skinning.
 */
export type PoseAdjuster = {
  adjustPose(frame: LiveFrame, pose: AnatomicalPose, scene: LiveAvatar): AnatomicalPose | null;
};

/** One tracked frame's diagnostics (labs: "Record diagnostics"). Local only, never uploaded. */
export type DiagnosticEntry = {
  t: number;
  receivedAt: number;
  phase: string;
  width: number;
  height: number;
  landmarks2d: LiveFrame['landmarks2d'];
  rawPose: AnatomicalPose | null;
  confidence: LiveFrame['confidence'];
  /** null for frames without a tracked pose (lost, turning away). */
  posed: {
    smoothed: AnatomicalPose;
    estimated: string[];
    adjusted: AnatomicalPose | null;
    final: AnatomicalPose;
    clamps: number;
    warnings: string[];
  } | null;
  joints: Record<string, [number, number, number]> | null;
  arAlignment: number | null;
  /** The AR renderer's debugState() when it offers one (V2), else null. */
  ar: unknown;
  timing: {
    trackerMs: number | null;
    inferenceMs: number | null;
    poseMs: number;
    displayMs: number;
    totalMs: number | null;
    sourceFps: number;
    renderFps: number;
  };
};

/**
 * Guards on the screen fit's output (agent V2's adjustPose). Lead decision 15:40: hanging, bent
 * arms need plane/axial corrections of 80-90 deg (cam-tshirt), so the cap is only a sanity bound
 * (FIT_ROTATION_CAP_DEG); V2's branch continuity and its 8 deg/frame slew prevent flips. Here
 * only a spike guard (FIT_SLEW_DEG_S) remains: no second smoothing filter, which measured
 * ~390 ms of lag behind the landmarks on the user's 15:18 recording.
 */
export const FIT_ROTATION_CAP_DEG = 100;
export const FIT_SLEW_DEG_S: Record<string, number> = { shoulder_plane: 250, shoulder_axial: 250 };
const FIT_ROTATION = /^shoulder_[LR]_(plane|axial)$/;
const FIT_ARM = /^(shoulder_[LR]_(plane|axial|elevation)|elbow_[LR]_flexion)$/;

/** Caps the fit's plane/axial to ±FIT_ROTATION_CAP_DEG around the smoothed pose. Pure. */
export function capFit(adjusted: AnatomicalPose, smoothed: AnatomicalPose): AnatomicalPose {
  const out: AnatomicalPose = { ...adjusted };
  for (const key of Object.keys(out)) {
    const base = smoothed[key];
    if (!FIT_ROTATION.test(key) || base === undefined || !Number.isFinite(out[key])) continue;
    out[key] =
      base + Math.max(-FIT_ROTATION_CAP_DEG, Math.min(FIT_ROTATION_CAP_DEG, out[key] - base));
  }
  return out;
}

/**
 * Spike guard per DOF on the (capped) screen-fit output: a median of the last three fit values
 * removes one-frame flips (the fit without its own smoothing flipped up to 33 deg/frame on
 * cam-parka) at the cost of at most one frame (~33 ms), then the slew limit. No smoothing lag.
 *
 * ?f1arm=1 (agent F1, lead RC5 item 2, user: "the sleeve follows the wrist with a delay"): no
 * median and the tracker's own slew (SLEW_DEG_S, 600 deg/s) for plane/axial too. During a move
 * the median of three rising values is the previous one, a whole camera frame behind (42 ms at
 * 24 fps), and a 300-400 deg/s swing outran the 250 deg/s plane/axial slew (a 90 deg swing at
 * 300 deg/s ends 15 deg behind); together about the 40-135 ms forearm lag CX-TRY measured on the
 * live recordings. Flips stay guarded upstream (screenFit.ts branch continuity, 40 deg/frame).
 */
export class FitFilter {
  constructor(
    private median = true,
    private fitSlew: Record<string, number> = FIT_SLEW_DEG_S,
  ) {}
  private last = new Map<string, { value: number; t: number }>();
  private history = new Map<string, number[]>();
  apply(t: number, pose: AnatomicalPose): AnatomicalPose {
    const out: AnatomicalPose = {};
    for (const [key, value] of Object.entries(pose)) {
      if (!Number.isFinite(value) || key === 'pelvis_drop_m') {
        out[key] = value;
        continue;
      }
      const prev = this.last.get(key);
      let v = value;
      if (this.median && FIT_ARM.test(key)) {
        const h = this.history.get(key) ?? [];
        h.push(value);
        if (h.length > 3) h.shift();
        this.history.set(key, h);
        if (h.length === 3) v = [...h].sort((a, b) => a - b)[1];
      }
      if (prev) {
        const dof = key.replace(/_[LR]_/, '_');
        const rate = this.fitSlew[dof] ?? SLEW_DEG_S[dof] ?? 600;
        const max = rate * Math.max(0, (t - prev.t) / 1000);
        v = prev.value + Math.max(-max, Math.min(max, v - prev.value));
      }
      this.last.set(key, { value: v, t });
      out[key] = v;
    }
    return out;
  }
}

/**
 * Hanging arms from the 2D image (user report 15:18: relaxed arms showed ~30-40 deg after the
 * screen fit). When the shoulder→elbow segment in the image is long (not foreshortened toward the
 * camera) and points within HANGING_IMAGE_DEG of straight down, the arm hangs: its elevation is
 * capped at the image angle + HANGING_MARGIN_DEG. A forward-raised arm is foreshortened, so it is
 * never mistaken for hanging. Heuristics.
 */
export const HANGING_IMAGE_DEG = 20;
export const HANGING_MARGIN_DEG = 8;
const HANGING_MIN_LENGTH = 0.75;
/** Per-frame decay of the remembered full upper-arm length in the image (~10 s half-life). */
const ARM_LENGTH_DECAY = 0.9977;

/**
 * An arm whose MediaPipe world elbow is this far (m) in front of its shoulder is raised forward,
 * not hanging, even when its image segment looks vertical and long (F3 14:43, puffer venue
 * 22.6–25.6 s crossed arms: the upper arm ~30° forward, its fitted 36–41° elevation was capped to
 * 22–28° and the drawn elbow left 43–56 px off). Used with ?f3arms=1 (forwardSkip). Heuristic.
 */
export const HANGING_FORWARD_M = 0.08;

export class HangingArms {
  private longest = { L: 0, R: 0 };
  constructor(private readonly forwardSkip = false) {}
  apply(frame: LiveFrame, pose: AnatomicalPose): AnatomicalPose {
    const lm = frame.landmarks2d;
    if (!lm || lm.length < 15) return pose;
    let out = pose;
    for (const [side, s, e] of [
      ['L', 11, 13],
      ['R', 12, 14],
    ] as const) {
      if (lm[s].visibility < 0.5 || lm[e].visibility < 0.5) continue;
      const w = this.forwardSkip ? frame.world : null;
      const forward =
        !!w?.[s] &&
        !!w[e] &&
        w[s].visibility >= 0.5 &&
        w[e].visibility >= 0.5 &&
        w[e].z - w[s].z < -HANGING_FORWARD_M;
      const dx = lm[e].x - lm[s].x,
        dy = lm[e].y - lm[s].y;
      const length = Math.hypot(dx, dy);
      this.longest[side] = Math.max(length, this.longest[side] * ARM_LENGTH_DECAY);
      if (forward) continue;
      if (dy <= 0 || length < HANGING_MIN_LENGTH * this.longest[side]) continue;
      const angle = (Math.atan2(Math.abs(dx), dy) * 180) / Math.PI;
      if (angle > HANGING_IMAGE_DEG) continue;
      const key = `shoulder_${side}_elevation`;
      const cap = angle + HANGING_MARGIN_DEG;
      if (out[key] !== undefined && out[key] > cap) out = { ...out, [key]: cap };
    }
    return out;
  }
}

type WarmFn = (options: LiveTryOnOptions, signal?: AbortSignal) => Promise<unknown>;

export type StaticFit = { sizes: Record<string, { zones: Record<string, StaticZone> }> };

export type LiveTryOnDeps = {
  arRenderer?: ArRenderer;
  moveBaker?: MoveBaker;
  /** 'kiosk' (default): the kiosk Viewer and GarmentLayer look; 'simple': a light stage. */
  mirrorLook?: 'kiosk' | 'simple';
  /** Fall back to arms hanging down rather than the display A-pose (default true). */
  armsDown?: boolean;
  /** Median-of-3 on the screen fit's arm DOFs (one-frame flip guard; default true). */
  fitMedian?: boolean;
  /** Drive hips and knees from the tracker (default false: kiosk framing is head to hips). */
  driveLegs?: boolean;
  /** Hysteresis, confidence blending and the arm-gimbal hold (default true; false = before). */
  stabilize?: boolean;
  /** Preload the MoveBaker once tracking starts (default true when it offers warm()). */
  warmBaker?: boolean;
  /** Person segmentation for the AR renderer; default on when an arRenderer is given. */
  segmentation?: boolean;
  /** Flip both views' final images like a mirror (default true). Presentation only. */
  mirrorDisplay?: boolean;
  /**
   * The live jacket's 'dynamics' deformer (agent V6, deform/): hem/hood/cuff sway. Default: the
   * page's ?dyn=0 / ?dyn=1, else DYNAMICS.defaultOn. Fit readouts never depend on it.
   */
  dynamics?: boolean;
  /**
   * Feed the whole-body heading (body turns) to the dynamics. Default: ?dynyaw=0/1, else
   * DYNAMICS.headingDefaultOn (off: on the recorded sessions the heading wandered 20-50 deg with
   * no turn and swung the hem; the engine still computes it for the HUD).
   */
  dynamicsHeading?: boolean;
  /**
   * Stillness lock on the shown pose (livePose.ts StillnessLock): at rest the pose, so the mirror
   * and the AR rig, is exactly constant. Experimental OFF until rest/onset gates pass; ?still=1 opts in.
   */
  stillnessLock?: boolean;
  /** Overrides for tests and the kiosk; defaults fetch from the local body service (/api). */
  loadRig?: (bodyId: string, signal: AbortSignal) => Promise<ArrayBuffer>;
  loadCloth?: (fitId: string, size: string, signal: AbortSignal) => Promise<ClothAsset>;
  /** The garment fit of this body and product (static-fit zones); null = no static readouts. */
  loadFit?: (options: LiveTryOnOptions, signal: AbortSignal) => Promise<StaticFit | null>;
};

export type LiveStats = {
  /** Tracked frames per second from the source. */
  sourceFps: number;
  /** Mirror frames rendered per second. */
  renderFps: number;
  /** Tracker: camera frame callback → pose emitted (ms), from the vision tracker. */
  trackerMs: number | null;
  /** MediaPipe inference (ms). */
  inferenceMs: number | null;
  /** Tracker model and delegate, e.g. "full/GPU". */
  tracker: string | null;
  /** Mean and p90 per-frame wrist travel in the mirror over the last frames (mm), both wrists. */
  wristStepMm: { mean: number; p90: number } | null;
  /** Rig evaluation + skinning of body and jacket (ms). */
  poseMs: number;
  /** Pose emitted → mirror frame drawn (ms). */
  displayMs: number;
  /** trackerMs + poseMs + displayMs: camera frame callback → avatar on screen (ms). */
  totalMs: number | null;
  /**
   * Frame received (onFrame start) → the next animation frame (ms). The AR canvas is drawn inside
   * onFrame, so it is on screen by then; pose, AR solve and draw are all inside this interval.
   * Read at the top of the tick, before the mirror's own update (F2 14:42: displayMs is read
   * after the mirror copy and starts at onFrame start, so totalMs counts poseMs twice).
   */
  arDisplayMs: number;
  /** trackerMs + arDisplayMs: camera frame callback → AR frame on screen (ms); no double count. */
  arTotalMs: number | null;
  /** Pose DOFs estimated with enough confidence in the last frame. */
  estimated: string[];
  clamps: number;
  /** The live jacket deformers (V7 pose correctives, V6 dynamics): active, note, ms per frame. */
  deform: DeformStatus[];
  /** The whole-body heading fed to the deformers (deg, + = turned to the left); null = unknown. */
  rootYawDeg: number | null;
  /** Pose groups the stillness lock holds exactly constant now (livePose.ts StillnessLock). */
  stillLocked: string[];
};

/** ?name=0 / ?name=1 on the page, if any (labs and the kiosk). */
function urlFlag(name: string): boolean | undefined {
  if (typeof location === 'undefined') return undefined;
  const value = new URLSearchParams(location.search).get(name);
  return value === '0' ? false : value === '1' ? true : undefined;
}

/**
 * f1close: both hips are hidden from the neutral stand: a hip landmark outside the frame, within
 * CLOSE.edgeMarginFrac of its edge, or below CLOSE.lowerMinVisibility (same rule as the AR solve,
 * ArTracker extrapolatedLowerBody).
 */
export function hipsHidden(frame: LiveFrame): boolean {
  const lm = frame.landmarks2d;
  if (!lm || lm.length < 25) return true;
  const m = CLOSE.edgeMarginFrac * frame.height;
  return [23, 24].some((i) => {
    const p = lm[i];
    return (
      !(p.visibility >= CLOSE.lowerMinVisibility) ||
      p.x < m ||
      p.y < m ||
      p.x > frame.width - m ||
      p.y > frame.height - m
    );
  });
}

async function defaultRig(bodyId: string, signal: AbortSignal) {
  if (!ID.test(bodyId)) throw new Error('Invalid body ID');
  const response = await fetch(`/api/motion/${bodyId}/rig.bin`, { cache: 'no-store', signal });
  if (response.status === 404) throw new Error('Body expired from memory. Build your body again.');
  if (!response.ok) throw new Error(`Body rig unavailable (${response.status})`);
  return response.arrayBuffer();
}

const idle = (): LiveTryOnState => ({
  phase: 'idle',
  message: '',
  trackingQuality: 0,
  arAlignment: null,
  zones: [],
  progress: null,
  exposureCm: null,
  sleeveRideUpCm: null,
});

export class LiveTryOnEngine implements LiveTryOn {
  private state: LiveTryOnState = idle();
  private listeners = new Set<(s: LiveTryOnState) => void>();
  private source?: LiveSource;
  private offFrame?: () => void;
  private options?: LiveTryOnOptions;
  private live?: LiveRig;
  private avatar?: LiveAvatar;
  private mirrorView?: MirrorView | KioskMirrorView;
  private mirrorVersion = -1;
  private mirrorContainer?: HTMLElement;
  private arContainer?: HTMLElement;
  private arPlaceholder?: HTMLElement;
  private arHost?: HTMLElement;
  private fit: StaticFit | null = null;
  private abort = new AbortController();
  private raf = 0;
  private lastEmit = 0;
  private lastPoseAt = 0;
  private smoother: PoseSmoother;
  private fitFilter: FitFilter;
  /** ?f3arms=1 (agent F3): a forward arm (world elbow in front of the shoulder) is not capped. */
  private hanging = new HangingArms(urlFlag('f3arms') ?? false);
  /** Per-frame wrist travel in the mirror (mm), last JITTER_WINDOW frames, for the stats. */
  private wristSteps: number[] = [];
  private lastWrists?: [number, number, number][];
  /** The avatar has eased back to the neutral stand after the person left. */
  private atNeutral = false;
  /** The last frame from the source (for the labs' overlays). */
  lastFrame?: LiveFrame;
  private calibrating = false;
  private frameTimes: number[] = [];
  private pendingDisplay: number | null = null;
  private pendingAr: number | null = null;
  /** Raw LiveFrames of the recording window (record/recordedPoses.ts turns them into poses). */
  private recording: LiveFrame[] | null = null;
  private recordEnd = 0;
  private recordStart = 0;
  private recordResolve?: () => void;
  private lastRecording: { t: number; pose: AnatomicalPose }[] = [];
  private baked?: BakedMove;
  private playback?: { start: number; kind: 'physics' | 'preview' };
  private sizeLoad = 0;
  private perf: LiveStats = {
    sourceFps: 0,
    renderFps: 0,
    trackerMs: null,
    inferenceMs: null,
    poseMs: 0,
    displayMs: 0,
    totalMs: null,
    arDisplayMs: 0,
    arTotalMs: null,
    estimated: [],
    clamps: 0,
    tracker: null,
    wristStepMm: null,
    deform: [],
    rootYawDeg: null,
    stillLocked: [],
  };
  /** Whole-body heading for the deformers (deform/heading.ts). */
  private yawFilter = new YawFilter();
  private dynamicsOn: boolean;
  private headingOn: boolean;
  private stillness = new StillnessLock();
  private sharedStillness = new SharedStillDetector();
  private stillOn: boolean;
  /**
   * ?f1turn=1 (agent F1, D1/D2): the AR draws the jacket through the turn and on the back
   * (ArTracker.turnThrough), so the status line no longer asks the person to turn back.
   */
  private readonly turnThrough = urlFlag('f1turn') ?? false;
  /**
   * ?f1close=1 (agent F1, lead U2; ar/config.ts CLOSE): head-to-waist framing is a normal try-on.
   * No request to step back for the hands (a close-up crops them), only when a shoulder is cut;
   * no head-to-hips wording; a neutral stand that cannot see the hips ends at once with the
   * camera as vertical instead of after CALIBRATION_FALLBACK_MS.
   */
  private readonly closeRange = urlFlag('f1close') ?? false;
  private calibrationAttempt?: AbortController;
  /**
   * ?f1torso=1 (agent F1; user J1 "wobbles like jelly"; torsoHold.ts, ar/config.ts TORSO): the trunk
   * DOFs that bend and twist the skinned jacket hold until a real, sustained change.
   */
  private readonly torsoHold = urlFlag('f1torso') ? new TorsoHold() : null;
  private hipsHiddenSince?: number;
  /**
   * ?f1idle=1 (agent F1, D9 fps; F4 16:17): while the mirror's canvas is not shown (Full AR, ?arfull=1)
   * the engine skips the mirror's per-pose geometry copy / draw (F2's kiosk profile: mirror.update
   * 8–11 ms of main thread per pose). It catches up on the first frame it is visible again.
   */
  private readonly mirrorIdle = urlFlag('f1idle') ?? false;
  private mirrorShown = true;
  private mirrorObserver?: IntersectionObserver;

  constructor(private deps: LiveTryOnDeps = {}) {
    this.dynamicsOn = deps.dynamics ?? urlFlag('dyn') ?? DYNAMICS.defaultOn;
    this.headingOn = deps.dynamicsHeading ?? urlFlag('dynyaw') ?? DYNAMICS.headingDefaultOn;
    this.stillOn = deps.stillnessLock ?? urlFlag('still') ?? false;
    this.mirrored = deps.mirrorDisplay ?? true;
    this.smoother = new PoseSmoother(undefined, undefined, deps.stabilize ?? true);
    const fastArms = urlFlag('f1arm') ?? false;
    this.fitFilter = new FitFilter(deps.fitMedian ?? !fastArms, fastArms ? {} : FIT_SLEW_DEG_S);
  }

  private mirrored = true;
  get mirrorDisplay() {
    return this.mirrored;
  }

  /** Flips the displayed image of both views (CSS on the elements the engine owns). */
  setMirrorDisplay(on: boolean) {
    this.mirrored = on;
    this.applyMirror();
  }

  private applyMirror() {
    const transform = this.mirrored ? 'scaleX(-1)' : '';
    if (this.mirrorView) this.canvasOf(this.mirrorView).style.transform = transform;
    // An AR renderer that mirrors its own stage (keeping its badges readable) is told; only
    // otherwise is its host flipped, so the image is never flipped twice.
    const ar = this.deps.arRenderer;
    if (ar?.setMirrorDisplay) {
      ar.setMirrorDisplay(this.mirrored);
      if (this.arHost) this.arHost.style.transform = '';
    } else if (this.arHost) this.arHost.style.transform = transform;
  }
  /** The posed avatar (LivePosedScene) once started. */
  get posedScene() {
    return this.avatar;
  }
  /** The injected AR renderer, if any (labs: diagnostics). */
  get arRenderer() {
    return this.deps.arRenderer;
  }
  get currentState() {
    return this.state;
  }
  get currentSource() {
    return this.source;
  }

  stats(): LiveStats {
    const s = this.source && isCalibratable(this.source) ? this.source.stats() : null;
    const trackerMs = s ? s.latencyMs : null;
    return {
      ...this.perf,
      sourceFps: this.frameTimes.length,
      renderFps:
        this.mirrorView instanceof KioskMirrorView
          ? this.mirrorView.drawFps
          : (this.mirrorView?.fps ?? 0),
      trackerMs,
      inferenceMs: s ? s.inferenceMs : null,
      tracker: s ? `${s.model}/${s.delegate}` : null,
      wristStepMm: this.wristSteps.length
        ? (() => {
            const sorted = [...this.wristSteps].sort((a, b) => a - b);
            return {
              mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
              p90: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))],
            };
          })()
        : null,
      totalMs: trackerMs === null ? null : trackerMs + this.perf.poseMs + this.perf.displayMs,
      arTotalMs: trackerMs === null ? null : trackerMs + this.perf.arDisplayMs,
      deform: this.avatar?.deformStatus() ?? [],
      stillLocked: this.stillOn ? this.stillness.lockedGroups : [],
    };
  }

  /** Turns the live jacket dynamics on or off (labs); the fit readouts never change. */
  setDynamics(on: boolean) {
    this.dynamicsOn = on;
    this.avatar?.deformers.setEnabled('dynamics', on);
  }
  get dynamics() {
    return this.dynamicsOn;
  }

  /**
   * The whole-body heading for the deformers: V2's resolved heading (ArCompositor
   * bodyHeadingDeg, read-only) when an AR renderer is attached, else the world landmarks' hip
   * line; through a dead-band filter (deform/heading.ts). null = unknown (the deformer holds).
   */
  private heading(frame: LiveFrame, now: number): number | null {
    const ar = this.deps.arRenderer as { bodyHeadingDeg?: unknown } | undefined;
    let raw: number | null;
    if (ar) {
      const value: unknown =
        typeof ar.bodyHeadingDeg === 'function'
          ? (ar.bodyHeadingDeg as () => unknown).call(ar)
          : ar.bodyHeadingDeg;
      raw = typeof value === 'number' && Number.isFinite(value) ? value : null;
    } else raw = rootYawFromWorld(frame.world);
    // Ambiguous (its size disagrees with the image shoulder span): null, the deformer holds.
    const yaw = this.yawFilter.update(
      now,
      plausibleHeading(raw, frame.landmarks2d ? this.spanRatio : null),
    );
    this.perf.rootYawDeg = yaw;
    return yaw;
  }

  onState(callback: (state: LiveTryOnState) => void) {
    this.listeners.add(callback);
    callback(this.state);
    return () => {
      this.listeners.delete(callback);
    };
  }

  private set(patch: Partial<LiveTryOnState>, force = false) {
    const phaseChanged = patch.phase !== undefined && patch.phase !== this.state.phase;
    this.state = { ...this.state, ...patch };
    const now = performance.now();
    if (!force && !phaseChanged && now - this.lastEmit < STATE_INTERVAL_MS) return;
    this.lastEmit = now;
    for (const l of this.listeners) l(this.state);
  }

  private fail(error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    console.error('[live] engine error', error);
    this.set({ phase: 'error', message: error instanceof Error ? error.message : String(error) });
  }

  attachMirrorView(container: HTMLElement) {
    if (this.mirrorView) {
      this.unbindMirror();
      this.mirrorView.dispose();
    }
    this.mirrorContainer = container;
    this.mirrorView =
      this.deps.mirrorLook === 'simple'
        ? new MirrorView(container)
        : new KioskMirrorView(container);
    this.bindMirror();
    this.applyMirror();
    this.observeMirror();
    this.loop();
  }

  /** f1idle: track whether the mirror canvas is on screen (no per-frame layout reads). */
  private observeMirror() {
    this.mirrorObserver?.disconnect();
    this.mirrorObserver = undefined;
    this.mirrorShown = true;
    if (!this.mirrorIdle || !this.mirrorView || typeof IntersectionObserver === 'undefined') return;
    this.mirrorObserver = new IntersectionObserver((entries) => {
      for (const e of entries) this.mirrorShown = e.isIntersecting;
    });
    this.mirrorObserver.observe(this.canvasOf(this.mirrorView));
  }

  private canvasOf(view: MirrorView | KioskMirrorView) {
    return view instanceof KioskMirrorView ? view.canvas : view.renderer.domElement;
  }

  /** Puts the current avatar (body + jacket) into the mirror view. */
  private bindMirror() {
    const view = this.mirrorView,
      avatar = this.avatar;
    if (!view || !avatar) return;
    this.mirrorVersion = -1;
    if (view instanceof MirrorView) {
      view.add(avatar.root);
      return;
    }
    view.setBody(avatar);
    void this.showMirrorJacket();
  }

  private unbindMirror() {
    if (this.mirrorView instanceof MirrorView && this.avatar)
      this.mirrorView.remove(this.avatar.root);
  }

  /** The kiosk-look view draws the jacket with its own layer (programs compiled first). */
  private async showMirrorJacket() {
    const view = this.mirrorView;
    if (!(view instanceof KioskMirrorView) || !this.avatar) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The kiosk look waits for its shader programs. If the GPU never reports them linked
      // (seen once under GPU contention), fall back to the light stage rather than hang.
      const ready = await Promise.race([
        view.setJacket(this.avatar.jacketAsset ?? null).then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), KIOSK_LOOK_TIMEOUT_MS);
        }),
      ]);
      if (ready) this.mirrorVersion = -1;
      else if (this.mirrorView === view) {
        console.warn('[live] kiosk look not ready in time: using the light mirror stage');
        this.useSimpleMirror();
      }
    } catch (error) {
      console.error('[live] mirror jacket failed', error);
      if (this.mirrorView === view) this.useSimpleMirror();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Replaces the kiosk-look mirror with the light MirrorView in the same container. */
  private useSimpleMirror() {
    const container = this.mirrorContainer;
    if (!container || this.mirrorView instanceof MirrorView) return;
    this.mirrorObserver?.disconnect();
    this.mirrorView?.dispose();
    this.mirrorView = new MirrorView(container);
    this.bindMirror();
    this.applyMirror();
    this.observeMirror();
  }

  attachArView(container: HTMLElement) {
    this.arPlaceholder?.remove();
    this.arPlaceholder = undefined;
    this.arHost?.remove();
    // The AR renderer draws into a host the engine owns, so the mirror flip never touches the
    // caller's container or its overlays.
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;inset:0';
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.append(host);
    this.arHost = host;
    this.arContainer = host;
    this.applyMirror();
    if (this.deps.arRenderer) {
      this.deps.arRenderer.attach(host, this.source?.video ?? null);
      this.applyMirror();
      return;
    }
    const note = document.createElement('div');
    note.textContent = 'AR view not available yet (agent V2 is building it).';
    note.style.cssText =
      'display:grid;place-items:center;height:100%;font:600 20px system-ui;color:#555;background:#f2f1ee;text-align:center;padding:16px';
    container.append(note);
    this.arPlaceholder = note;
    host.remove();
    this.arHost = undefined;
    this.arContainer = undefined;
  }

  /**
   * Loads the body and dresses the jacket without a source: the avatar stands in the body's
   * neutral (display) pose. Used by start() and by the labs' still renders.
   */
  async load(options: LiveTryOnOptions) {
    this.stopSource();
    this.abort.abort();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.options = { ...options };
    this.set({ ...idle(), phase: 'starting', message: 'Loading your body…' }, true);
    try {
      await this.loadBody(options, signal);
      if (!signal.aborted) this.set({ phase: 'idle', message: 'Dressed (neutral pose)' }, true);
    } catch (error) {
      this.fail(error);
    }
  }

  /** The kiosk-look mirror view, when attached (stills and framing in the labs). */
  get kioskView() {
    return this.mirrorView instanceof KioskMirrorView ? this.mirrorView : undefined;
  }

  private async loadBody(options: LiveTryOnOptions, signal: AbortSignal) {
    const loadRig = this.deps.loadRig ?? defaultRig;
    const [buffer, fit] = await Promise.all([
      loadRig(options.bodyId, signal),
      this.deps.loadFit?.(options, signal) ?? Promise.resolve(null),
    ]);
    if (signal.aborted) return;
    this.fit = fit;
    this.live = loadLiveRig(buffer);
    this.unbindMirror();
    this.avatar?.dispose();
    this.avatar = new LiveAvatar(this.live, { deformers: { dynamics: this.dynamicsOn } });
    this.bindMirror();
    this.set({ message: 'Dressing the jacket…', zones: this.staticZones() }, true);
    await this.loadSize(options.size, signal);
  }

  async start(source: LiveSource, options: LiveTryOnOptions) {
    this.stopSource();
    this.abort.abort();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.options = { ...options };
    this.set({ ...idle(), phase: 'starting', message: 'Loading your body…' }, true);
    try {
      await this.loadBody(options, signal);
      if (signal.aborted) return;
      this.set({ message: 'Starting the camera…' }, true);
      this.source = source;
      this.offFrame = source.onFrame((frame) => this.onFrame(frame));
      // Segmentation (AR occlusion) defaults on when an AR renderer is attached.
      if (
        source instanceof TrackedSource &&
        this.deps.arRenderer &&
        this.deps.segmentation !== false
      )
        source.setSegmentation(true);
      await source.start();
      if (signal.aborted) return;
      if (this.deps.arRenderer && this.arContainer) {
        // The compositor re-creates its canvas on attach: re-apply the mirror state after.
        this.deps.arRenderer.attach(this.arContainer, source.video);
        this.applyMirror();
      }
      this.lastPoseAt = performance.now();
      if (isCalibratable(source) && !source.calibrated) void this.calibrate();
      else this.set({ phase: 'lost', message: 'Step into view' }, true);
      this.loop();
    } catch (error) {
      this.fail(error);
    }
  }

  /** Preloads the physics bake (motion data, relaxed cloth) in its worker while tracking. */
  private warmBaker() {
    const baker = this.deps.moveBaker as (MoveBaker & { warm?: WarmFn }) | undefined;
    if (!baker?.warm || !this.options || this.deps.warmBaker === false) return;
    baker.warm({ ...this.options }, this.abort.signal).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError'))
        console.warn('[live] bake warm-up failed', error);
    });
  }

  /** Runs (or re-runs) the neutral stand. */
  async calibrate() {
    const source = this.source;
    if (!source || !isCalibratable(source)) return;
    this.calibrating = true;
    this.set(
      { phase: 'calibrating', message: 'Stand straight, arms relaxed at your sides', progress: 0 },
      true,
    );
    // A neutral stand that cannot finish (shaky video, a judge who keeps moving) must not block
    // the demo: after CALIBRATION_FALLBACK_MS the pose is measured against the camera's up axis,
    // and the screen says so.
    const attempt = new AbortController();
    const parent = this.abort.signal;
    const onParent = () => attempt.abort();
    parent.addEventListener('abort', onParent, { once: true });
    const timer = setTimeout(() => attempt.abort(), CALIBRATION_FALLBACK_MS);
    this.calibrationAttempt = attempt;
    this.hipsHiddenSince = undefined;
    try {
      await source.calibrate(attempt.signal);
      this.calibrating = false;
      this.avatar?.resetPose();
      this.smoother.reset();
      this.stillness.reset();
      this.sharedStillness.reset();
      this.set(
        { phase: 'tracking', message: 'Move! The mirror follows you', progress: null },
        true,
      );
      this.warmBaker();
    } catch (error) {
      this.calibrating = false;
      if (parent.aborted) return;
      if (error instanceof DOMException && error.name === 'AbortError') {
        source.useCameraVertical();
        this.avatar?.resetPose();
        this.smoother.reset();
        this.stillness.reset();
        this.sharedStillness.reset();
        this.set(
          {
            phase: 'tracking',
            progress: null,
            message: 'Calibration skipped: using the camera as vertical. Recalibrate any time.',
          },
          true,
        );
        this.warmBaker();
      } else this.fail(error);
    } finally {
      clearTimeout(timer);
      if (this.calibrationAttempt === attempt) this.calibrationAttempt = undefined;
      parent.removeEventListener('abort', onParent);
    }
  }

  private staticZones(): ZoneReadout[] {
    const size = this.options?.size;
    return staticReadouts(size ? this.fit?.sizes[size]?.zones : undefined);
  }

  private async loadSize(size: string, signal: AbortSignal) {
    const avatar = this.avatar;
    const options = this.options;
    if (!avatar || !options) return;
    const ticket = ++this.sizeLoad;
    const load =
      this.deps.loadCloth ??
      ((fitId: string, s: string, sig: AbortSignal) => clothAsset(fitId, s, sig));
    const asset = await load(options.fitId, size, signal);
    if (signal.aborted || ticket !== this.sizeLoad) return;
    avatar.setGarment(asset, { bodyId: options.bodyId, productId: options.productId, size });
    // Never block tracking on the mirror's look: it dresses in the background.
    void this.showMirrorJacket();
  }

  /**
   * A recorded or baked move belongs to one product and size: a change invalidates it (playback
   * returns to live, the bake is disposed, "Replay" has nothing to replay).
   */
  private invalidateMoves() {
    const wasPlaying = this.state.phase === 'playback';
    this.playback = undefined;
    this.avatar?.setDeformBypass(false);
    this.baked?.dispose();
    this.baked = undefined;
    this.lastRecording = [];
    if (wasPlaying)
      this.set(
        {
          phase: 'tracking',
          progress: null,
          exposureCm: null,
          sleeveRideUpCm: null,
          message: 'Back to live',
        },
        true,
      );
  }

  async setSize(size: string) {
    if (!this.options) return;
    if (size !== this.options.size) this.invalidateMoves();
    this.options = { ...this.options, size };
    try {
      await this.loadSize(size, this.abort.signal);
      this.set({ zones: this.staticZones() }, true);
    } catch (error) {
      this.fail(error);
    }
  }

  async setProduct(productId: string, fitId: string) {
    if (!this.options) return;
    if (productId !== this.options.productId || fitId !== this.options.fitId)
      this.invalidateMoves();
    this.options = { ...this.options, productId, fitId };
    try {
      this.fit = (await this.deps.loadFit?.(this.options, this.abort.signal)) ?? null;
      const sizes = this.fit ? Object.keys(this.fit.sizes) : [];
      if (sizes.length && !sizes.includes(this.options.size)) this.options.size = sizes[0];
      await this.loadSize(this.options.size, this.abort.signal);
      this.set({ zones: this.staticZones() }, true);
    } catch (error) {
      this.fail(error);
    }
  }

  private onFrame(frame: LiveFrame) {
    // Publish before any layer sees this frame. Recorded physics must remain unheld.
    const arStill = this.deps.arRenderer as { stillnessOn?: boolean } | undefined;
    const shared = this.sharedStillness.update(
      frame,
      this.stillOn &&
        arStill?.stillnessOn !== false &&
        this.state.phase !== 'playback' &&
        this.state.phase !== 'baking',
    );
    const now = performance.now();
    this.lastFrame = frame;
    this.frameTimes.push(now);
    while (this.frameTimes.length && now - this.frameTimes[0] > 1000) this.frameTimes.shift();
    const quality = frame.landmarks2d ? trackingQuality(frame.confidence) : 0;
    const avatar = this.avatar;
    if (this.state.phase === 'playback' || this.state.phase === 'baking') {
      this.set({ trackingQuality: quality });
      return;
    }
    if (this.calibrating) {
      const source = this.source;
      const progress = source && isCalibratable(source) ? source.calibrationProgress : null;
      const issues = progress?.issues ?? [];
      // f1close: the stand needs the hips; a close-up that hides them goes on without it.
      if (this.closeRange && frame.landmarks2d) {
        if (hipsHidden(frame)) {
          this.hipsHiddenSince ??= now;
          if (now - this.hipsHiddenSince >= CLOSE.calibrationHiddenMs)
            this.calibrationAttempt?.abort();
        } else this.hipsHiddenSince = undefined;
      }
      this.set({
        phase: 'calibrating',
        trackingQuality: quality,
        progress: progress?.progress ?? 0,
        message: !frame.landmarks2d
          ? this.closeRange
            ? 'Step into view: head and shoulders in the frame'
            : 'Step into view: head to hips in the frame'
          : issues.length
            ? `Stand straight, arms relaxed (${issues.join(', ')})`
            : 'Hold still…',
      });
      this.renderAr(frame);
      return;
    }
    if (this.recording) {
      this.recording.push(frame);
      const progress = Math.min(1, (now - this.recordStart) / (this.recordEnd - this.recordStart));
      this.set({
        phase: 'recording',
        progress,
        trackingQuality: quality,
        message: `Recording… ${Math.max(0, Math.ceil((this.recordEnd - now) / 1000))} s`,
      });
      if (now >= this.recordEnd) this.recordResolve?.();
    }
    const range = this.outOfRange(frame);
    if (frame.pose && avatar) {
      const t0 = performance.now();
      // Kiosk framing is head to hips: the legs are not seen, so they stay at the neutral stand
      // unless driveLegs (a hallucinated sit would drop the whole avatar).
      const confidence = this.deps.driveLegs
        ? frame.confidence
        : Object.fromEntries(
            Object.entries(frame.confidence).filter(([k]) => !/^(hip|knee)_/.test(k)),
          );
      // Turned far from the camera, the single-view angles are unreliable: hold the last good
      // pose briefly, then ease to the stand (the mirror keeps working, nothing jumps).
      const gated = this.smoother.update(
        now,
        range.turned ? null : frame.pose,
        confidence,
        this.fallbackPose(avatar),
      );
      this.atNeutral = false;
      // Optional screen-space fit (agent V2's AR renderer): corrections to the smoothed pose so
      // the projected joints land on the 2D landmarks. Both views then show the corrected pose.
      const fit = (this.deps.arRenderer as Partial<PoseAdjuster> | undefined)?.adjustPose;
      // Hanging arms read from the 2D image: before the screen fit (a better start) and after it.
      const start = this.hanging.apply(frame, gated.pose);
      let shown = start;
      if (fit)
        try {
          const adjusted = fit.call(this.deps.arRenderer, frame, start, avatar);
          // Spike guard + sanity cap only (V2's fit has its own continuity and slew).
          if (adjusted)
            shown = this.hanging.apply(frame, this.fitFilter.apply(now, capFit(adjusted, start)));
        } catch (error) {
          console.error('[live] screen fit failed', error);
        }
      // Stillness lock last: at rest the shown pose (mirror and AR rig) is exactly constant.
      shown = this.stillness.apply(now, shown, shared);
      if (this.torsoHold) shown = this.torsoHold.apply(now, shown);
      // Body turns reach the jacket dynamics through the heading (the pose has no root yaw).
      const heading = this.heading(frame, now);
      avatar.rootYawDeg = this.headingOn ? heading : null;
      const result = avatar.applyPose(shown, now);
      this.perf.poseMs = performance.now() - t0;
      this.measureWrists(avatar.joints);
      this.perf.estimated = gated.estimated;
      this.perf.clamps = result.clamps.length;
      this.pendingDisplay = now;
      this.lastPoseAt = now;
      if (this.diagListeners.size)
        this.emitDiagnostics(frame, now, {
          smoothed: gated.pose,
          estimated: gated.estimated,
          adjusted: fit ? shown : null,
          final: result.pose,
          clamps: result.clamps.length,
          warnings: result.warnings,
        });
      if (!this.recording) {
        const stretch = avatar.previewStretch();
        const size = this.options?.size;
        const zones = size ? this.fit?.sizes[size]?.zones : undefined;
        const weak = quality < WEAK_TRACKING;
        const prompt =
          range.turned && !this.turnThrough
            ? 'Turn back toward the camera to see the jacket on you'
            : this.closeRange
              ? range.shouldersOut
                ? 'Step back a little so your shoulders are in view'
                : weak
                  ? 'Tracking is weak: more light on you'
                  : null
              : range.handsOut
                ? 'Step back a little so your hands stay in view'
                : weak
                  ? 'Tracking is weak: more light on you, or step back so both arms are in view'
                  : null;
        const previous = this.state.message;
        this.set({
          phase: 'tracking',
          message:
            prompt ??
            (this.state.phase === 'tracking' && !PROMPTS.some((p) => previous.startsWith(p))
              ? previous
              : 'Tracking you'),
          trackingQuality: quality,
          zones: [...staticReadouts(zones), ...previewReadouts(zones, stretch)],
        });
      }
    } else {
      if (this.diagListeners.size) this.emitDiagnostics(frame, now, null);
      // Nobody tracked: hold the last pose briefly, then ease back to the neutral stand, so a
      // person leaving and re-entering never leaves the avatar frozen mid-gesture.
      if (avatar && !this.recording) {
        const eased = this.smoother.update(now, null, {}, this.fallbackPose(avatar));
        if (!this.atNeutral) {
          // Nobody seen: the heading is unknown (the deformer holds the last one).
          const heading = this.heading(frame, now);
          avatar.rootYawDeg = this.headingOn ? heading : null;
          avatar.applyPose(eased.pose, now);
          this.atNeutral = eased.settled;
        }
      }
      if (now - this.lastPoseAt > LOST_AFTER_MS && this.state.phase !== 'recording') {
        // Tracking lost: the jacket's motion restarts from its target when the person returns.
        if (this.state.phase !== 'lost') {
          avatar?.resetDeformers();
          this.yawFilter.reset();
          this.stillness.reset();
          this.torsoHold?.reset();
          this.sharedStillness.reset();
        }
        this.set({
          phase: 'lost',
          trackingQuality: quality,
          zones: this.staticZones(),
          message: frame.landmarks2d
            ? 'Hold on, finding your arms…'
            : this.closeRange
              ? 'Step into view: head and shoulders in the frame'
              : 'Step back into view: head to hips in the frame',
        });
      }
    }
    this.pendingAr = now;
    this.renderAr(frame);
  }

  /** What a DOF falls back to when not measured: arms down, unless deps.armsDown is false. */
  private fallbackPose(avatar: LiveAvatar) {
    const display = avatar.live.rig.neutralPose;
    if (this.deps.armsDown === false) return display;
    if (this.neutralFor !== display) {
      this.neutralFor = display;
      this.neutralLive = liveNeutral(display);
    }
    return this.neutralLive!;
  }
  private neutralFor?: AnatomicalPose;
  private neutralLive?: AnatomicalPose;

  private measureWrists(joints: Record<string, [number, number, number]>) {
    const now = [joints.lWrist, joints.rWrist];
    if (!now[0] || !now[1]) return;
    const prev = this.lastWrists;
    this.lastWrists = [now[0], now[1], [0, 0, 0]];
    if (!prev) return;
    let sum = 0;
    for (let i = 0; i < 2; i++)
      sum += Math.hypot(now[i][0] - prev[i][0], now[i][1] - prev[i][1], now[i][2] - prev[i][2]);
    this.wristSteps.push((sum / 2) * 1000);
    if (this.wristSteps.length > JITTER_WINDOW) this.wristSteps.shift();
  }

  private shoulderSpan = 0;
  /** This frame's image shoulder span / the remembered frontal span (heading plausibility). */
  private spanRatio: number | null = null;
  /**
   * Out of range, from the 2D landmarks (works with or without the AR): turned away when the
   * image shoulder span falls below TURNED_SPAN_RATIO of the recent frontal span (cos 60 deg = 0.5;
   * the span decays slowly so a person stepping back is not "turned"); hands out when a wrist is
   * outside the frame or unseen.
   */
  private outOfRange(frame: LiveFrame) {
    const lm = frame.landmarks2d;
    if (!lm || lm.length < 17) return { turned: false, handsOut: false, shouldersOut: false };
    const span = Math.hypot(lm[11].x - lm[12].x, lm[11].y - lm[12].y);
    this.shoulderSpan = Math.max(span, this.shoulderSpan * SPAN_DECAY);
    this.spanRatio = this.shoulderSpan > 0 ? span / this.shoulderSpan : null;
    const turned = this.shoulderSpan > 0 && span < TURNED_SPAN_RATIO * this.shoulderSpan;
    const out = (i: number) =>
      lm[i].visibility < 0.3 ||
      lm[i].x < 0 ||
      lm[i].y < 0 ||
      lm[i].x > frame.width ||
      lm[i].y > frame.height;
    return { turned, handsOut: out(15) || out(16), shouldersOut: out(11) || out(12) };
  }

  private diagListeners = new Set<(entry: DiagnosticEntry) => void>();

  /** Per-frame diagnostics (the labs' "Record diagnostics"). Returns an unsubscribe function. */
  onDiagnostics(callback: (entry: DiagnosticEntry) => void) {
    this.diagListeners.add(callback);
    return () => {
      this.diagListeners.delete(callback);
    };
  }

  private emitDiagnostics(frame: LiveFrame, receivedAt: number, posed: DiagnosticEntry['posed']) {
    const s = this.stats();
    const ar = this.deps.arRenderer as (ArRenderer & { debugState?: () => unknown }) | undefined;
    let arState: unknown = null;
    try {
      arState = ar?.debugState?.() ?? null;
    } catch (error) {
      arState = { error: String(error) };
    }
    const entry: DiagnosticEntry = {
      t: frame.t,
      receivedAt,
      phase: this.state.phase,
      width: frame.width,
      height: frame.height,
      landmarks2d: frame.landmarks2d,
      rawPose: frame.pose,
      confidence: frame.confidence,
      posed,
      joints: this.avatar ? { ...this.avatar.joints } : null,
      arAlignment: ar?.alignment ?? null,
      ar: arState,
      timing: {
        trackerMs: s.trackerMs,
        inferenceMs: s.inferenceMs,
        poseMs: s.poseMs,
        displayMs: s.displayMs,
        totalMs: s.totalMs,
        sourceFps: s.sourceFps,
        renderFps: s.renderFps,
      },
    };
    for (const l of this.diagListeners) l(entry);
  }

  /** The mirror view's canvas (for recording), once attached. */
  get mirrorCanvas(): HTMLCanvasElement | null {
    return this.mirrorView ? this.canvasOf(this.mirrorView) : null;
  }

  private renderAr(frame: LiveFrame) {
    const ar = this.deps.arRenderer;
    if (!ar || !this.avatar) return;
    try {
      ar.render(frame, this.avatar);
      this.set({ arAlignment: ar.alignment });
    } catch (error) {
      console.error('[live] AR render failed', error);
    }
  }

  private loop() {
    if (this.raf) return;
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      if (this.pendingAr !== null) {
        this.perf.arDisplayMs = performance.now() - this.pendingAr;
        this.pendingAr = null;
      }
      if (this.playback) this.playFrame();
      // f1idle: a hidden mirror (Full AR) costs no main-thread time; it catches up when shown.
      const view = this.mirrorShown ? this.mirrorView : undefined;
      if (view instanceof MirrorView) view.render();
      else if (view && this.avatar && this.avatar.version !== this.mirrorVersion) {
        // The kiosk Viewer renders itself; copy the posed geometry only when it changed.
        view.update(this.avatar);
        this.mirrorVersion = this.avatar.version;
      }
      if (this.pendingDisplay !== null) {
        this.perf.displayMs = performance.now() - this.pendingDisplay;
        this.pendingDisplay = null;
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  async recordMove(seconds: number) {
    if (this.state.phase !== 'tracking' || !this.options) {
      this.set({ message: 'Get tracked first, then record a move' }, true);
      return;
    }
    const duration = Math.max(1, Math.min(10, seconds)) * 1000;
    this.recording = [];
    this.recordStart = performance.now();
    this.recordEnd = this.recordStart + duration;
    this.set({ phase: 'recording', progress: 0, message: 'Recording… do your move' }, true);
    await new Promise<void>((resolve) => {
      this.recordResolve = resolve;
      setTimeout(resolve, duration + 2000); // the source may stall; never hang
    });
    const frames = this.recording ?? [];
    this.recording = null;
    this.recordResolve = undefined;
    let traceMessage = '';
    try {
      // V3: low-confidence DOFs held at neutral for the whole move; throws if the person was lost.
      const { poses, trace } = recordedPoses(frames);
      const t0 = poses[0]?.t ?? 0;
      this.lastRecording = poses.map((p) => ({ t: p.t - t0, pose: p.pose }));
      traceMessage = trace.message;
    } catch (error) {
      this.set(
        {
          phase: 'tracking',
          progress: null,
          message:
            error instanceof RecordingError
              ? 'You stepped out of view; try again.'
              : `Recording failed: ${error instanceof Error ? error.message : String(error)}`,
        },
        true,
      );
      return;
    }
    const baker = this.deps.moveBaker;
    if (!baker) {
      this.set(
        {
          phase: 'tracking',
          progress: null,
          message: `${traceMessage} Physics bake not available yet.`,
        },
        true,
      );
      return;
    }
    this.set(
      { phase: 'baking', progress: 0, message: `${traceMessage} Simulating the jacket…` },
      true,
    );
    try {
      this.baked?.dispose();
      this.baked = await baker.bake(
        this.lastRecording,
        this.options,
        (fraction) => this.set({ progress: fraction }),
        this.abort.signal,
      );
      this.startPlayback('physics');
    } catch (error) {
      if (error instanceof Error && error.name === 'PhysicsInvalidError') {
        // V3's sanity gate: the simulation is physically impossible, so no number is shown.
        this.baked = undefined;
        this.set(
          {
            phase: 'tracking',
            progress: null,
            message: error.message,
            zones: this.staticZones(),
            exposureCm: null,
            sleeveRideUpCm: null,
          },
          true,
        );
        return;
      }
      this.fail(error);
    }
  }

  private startPlayback(kind: 'physics' | 'preview') {
    this.playback = { start: performance.now(), kind };
    // A physics replay shows V3's simulated cloth: no deformer runs on it. A preview replay keeps
    // the deformers (it is the preview) but restarts their motion.
    this.avatar?.setDeformBypass(kind === 'physics');
    this.set(
      {
        phase: 'playback',
        progress: null,
        message:
          kind === 'physics' ? 'Physics replay of your move' : 'Replay (preview, no physics)',
      },
      true,
    );
  }

  private playFrame() {
    const avatar = this.avatar,
      playback = this.playback;
    if (!avatar || !playback) return;
    const elapsed = (performance.now() - playback.start) / 1000;
    if (playback.kind === 'physics' && this.baked) {
      const b = this.baked;
      // Play only the recorded window (V3 adds a neutral lead-in and lead-out to every move).
      const range = (b as Partial<{ recorded: { start: number; end: number } }>).recorded;
      const start = range?.start ?? 0,
        span = Math.max(1, (range ? range.end : b.frameCount - 1) - start + 1);
      const i = start + (Math.floor(elapsed * b.fps) % span);
      b.applyFrame(i, avatar);
      this.set({ ...b.readouts(i) });
      return;
    }
    const rec = this.lastRecording;
    if (!rec.length) return;
    const duration = rec[rec.length - 1].t / 1000 || 1;
    const t = (elapsed % duration) * 1000;
    let i = 0;
    while (i + 1 < rec.length && rec[i + 1].t <= t) i++;
    avatar.rootYawDeg = null;
    avatar.applyPose(rec[i].pose, performance.now());
  }

  replayLast() {
    if (this.baked) this.startPlayback('physics');
    else if (this.lastRecording.length) this.startPlayback('preview');
  }

  backToLive() {
    this.playback = undefined;
    this.avatar?.setDeformBypass(false);
    this.set(
      {
        phase: 'tracking',
        progress: null,
        exposureCm: null,
        sleeveRideUpCm: null,
        message: 'Back to live',
      },
      true,
    );
  }

  private stopSource() {
    this.offFrame?.();
    this.offFrame = undefined;
    this.source?.stop();
    this.source = undefined;
  }

  stop() {
    this.abort.abort();
    this.stopSource();
    this.calibrating = false;
    this.recording = null;
    this.playback = undefined;
    this.avatar?.setDeformBypass(false);
    this.yawFilter.reset();
    this.stillness.reset();
    this.sharedStillness.reset();
    this.set({ ...idle() }, true);
  }

  dispose() {
    this.stop();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.baked?.dispose();
    this.deps.arRenderer?.dispose();
    this.arPlaceholder?.remove();
    this.arHost?.remove();
    this.unbindMirror();
    this.avatar?.dispose();
    this.mirrorObserver?.disconnect();
    this.mirrorView?.dispose();
    this.listeners.clear();
    void this.mirrorContainer;
  }
}

/** Factory for the kiosk screen (CX-TRY) and the labs. */
export function createLiveTryOn(deps: LiveTryOnDeps = {}) {
  return new LiveTryOnEngine(deps);
}

/** loadFit for the labs/kiosk: the body service's garment fit (same request as the kiosk). */
export function garmentFitLoader(request: { layer_cm: number; preference: string }) {
  return async (options: LiveTryOnOptions, signal: AbortSignal): Promise<StaticFit> =>
    (await api.garmentFit(
      {
        body_id: options.bodyId,
        product_id: options.productId,
        layer_cm: request.layer_cm,
        preference: request.preference as 'regular',
      },
      signal,
    )) as unknown as StaticFit;
}
