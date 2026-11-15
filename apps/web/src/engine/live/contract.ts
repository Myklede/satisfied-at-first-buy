// Live try-on contract (prompt 14). The lead owns this file: change it only through the lead.
//
// "Try it on you" = a split screen.
//   Left: AR. The camera image of the real person, with the jacket rendered over their body.
//   Right: a mirror. The person's own fitted Anny body wearing the jacket, moving with them.
// Physics: the live view is a skinned PREVIEW, labelled "preview". "Record a move" captures a
// few seconds of pose, bakes true cloth physics on this body (the existing motion bake), then
// plays it back in both views, labelled "physics".
//
// Types only; no runtime code. Implementations:
//   engine/live/**     (Claude V1: sources, rig, mirror; V3: record + bake)
//   engine/live/ar/**  (Claude V2: camera model, alignment, compositor, occlusion)
//   kiosk/tryon/**     (Codex: screen and UX, against a mock until the engine lands)
// Units: scene in metres, Y up, +Z body front (AGENTS.md §5); pose angles in degrees
// (prompts/motion-contract.md); image coordinates in source pixels, origin top-left.
import type { Object3D } from 'three';
import type { AnatomicalPose } from '../motion/rig';

export type LiveSourceKind = 'camera' | 'video-file' | 'recording';

/** One MediaPipe pose landmark in source-image pixels (33 per frame, BlazePose order). */
export type ImageLandmark = { x: number; y: number; visibility: number };
/** One MediaPipe world landmark in metres (hip-centred, as MediaPipe reports it). */
export type WorldLandmark = { x: number; y: number; z: number; visibility: number };

/** One tracked frame from the camera, a video file, or a pose recording replay. */
export interface LiveFrame {
  /** Source time in ms, monotonic within a session. */
  t: number;
  /** Source frame size in pixels. */
  width: number;
  height: number;
  /** null when no person is tracked in this frame. */
  landmarks2d: ImageLandmark[] | null;
  world: WorldLandmark[] | null;
  /** Filtered anatomical pose, or null before neutral calibration or when tracking is lost. */
  pose: AnatomicalPose | null;
  /** Per-DOF confidence 0..1. A low confidence means "not estimated"; never invent a value. */
  confidence: Partial<Record<string, number>>;
  /** Person segmentation for AR occlusion: 0..1 per pixel, at maskWidth×maskHeight. Optional. */
  mask: { data: Float32Array; width: number; height: number } | null;
}

export interface LiveSource {
  readonly kind: LiveSourceKind;
  /** Drawable frame source for the AR view (camera or file); null for numbers-only recordings. */
  readonly video: HTMLVideoElement | null;
  start(): Promise<void>;
  stop(): void;
  /** Returns an unsubscribe function. */
  onFrame(callback: (frame: LiveFrame) => void): () => void;
}

export type LiveZone = 'shoulder' | 'chest' | 'bicep' | 'sleeve' | 'hem' | 'collar';
export type LiveStatus = 'tight' | 'fit' | 'relaxed' | 'too_big' | 'unknown';
/** Where a number comes from. Every number on screen carries its basis. */
export type LiveBasis = 'static-fit' | 'preview' | 'physics';

export type ZoneReadout = {
  zone: LiveZone;
  /** Signed ease or offset in cm, as the engine reports it; null = unknown. */
  valueCm: number | null;
  status: LiveStatus;
  basis: LiveBasis;
};

export type LivePhase =
  | 'idle'
  | 'starting'
  | 'calibrating' // the neutral stand: "stand straight, arms relaxed" (NeutralCalibrator)
  | 'tracking'
  | 'lost' // no person or low confidence
  | 'recording'
  | 'baking'
  | 'playback'
  | 'error';

export interface LiveTryOnState {
  phase: LivePhase;
  /** One short human-readable status line, in the kiosk's tone (English). */
  message: string;
  /** 0..1 overall tracking quality, for a small indicator. */
  trackingQuality: number;
  /** 0..1 how well the AR overlay is aligned to the person; null when AR is not running. */
  arAlignment: number | null;
  zones: ZoneReadout[];
  /** 0..1 while recording or baking; otherwise null. */
  progress: number | null;
  /** Physics playback only: belly/back skin exposed by the hem, in cm (motion-contract "exposure"). */
  exposureCm: { front: number; back: number; sides: number } | null;
  /** Physics playback only: how far the sleeve cuff rides up from the wrist, in cm. */
  sleeveRideUpCm: { left: number; right: number } | null;
}

export type LiveTryOnOptions = {
  /** The kiosk's fitted body (FitResponse.body_id) and the garment fit for this product. */
  bodyId: string;
  fitId: string;
  productId: string;
  size: string;
};

export interface LiveTryOn {
  start(source: LiveSource, options: LiveTryOnOptions): Promise<void>;
  stop(): void;
  setSize(size: string): Promise<void>;
  setProduct(productId: string, fitId: string): Promise<void>;
  /** The mirror view (avatar + jacket). The engine owns the canvas inside the container. */
  attachMirrorView(container: HTMLElement): void;
  /** The AR view (source video + jacket overlay). The engine owns the canvas inside the container. */
  attachArView(container: HTMLElement): void;
  /**
   * Mirror the displayed image of both views, like a real mirror (default true). Presentation
   * only: the posed scene is always the person's true, unmirrored pose (lead decision, 13:55).
   */
  setMirrorDisplay?(on: boolean): void;
  /** Records `seconds` of pose, bakes true cloth physics on this body, then plays it back. */
  recordMove(seconds: number): Promise<void>;
  replayLast(): void;
  backToLive(): void;
  onState(callback: (state: LiveTryOnState) => void): () => void;
  dispose(): void;
}

