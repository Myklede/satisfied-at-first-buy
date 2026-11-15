// The AR finishing pass (agent V4, prompt 14): makes the glued jacket look worn, not pasted.
// Plugged into V2's ArCompositor through its ArFinisher seam (compositor.finisher = new
// ArFinish()): called after the warp with the warped jacket (premultiplied linear), the video,
// the person mask, the landmarks and the real-hand capsules; it composites onto the canvas, which
// already holds the video, and returns true.
//
// Two full-screen passes per frame:
//   A. half-size, mipmapped: the graded jacket (premultiplied). Its mip chain is the push-pull
//      pyramid for the coverage fill and a blurred jacket cover for shadows and the near test.
//   B. canvas-size composite (shaders.ts compositeFragment): softness + feather, coverage over
//      real clothing (selfie multiclass mask when fresh, else the person mask), closed dark cuffs,
//      real hands, contact shadow, grain.
// Colour: the jacket's exposure and white balance follow the face skin (the room light on the
// person), its blacks the camera's black level, its grain the camera's noise (colour.ts).
//
// Main-thread budget (≤ 4 ms/frame, lead): nothing here waits for the GPU or a model. The
// multiclass segmenter runs in a worker (segmenterClient.ts); the colour statistics are read back
// asynchronously (probe.ts). Per frame: two draws, a person-mask pack and texture uploads.
//
// Privacy: frames are read in memory only (tiny GPU crops; the worker's bitmap); nothing is
// stored or sent. Plain Three.js, no React.
import {
  CustomBlending,
  DataTexture,
  NoBlending,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PerspectiveCamera,
  PlaneGeometry,
  RedFormat,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import type { ArFinisher } from '../ArCompositor';
import type { ImageLandmark, LiveFrame } from '../../contract';
import { VISION_ASSET_BASE } from '../../sources/trackedSource';
import {
  BLUR_SOURCE_PX,
  CLASS,
  CLASS_EDGE,
  CONTACT_F4,
  CLASS_MAX_AGE_MS,
  CLASS_REQUEST_HZ,
  STILL,
  CUFF,
  EDGE_JBU,
  EXPOSURE_AT_REF,
  HANDS_BRIDGE_MS,
  GRAIN_F4,
  MASK_STABLE,
  MASK_CAPTURE_EVERY,
  SHARPNESS,
  FEATHER_SOURCE_PX,
  FILL_SHADE,
  GRAIN_MAX_8BIT,
  HAND_SOFT,
  LIFT_TAU_S,
  LIGHT_TAU_S,
  MASK_MAX_WIDTH,
  MATCH_EVERY_FRAMES,
  MATCH_EVERY_FRAMES_F4,
  NOISE_EVERY_FRAMES_F4,
  MATCH_TAU_S,
  MATCH_WIDTH,
  NEAR_OF_SPAN,
  NOISE_EVERY_FRAMES,
  NOISE_PATCH,
  PERSON_EDGE,
  SHADOW,
  VENUE_EXPOSURE,
} from './config';
import { cameraAdaptation, keyDirCamera, readF4Flags, venueExposure, type F4Flags } from './f4';
import {
  exposureFromFace,
  faceSkinColour,
  liftFromP1,
  luminance,
  lumaPercentile,
  noiseSigma,
  smoothToward,
  whiteBalanceGains,
  plausibleSkin,
  srgbToLinear,
  type Rgb,
} from './colour';
import { faceNormal, fitFaceLight, smoothLight, type LightEstimate, type Vec3 } from './light';
import { faceBox, finishGeometry, frontal, upperBodyRect, type FinishGeometry } from './geometry';
import { coverageFromMetric, packPerson, type ByteMask } from './masks';
import { VideoProbe, type PixelRect } from './probe';
import { hysteresis } from './masks';
import { cameraEdgeWidth, matchedSigma, temporalSigma } from './sharpness';
import {
  pickCaptured,
  WorkerSegmenter,
  type ClassMaskResult,
  type MaskRect,
} from './segmenterClient';
import {
  applyAffine,
  IDENTITY,
  maskMotion,
  snapshot,
  translation,
  type Affine,
  type LandmarkSnapshot,
  type MaskMotion,
} from './motion';
import { compositeFragment, fillFragment, quadVertex } from './shaders';
import {
  blendFactor,
  blendInto,
  deadband,
  holdRect,
  motionOfSpan,
  RestHold,
  stillness,
} from './stability';

type FinishInput = Parameters<ArFinisher['apply']>[1];

/** Per-effect switches (lab toggles and before/after evaluation). */
export type FinishOptions = {
  cover: boolean;
  cuffs: boolean;
  hands: boolean;
  shadow: boolean;
  /** Face-based exposure / white balance and black lift; off = the compositor's exposure. */
  grade: boolean;
  grain: boolean;
  /** Softness blur and edge feather. */
  soften: boolean;
  /** The selfie multiclass segmenter (in a worker); off = person mask only. */
  classes: boolean;
  /** Rest stability (stability.ts): masks blended and the grade held while the person is still. */
  stabilize: boolean;
};

export type FinishStats = {
  frames: number;
  /** Main-thread time of apply() (ms, mean over ≈ 10 frames). */
  applyMs: number;
  /** With bench = true: apply() between two gl.finish() calls, i.e. CPU + GPU (ms, mean). */
  benchMs: number | null;
  /** Segmenter inference inside the worker (ms, mean) and its delegate / error. */
  classMs: number | null;
  /** Sent → mask back, ms (mean): how old a class mask is when it arrives. */
  classLatencyMs: number | null;
  classDelegate: 'GPU' | 'CPU' | null;
  classError: string | null;
  /** Class masks received. */
  classMasks: number;
  /** Whether the last frame used the class mask (else the person mask). */
  usedClasses: boolean;
  /** F4: mean class-mask latency breakdown (ms; segmenterClient.ts ClassMaskResult.timing). */
  classTiming: ClassMaskResult['timing'] | null;
  /** F4: arrival → the first apply() that uploads it (ms, mean). */
  classUseDelayMs: number | null;
  /** F4: the used class mask's age at apply(), now − sent (ms, mean over frames using one). */
  classAgeMs: number | null;
  /**
   * F4 capture path ('posecapture'): the drawn frame's t minus the used mask's frame t (ms, mean;
   * 0 = the mask is of the very frame drawn), and whether that path is active.
   */
  classFrameLagMs: number | null;
  classCapture: boolean;
  /** F4 sharp: the camera's measured edge transition (source px) and the jacket blur σ used. */
  cameraEdgePx: number | null;
  jacketSigmaPx: number | null;
};

const mean = (prev: number, x: number, k = 0.1) =>
  Number.isFinite(prev) ? prev * (1 - k) + x * k : x;

export class ArFinish implements ArFinisher {
  enabled = true;
  options: FinishOptions = {
    cover: true,
    cuffs: true,
    hands: true,
    shadow: true,
    grade: true,
    grain: true,
    soften: true,
    classes: true,
    stabilize: true,
  };
  /**
   * Segmenter delegate in the worker. GPU (third eval, same bitmaps, three frames per clip):
   * 20–33 ms per mask vs CPU 260–306 ms, pixel agreement 99.72–99.97 %, class histograms within
   * 0.2 %; first call 0.4–3.1 s (warm-up, off the main thread). The lead's wrapper falls back to
   * CPU if the GPU context or its first readback fails.
   */
  segmenterDelegate: 'GPU' | 'CPU' = 'GPU';
  /** F4 flags (f4.ts; URL ?f4edge=1 / ?f4light=1 / ?f4mask=1), read once; settable for A/B. */
  f4: F4Flags = readF4Flags();
  /**
   * F4 skin mask for other passes (F3X re-composites the real hands over the sleeves): set
   * `requestSkinMask = true` and, after each apply(), `skinMask.texture` holds this frame's real
   * skin, canvas-aligned (sample at the canvas uv, GL rows bottom-up like any render target; its
   * size = the warped jacket's = the drawing buffer). R = skin (class skin × person mask; JBU-
   * refined against the full-res frame under ?f4edge=1; class mask motion-compensated, the hands
   * with their forearm), G = the finisher's real-hand capsules (soft edge). `valid` = drawn this
   * frame (false without a person mask or class mask; then R = the person mask inside the hands).
   */
  requestSkinMask = false;
  readonly skinMask = {
    texture: null as import('three').Texture | null,
    width: 0,
    height: 0,
    valid: false,
    frame: 0,
  };
  private skinTarget?: WebGLRenderTarget;
  /**
   * F4 hands (?f4hands=1): the last seen hand capsule per side and when (performance.now()). The
   * still lock holds the finisher's geometry, hands included, from the frame it engaged; a hand
   * unseen on that frame (crossed arms: low hand-landmark visibility) stayed hidden for the whole
   * hold (F3X 15:18). The hands are always the live ones, bridged over short gaps.
   */
  private lastHands: ({
    shape: NonNullable<FinishGeometry['hands'][number]>;
    at: number;
  } | null)[] = [null, null];
  /** The product's colour (#rrggbb, ArCompositor sets it), for f4light's camera adaptation. */
  garmentColour: string | null = null;
  /** Fixed grade values (calibration in the harness); undefined fields = measured. */
  override: { exposure?: number; gain?: Rgb; lift?: number; grainSigma?: number } = {};
  /** Evaluation only: wrap apply() in gl.finish() to time CPU + GPU (stalls the pipeline). */
  bench = false;
  /**
   * How a class mask is moved to the current frame: per region (torso affine + arm segments,
   * default), the mid-shoulder translation only, or not at all (evaluation comparisons).
   */
  motionCompensation: 'regions' | 'translate' | 'none' = 'regions';
  /** Evaluation only: send no new frames to the segmenter and ignore the mask's age. */
  freezeClasses = false;
  private classMotion: MaskMotion = { torso: IDENTITY, arms: [null, null, null, null] };
  private lastRequestAt = -Infinity;
  /** Rest stability state (stability.ts). */
  private prevSnap: LandmarkSnapshot | null = null;
  private sharedStill: { readonly still: boolean } | null = null;
  private readonly restGeometry = new RestHold<FinishGeometry>();
  private restSize = '';
  private held = false;

  /** Called before apply, from the same shared decision consumed by pose and AR. */
  setStillState(state: { readonly still: boolean } | null) {
    this.sharedStill = state;
  }
  /** 1 = the person is still this frame, 0 = moving (readout). */
  still = 0;
  private personAcc?: Float32Array;
  /** ?f4stable: the previous uploaded person mask (hysteresis state). */
  private personPrev?: Uint8Array;
  private personOut?: Uint8Array;
  private classAcc?: Float32Array;
  private classOut?: ByteMask;
  private classAccRect: MaskRect | null = null;
  private heldRect: MaskRect | null = null;
  private target = { exposure: NaN, gain: [NaN, NaN, NaN] as Rgb, lift: NaN };
  stats: FinishStats = {
    frames: 0,
    applyMs: NaN,
    benchMs: null,
    classMs: null,
    classLatencyMs: null,
    classDelegate: null,
    classError: null,
    classMasks: 0,
    usedClasses: false,
    classTiming: null,
    classUseDelayMs: null,
    classAgeMs: null,
    classFrameLagMs: null,
    classCapture: false,
    cameraEdgePx: null,
    jacketSigmaPx: null,
  };
  /** The colour match as applied (readout). */
  match = {
    exposure: NaN,
    gain: [1, 1, 1] as Rgb,
    lift: 0,
    grainSigma8bit: 0,
    face: null as Rgb | null,
    faceY: null as number | null,
    frontal: false,
    p1: null as number | null,
  };
  /**
   * Scene light estimated from the face's shading (light.ts): direction toward the key light in
   * camera coordinates (x image right, y up, z toward the camera), key strength and ambient
   * relative to the skin, confidence. Null until a frontal face was seen. Read-only output: the
   * renderer's lights are not changed here.
   */
  light: LightEstimate | null = null;
  /** The geometry of the last frame (lab overlay, tests). */
  geometry: FinishGeometry | null = null;

  private readonly camera = new PerspectiveCamera();
  private readonly fillTarget = new WebGLRenderTarget(1, 1, {
    type: UnsignedByteType,
    generateMipmaps: true,
    minFilter: LinearMipmapLinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
  });
  private readonly fillMaterial: ShaderMaterial;
  private readonly compositeMaterial: ShaderMaterial;
  private readonly fillScene = new Scene();
  private readonly compositeScene = new Scene();
  private readonly quadGeometry = new PlaneGeometry(2, 2);
  private readonly probe = new VideoProbe();
  private personTexture?: DataTexture;
  private personBytes?: ByteMask;
  private classTexture?: DataTexture;
  private classResult: ClassMaskResult | null = null;
  /** The landmarks the used class mask is anchored to (its own frame's, on the capture path). */
  private classAnchor: LandmarkSnapshot | null = null;
  /**
   * F4 capture path (?f4mask=1 + the pose worker): the source <video> fires 'posecapture'
   * {frameTime, t} as the camera frame is captured for the pose (F2, c17475c); the class request is
   * cut from that same frame at once, in parallel with the pose inference, and paired with that
   * frame's landmarks when the frame is drawn (anchorsByT, keyed by LiveFrame.t).
   */
  private captureVideo?: HTMLVideoElement;
  private captureAt = -Infinity;
  private lastRect: MaskRect | null = null;
  private lastFrameSize = { width: 0, height: 0 };
  private readonly anchorsByT = new Map<number, LandmarkSnapshot | null>();
  private readonly onCapture = (event: Event) => {
    const seg = this.segmenter,
      video = this.captureVideo,
      rect = this.lastRect;
    const t = (event as CustomEvent<{ t?: number }>).detail?.t;
    if (!this.f4.mask || !seg || !video || !rect || typeof t !== 'number' || this.freezeClasses)
      return;
    this.captureAt = performance.now();
    // Every other captured frame (≈ 12–15 masks/s at 24–30 fps): the mask is paired with its own
    // frame's landmarks, so a mask one frame older is still motion-compensated exactly; half the
    // segmentations on the GPU (F2's bisect 19:23).
    if (this.captures++ % MASK_CAPTURE_EVERY !== 0) return;
    if (video.readyState >= 2 && seg.request(video, rect, this.lastFrameSize, null, t))
      this.lastRequestAt = performance.now();
  };
  private segmenter?: WorkerSegmenter;
  private faceT?: number;
  private liftT?: number;
  private noiseIndex = 0;
  private noiseRecent: number[] = [];
  private lastInput?: FinishInput;

  constructor(options: Partial<FinishOptions> = {}) {
    Object.assign(this.options, options);
    const common = {
      vertexShader: quadVertex,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    };
    this.fillMaterial = new ShaderMaterial({
      ...common,
      uniforms: {
        tWarped: { value: null },
        uExposure: { value: 0.92 },
        uGain: { value: new Vector3(1, 1, 1) },
        uLift: { value: 0 },
      },
      fragmentShader: fillFragment,
      // F4X's camera tone curve under ?f4light=1 (shaders.ts grade); default shader unchanged.
      defines: this.f4.light ? { F4_CAMERA: 1 } : {},
    });
    this.compositeMaterial = new ShaderMaterial({
      ...common,
      uniforms: {
        tWarped: { value: null },
        tFill: { value: this.fillTarget.texture },
        tVideo: { value: null },
        tPerson: { value: null },
        tClass: { value: null },
        uHasPerson: { value: 0 },
        uHasClass: { value: 0 },
        uClassRect: { value: new Vector4(0, 0, 1, 1) },
        uClassTorso: { value: [new Vector3(1, 0, 0), new Vector3(0, 1, 0)] },
        uClassArm: {
          value: Array.from(
            { length: 8 },
            (_, i) => new Vector3(...(i % 2 ? [0, 1, 0] : [1, 0, 0])),
          ),
        },
        uClassArmOn: { value: [0, 0, 0, 0] },
        uSrc: { value: new Vector2(1, 1) },
        uTexel: { value: new Vector2(1, 1) },
        uScale: { value: 1 },
        uSpan: { value: 0 },
        uTorso: { value: [new Vector2(), new Vector2(), new Vector2(), new Vector2()] },
        uTorsoOn: { value: 0 },
        uBand: { value: [new Vector2(), new Vector2(), new Vector2(), new Vector2()] },
        uBandOn: { value: 0 },
        uSegA: { value: [0, 1, 2, 3].map(() => new Vector2()) },
        uSegB: { value: [0, 1, 2, 3].map(() => new Vector2()) },
        uSegR: { value: [0, 0, 0, 0] },
        uSegFlat: { value: [0, 0, 0, 0] },
        uSegFlatStart: { value: [0, 0, 0, 0] },
        uHead: { value: new Vector4() },
        uHeadUp: { value: 1 },
        uHeadOn: { value: 0 },
        uNeck: { value: new Vector4() },
        uNeckHalf: { value: 0 },
        uHandA: { value: [new Vector2(), new Vector2()] },
        uHandB: { value: [new Vector2(), new Vector2()] },
        uHandR: { value: [0, 0] },
        uCuffW: { value: [new Vector2(), new Vector2()] },
        uCuffD: { value: [new Vector2(1, 0), new Vector2(1, 0)] },
        uCuffR: { value: [0, 0] },
        uCuffDepth: { value: [CUFF.minDepth, CUFF.minDepth] },
        uLining: { value: CUFF.liningShade },
        uMarchFrom: { value: CUFF.marchFrom },
        uMarchTo: { value: CUFF.marchTo },
        uMinFacing: { value: CUFF.minFacing },
        uMaxEnd: { value: CUFF.maxEndFromWrist },
        uHandSoft: { value: HAND_SOFT },
        uGrain: { value: 0 },
        uSeed: { value: 0 },
        uBlur: { value: 0 },
        uFeather: { value: 0 },
        uNear: { value: 0 },
        uPersonEdge: { value: new Vector2(...PERSON_EDGE) },
        uClassEdge: { value: new Vector2(...CLASS_EDGE) },
        uContactR: { value: 1 },
        uContactS: { value: SHADOW.contactStrength },
        uEnclosureR: { value: 1 },
        uEnclosureS: { value: SHADOW.enclosureStrength },
        uInnerR: { value: 1 },
        uInnerS: { value: SHADOW.innerStrength },
        uShadeR: { value: 1 },
        uShadeK: { value: FILL_SHADE.strength },
        uShadeRange: { value: new Vector2(...FILL_SHADE.range) },
        uShadeEdge: { value: FILL_SHADE.edge },
        uCover: { value: 1 },
        uCuffs: { value: 1 },
        uHands: { value: 1 },
        uShadow: { value: 1 },
        uMode: { value: 0 },
        uEdge: { value: 0 },
        uPersonTexel: { value: new Vector2(4, 4) },
        uJbuRange: { value: EDGE_JBU.rangeSigma },
        uJbuSpatial: { value: EDGE_JBU.spatialSigma },
        uJbuBand: { value: new Vector2(...EDGE_JBU.band) },
        uMirrorFill: { value: 0 },
        uClassTexel: { value: new Vector2(2, 2) },
        uSharpen: { value: EDGE_JBU.sharpen },
        uHandsLive: { value: 0 },
        uShadowDir: { value: new Vector2(0, -1) },
        uShadowReach: { value: 1 },
        uShadowS: { value: CONTACT_F4.strength },
        uExposure: { value: 0.92 },
        uGain: { value: new Vector3(1, 1, 1) },
        uLift: { value: 0 },
      },
      fragmentShader: compositeFragment,
      // F4 code paths are compiled only when their flag is on (the default shader is unchanged).
      defines: {
        ...(this.f4.edge ? { F4_EDGE: 1 } : {}),
        ...(this.f4.fill ? { F4_FILL: 1 } : {}),
        ...(this.f4.light ? { F4_CAMERA: 1 } : {}),
        ...(this.f4.shadow ? { F4_SHADOW: 1 } : {}),
      },
      transparent: true,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
    });
    for (const [scene, material] of [
      [this.fillScene, this.fillMaterial],
      [this.compositeScene, this.compositeMaterial],
    ] as const) {
      const mesh = new Mesh(this.quadGeometry, material);
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
  }

  /** performance.now() of the newest class mask's frame (harness: wait for a fresh one). */
  get classSentAt() {
    return this.classResult?.sentAt ?? -Infinity;
  }

  apply(renderer: WebGLRenderer, input: FinishInput): boolean {
    if (!this.enabled) return false;
    const gl = this.bench ? renderer.getContext() : null;
    if (gl) gl.finish();
    const t0 = performance.now();
    const { warped, frame } = input;
    const W = frame.width,
      H = frame.height;
    if (!W || !H || !warped.width || !warped.height) return false;
    this.lastInput = input;
    this.stats.frames++;

    const fw = Math.max(1, Math.ceil(warped.width / 2)),
      fh = Math.max(1, Math.ceil(warped.height / 2));
    if (this.fillTarget.width !== fw || this.fillTarget.height !== fh)
      this.fillTarget.setSize(fw, fh);

    const size = `${W}x${H}`;
    const resized = size !== this.restSize;
    if (resized) this.restGeometry.reset();
    this.restSize = size;
    this.held = this.options.stabilize && this.sharedStill?.still === true && !resized;
    const live = finishGeometry(
      input.landmarks,
      input.hands.map((h) => ({ a: h.a, b: h.b, radius: h.radius })),
    );
    let geometry = this.restGeometry.update(live, this.held);
    if (this.f4.hands && geometry) geometry = { ...geometry, hands: this.liveHands(live) };
    this.geometry = geometry;
    const snap = snapshot(input.landmarks);
    this.still = !this.options.stabilize
      ? 0
      : this.sharedStill
        ? Number(this.held)
        : stillness(motionOfSpan(this.prevSnap, snap, geometry?.span ?? 0));
    this.prevSnap = snap;
    const video = input.video.image as HTMLVideoElement | HTMLCanvasElement | undefined;
    this.uploadPerson(input.personMask);
    this.updateClasses(video, input, geometry);
    this.updateMatch(renderer, input, geometry);
    if (this.f4.sharp) this.updateSharpness(renderer, input, geometry);
    if (this.f4.grain) this.updateGrain(renderer, input, geometry);
    this.setUniforms(input, geometry, warped.width / W);

    // Pass A: the graded jacket at half size, mipmapped (three regenerates the mips after render).
    renderer.setRenderTarget(this.fillTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(this.fillScene, this.camera);
    // Pass B: the composite over the video on the canvas.
    renderer.setRenderTarget(null);
    renderer.setClearColor(0x000000, 1);
    renderer.render(this.compositeScene, this.camera);
    if (this.requestSkinMask) this.renderSkinMask(renderer, warped.width, warped.height, input);

    if (gl) {
      gl.finish();
      this.stats.benchMs = mean(this.stats.benchMs ?? NaN, performance.now() - t0);
    }
    this.stats.applyMs = mean(this.stats.applyMs, performance.now() - t0);
    return true;
  }

  /** F4 sharp: the camera's edge transition (source px), smoothed; NaN until measured. */
  private cameraEdgePx = NaN;
  private sharpT?: number;
  private sharpAt = -Infinity;
  private sharpReadings = 0;
  /** F4 mask: posecapture events seen (the class crop is cut on every MASK_CAPTURE_EVERY-th). */
  private captures = 0;
  /** Physical display pixels per source pixel of the AR canvas (1 when unknown). */
  private displayPerSource = 1;

  /**
   * F4 sharp: rarely (SHARPNESS.intervalMs, then steadyIntervalMs; not while held), a crop across the person's upper-arm
   * outline (the side whose shoulder is seen), read back asynchronously; its median step width.
   */
  private updateSharpness(renderer: WebGLRenderer, input: FinishInput, g: FinishGeometry | null) {
    // Physical display pixels per source pixel (CSS width × the device pixel ratio).
    // Rare (F2's RC3 bisect 19:23: f4sharp + f4mask cost ≈ 2.9 fps): nothing on the per-frame
    // path, not even the canvas's clientWidth (a forced layout while the kiosk UI updates). One
    // reading every intervalMs for the first few, then every steadyIntervalMs.
    const now = performance.now();
    const every =
      this.sharpReadings < SHARPNESS.settleReadings
        ? SHARPNESS.intervalMs
        : SHARPNESS.steadyIntervalMs;
    if (this.held || !g || now - this.sharpAt < every) return;
    this.sharpAt = now;
    const css = renderer.domElement.clientWidth;
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
    this.displayPerSource = css > 0 ? (css * dpr) / input.frame.width : 1;
    const l = input.landmarks;
    const W = input.frame.width,
      H = input.frame.height;
    const span = g.span;
    // The arm's outer outline, a little below and outside a seen shoulder.
    const i = [11, 12].find((k) => (l?.[k]?.visibility ?? 0) >= 0.5);
    if (!l || i === undefined || !(span > 20)) return;
    const sh = l[i],
      other = l[i === 11 ? 12 : 11];
    const outward = other ? Math.sign(sh.x - other.x) || 1 : 1;
    const cx = sh.x + outward * 0.3 * span,
      cy = sh.y + 0.45 * span;
    const w = Math.round(Math.min(W, 0.6 * span)),
      h = Math.round(Math.min(H, 0.3 * span));
    const x = Math.round(Math.min(W - w, Math.max(0, cx - w / 2))),
      y = Math.round(Math.min(H - h, Math.max(0, cy - h / 2)));
    if (w < 16 || h < 8) return;
    const rw = Math.min(w, 128),
      rh = Math.min(h, 32);
    this.probe
      .read(renderer, 'sharp', input.video, { x, y, w, h }, input.frame, rw, rh)
      ?.then((px) => {
        const width = cameraEdgeWidth(px, rw, rh);
        if (width === null) return;
        const src = Math.min(SHARPNESS.range[1], Math.max(SHARPNESS.range[0], width * (w / rw)));
        const now = performance.now();
        const dt = this.sharpT === undefined ? Infinity : (now - this.sharpT) / 1000;
        this.sharpT = now;
        this.sharpReadings++;
        this.cameraEdgePx = Number.isFinite(this.cameraEdgePx)
          ? smoothToward(this.cameraEdgePx, src, dt, SHARPNESS.tauS)
          : src;
        this.stats.cameraEdgePx = this.cameraEdgePx;
      })
      .catch(() => undefined);
  }

  /** F4 grain: the camera's temporal noise from a background patch read on two frames. */
  private grainAt = -Infinity;
  private grainFirst: { rect: PixelRect; px: Uint8Array } | null = null;
  private grainBusy = false;
  private grainRecent: number[] = [];

  /**
   * F4 grain: every GRAIN_F4.intervalMs (held or not: the background's noise does not depend on
   * the person), a corner patch clear of the person, then the same patch a frame or two later;
   * σ_t from their difference (sharpness.ts temporalSigma), the median of the last few readings.
   * Replaces the spatial estimate (which reads the codec-denoised flat patch: 0.2–0.5 levels on
   * the venue and Camo clips, while the camera's temporal noise in the recording is 1.3–3 levels).
   */
  private updateGrain(renderer: WebGLRenderer, input: FinishInput, g: FinishGeometry | null) {
    if (this.grainBusy) return;
    const { frame, video, landmarks } = input;
    const P = GRAIN_F4.patch;
    const first = this.grainFirst;
    if (first) {
      const second = this.probe.read(renderer, 'grainB', video, first.rect, frame, P, P);
      if (!second) return;
      this.grainBusy = true;
      second
        .then((px) => {
          const s = temporalSigma(first.px, px);
          if (s === null) return;
          this.grainRecent.push(s);
          if (this.grainRecent.length > GRAIN_F4.keep) this.grainRecent.shift();
          const sorted = [...this.grainRecent].sort((a, b) => a - b);
          this.match.grainSigma8bit = sorted[sorted.length >> 1];
        })
        .catch(() => undefined)
        .finally(() => {
          this.grainFirst = null;
          this.grainBusy = false;
        });
      return;
    }
    const now = performance.now();
    if (now - this.grainAt < GRAIN_F4.intervalMs) return;
    const W = frame.width,
      H = frame.height;
    if (W < P * 3 || H < P * 3) return;
    const box = personBox(landmarks, g?.span ?? 0, W, H);
    const corners: PixelRect[] = [
      { x: 8, y: 8, w: P, h: P },
      { x: W - P - 8, y: 8, w: P, h: P },
      { x: 8, y: Math.round(H / 2 - P / 2), w: P, h: P },
      { x: W - P - 8, y: Math.round(H / 2 - P / 2), w: P, h: P },
    ].filter(
      (r) => !box || r.x + P <= box.x0 || r.x >= box.x1 || r.y + P <= box.y0 || r.y >= box.y1,
    );
    if (!corners.length) return;
    const rect = corners[this.noiseIndex++ % corners.length];
    const read = this.probe.read(renderer, 'grainA', video, rect, frame, P, P);
    if (!read) return;
    this.grainAt = now;
    this.grainBusy = true;
    read
      .then((px) => {
        this.grainFirst = { rect, px: Uint8Array.from(px) };
      })
      .catch(() => undefined)
      .finally(() => (this.grainBusy = false));
  }

  /** F4: this frame's skin mask into `skinMask` (uMode 5 of the composite shader, no blending). */
  private renderSkinMask(renderer: WebGLRenderer, w: number, h: number, input: FinishInput) {
    if (!this.skinTarget || this.skinTarget.width !== w || this.skinTarget.height !== h) {
      this.skinTarget?.dispose();
      this.skinTarget = new WebGLRenderTarget(w, h, {
        type: UnsignedByteType,
        depthBuffer: false,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
      });
    }
    const u = this.compositeMaterial.uniforms;
    // Only round the hands (landmarks 15–22, padded by 0.35 shoulder span): the rest is cleared.
    // A full-canvas pass with the edge refinement cost GPU time every frame under f3x.
    const l = input.landmarks,
      k = w / input.frame.width,
      pad = 0.35 * (this.geometry?.span ?? 0) + 8;
    const boxes: [number, number, number, number][] = [];
    for (const ids of [
      [15, 17, 19, 21],
      [16, 18, 20, 22],
    ]) {
      const pts = ids.map((i) => l?.[i]).filter((p) => p && p.visibility >= 0.3);
      if (!pts.length) continue;
      const xs = pts.map((p) => p!.x),
        ys = pts.map((p) => p!.y);
      const x0 = Math.max(0, Math.floor((Math.min(...xs) - pad) * k)),
        x1 = Math.min(w, Math.ceil((Math.max(...xs) + pad) * k)),
        y0 = Math.max(0, Math.floor((Math.min(...ys) - pad) * k)),
        y1 = Math.min(h, Math.ceil((Math.max(...ys) + pad) * k));
      // GL scissor origin is bottom left.
      if (x1 > x0 && y1 > y0) boxes.push([x0, h - y1, x1 - x0, y1 - y0]);
    }
    try {
      u.uMode.value = 5;
      this.compositeMaterial.blending = NoBlending;
      renderer.setRenderTarget(this.skinTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      for (const [x, y, bw, bh] of boxes) {
        this.skinTarget.scissor.set(x, y, bw, bh);
        this.skinTarget.scissorTest = true;
        renderer.setRenderTarget(this.skinTarget);
        renderer.render(this.compositeScene, this.camera);
      }
    } finally {
      this.skinTarget.scissorTest = false;
      u.uMode.value = 0;
      this.compositeMaterial.blending = CustomBlending;
      renderer.setRenderTarget(null);
      renderer.setClearColor(0x000000, 1);
    }
    const m = this.skinMask;
    m.texture = this.skinTarget.texture;
    m.width = w;
    m.height = h;
    m.valid = u.uHasPerson.value > 0.5;
    m.frame = this.stats.frames;
  }

  /**
   * F4 hands: this frame's hand per side, else the last one seen within HANDS_BRIDGE_MS (a hand
   * landmark dropping below visibility for a few frames must not blink the hand away).
   */
  private liveHands(live: FinishGeometry | null): FinishGeometry['hands'] {
    const now = performance.now();
    return [0, 1].map((i) => {
      const h = live?.hands[i] ?? null;
      if (h) {
        this.lastHands[i] = { shape: h, at: now };
        return h;
      }
      const last = this.lastHands[i];
      return last && now - last.at <= HANDS_BRIDGE_MS ? last.shape : null;
    });
  }

  /**
   * Evaluation: re-runs the last composite in metric mode and reads it back (synchronous). The
   * uncovered share of the upper-body clothing before (the warped jacket alone) and after.
   */
  measureCoverage(
    renderer: WebGLRenderer,
    raw = false,
    metric: 'region' | 'independent' = 'region',
  ) {
    const input = this.lastInput;
    if (!input) return null;
    const w = Math.max(1, Math.round(input.frame.width / 2)),
      h = Math.max(1, Math.round(input.frame.height / 2));
    const target = new WebGLRenderTarget(w, h, { type: UnsignedByteType, depthBuffer: false });
    const pixels = new Uint8Array(w * h * 4);
    const u = this.compositeMaterial.uniforms;
    try {
      u.uMode.value = metric === 'independent' ? 2 : 1;
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      // The metric writes its channels as they are (no blending with the cleared target).
      this.compositeMaterial.blending = NoBlending;
      renderer.render(this.compositeScene, this.camera);
      renderer.readRenderTargetPixels(target, 0, 0, w, h, pixels);
    } finally {
      u.uMode.value = 0;
      this.compositeMaterial.blending = CustomBlending;
      renderer.setRenderTarget(null);
      renderer.setClearColor(0x000000, 1);
      target.dispose();
    }
    const c = coverageFromMetric(pixels);
    return c ? { ...c, classes: this.stats.usedClasses, pixels: raw ? pixels : null } : null;
  }

  /**
   * Evaluation (rest stability): re-runs the last composite into a half-size target twice and
   * reads it back (synchronous): `colour` = this pass's own layer (premultiplied RGBA, shadows and
   * grain included); `alphas` = R the jacket before this pass, G the fill, B the final alpha.
   */
  measureLayers(renderer: WebGLRenderer) {
    const input = this.lastInput;
    if (!input) return null;
    const w = Math.max(1, Math.round(input.frame.width / 2)),
      h = Math.max(1, Math.round(input.frame.height / 2));
    if (!this.layerTarget || this.layerTarget.width !== w || this.layerTarget.height !== h) {
      this.layerTarget?.dispose();
      this.layerTarget = new WebGLRenderTarget(w, h, {
        type: UnsignedByteType,
        depthBuffer: false,
      });
    }
    const u = this.compositeMaterial.uniforms;
    const read = (mode: number) => {
      const px = new Uint8Array(w * h * 4);
      u.uMode.value = mode;
      renderer.setRenderTarget(this.layerTarget!);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this.compositeScene, this.camera);
      renderer.readRenderTargetPixels(this.layerTarget!, 0, 0, w, h, px);
      return px;
    };
    try {
      this.compositeMaterial.blending = NoBlending;
      return {
        width: w,
        height: h,
        scale: input.frame.width / w,
        colour: read(0),
        alphas: read(4),
      };
    } finally {
      u.uMode.value = 0;
      this.compositeMaterial.blending = CustomBlending;
      renderer.setRenderTarget(null);
      renderer.setClearColor(0x000000, 1);
    }
  }
  private layerTarget?: WebGLRenderTarget;

  private setUniforms(input: FinishInput, g: FinishGeometry | null, scale: number) {
    const u = this.compositeMaterial.uniforms;
    const W = input.frame.width,
      H = input.frame.height;
    const o = this.options;
    u.tWarped.value = input.warped.texture;
    u.tVideo.value = input.video;
    this.fillMaterial.uniforms.tWarped.value = input.warped.texture;
    u.uSrc.value.set(W, H);
    u.uTexel.value.set(1 / input.warped.width, 1 / input.warped.height);
    u.uScale.value = scale;
    u.uCover.value = o.cover ? 1 : 0;
    // ?f4hands: no closed dark cuff opening. The real hand is always shown beyond the cuff
    // (Anywear A2) and fills the opening; the dark lining ellipse read as a hole around it.
    u.uCuffs.value = o.cuffs && !this.f4.hands && !this.f4.noCuff ? 1 : 0;
    u.uHands.value = o.hands ? 1 : 0;
    u.uShadow.value = o.shadow ? 1 : 0;
    // Softness: σ ≈ 0.77 × the tap offset for the 5-tap kernel (shaders.ts). F4 edge: no feather
    // (it eroded the edge); the jacket's MSAA alpha is its edge, blurred only to the camera's own
    // measured sharpness (EDGE_JBU.cameraSigmaSrc, source px: scale-aware for any camera size).
    const soften = o.soften && !this.f4.edge;
    // ?f4sharp: σ from the camera's measured sharpness, capped by the crisp floor (sharpness.ts).
    const edgeSigma =
      this.f4.sharp && Number.isFinite(this.cameraEdgePx)
        ? matchedSigma(
            this.cameraEdgePx,
            SHARPNESS.jacketCanvasPx / scale,
            SHARPNESS.floorDisplayPx / this.displayPerSource,
          )
        : EDGE_JBU.cameraSigmaSrc;
    this.stats.jacketSigmaPx = this.f4.edge ? edgeSigma : null;
    u.uBlur.value = soften
      ? (BLUR_SOURCE_PX / 0.77) * scale
      : this.f4.edge && o.soften
        ? (edgeSigma / 0.77) * scale
        : 0;
    u.uFeather.value = soften ? FEATHER_SOURCE_PX * scale : 0;
    u.uEdge.value = this.f4.edge ? 1 : 0;
    u.uMirrorFill.value = this.f4.fill ? 1 : 0;
    // ?f4hands=2: while held (class mask frozen), the hands' skin also from the live colour.
    u.uHandsLive.value = this.f4.handsLive && this.held ? 1 : 0;
    const pm = this.personBytes;
    if (pm)
      u.uPersonTexel.value.set(
        (W / pm.width) * EDGE_JBU.tapOfTexel,
        (H / pm.height) * EDGE_JBU.tapOfTexel,
      );
    // Static grain when stabilised (a fixed pattern at the camera's σ, not boiling noise).
    // ?f4grain=1: the camera's noise is temporal (it boils frame to frame), so the matched grain is
    // too: a new pattern every frame at the measured σ (judge grain ratio = temporal noise of the
    // jacket / the camera's; a static pattern read ≈ 0.47 on RC3).
    u.uSeed.value = o.stabilize && !this.f4.grain ? 0 : (this.stats.frames % 997) * 0.731;
    const span = g?.span ?? 0;
    u.uSpan.value = span;
    u.uNear.value = NEAR_OF_SPAN * span;
    u.uContactR.value = Math.max(1, SHADOW.contactRadiusOfSpan * span);
    u.uEnclosureR.value = Math.max(1, SHADOW.enclosureRadiusOfSpan * span);
    u.uInnerR.value = Math.max(1, SHADOW.innerRadiusOfSpan * span);
    u.uShadeR.value = Math.max(1, FILL_SHADE.radiusOfSpan * span);
    if (this.f4.shadow) {
      // Toward the key light in image px (y down); a nearly frontal key: straight up (overhead).
      const k = keyDirCamera(this.light);
      const n = Math.hypot(k[0], k[1]);
      if (n > 0.2) u.uShadowDir.value.set(k[0] / n, -k[1] / n);
      else u.uShadowDir.value.set(0, -1);
      u.uShadowReach.value = Math.max(1, CONTACT_F4.reachOfSpan * span);
    }
    u.uTorsoOn.value = g?.torso ? 1 : 0;
    if (g?.torso) g.torso.forEach((c, i) => u.uTorso.value[i].set(c[0], c[1]));
    u.uBandOn.value = g?.band ? 1 : 0;
    if (g?.band) g.band.forEach((c, i) => u.uBand.value[i].set(c[0], c[1]));
    for (let i = 0; i < 4; i++) {
      const s = g?.arms[i];
      u.uSegR.value[i] = s ? s.radius : 0;
      u.uSegFlat.value[i] = s?.flatEnd ? 1 : 0;
      u.uSegFlatStart.value[i] = s?.flatStart ? 1 : 0;
      if (s) {
        u.uSegA.value[i].set(s.a[0], s.a[1]);
        u.uSegB.value[i].set(s.b[0], s.b[1]);
      }
    }
    u.uHeadOn.value = g?.head ? 1 : 0;
    if (g?.head) {
      u.uHead.value.set(g.head.centre[0], g.head.centre[1], g.head.radius, g.head.chinY);
      u.uHeadUp.value = g.head.up;
    }
    u.uNeckHalf.value = g?.neck ? g.neck.halfWidth : 0;
    if (g?.neck) u.uNeck.value.set(g.neck.a[0], g.neck.a[1], g.neck.b[0], g.neck.b[1]);
    for (let i = 0; i < 2; i++) {
      const h = g?.hands[i];
      u.uHandR.value[i] = h ? h.radius : 0;
      if (h) {
        u.uHandA.value[i].set(h.a[0], h.a[1]);
        u.uHandB.value[i].set(h.b[0], h.b[1]);
      }
      const c = g?.cuffs[i];
      u.uCuffR.value[i] = c ? c.halfWidth : 0;
      if (c) {
        u.uCuffW.value[i].set(c.wrist[0], c.wrist[1]);
        u.uCuffD.value[i].set(c.dir[0], c.dir[1]);
        u.uCuffDepth.value[i] = c.depth;
      }
    }
    // Grade (both passes).
    const m = this.match;
    const exposure = this.override.exposure ?? (o.grade ? m.exposure : input.exposure);
    const gain = this.override.gain ?? (o.grade ? m.gain : ([1, 1, 1] as Rgb));
    const lift = this.override.lift ?? (o.grade ? m.lift : 0);
    // F4 light: the camera's adaptation to the garment (f4.ts cameraAdaptation).
    const adapt = this.f4.light && o.grade ? cameraAdaptation(this.garmentColour) : null;
    const e0 = Number.isFinite(exposure) ? exposure : input.exposure;
    for (const material of [this.fillMaterial, this.compositeMaterial]) {
      material.uniforms.uExposure.value = e0 * (adapt?.exposure ?? 1);
      material.uniforms.uGain.value.set(
        gain[0] * (adapt?.gain[0] ?? 1),
        gain[1] * (adapt?.gain[1] ?? 1),
        gain[2] * (adapt?.gain[2] ?? 1),
      );
      material.uniforms.uLift.value = lift;
    }
    const sigma = this.override.grainSigma ?? m.grainSigma8bit;
    u.uGrain.value = o.grain ? Math.min(GRAIN_MAX_8BIT, sigma) / 255 : 0;
  }

  private uploadPerson(mask: LiveFrame['mask']) {
    const u = this.compositeMaterial.uniforms;
    // The shared lock freezes the actual uploaded bytes, not an accumulator still settling.
    if (this.held && this.personTexture && mask) {
      u.uHasPerson.value = 1;
      return;
    }
    if (!mask) {
      u.uHasPerson.value = 0;
      return;
    }
    const packed = packPerson(mask, MASK_MAX_WIDTH, this.personBytes, this.f4.edge);
    const fresh = packed !== this.personBytes || !this.personTexture;
    if (fresh) {
      this.personTexture?.dispose();
      this.personAcc = new Float32Array(packed.data.length);
      this.personOut = new Uint8Array(packed.data.length);
      this.personTexture = new DataTexture(
        this.personOut,
        packed.width,
        packed.height,
        RedFormat,
        UnsignedByteType,
      );
      this.personTexture.minFilter = this.personTexture.magFilter = LinearFilter;
      this.personBytes = packed;
    }
    // Still: the model's frame-to-frame edge noise averages out; moving: the new mask as is.
    let a = fresh ? 1 : blendFactor(this.still, STILL.personBlend);
    // ?f4stable=1: a light EMA while moving too (MASK_STABLE.moving of the new mask), then
    // hysteresis round the 0.5 edge so a boundary pixel only flips on a clear change.
    if (this.f4.stable && !fresh) a = Math.min(a, MASK_STABLE.moving);
    blendInto(this.personAcc!, packed.data, a, this.personOut!);
    if (this.f4.stable) {
      if (!this.personPrev || this.personPrev.length !== this.personOut!.length || fresh)
        this.personPrev = Uint8Array.from(this.personOut!);
      else hysteresis(this.personOut!, this.personPrev, MASK_STABLE.band);
    }
    this.personTexture!.needsUpdate = true;
    u.tPerson.value = this.personTexture;
    u.uHasPerson.value = 1;
  }

  /**
   * Sends the upper body to the worker when it is idle; uploads a newly arrived class mask; uses
   * it while fresh, looked up through the person's motion since its frame (motion.ts).
   */
  private updateClasses(
    video: HTMLVideoElement | HTMLCanvasElement | undefined,
    input: FinishInput,
    g: FinishGeometry | null,
  ) {
    const u = this.compositeMaterial.uniforms;
    // Keep the drawn class texture AND its crop/affines together. Assimilating a new mask or
    // aging into the person fallback while held would move the coverage edge on a still body.
    // A pending worker reply stays in latest and is consumed immediately on shared release.
    if (this.held && this.stats.usedClasses && this.options.classes && video) return;
    u.uHasClass.value = 0;
    this.stats.usedClasses = false;
    if (!this.options.classes || !video) return;
    this.segmenter ??= new WorkerSegmenter(VISION_ASSET_BASE, this.segmenterDelegate);
    const seg = this.segmenter;
    this.stats.classError = seg.error;
    this.stats.classDelegate = seg.delegate;
    const now = snapshot(input.landmarks);
    const ready = video instanceof HTMLVideoElement ? video.readyState >= 2 : video.width > 0;
    let rect = g && upperBodyRect(input.landmarks, g.span, input.frame);
    // The crop box holds still unless it really moved, so blended masks share it.
    if (rect && g && this.options.stabilize)
      rect = this.heldRect = holdRect(this.heldRect, rect, STILL.rectTolOfSpan * g.span);
    // F4 mask: the capture path when the source announces its frames (one 'posecapture' in the
    // last 0.5 s), else no rate cap (one request in flight; the freshest mask possible).
    const source = input.sourceVideo ?? null;
    if (this.f4.mask && source && source !== this.captureVideo) {
      this.captureVideo?.removeEventListener('posecapture', this.onCapture);
      this.captureVideo = source;
      source.addEventListener('posecapture', this.onCapture);
    }
    if (rect) this.lastRect = rect;
    this.lastFrameSize = { width: input.frame.width, height: input.frame.height };
    const capture = this.f4.mask && performance.now() - this.captureAt < 500;
    this.stats.classCapture = capture;
    const frameT = input.frame.t;
    if (capture && typeof frameT === 'number') {
      this.anchorsByT.set(frameT, now);
      while (this.anchorsByT.size > 16)
        this.anchorsByT.delete(this.anchorsByT.keys().next().value as number);
    }
    // Draw-time requests keep the 15 Hz cap (with f4mask too: uncapped they doubled the GPU's
    // segmentation work for little gain without the capture path).
    const due = performance.now() - this.lastRequestAt >= 1000 / CLASS_REQUEST_HZ;
    if (
      !capture &&
      ready &&
      rect &&
      due &&
      !this.freezeClasses &&
      seg.request(video, rect, input.frame, now)
    )
      this.lastRequestAt = performance.now();
    // Capture path: the newest mask whose frame is not newer than the one drawn now, anchored to
    // that frame's own landmarks (identity motion when it IS this frame).
    let r = seg.latest;
    let anchor = r?.anchor ?? null;
    if (capture && typeof frameT === 'number') {
      r = pickCaptured(seg.recent, frameT, this.anchorsByT);
      anchor = r ? (this.anchorsByT.get(r.tag!) ?? null) : null;
      if (!r) r = this.classResult;
      else this.stats.classFrameLagMs = mean(this.stats.classFrameLagMs ?? NaN, frameT - r.tag!);
    }
    if (r && r !== this.classResult) {
      this.classResult = r;
      this.classAnchor = anchor;
      this.stats.classMasks++;
      this.stats.classMs = mean(this.stats.classMs ?? NaN, r.workerMs);
      this.stats.classLatencyMs = mean(this.stats.classLatencyMs ?? NaN, r.arrivedAt - r.sentAt);
      this.stats.classUseDelayMs = mean(
        this.stats.classUseDelayMs ?? NaN,
        performance.now() - r.arrivedAt,
      );
      const prev = this.stats.classTiming;
      this.stats.classTiming = prev
        ? (Object.fromEntries(
            Object.entries(r.timing).map(([k, v]) => [k, mean(prev[k as keyof typeof prev], v)]),
          ) as ClassMaskResult['timing'])
        : { ...r.timing };
      // Packed in the worker; only the blend and upload are on this thread.
      const packed = r.packed;
      const sameSize =
        !!this.classOut &&
        this.classOut.width === packed.width &&
        this.classOut.height === packed.height;
      if (!this.classTexture || !sameSize) {
        this.classTexture?.dispose();
        this.classAcc = new Float32Array(packed.data.length);
        this.classOut = {
          data: new Uint8Array(packed.data.length),
          width: packed.width,
          height: packed.height,
        };
        this.classTexture = new DataTexture(
          this.classOut.data,
          packed.width,
          packed.height,
          RGBAFormat,
          UnsignedByteType,
        );
        this.classTexture.minFilter = this.classTexture.magFilter = LinearFilter;
        this.classAccRect = null;
      }
      // Blend only masks of the same crop box, and only while still.
      const r0 = this.classAccRect;
      const aligned =
        !!r0 && r0.x === r.rect.x && r0.y === r.rect.y && r0.w === r.rect.w && r0.h === r.rect.h;
      let a = this.options.stabilize && aligned ? blendFactor(this.still, STILL.classBlend) : 1;
      if (this.f4.stable && aligned) a = Math.min(a, MASK_STABLE.moving);
      blendInto(this.classAcc!, packed.data, a, this.classOut!.data);
      this.classAccRect = r.rect;
      this.classTexture.needsUpdate = true;
      u.tClass.value = this.classTexture;
    }
    const c = this.classResult;
    if (!c || !this.classTexture) return;
    if (!this.freezeClasses && performance.now() - c.sentAt > CLASS_MAX_AGE_MS) return;
    u.uHasClass.value = 1;
    u.uClassTexel.value.set(
      (c.rect.w / Math.max(1, c.packed.width)) * EDGE_JBU.tapOfTexel,
      (c.rect.h / Math.max(1, c.packed.height)) * EDGE_JBU.tapOfTexel,
    );
    this.stats.classAgeMs = mean(this.stats.classAgeMs ?? NaN, performance.now() - c.sentAt);
    u.uClassRect.value.set(c.rect.x, c.rect.y, c.rect.w, c.rect.h);
    const motion =
      this.motionCompensation === 'regions'
        ? maskMotion(now, this.classAnchor)
        : this.motionCompensation === 'translate'
          ? shoulderShift(now, this.classAnchor)
          : { torso: IDENTITY, arms: [null, null, null, null] };
    this.classMotion = motion;
    const rows = (T: Affine, out: Vector3[], i: number) => {
      out[i].set(T[0], T[1], T[2]);
      out[i + 1].set(T[3], T[4], T[5]);
    };
    rows(motion.torso, u.uClassTorso.value, 0);
    motion.arms.forEach((T, i) => {
      u.uClassArmOn.value[i] = T ? 1 : 0;
      if (T) rows(T, u.uClassArm.value, i * 2);
    });
    this.stats.usedClasses = true;
  }

  /** Grade time-constant multiplier: STILL.gradeSlow when still, 1 when moving. */
  private gradeSlow() {
    return this.options.stabilize ? 1 + (STILL.gradeSlow - 1) * this.still : 1;
  }

  /** The class at a source pixel from the CPU copy of the current class mask, or null. */
  private classOf(x: number, y: number): number | null {
    const c = this.classResult;
    if (!c || !this.stats.usedClasses) return null;
    const [qx, qy] = applyAffine(this.classMotion.torso, [x, y]);
    const cx = (qx - c.rect.x) / c.rect.w,
      cy = (qy - c.rect.y) / c.rect.h;
    if (cx < 0 || cy < 0 || cx >= 1 || cy >= 1) return null;
    const m = c.mask;
    return m.data[Math.floor(cy * m.height) * m.width + Math.floor(cx * m.width)];
  }

  /**
   * Face-skin exposure / white balance, black level and noise. GPU crops of the video, read back
   * asynchronously every few frames; the results update the smoothed match when they land.
   */
  private updateMatch(renderer: WebGLRenderer, input: FinishInput, g: FinishGeometry | null) {
    const m = this.match;
    // No face reference yet: the calibrated exposure (not the compositor's kiosk 0.92).
    if (!Number.isFinite(m.exposure))
      m.exposure = this.f4.light ? VENUE_EXPOSURE.atRef : EXPOSURE_AT_REF;
    // F4X (?f4light=1): a person who stands still from the first frame is held at once, so the
    // grade would never be seeded (gain [1,1,1], no lift) until they first move: the readings run
    // while held until the first face and black-level readings have landed (dt = ∞ applies them
    // at once); afterwards the hold works as before.
    const seedFace = this.f4.light && m.face === null,
      seedLift = this.f4.light && m.p1 === null;
    if (this.held && !seedFace && !seedLift) return;
    const n = this.stats.frames;
    const every = this.f4.mask ? MATCH_EVERY_FRAMES_F4 : MATCH_EVERY_FRAMES;
    if (n % every !== 1 % every && n > 1) return;
    const { frame, video, landmarks } = input;
    const W = frame.width,
      H = frame.height;
    // Black level: p1 luma of a small copy of the whole frame.
    const sw = MATCH_WIDTH,
      sh = Math.max(1, Math.round((MATCH_WIDTH * H) / W));
    this.probe
      .read(renderer, 'frame', video, { x: 0, y: 0, w: W, h: H }, frame, sw, sh)
      ?.then((px) => {
        const now = performance.now();
        const dt = this.liftT === undefined ? Infinity : (now - this.liftT) / 1000;
        this.liftT = now;
        if (this.held && !(this.f4.light && m.p1 === null)) return;
        m.p1 = lumaPercentile(px, 0.01);
        const t = this.target;
        const stab = this.options.stabilize;
        t.lift = stab ? deadband(t.lift, liftFromP1(m.p1), STILL.liftBand) : liftFromP1(m.p1);
        m.lift = smoothToward(m.lift, t.lift, dt, LIFT_TAU_S * this.gradeSlow());
      })
      .catch(() => undefined);
    // Face skin: a crop between the eyes and the mouth, only while the face is frontal.
    const face = landmarks && faceBox(landmarks, W, H);
    m.frontal = !!face && !!landmarks && frontal(landmarks);
    if (face && m.frontal) {
      const S = 24;
      this.probe
        .read(renderer, 'face', video, face, frame, S, S)
        ?.then((px) => {
          // Rows come back bottom-up: row r is source y = face.y + face.h − (r + 0.5) · face.h / S.
          const isSkin = this.stats.usedClasses
            ? (i: number) => {
                const x = face.x + ((i % S) + 0.5) * (face.w / S),
                  y = face.y + face.h - (Math.floor(i / S) + 0.5) * (face.h / S);
                return this.classOf(x, y) === CLASS.faceSkin;
              }
            : undefined;
          // With classes, only face-skin pixels count (no fallback to the raw crop: on a back view
          // it held the hood, Y ≈ 1); either way the colour must look like lit skin.
          const skin = faceSkinColour(px, isSkin);
          if (!skin || !plausibleSkin(skin)) return;
          const now = performance.now();
          const dt = this.faceT === undefined ? Infinity : (now - this.faceT) / 1000;
          this.faceT = now;
          if (this.held && !(this.f4.light && m.face === null)) return;
          const y = luminance(skin);
          m.face = skin;
          m.faceY = y;
          // Targets move only beyond a deadband when stabilised; the grade then eases toward them,
          // slower while the person is still.
          const t = this.target;
          const stab = this.options.stabilize;
          const e = this.f4.light ? venueExposure(y) : exposureFromFace(y);
          t.exposure = stab ? deadband(t.exposure, e, STILL.exposureBand) : e;
          const gains = whiteBalanceGains(skin);
          t.gain = gains.map((c, k) => (stab ? deadband(t.gain[k], c, STILL.gainBand) : c)) as Rgb;
          const tau = MATCH_TAU_S * this.gradeSlow();
          m.exposure = smoothToward(m.exposure, t.exposure, dt, tau);
          m.gain = m.gain.map((c, k) => smoothToward(c, t.gain[k], dt, tau)) as Rgb;
          // Scene light from the same crop's shading (light.ts), skin pixels only.
          const lo = y * 0.35,
            hi = y * 2.2;
          const samples: { n: Vec3; c: Rgb }[] = [];
          for (let i = 0; i < S * S; i++) {
            if (isSkin && !isSkin(i)) continue;
            const c: Rgb = [
              srgbToLinear(px[i * 4] / 255),
              srgbToLinear(px[i * 4 + 1] / 255),
              srgbToLinear(px[i * 4 + 2] / 255),
            ];
            const Y = luminance(c);
            if (Y < lo || Y > hi) continue; // eyes, nostrils, specular highlights
            const u = (((i % S) + 0.5) / S) * 2 - 1,
              v = 1 - ((Math.floor(i / S) + 0.5) / S) * 2; // rows come back bottom-up
            samples.push({ n: faceNormal(u, v), c });
          }
          const fit = fitFaceLight(samples);
          if (fit) this.light = smoothLight(this.light, fit, dt, LIGHT_TAU_S);
        })
        .catch(() => undefined);
    }
    // Noise: one corner patch clear of the person per round; σ = the minimum of the last four.
    const noiseEvery = this.f4.mask ? NOISE_EVERY_FRAMES_F4 : NOISE_EVERY_FRAMES;
    if (n % noiseEvery === 1 % noiseEvery || n <= 1) {
      const P = NOISE_PATCH;
      if (W > P * 2 && H > P * 2) {
        const box = personBox(landmarks, g?.span ?? 0, W, H);
        const corners: PixelRect[] = [
          { x: 8, y: 8, w: P, h: P },
          { x: W - P - 8, y: 8, w: P, h: P },
          { x: 8, y: Math.round(H / 2 - P / 2), w: P, h: P },
          { x: W - P - 8, y: Math.round(H / 2 - P / 2), w: P, h: P },
        ].filter(
          (r) => !box || r.x + P <= box.x0 || r.x >= box.x1 || r.y + P <= box.y0 || r.y >= box.y1,
        );
        if (corners.length) {
          const rect = corners[this.noiseIndex++ % corners.length];
          this.probe
            .read(renderer, 'noise', video, rect, frame, P, P)
            ?.then((px) => {
              // f4grain: the temporal estimate (updateGrain) sets the σ instead.
              if (this.held || this.f4.grain) return;
              this.noiseRecent.push(noiseSigma(px, P, P));
              if (this.noiseRecent.length > 4) this.noiseRecent.shift();
              m.grainSigma8bit = Math.min(...this.noiseRecent);
            })
            .catch(() => undefined);
        }
      }
    }
  }

  dispose() {
    this.captureVideo?.removeEventListener('posecapture', this.onCapture);
    this.segmenter?.dispose();
    this.segmenter = undefined;
    this.probe.dispose();
    this.layerTarget?.dispose();
    this.skinTarget?.dispose();
    this.fillTarget.dispose();
    this.fillMaterial.dispose();
    this.compositeMaterial.dispose();
    this.quadGeometry.dispose();
    this.personTexture?.dispose();
    this.classTexture?.dispose();
  }
}

/** The person's landmark box padded by 0.5 S (noise patches avoid it), in source px. */
function personBox(l: readonly ImageLandmark[] | null, span: number, W: number, H: number) {
  const r = upperBodyRect(l, span, { width: W, height: H });
  if (!r) return null;
  const pad = 0.2 * span;
  return { x0: r.x - pad, x1: r.x + r.w + pad, y0: r.y - pad, y1: r.y + r.h + pad };
}

/** The mid-shoulder translation from now back to the mask's frame (the simple compensation). */
function shoulderShift(now: LandmarkSnapshot | null, then: LandmarkSnapshot | null): MaskMotion {
  const mid = (s: LandmarkSnapshot | null) =>
    s?.[11] && s[12] ? [(s[11][0] + s[12][0]) / 2, (s[11][1] + s[12][1]) / 2] : null;
  const a = mid(now),
    b = mid(then);
  return {
    torso: a && b ? translation(b[0] - a[0], b[1] - a[1]) : IDENTITY,
    arms: [null, null, null, null],
  };
}