// ---- Seams between the three engine agents (V1 composes; V2 and V3 plug in) ----

/**
 * The posed avatar + jacket at one instant, in scene metres. Shared by the mirror and AR views.
 * Always the person's true pose, never mirrored; mirroring happens only at display.
 */
export interface LivePosedScene {
  /** The root holding body and jacket, in the engine's scene frame. */
  root: Object3D;
  /** The posed jacket meshes. AR draws these over the video. */
  jacket: Object3D;
  /** The posed body. AR never draws it in colour; it may use it as a depth-only occluder. */
  body: Object3D;
  /** Posed joint positions in scene metres, keyed by the JointName of packages/vision poseSynth. */
  joints: Record<string, [number, number, number]>;
}

/** Implemented by V2 in engine/live/ar. V1's engine calls it every frame. */
export interface ArRenderer {
  attach(container: HTMLElement, video: HTMLVideoElement | null): void;
  render(frame: LiveFrame, scene: LivePosedScene): void;
  /** 0..1, how well the overlay matches the person (e.g. landmark reprojection); null = unknown. */
  readonly alignment: number | null;
  /**
   * Mirror the displayed AR image (video and jacket), keeping status badges readable. When it is
   * implemented, the engine calls this INSTEAD of flipping the AR container (no double flip).
   */
  setMirrorDisplay?(on: boolean): void;
  dispose(): void;
}

// ---- Live jacket deformers (lead, 2026-11-13 17:40) ----
// The live preview is LBS-skinned. Deformers run after skinning, in this order, on the shared
// posed jacket (so the mirror and the AR view both get them):
//   1. 'pose-correctives' (agent V7): the pose-dependent shape (hem lift with raised arms, folds at
//      elbows and armpits), learnt offline from TRUE cloth solves on this body + size.
//   2. 'dynamics' (agent V6): bounded real-time secondary motion (hem/hood/cuff sway, settling),
//      each particle constrained to a max distance from its target, colliding with the body.
// Basis stays 'preview'. Fit numbers (zones) keep coming from the skinned jacket before any
// deformer, so a deformer can never change a reported fit number.
// A baked physics move (BakedMove.applyFrame) bypasses every deformer.

/** What a deformer gets when the jacket changes (product, size or body). Read-only arrays. */
export interface LiveGarmentBinding {
  /** Particle count N; positions are N·3 in scene metres. */
  count: number;
  /** Particle positions at the neutral pose (the bind pose of the skinning). */
  bound: Float32Array;
  /** Jacket triangle indices (into particles). */
  triangles: ArrayLike<number>;
  /** LBS binding per particle: GARMENT_INFLUENCES driver indices + weights (garmentSkin.ts). */
  skinDrivers: Uint8Array;
  skinWeights: Float32Array;
  /** The server's cloth asset (panels, landmarks, paths); its type lives in api.ts (ClothAsset). */
  asset: unknown;
  /** Stable key of the binding (body id, product, size, asset version) for caches. */
  key: string;
}

/** Per-frame context. `drivers` are the 18·12 LBS driver matrices used for this frame. */
export interface LiveDeformContext {
  /** performance.now() of the source frame, ms (monotonic within a session). */
  timeMs: number;
  pose: AnatomicalPose | null;
  drivers: ArrayLike<number>;
  /** Posed body vertex positions (scene metres) for collisions; read-only. */
  bodyPositions: Float32Array;
  joints: Record<string, [number, number, number]>;
  /**
   * Whole-body heading about the vertical axis in degrees (0 = facing the camera, + = turning to
   * the person's left), e.g. from the world landmarks' hip/shoulder line, with V2's back-view
   * detector resolving the front/back ambiguity. null = unknown or ambiguous. The live pose has no
   * root yaw (only trunk twist), so a deformer reads body turns from here. Optional (lead, 18:00).
   */
  rootYawDeg?: number | null;
}

export interface LiveJacketDeformer {
  readonly name: 'pose-correctives' | 'dynamics';
  /** Called whenever the jacket changes; null = no jacket. May start async work (e.g. a bake). */
  bind(binding: LiveGarmentBinding | null): void;
  /** Deforms `positions` (N·3, already skinned and earlier stages applied) in place. ≤ 2 ms. */
  apply(positions: Float32Array, ctx: LiveDeformContext): void;
  /** Forget all temporal state (after tracking loss, a baked playback or a pose jump). */
  reset(): void;
  /** For the HUD/diagnostics: whether it is active, and why not if it isn't. */
  status(): { active: boolean; note: string; lastApplyMs: number };
  dispose(): void;
}

/** One baked move, for playback in both views. */
export interface BakedMove {
  fps: number;
  frameCount: number;
  /** Applies frame i (body drivers + simulated cloth positions) to the posed scene. */
  applyFrame(index: number, scene: LivePosedScene): void;
  /** Physics readouts at frame i, with basis 'physics'. */
  readouts(index: number): Pick<LiveTryOnState, 'zones' | 'exposureCm' | 'sleeveRideUpCm'>;
  dispose(): void;
}

/** Implemented by V3 in engine/live/record. It bakes true cloth physics for a recorded pose sequence. */
export interface MoveBaker {
  bake(
    poses: { t: number; pose: AnatomicalPose }[],
    options: LiveTryOnOptions,
    onProgress: (fraction: number) => void,
    signal: AbortSignal,
  ): Promise<BakedMove>;
}
