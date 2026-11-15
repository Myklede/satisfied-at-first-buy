// AR view (agent V2, prompt 14): the source video with the posed jacket drawn over the person.
// Implements contract.ts ArRenderer. Plain Three.js, no React.
//
// Per render(frame, scene):
//   1. ArTracker solves the camera (intrinsics + smoothed body→camera pose) from the frame's
//      landmarks and the posed joints, and scores the alignment.
//   2. Draw, into one canvas with the video's aspect ratio:
//      a. the video frame (full canvas; the canvas IS the source image, so pixels map 1:1);
//      b. the posed body, depth only (never in colour): the jacket's inside and back faces hide
//         behind the body like they do on the real person (neck opening, hem from below);
//      c. the jacket, with the kiosk's own materials, lights and tone mapping (Viewer.ts);
//      d. hand occluders: where a real hand (MediaPipe hand landmarks, refined by the person
//         segmentation mask) is in front of the jacket by the posed depth, the video wins.
//   The posed scene belongs to the caller (V1): its root is lent to this scene for the draw
//   and handed back in `finally`, under a wrapper carrying its parent's world transform.
//
// Program warm-up: the first draw of a garment program on a cold GPU cache blocks for seconds
// (programWarmup.ts). New materials are compiled asynchronously first and the jacket is drawn
// once they are linked; until then the video shows alone, with "preparing the jacket".
import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DirectionalLight,
  Group,
  HemisphereLight,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  NeutralToneMapping,
  NoBlending,
  NormalBlending,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  RedFormat,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  Texture,
  UnsignedByteType,
  Vector2,
  VideoTexture,
  WebGLRenderer,
  WebGLRenderTarget,
  type Material,
  type Object3D,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { ArRenderer, LiveFrame, LivePosedScene } from '../contract';
import type { MotionRig } from '../../motion/rig';
import { ArKioskJacket, isKioskJacketSource } from './ArKioskJacket';
import { readF4xFlags } from './f4x';
import {
  ArTracker,
  torsoAlignmentScore,
  type ArSolution,
  type ArTrackerOptions,
} from './ArTracker';
import { occluderIndex } from './occluder';
import { ContourHold, contourTargets, type ContourSide } from './contour';
import { rotateAbout, sagittalHeadAngleDeg } from './headPose';
import type { StillnessState } from './stillness';
import { SharedStillDetector, sharedStillState, type SharedStillState } from '../sharedStillness';
import { ScreenFit } from './screenFit';
import { ArGlue } from './glue';
import { ArFinish } from './finish';
import { readF4Flags, venueRig, type F4Flags, type VenueRig } from './finish/f4';
import {
  F3_BODY_PUSH_M,
  F3_CHIN_FROM_MOUTH,
  F3_TORSO_HALF_DEPTH_M,
  F3_COLLAR_MAX_DROP_M,
  F3_COLLAR_TAU_S,
  F3_MIN_AREA,
  F3_SLEEVE_COLUMNS,
  F3_SLEEVE_STRETCH,
  F3_TORSO_STRETCH,
  readF3Flags,
  f3Flag,
  type F3Flags,
} from './f3Flags';
import type { LightEstimate } from './finish/light';
import { RES_MAX_RATIO } from './finish/config';
import { SleeveLayers, type LayerName } from './sleeveLayers';
import { createF3x } from './sleeveAnchor';
import { HandHold } from './handHold';
import { passOccluderIndex } from './armOccluder';
import { backHeadCapsule } from './backHead';
import { upperTorsoOccluderIndex } from './flatFront';
import { armsHanging, fitSimilarity, RigidFilter } from './rigidGlue';
import type { Control } from './warp';
import { OneEuroFilter, OneEuroVecFilter } from '@satisfy/vision';
import type { AnatomicalPose } from '../../motion/rig';
import { PANEL } from '../../garmentSurface';
import { acromionVertices, collarTargetKind, shoulderMarks, visibleCollarTop } from './anchors';
import { project, rotation, toCamera, viewMatrix, type Intrinsics, type Vec3 } from './cameraModel';
import {
  BODY_DEPTH_OFFSET,
  HEAD_FLEXION,
  CONTOUR_ARM_RADIUS_M,
  CONTOUR_CAP_PX,
  CONTOUR_DEADBAND_PX,
  CONTOUR_ROWS,
  GLUE_COLUMNS,
  GLUE_EASE_M,
  GLUE_SCALE_CAP,
  GLUE_SIZE_DEADBAND,
  SMOOTH_GLUE_ARMS,
  F1STAB_GLUE,
  SMOOTH_GLUE_TARGETS,
  MATCH_EVERY_FRAMES,
  MATCH_EXPOSURE_RANGE,
  MATCH_GAMMA,
  MATCH_REFERENCE_LUMA,
  MATCH_TAU_S,
  MATCH_TINT,
  COLLAR_GUARD_MAX_FRACTION,
  COLLAR_GUARD_GLUE_CM,
  COLLAR_GUARD_GLUE_MIN_ALIGNMENT,
  COLLAR_TARGET_FROM_MOUTH,
  SHOULDER_MARK_BLEND,
  type CollarTargetKind,
  COLLAR_TARGET_MAX_M,
  COLLAR_TARGET_TAU_S,
  EYE_SPACING_M,
  COLLAR_GUARD_TAU_S,
  COLLAR_HALF_WIDTH_M,
  HAND_DEPTH_MARGIN_M,
  HAND_RADIUS,
  HAND_RADIUS_MIN,
  HAND_REACH,
  MASK_MAX_WIDTH,
  MIN_VISIBILITY,
} from './config';

const NEAR = 0.05,
  FAR = 30;

/**
 * F2 frame scheduling (?poseWorker=1&poseSync=1, sources/trackedSource.ts): the source hangs a
 * canvas on its video element that always holds the exact camera frame of the latest pose. The
 * AR draws (and the finisher samples) that canvas, so the jacket and the picture are the same
 * frame; `this.video` stays the real element (readiness, playback). Without the flag: the video.
 */
function frameShown(video: HTMLVideoElement): HTMLVideoElement {
  const shown = (video as HTMLVideoElement & { poseSyncDisplay?: HTMLCanvasElement })
    .poseSyncDisplay;
  // VideoTexture reads only readyState/requestVideoFrameCallback; the canvas answers readyState.
  return shown ? (shown as unknown as HTMLVideoElement) : video;
}

/** Hand landmarks (BlazePose): wrist, pinky knuckle, index knuckle, thumb; and the posed wrist. */
const HANDS = [
  { wrist: 15, pinky: 17, index: 19, joint: 'lWrist' },
  { wrist: 16, pinky: 18, index: 20, joint: 'rWrist' },
] as const;

export type HandCapsule = {
  a: [number, number];
  b: [number, number];
  radius: number;
  /** Camera depth (m) of the hand plane: the posed wrist, moved toward the lens by the margin. */
  depth: number;
};

/** The hand capsules of a frame (source px), or none when the hand landmarks are not visible. */
export function handCapsules(
  frame: LiveFrame,
  solution: ArSolution,
  joints: LivePosedScene['joints'],
): HandCapsule[] {
  const out: HandCapsule[] = [];
  const l = frame.landmarks2d;
  if (!l) return out;
  const R = viewMatrix(solution.pose, solution.pivot);
  for (const hand of HANDS) {
    const w = l[hand.wrist],
      p = l[hand.pinky],
      i = l[hand.index];
    const X = joints[hand.joint];
    if (!w || !p || !i || !X) continue;
    if (Math.min(w.visibility, p.visibility, i.visibility) < MIN_VISIBILITY) continue;
    const kx = (p.x + i.x) / 2,
      ky = (p.y + i.y) / 2;
    const len = Math.hypot(kx - w.x, ky - w.y);
    if (len < 2) continue;
    const spread = Math.hypot(p.x - i.x, p.y - i.y);
    const radius = Math.max(HAND_RADIUS * spread, HAND_RADIUS_MIN * len);
    const b: [number, number] = [w.x + (kx - w.x) * HAND_REACH, w.y + (ky - w.y) * HAND_REACH];
    const z = R[8] * X[0] + R[9] * X[1] + R[10] * X[2] + R[11];
    out.push({ a: [w.x, w.y], b, radius, depth: z - HAND_DEPTH_MARGIN_M });
  }
  return out;
}

const quadVertex = /* glsl */ `
  uniform float uDepth;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, uDepth, 1.0);
  }
`;

/**
 * The video, as background (uMode 0) or as a hand occluder (uMode 1: alpha = inside the capsule ×
 * person mask). The source pixel of a fragment is (vUv.x·W, (1 − vUv.y)·H).
 */
const quadFragment = /* glsl */ `
  uniform sampler2D tVideo;
  uniform sampler2D tMask;
  uniform float uHasMask;
  uniform float uMode;
  uniform vec2 uSize;
  uniform vec2 uA;
  uniform vec2 uB;
  uniform float uRadius;
  uniform float uAlpha;
  varying vec2 vUv;
  void main() {
    vec4 video = texture2D(tVideo, vUv);
    float alpha = uAlpha;
    if (uMode > 0.5) {
      vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uSize;
      vec2 ab = uB - uA;
      float h = clamp(dot(px - uA, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
      float d = length(px - uA - ab * h);
      alpha = 1.0 - smoothstep(uRadius * 0.75, uRadius, d);
      if (uHasMask > 0.5) alpha *= smoothstep(0.3, 0.7, texture2D(tMask, vec2(vUv.x, 1.0 - vUv.y)).r);
      if (alpha < 0.004) discard;
    }
    // The video texture is sampled as stored (sRGB values; three does not decode it for a
    // ShaderMaterial), so it is written out unchanged: NO second sRGB encode. With
    // colorspace_fragment here every black was lifted to grey (V4: wall 116 → 189).
    gl_FragColor = vec4(video.rgb, alpha);
  }
`;

function quadMaterial(occluder: boolean) {
  return new ShaderMaterial({
    uniforms: {
      tVideo: { value: null },
      tMask: { value: null },
      uHasMask: { value: 0 },
      uMode: { value: occluder ? 1 : 0 },
      uSize: { value: new Vector2(1, 1) },
      uA: { value: new Vector2() },
      uB: { value: new Vector2() },
      uRadius: { value: 1 },
      uAlpha: { value: 1 },
      uDepth: { value: occluder ? 0 : 1 },
    },
    vertexShader: quadVertex,
    fragmentShader: quadFragment,
    depthTest: occluder,
    depthWrite: false,
    transparent: occluder,
    blending: occluder ? NormalBlending : NoBlending,
    toneMapped: false,
  });
}

type ProgramState = { programs?: Map<string, { isReady(): boolean }> };

export type ArCompositorOptions = ArTrackerOptions & {
  /**
   * Flip the finished composite for display, like a mirror (default true). Presentation only:
   * the solve, the alignment and every overlay are computed in unflipped source pixels.
   */
  mirrorDisplay?: boolean;
  /** Cap on the device pixel ratio. Default 1.5. */
  maxPixelRatio?: number;
};

/**
 * Finishing seam (agent V4, engine/live/ar/finish/**): called after the warp with the warped
 * jacket and the frame's inputs. It composites onto the canvas (current target null, video
 * already drawn) and returns true; false (or no finisher) = this compositor's own composite.
 * Shape agreed through the lead; inputs are read-only.
 */
export interface ArFinisher {
  setStillState?(state: { readonly still: boolean } | null): void;
  /** F4: the scene light the finisher measured on the face (finish/light.ts), or null. */
  readonly light?: LightEstimate | null;
  /** F4: the shown product's colour (#rrggbb), set by the compositor each frame. */
  garmentColour?: string | null;
  apply(
    renderer: WebGLRenderer,
    input: {
      /** Warped jacket, canvas size: premultiplied LINEAR colour + alpha (not tone mapped). */
      warped: WebGLRenderTarget;
      /** The unwarped jacket render (colour + alpha), same size, for depth-free effects. */
      jacket: WebGLRenderTarget;
      /** The source video frame (sRGB). */
      video: Texture;
      /** Person segmentation (0..1, row 0 = top) at its own size, or null. */
      personMask: LiveFrame['mask'];
      /** MediaPipe landmarks (source px) of this frame, or null. */
      landmarks: LiveFrame['landmarks2d'];
      /** Source size; `t` = LiveFrame.t (F4: pairs a class mask with its own frame). */
      frame: { width: number; height: number; t?: number };
      /**
       * F4: the source <video> element itself (under poseSync `video` is the painted frame), for
       * its 'posecapture' event (F2, trackedSource.ts).
       */
      sourceVideo?: HTMLVideoElement | null;
      /** The exposure this compositor would use (video-matched), for the tone mapping. */
      exposure: number;
      /** Real-hand capsules (source px) the compositor would draw over the jacket. */
      hands: HandCapsule[];
    },
  ): boolean;
  dispose?(): void;
}

export type ArStatus = 'idle' | 'preparing' | 'drawn' | 'no-person' | 'no-video';

export class ArCompositor implements ArRenderer {
  readonly tracker: ArTracker;
  renderer?: WebGLRenderer;
  /** What the last render() did, for the UI and the lab. */
  status: ArStatus = 'idle';
  /** Hand capsules of the last frame (lab overlay). */
  lastHands: HandCapsule[] = [];
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera();
  private readonly lend = new Group();
  private readonly quadCamera = new PerspectiveCamera();
  private readonly background: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly occluder: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly quadScene = new Scene();
  private readonly occluderScene = new Scene();
  private readonly fadeScene = new Scene();
  private readonly fadeQuad: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly depthOnly = new MeshBasicMaterial({
    colorWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: BODY_DEPTH_OFFSET.factor,
    polygonOffsetUnits: BODY_DEPTH_OFFSET.units,
  });
  private videoTexture?: Texture;
  private maskTexture?: DataTexture;
  private maskBytes?: Uint8Array;
  private container?: HTMLElement;
  private wrapper?: HTMLDivElement;
  private badge?: HTMLDivElement;
  private video: HTMLVideoElement | null = null;
  private observer?: ResizeObserver;
  private environment?: { texture: Texture; dispose(): void };
  private ready = new WeakSet<Material>();
  private compiling = false;
  private frameSize = { width: 0, height: 0 };
  private mirrorDisplay: boolean;
  /**
   * The flipped-for-display stage holding the canvas (CSS scaleX(−1) when mirrorDisplay). Lab
   * overlays go in here, drawn in source-pixel coordinates scaled to the stage, so they flip with it.
   */
  stage?: HTMLDivElement;
  private readonly maxPixelRatio: number;
  private laidOut?: { key: string; cw: number; ch: number };
  /** The jacket in the kiosk's GarmentLayer look (when the posed scene is a LiveAvatar). */
  private kiosk?: ArKioskJacket;
  /** Depth-only torso/arms/head of the posed body (occluder.ts), sharing its positions. */
  private bodyOccluder?: { source: BufferGeometry; mesh: Mesh<BufferGeometry, MeshBasicMaterial> };
  private lastT?: number;
  /** True when the last drawn jacket was the kiosk-look one. */
  kioskLook = false;
  /** F4 flags (finish/f4.ts: ?f4res=1 render resolution, ?f4light=1 measured light rig). */
  f4: F4Flags = readF4Flags();
  /** F3 flags (f3Flags.ts: ?f3warp=1 bounded glue warp, ?f3arms=1 sleeve path, ?f3depth=1). */
  readonly f3: F3Flags = readF3Flags();
  /**
   * F3X (?f3x=1, default OFF; sleeveAnchor.ts + armOccluder.ts, defect D3): the sleeve layers as
   * rigid pieces on the real arm, ordered round the torso layer. Undefined = the current path.
   */
  private readonly f3x = createF3x();
  /** F4X flags (f4x.ts: ?f4xwarm=1 cold start of the kiosk-look jacket). */
  private readonly f4x = readF4xFlags();
  /** The light rig (kept for F4's measured-light hookup). */
  private readonly rig: {
    key: DirectionalLight;
    fill: DirectionalLight;
    rim: DirectionalLight;
    hemisphere: HemisphereLight;
  };
  /** F4 readout: the rig applied on the last frame (null = the kiosk rig). */
  f4LightState: VenueRig | null = null;

  constructor(options: ArCompositorOptions = {}) {
    this.tracker = new ArTracker(options);
    // V4's finishing pass (coverage over the real clothes, closed cuffs with the real hands,
    // feather, contact shadow, exposure/WB from the face) is wired but OFF by default
    // (`useFinisher`): it cost ~100 ms/frame here (5 fps). It allocates nothing until its first
    // apply() and loads its selfie segmenter lazily (CPU).
    this.finisher ??= new ArFinish();
    this.mirrorDisplay = options.mirrorDisplay ?? true;
    this.maxPixelRatio = options.maxPixelRatio ?? 1.5;
    this.background = new Mesh(new PlaneGeometry(2, 2), quadMaterial(false));
    this.background.frustumCulled = false;
    this.quadScene.add(this.background);
    // The fade: the video drawn back over the jacket with alpha = solution.fade.
    const fadeMaterial = quadMaterial(false);
    fadeMaterial.transparent = true;
    fadeMaterial.blending = NormalBlending;
    this.fadeQuad = new Mesh(new PlaneGeometry(2, 2), fadeMaterial);
    this.fadeQuad.frustumCulled = false;
    this.fadeScene.add(this.fadeQuad);
    this.occluder = new Mesh(new PlaneGeometry(2, 2), quadMaterial(true));
    this.occluder.frustumCulled = false;
    this.occluderScene.add(this.occluder);
    this.lend.matrixAutoUpdate = false;
    this.scene.add(this.lend);
    // The kiosk viewer's light rig (Viewer.ts): neutral white key (with its soft shadow), fill and
    // rim, soft room IBL. The Viewer's GTAO pass is not run in AR (see docs/STATUS-tryon-ar.md).
    const key = new DirectionalLight(0xffffff, 2.2);
    key.position.set(-2, 4, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = key.shadow.camera.bottom = -2;
    key.shadow.camera.right = key.shadow.camera.top = 2;
    key.shadow.normalBias = 0.001;
    key.shadow.radius = 4;
    const fill = new DirectionalLight(0xf4f6ff, 0.42);
    fill.position.set(3, 2, 1);
    const rim = new DirectionalLight(0xffffff, 1.1);
    rim.position.set(0, 3, -3);
    const hemisphere = new HemisphereLight(0xffffff, 0x8a8885, 0.18);
    this.scene.add(key, fill, rim, hemisphere);
    this.rig = { key, fill, rim, hemisphere };
    this.tinted = [
      { light: key, base: key.color.clone() },
      { light: fill, base: fill.color.clone() },
      { light: rim, base: rim.color.clone() },
    ];
    this.camera.matrixAutoUpdate = false;
    // F3 (?f3arms=1): the arm fit picks its ray–sphere branches by MediaPipe's world depth.
    this.screenFit.depthPrior = this.f3.arms;
    // F3 (?f3shoulder=1): the dropped shoulder's cap is drawn with its sleeve (sleeveLayers.ts).
    this.sleeves.dropCapToSleeve = this.f3.shoulder;
    // F3: the sleeve caps are NOT drawn in the torso layer any more (sleeveLayers capInTorso
    // stays off): when the sleeve moved off them they stood out as a flap/ledge at the shoulder
    // (RC3 judge worst10 #3-#6, #9-#10); the notch is covered by the torso occluder subset.
    if (this.f3.depth) {
      // F3 (?f3depth=1, D5/D3): the depth-only body moves F3_BODY_PUSH_M further from the lens
      // along each view ray; its silhouette is unchanged (f3Flags.ts).
      this.depthOnly.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader.replace(
          '#include <project_vertex>',
          `#include <project_vertex>
          mvPosition.xyz += normalize(mvPosition.xyz) * ${F3_BODY_PUSH_M.toFixed(4)};
          gl_Position = projectionMatrix * mvPosition;`,
        );
      };
      this.depthOnly.customProgramCacheKey = () => `f3push${F3_BODY_PUSH_M}`;
    }
  }

  get alignment(): number | null {
    return this.tracker.alignment;
  }

  /**
   * Mirror the displayed composite (contract LiveTryOn.setMirrorDisplay). Presentation only: the
   * solve, alignment and overlays stay in unflipped source pixels.
   */
  setMirrorDisplay(on: boolean) {
    this.mirrorDisplay = on;
    if (this.stage) this.stage.style.transform = on ? 'scaleX(-1)' : '';
  }

  /**
   * Collar readout + guard: the drawn collar top vs the mouth line (px, + = below the mouth),
   * whether the guard moved the jacket down this frame, and counts since attach.
   */
  collar: {
    marginPx: number | null;
    shiftPx: number;
    clamped: boolean;
    frames: number;
    triggered: number;
    /** Collar top − chin estimate before / after the chin target, cm (eye-spacing scale); + = below. */
    chinBeforeCm: number | null;
    chinAfterCm: number | null;
    /** The learned vertical offset of the drawn jacket (m, + = down). */
    targetOffsetM: number;
    /** The face point the collar top is aimed at (per product, config COLLAR_TARGET_FROM_MOUTH). */
    target: CollarTargetKind;
  } = {
    marginPx: null,
    shiftPx: 0,
    clamped: false,
    frames: 0,
    triggered: 0,
    chinBeforeCm: null,
    chinAfterCm: null,
    targetOffsetM: 0,
    target: 'chin',
  };
  private collarOffsetM = 0;
  /** F3 (?f3arms=1, D3 flicker): real-hand capsules held through landmark dropouts (handHold.ts). */
  private readonly handHoldFinish = new HandHold();
  private readonly handHoldOwn = new HandHold();
  /** F3 (?f3collar=1): the collar-front drop applied to the drawn jacket (m). */
  f3CollarDrop = 0;
  collarTarget = true;
  private collarShift = 0;
  collarGuard = true;

  /** The visible collar top near the front centre line (scene m), or null (anchors.ts). */
  private collarTop(scene: LivePosedScene): Vec3 | null {
    if (!isKioskJacketSource(scene)) return null;
    const p = scene.jacketPositions();
    const asset = scene.jacketAsset;
    const ms = scene.joints.midShoulder ?? scene.joints.lShoulder;
    if (!p || !ms || !asset) return null;
    return visibleCollarTop(p, asset, ms, COLLAR_HALF_WIDTH_M);
  }

  /** The face point this product's collar top is aimed at (anchors.ts collarTargetKind). */
  private collarTargetKind(scene: LivePosedScene): CollarTargetKind {
    return collarTargetKind(isKioskJacketSource(scene) ? scene.jacketAsset : undefined);
  }

  /**
   * Collar guard: returns the solution to draw (moved down when the collar top projects above
   * the mouth line) and updates the readout.
   */
  private guardCollar(
    frame: LiveFrame,
    scene: LivePosedScene,
    s: ArSolution,
    dt: number,
  ): ArSolution {
    const l = frame.landmarks2d;
    const top = this.collarTop(scene);
    const m9 = l?.[9],
      m10 = l?.[10],
      nose = l?.[0],
      e2 = l?.[2],
      e5 = l?.[5];
    let excess = 0;
    this.collar.marginPx = null;
    this.collar.chinBeforeCm = null;
    this.collar.chinAfterCm = null;
    const z0 = s.pose.t[2];
    const pxPerM = s.intrinsics.f / z0;
    const face =
      top &&
      m9 &&
      m10 &&
      nose &&
      Math.min(m9.visibility, m10.visibility, nose.visibility) >= MIN_VISIBILITY;
    const kind = this.collarTargetKind(scene);
    this.collar.target = kind;
    // The collar target moves the whole drawn jacket: with the glue on, the glue re-pins the
    // shoulders and only the hem stretches (puffer: residual 3.7 → 4.8 px, cap bound ~100 %), so
    // the target is used only without the glue (lead, 18:00). Registration comes from the body.
    const targetOn = this.collarTarget && !this.glue;
    if (face) {
      const [, v, z] = project(s.intrinsics, s.pose, s.pivot, top);
      const mouth = (m9.y + m10.y) / 2;
      if (z > 0.3 && Number.isFinite(v) && Math.abs(v - mouth) < frame.height) {
        // Collar target: learn the vertical offset that puts the collar top on this product's
        // face point (chin or lower lip; the `chin*Cm` readouts are relative to that point).
        const chin = mouth + COLLAR_TARGET_FROM_MOUTH[kind] * Math.max(0, mouth - nose.y);
        const cmPerPx =
          e2 && e5 && Math.min(e2.visibility, e5.visibility) >= MIN_VISIBILITY
            ? (EYE_SPACING_M * 100) / Math.max(1, Math.hypot(e2.x - e5.x, e2.y - e5.y))
            : 100 / pxPerM;
        this.collar.chinBeforeCm = (v - chin) * cmPerPx;
        const facing = Math.abs(s.pose.yaw) < 15 * (Math.PI / 180);
        if (targetOn && facing) {
          const want = Math.max(
            -COLLAR_TARGET_MAX_M,
            Math.min(COLLAR_TARGET_MAX_M, (chin - v) / pxPerM),
          );
          const b = dt > 0 ? 1 - Math.exp(-dt / COLLAR_TARGET_TAU_S) : 0.2;
          this.collarOffsetM += b * (want - this.collarOffsetM);
        }
        // F3 (?f3collar=1, D7): the drawn collar is lowered round the front and sides
        // (collarFit.ts) so its top never stands above the chin (lead 19:2x: the real puffer is
        // worn open, the whole face, chin and part of the neck visible). A hard ceiling: the
        // drop rises at once to what this frame's face needs (any pose with the mouth and nose
        // seen: still, arms up, turn); it eases back only while moving, and holds when still.
        if (this.f3.collar) {
          const chinF3 = mouth + F3_CHIN_FROM_MOUTH * Math.max(0, mouth - nose.y);
          const want = Math.max(0, Math.min(F3_COLLAR_MAX_DROP_M, (chinF3 - v) / pxPerM));
          if (want > this.f3CollarDrop) this.f3CollarDrop = want;
          else if (!this.stillFrame(frame).still) {
            const b = dt > 0 ? 1 - Math.exp(-dt / F3_COLLAR_TAU_S) : 1;
            this.f3CollarDrop += b * (want - this.f3CollarDrop);
          }
        }
        const vAfter =
          v +
          ((targetOn ? this.collarOffsetM : 0) +
            // the drop the drawn jacket actually has (0 without a funnel collar, e.g. the parka)
            (this.f3.collar ? (this.kiosk?.collarDropApplied ?? 0) : 0)) *
            pxPerM;
        this.collar.chinAfterCm = (vAfter - chin) * cmPerPx;
        this.collar.marginPx = vAfter - mouth; // + = the collar top is below the mouth line
        const over = Math.max(0, mouth - vAfter);
        // With the glue and a good registration, collar height is the garment's truth: the
        // guard acts only on gross misregistration (over the mouth line by more than
        // COLLAR_GUARD_GLUE_CM.over), by at most COLLAR_GUARD_GLUE_CM.shift (lead, 18:00).
        // Registration = the torso joints (the arms are fitted separately; on the puffer video
        // the full score was 0.37–0.40 from the arms alone and let the old guard drag the jacket).
        const strict =
          this.glue && (torsoAlignmentScore(s.alignment) ?? 0) >= COLLAR_GUARD_GLUE_MIN_ALIGNMENT;
        excess = strict
          ? Math.min(
              COLLAR_GUARD_GLUE_CM.shift / cmPerPx,
              Math.max(0, over - COLLAR_GUARD_GLUE_CM.over / cmPerPx),
            )
          : Math.min(COLLAR_GUARD_MAX_FRACTION * frame.height, over);
      }
    }
    this.collar.targetOffsetM = targetOn ? this.collarOffsetM : 0;
    if (this.kiosk) this.kiosk.collarDrop = this.f3.collar ? this.f3CollarDrop : 0;
    const a = dt > 0 ? 1 - Math.exp(-dt / COLLAR_GUARD_TAU_S) : 1;
    this.collarShift += a * ((this.collarGuard ? excess : 0) - this.collarShift);
    this.collar.frames++;
    this.collar.clamped = excess > 0.5;
    if (this.collar.clamped) this.collar.triggered++;
    this.collar.shiftPx = this.collarShift;
    const down = this.collar.targetOffsetM + (this.collarShift * z0) / s.intrinsics.f;
    if (Math.abs(down) < 1e-4) return s;
    const t: Vec3 = [s.pose.t[0], s.pose.t[1] + down, z0];
    return { ...s, pose: { ...s.pose, t } };
  }

  /** Exposure / white-balance match (config MATCH_*); lab toggle and readout. */
  videoMatch = true;
  match = {
    exposure: 0.92,
    tint: [1, 1, 1] as [number, number, number],
    luma: null as number | null,
  };
  private tinted: { light: DirectionalLight; base: import('three').Color }[] = [];
  private matchCanvas?: HTMLCanvasElement;
  private matchFrames = 0;
  private matchT?: number;

  private matchVideo(frame: LiveFrame) {
    const renderer = this.renderer,
      video = this.video;
    if (!renderer || !video || video.readyState < 2) return;
    // With V4's finisher in use the lights stay neutral: it white-balances and exposes from the
    // face skin. Tinting by the torso's mean colour tinted the jacket by the person's own clothes
    // (a red T-shirt → a reddish parka; a dark hoodie → a dark jacket).
    if (!this.videoMatch || (this.finisher && this.useFinisher)) {
      renderer.toneMappingExposure = 0.92;
      for (const t of this.tinted) t.light.color.copy(t.base);
      return;
    }
    if (this.matchFrames++ % MATCH_EVERY_FRAMES) return;
    const l = frame.landmarks2d;
    const W = 48,
      H = Math.max(1, Math.round((48 * frame.height) / Math.max(1, frame.width)));
    this.matchCanvas ??= document.createElement('canvas');
    const c = this.matchCanvas;
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, W, H);
    // The torso box (shoulders–hips) when tracked, else the middle third of the frame.
    let x0 = W / 3,
      x1 = (2 * W) / 3,
      y0 = H / 3,
      y1 = (2 * H) / 3;
    if (l && [11, 12, 23, 24].every((i) => l[i]?.visibility >= MIN_VISIBILITY)) {
      const xs = [11, 12, 23, 24].map((i) => (l[i].x / frame.width) * W),
        ys = [11, 12, 23, 24].map((i) => (l[i].y / frame.height) * H);
      x0 = Math.min(...xs);
      x1 = Math.max(...xs);
      y0 = Math.min(...ys);
      y1 = Math.max(...ys);
    }
    const ix0 = Math.max(0, Math.floor(x0)),
      iy0 = Math.max(0, Math.floor(y0));
    const iw = Math.max(1, Math.min(W - ix0, Math.ceil(x1 - x0))),
      ih = Math.max(1, Math.min(H - iy0, Math.ceil(y1 - y0)));
    const px = ctx.getImageData(ix0, iy0, iw, ih).data;
    let r = 0,
      g = 0,
      b = 0;
    for (let i = 0; i < px.length; i += 4) {
      r += px[i];
      g += px[i + 1];
      b += px[i + 2];
    }
    const n = px.length / 4 || 1;
    r /= n * 255;
    g /= n * 255;
    b /= n * 255;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const target = Math.min(
      MATCH_EXPOSURE_RANGE[1],
      Math.max(MATCH_EXPOSURE_RANGE[0], 0.92 * Math.pow(luma / MATCH_REFERENCE_LUMA, MATCH_GAMMA)),
    );
    const mean = (r + g + b) / 3 || 1;
    const cast: [number, number, number] = [r / mean, g / mean, b / mean].map(
      (v) => 1 + MATCH_TINT * (v - 1),
    ) as [number, number, number];
    const dt = this.matchT === undefined ? 1e9 : Math.max(0, (frame.t - this.matchT) / 1000);
    this.matchT = frame.t;
    const a = 1 - Math.exp(-dt / MATCH_TAU_S);
    this.match.exposure += a * (target - this.match.exposure);
    this.match.tint = this.match.tint.map((v, i) => v + a * (cast[i] - v)) as [
      number,
      number,
      number,
    ];
    this.match.luma = luma;
    renderer.toneMappingExposure = this.match.exposure;
    for (const t of this.tinted)
      t.light.color.setRGB(
        t.base.r * this.match.tint[0],
        t.base.g * this.match.tint[1],
        t.base.b * this.match.tint[2],
      );
  }

  /**
   * Hybrid "glue" (lead/user decision): the rendered jacket is warped so its keypoints land on the
   * person's. Lab toggle. Visual only: every fit number comes from the 3D.
   */
  glue = true;
  glueRenderer?: ArGlue;
  /** Sleeve layers (sleeveLayers.ts): torso and each sleeve warped separately. Lab toggle. */
  layeredSleeves = true;
  private readonly sleeves = new SleeveLayers();
  private sleeveGlue?: { sleeveL: ArGlue; sleeveR: ArGlue };
  private readonly shadowDummy = new WebGLRenderTarget(1, 1);
  /** This frame's smoothed glue landmarks (shared by the torso and sleeve controls; lab lag). */
  glueLandmarks: { x: number; y: number; visibility: number }[] | null = null;
  /** Whether the last frame was drawn with sleeve layers. */
  layeredLast = false;

  /** Controls of one sleeve: shoulder anchored where the torso warp put it; elbow, wrist → landmarks. */
  private sleeveControls(
    scene: LivePosedScene,
    s: ArSolution,
    side: 'L' | 'R',
    torso: ArGlue,
  ): Control[] {
    const l = this.glueLandmarks;
    if (!l) return [];
    const joints = this.jointsOf(scene);
    const lower = side.toLowerCase();
    const K = s.intrinsics;
    const S = joints[`${lower}Shoulder`],
      E = joints[`${lower}Elbow`],
      Wr = joints[`${lower}Wrist`];
    if (!S) return [];
    const out: Control[] = [];
    const [su, sv, sz] = project(K, s.pose, s.pivot, S);
    if (sz <= 0.3) return [];
    // The armhole goes wherever the torso warp sent it: the sleeve stays attached.
    out.push({
      p: [su, sv],
      q: torso.mapPoint([su, sv]),
      importance: 2,
      name: `${lower}SleeveShoulder`,
    });
    const W = this.frameSize.width,
      H = this.frameSize.height;
    for (const [X, i, name] of [
      [E, side === 'L' ? 13 : 14, `${lower}Elbow`],
      [Wr, side === 'L' ? 15 : 16, `${lower}Wrist`],
    ] as const) {
      const p = l[i];
      if (!X || !p || p.visibility < MIN_VISIBILITY || p.x < 0 || p.y < 0 || p.x > W || p.y > H)
        continue;
      const [u, v, z] = project(K, s.pose, s.pivot, X);
      if (z > 0.3) out.push({ p: [u, v], q: [p.x, p.y], importance: 1.5, name });
    }
    // F3 (?f3arms=1): controls along each bone (thirds of shoulder→elbow and elbow→wrist), so the
    // rigid MLS moves each segment as a whole instead of bending the sleeve between point pins.
    if (this.f3.arms) {
      const chain = ['Shoulder', 'Elbow', 'Wrist'].map((j) =>
        out.find((c) => c.name === (j === 'Shoulder' ? `${lower}SleeveShoulder` : `${lower}${j}`)),
      );
      for (let k = 0; k + 1 < chain.length; k++) {
        const a = chain[k],
          b = chain[k + 1];
        if (!a || !b) continue;
        for (const f of [1 / 3, 2 / 3])
          out.push({
            p: [a.p[0] + f * (b.p[0] - a.p[0]), a.p[1] + f * (b.p[1] - a.p[1])],
            q: [a.q[0] + f * (b.q[0] - a.q[0]), a.q[1] + f * (b.q[1] - a.q[1])],
            importance: 1,
          });
      }
    }
    return out;
  }

  /**
   * The person's whole-body heading, degrees in (−180, 180]: 0 = facing the camera, + = turned to
   * their left, ±180 = back to the camera (the back-view detector resolves front/back); null when
   * not tracked. Read-only, for V6's LiveDeformContext.rootYawDeg.
   */
  get bodyHeadingDeg(): number | null {
    return this.tracker.headingDeg;
  }

  /** True when the finisher composited the last frame (then it also drew the real hands). */
  finishedLast = false;

  /** Hands the warped layers to V4's finisher; true when it composited. */
  private finish(
    renderer: WebGLRenderer,
    frame: LiveFrame,
    drawn: ArSolution,
    joints: LivePosedScene['joints'],
    torso: ArGlue,
    sleeves: ArGlue[],
  ) {
    const finisher = this.useFinisher ? this.finisher : undefined;
    if (!finisher || !this.videoTexture) return false;
    finisher.setStillState?.(this.stillFrame(frame));
    return finisher.apply(renderer, {
      warped: this.f3x?.compose(renderer, torso, sleeves) ?? torso.warpTo(renderer, sleeves),
      jacket: torso.target,
      video: this.videoTexture,
      personMask: frame.mask,
      landmarks: frame.landmarks2d,
      frame: { width: frame.width, height: frame.height, t: frame.t },
      sourceVideo: this.video,
      exposure: renderer.toneMappingExposure,
      hands: this.f3xHands(
        this.f3.arms
          ? this.handHoldFinish.update(
              frame.t,
              handCapsules(frame, drawn, joints),
              frame.landmarks2d,
            )
          : handCapsules(frame, drawn, joints),
      ),
    });
  }

  /** F3X: the hands the finisher may draw (a hand on the other arm's sleeve is cut there). */
  private f3xHands(hands: HandCapsule[]) {
    return this.f3x?.filterHands(hands) ?? hands;
  }

  /**
   * V4's finisher (seam above); used when set and `useFinisher`. Default ON again (V4, lead's
   * condition): the segmenter moved to a worker and the colour statistics to async readbacks;
   * apply() measured 0.33–0.38 ms/frame on the main thread (CPU + GPU 0.35–0.38 ms with
   * gl.finish, 521×293 canvas), AR fps with and without it within noise
   * (docs/validation/ar-finish-v4.json). Before: ~110 ms/frame (5 fps).
   */
  finisher?: ArFinisher;
  useFinisher = true;
  /**
   * Glue control groups (lab experiments). The collar→chin control is OFF: it squashed the small
   * collar-to-shoulder region by 25–75 % and made the ±15 % cap bind on every frame (cam-tshirt
   * 94/94); the collar height is handled by the global chin target (guardCollar).
   * Torso-cap fixes (A/B switches for the lab; the driver was coverage, not the hem):
   *  coverTorso: coverage takes the jacket's side edge from the TORSO panels only (the sleeves
   *    are their own layers; a hanging sleeve's outer edge was pushed by the torso warp);
   *  coverClamp: the person's edge walk stops at the shoulder landmarks' span + ease (a hanging
   *    arm touching the torso is not torso: the walk ran out to the arm's outer edge);
   *  hemFollow: the hem anchors move with the hips' mean displacement (translation only) instead
   *    of staying fixed while the hips move (the band between them stretched past the cap).
   */
  glueGroups = {
    torso: true,
    arms: true,
    collar: false,
    coverage: true,
    hem: true,
    // Measured (cam-parka facing 1.5–4 s, 14 fps): cap bound 55/56 → 12/54 frames, post-glue
    // residual 4.5 ± 6.5 → 0.5 ± 2.3 px with coverTorso + coverClamp. hemFollow changed nothing
    // (46/48 bound alone): off.
    coverTorso: true,
    coverClamp: true,
    hemFollow: false,
    /**
     * Contour fit (lead, 2026-11-13; config CONTOUR_*): replaces coverage. The 3D body's torso
     * silhouette is registered to the person mask's edge on CONTOUR_ROWS and the jacket keeps
     * its 3D ease outside it (contour.ts). Measured (lab, 2026-11-13): outline error before →
     * after the warp cam-tshirt 8.3 → 1.1 px, cam-parka 16.6 → 1.6 px, puffer video 28.3 → 4.7 px;
     * 0.3–0.6 ms; outline step not worse (cam-tshirt 2.3–2.8 vs 3.6–5.0 px/frame).
     */
    contour: true,
  };
  private contourHold = new ContourHold(CONTOUR_DEADBAND_PX, CONTOUR_CAP_PX);
  /** Last frame's contour fit: outline error vs the targets before / after the warp, px. */
  contour: { sides: number; beforePx: number | null; afterPx: number | null; ms: number } = {
    sides: 0,
    beforePx: null,
    afterPx: null,
    ms: 0,
  };
  private contourSides: ContourSide[] = [];
  private torsoVertices?: { rig: object; ids: Uint32Array };
  /**
   * ?f1glue=1 (agent F1, D9): glue target filters with a fast derivative cutoff (F1STAB_GLUE). Split
   * from ?f1stab=1 (the landmark gate) before RC1 so the two are judged apart.
   */
  private readonly f1glue = f3Flag(
    typeof location === 'undefined' ? '' : location.search,
    'f1glue',
  );
  private glueTargets = new OneEuroVecFilter(
    66,
    this.f1glue ? F1STAB_GLUE.torso : SMOOTH_GLUE_TARGETS,
  );
  private glueArmTargets = new OneEuroVecFilter(
    66,
    this.f1glue ? F1STAB_GLUE.arms : SMOOTH_GLUE_ARMS,
  );
  /** Held spread (px) of the glue's torso targets about their centroid (size hold). */
  private glueSize?: number;
  private overlayTag?: HTMLDivElement;

  /** Controls of the glue: rendered keypoint (px, from the 3D) → the person's (px). */
  /** The contour outline error after the warp: |warped jacket edge − target| per side, px. */
  private contourAfter(glue: ArGlue) {
    const sides = this.contourSides;
    if (!sides.length) return;
    let after = 0;
    for (const c of sides) after += Math.abs(glue.mapPoint(c.jacket)[0] - c.targetX);
    this.contour.afterPx = after / sides.length;
  }

  /** Posed-body vertices of the torso (not arms, hands or legs), per rig. */
  private torsoIds(rig: MotionRig): Uint32Array {
    if (this.torsoVertices?.rig === rig) return this.torsoVertices.ids;
    const limb = /^(upperarm|lowerarm|wrist|finger|metacarpal|upperleg|lowerleg|foot|toe)/;
    const excluded = rig.bones.map((b) => limb.test(b));
    const K = rig.influences;
    const ids: number[] = [];
    for (let v = 0; v < rig.vertexCount; v++) {
      let w = 0;
      for (let k = 0; k < K; k++)
        if (excluded[rig.skinIndices[v * K + k]]) w += rig.skinWeights[v * K + k];
      if (w < 0.5) ids.push(v);
    }
    this.torsoVertices = { rig, ids: Uint32Array.from(ids) };
    return this.torsoVertices.ids;
  }

  /** Contour-fit controls (contour.ts) for the torso warp; updates `this.contour`. */
  private contourControls(
    frame: LiveFrame,
    scene: LivePosedScene,
    s: ArSolution,
    l: { x: number; y: number; visibility: number }[],
  ): Control[] {
    const started = performance.now();
    const mask = frame.mask;
    if (!mask || !isKioskJacketSource(scene)) return [];
    const pos = scene.jacketPositions();
    const panels = scene.jacketAsset?.panels;
    const rig = (scene as { live?: { rig?: MotionRig } }).live?.rig;
    const arrays = (scene as { bodyArrays?: () => { positions: Float32Array } }).bodyArrays;
    const body = arrays ? arrays.call(scene).positions : undefined;
    const ls = l[11],
      rs = l[12],
      lh = l[23],
      rh = l[24];
    if (
      !pos ||
      !panels ||
      panels.length !== pos.length / 3 ||
      !rig ||
      !body ||
      body.length !== rig.vertexCount * 3 ||
      ![ls, rs, lh, rh].every((p) => p.visibility >= MIN_VISIBILITY)
    )
      return [];
    const K = s.intrinsics;
    const R = rotation(s.pose);
    const project2 = (x: number, y: number, z: number, into: number[]) => {
      const c = toCamera(R, s.pose.t, s.pivot, [x, y, z]);
      if (c[2] > 0.3) into.push((K.f * c[0]) / c[2] + K.cx, (K.f * c[1]) / c[2] + K.cy);
    };
    const jacket: number[] = [];
    for (let i = 0; i < pos.length; i += 6) {
      const p = panels[i / 3];
      if (p >= PANEL.frontL && p <= PANEL.yoke) project2(pos[i], pos[i + 1], pos[i + 2], jacket);
    }
    const torso: number[] = [];
    const ids = this.torsoIds(rig);
    for (let k = 0; k < ids.length; k += 2) {
      const v = ids[k] * 3;
      project2(body[v], body[v + 1], body[v + 2], torso);
    }
    const sy = (ls.y + rs.y) / 2,
      hy = (lh.y + rh.y) / 2;
    const rows = CONTOUR_ROWS.map((f) => sy + f * (hy - sy));
    const pxPerM = K.f / s.pose.t[2];
    const ease = GLUE_EASE_M * pxPerM;
    const sideReach = this.f3.side
      ? F3_TORSO_HALF_DEPTH_M * pxPerM * Math.min(1, Math.abs(Math.sin(s.pose.yaw)))
      : 0;
    const arm = (a: number, b: number, c: number) =>
      [l[a], l[b], l[c]]
        .filter((p) => p.visibility >= MIN_VISIBILITY)
        .map((p) => [p.x, p.y] as [number, number]);
    const sides = contourTargets({
      rows,
      band: Math.max(2, 0.015 * frame.height),
      jacket,
      body: torso,
      mask,
      width: frame.width,
      height: frame.height,
      // F3 (?f3side=1, U5 uncovered at 3/4, side and back): the person-edge walk may reach as far
      // as the hips and the torso's projected depth at this yaw, so the front and back edges
      // of a turned person are found (the shoulders alone overlap in x at a side view).
      minX: Math.min(ls.x, rs.x, ...(this.f3.side ? [lh.x, rh.x] : [])) - ease - sideReach,
      maxX: Math.max(ls.x, rs.x, ...(this.f3.side ? [lh.x, rh.x] : [])) + ease + sideReach,
      arms: [arm(11, 13, 15), arm(12, 14, 16)],
      armRadius: CONTOUR_ARM_RADIUS_M * pxPerM,
    });
    this.contourSides = sides;
    const out: Control[] = [];
    let before = 0;
    for (const c of sides) {
      const want = c.targetX - c.jacket[0];
      before += Math.abs(want);
      const shift = this.contourHold.apply(`${c.side}${c.index}`, want);
      out.push({
        p: c.jacket,
        q: [c.jacket[0] + shift, c.jacket[1]],
        importance: 0.7,
        name: `contour${c.side}${c.index}`,
      });
    }
    this.contour = {
      sides: sides.length,
      beforePx: sides.length ? before / sides.length : null,
      afterPx: null,
      ms: performance.now() - started,
    };
    return out;
  }

  private glueControls(
    frame: LiveFrame,
    scene: LivePosedScene,
    s: ArSolution,
    withArms = true,
  ): Control[] {
    const raw = frame.landmarks2d;
    if (!raw || raw.length !== 33) return [];
    const xy = new Array<number>(66);
    for (let i = 0; i < 33; i++) {
      xy[i * 2] = raw[i].x;
      xy[i * 2 + 1] = raw[i].y;
    }
    const f = this.glueTargets.filter(xy, frame.t);
    const fa = this.glueArmTargets.filter(xy, frame.t);
    const armIndex = new Set([13, 14, 15, 16]);
    const l = raw.map((p, i) => {
      const src = armIndex.has(i) ? fa : f;
      return { x: src[i * 2], y: src[i * 2 + 1], visibility: p.visibility };
    });
    this.glueLandmarks = l;
    // Shoulder controls use the same landmark-matched points as the solve (landmarkJoints).
    const joints = this.landmarkJoints(scene, this.jointsOf(scene));
    const K = s.intrinsics;
    const spread = this.tracker.landmarkSpread;
    const W = frame.width,
      H = frame.height;
    const inFrame = (x: number, y: number) => x >= 0 && y >= 0 && x <= W && y <= H;
    const out: Control[] = [];
    // Shoulders and hips: MediaPipe's definition sits inside the rig's joints by the learned
    // spread, so the rendered point that corresponds to the landmark is the spread-scaled joint.
    const add = (name: string, index: number, sx: number, importance = 1) => {
      const X = joints[name],
        p = l[index];
      if (!X || !p || p.visibility < MIN_VISIBILITY || !inFrame(p.x, p.y)) return;
      const [u, v, z] = project(K, { ...s.pose, sx }, s.pivot, X);
      if (z <= 0.3) return;
      out.push({ p: [u, v], q: [p.x, p.y], importance, name });
    };
    const g = this.glueGroups;
    if (g.torso) {
      const first = out.length;
      add('lShoulder', 11, spread);
      add('rShoulder', 12, spread);
      // ?f1close=1: hips the solve did not use (MediaPipe's guess past the frame edge) are not
      // glued either; the hem is simply cropped by the frame.
      if (s.hipsSeen !== false) {
        add('lHip', 23, spread);
        add('rHip', 24, spread);
      }
      // Size hold: the torso targets' spread about their centroid changes only beyond the
      // backlash; the centroid (position) follows every frame.
      const torso = out.slice(first);
      if (torso.length >= 2) {
        const cx = torso.reduce((a, c) => a + c.q[0], 0) / torso.length,
          cy = torso.reduce((a, c) => a + c.q[1], 0) / torso.length;
        const size = Math.sqrt(
          torso.reduce((a, c) => a + (c.q[0] - cx) ** 2 + (c.q[1] - cy) ** 2, 0) / torso.length,
        );
        let held = this.glueSize ?? size;
        if (size > held * (1 + GLUE_SIZE_DEADBAND)) held = size / (1 + GLUE_SIZE_DEADBAND);
        else if (size < held * (1 - GLUE_SIZE_DEADBAND)) held = size / (1 - GLUE_SIZE_DEADBAND);
        this.glueSize = held;
        const k = size > 1e-6 ? held / size : 1;
        for (const c of torso) c.q = [cx + (c.q[0] - cx) * k, cy + (c.q[1] - cy) * k];
      }
    }
    if (g.arms && withArms) {
      add('lElbow', 13, 1);
      add('rElbow', 14, 1);
      add('lWrist', 15, 1);
      add('rWrist', 16, 1);
    }
    // Collar top → the chin (facing): the user's truth for the zipped parka.
    const top = this.collarTop(scene);
    const m9 = l[9],
      m10 = l[10],
      nose = l[0];
    if (
      g.collar &&
      top &&
      Math.abs(s.pose.yaw) < (15 * Math.PI) / 180 &&
      Math.min(m9.visibility, m10.visibility, nose.visibility) >= MIN_VISIBILITY
    ) {
      const [u, v, z] = project(K, s.pose, s.pivot, top);
      const mouth = (m9.y + m10.y) / 2;
      const chin =
        mouth +
        COLLAR_TARGET_FROM_MOUTH[this.collarTargetKind(scene)] * Math.max(0, mouth - nose.y);
      if (z > 0.3 && Math.abs(chin - v) < 0.15 * H)
        out.push({ p: [u, v], q: [u, chin], importance: 0.5, name: 'collar' });
    }
    // Coverage: at chest and waist rows, a jacket side edge that falls inside the person's
    // silhouette (+ ease) is pushed out to it, so the real clothes never show beside the jacket.
    // A jacket wider than the person is left as it is (the garment is bigger than the T-shirt).
    const mask = frame.mask;
    this.contourSides = [];
    if (g.contour && mask && isKioskJacketSource(scene))
      out.push(...this.contourControls(frame, scene, s, l));
    else if (g.coverage && mask && isKioskJacketSource(scene)) {
      const pos = scene.jacketPositions();
      const ls = l[11],
        rs = l[12],
        lh = l[23],
        rh = l[24];
      if (pos && [ls, rs, lh, rh].every((p) => p.visibility >= MIN_VISIBILITY)) {
        const pxPerM = K.f / s.pose.t[2];
        const ease = GLUE_EASE_M * pxPerM;
        const rows = [0.35, 0.7].map((f) => ({
          y: (ls.y + rs.y) / 2 + f * ((lh.y + rh.y) / 2 - (ls.y + rs.y) / 2),
          min: Infinity,
          max: -Infinity,
          minP: [0, 0] as [number, number],
          maxP: [0, 0] as [number, number],
        }));
        const band = 0.02 * H;
        const R = rotation(s.pose);
        const panels = scene.jacketAsset?.panels;
        const torsoOnly = g.coverTorso && panels?.length === pos.length / 3;
        for (let i = 0; i < pos.length; i += 9) {
          if (torsoOnly && !(panels[i / 3] >= PANEL.frontL && panels[i / 3] <= PANEL.yoke))
            continue;
          const c = toCamera(R, s.pose.t, s.pivot, [pos[i], pos[i + 1], pos[i + 2]]);
          if (c[2] <= 0.3) continue;
          const u = (K.f * c[0]) / c[2] + K.cx,
            v = (K.f * c[1]) / c[2] + K.cy;
          for (const r of rows) {
            if (Math.abs(v - r.y) > band) continue;
            if (u < r.min) {
              r.min = u;
              r.minP = [u, v];
            }
            if (u > r.max) {
              r.max = u;
              r.maxP = [u, v];
            }
          }
        }
        const person = (x: number, y: number) => {
          const mx = Math.min(mask.width - 1, Math.max(0, Math.floor((x / W) * mask.width)));
          const my = Math.min(mask.height - 1, Math.max(0, Math.floor((y / H) * mask.height)));
          return mask.data[my * mask.width + mx] >= 0.5;
        };
        for (const r of rows) {
          if (!Number.isFinite(r.min) || !Number.isFinite(r.max)) continue;
          const centre = (r.min + r.max) / 2;
          // The person's silhouette edges on this row, walking out from the centre.
          let left = centre,
            right = centre;
          const minX = g.coverClamp ? Math.min(ls.x, rs.x) - ease : 0,
            maxX = g.coverClamp ? Math.max(ls.x, rs.x) + ease : W - 1;
          while (left > Math.max(0, minX) && person(left - 1, r.y)) left--;
          while (right < Math.min(W - 1, maxX) && person(right + 1, r.y)) right++;
          if (r.min > left - ease)
            out.push({
              p: r.minP,
              q: [left - ease, r.y],
              importance: 0.7,
              name: `coverL${r.y | 0}`,
            });
          if (r.max < right + ease)
            out.push({
              p: r.maxP,
              q: [right + ease, r.y],
              importance: 0.7,
              name: `coverR${r.y | 0}`,
            });
        }
      }
    }
    // Hem: no landmark; the 3D hem stays where it is (fixed anchors at its lowest points).
    if (g.hem && isKioskJacketSource(scene)) {
      const pos = scene.jacketPositions();
      const mh = joints.midHip;
      if (pos && mh) {
        const lowest: (Vec3 | null)[] = [null, null, null];
        for (let i = 0; i < pos.length; i += 3) {
          const dx = pos[i] - mh[0];
          const bin = dx < -0.06 ? 0 : dx > 0.06 ? 2 : 1;
          const cur = lowest[bin];
          if (!cur || pos[i + 1] < cur[1]) lowest[bin] = [pos[i], pos[i + 1], pos[i + 2]];
        }
        // With hemFollow the anchors carry the hips' mean displacement (no scale, no rotation).
        const hips = g.hemFollow ? out.filter((c) => c.name === 'lHip' || c.name === 'rHip') : [];
        const dx = hips.length ? hips.reduce((a, c) => a + c.q[0] - c.p[0], 0) / hips.length : 0,
          dy = hips.length ? hips.reduce((a, c) => a + c.q[1] - c.p[1], 0) / hips.length : 0;
        for (const X of lowest) {
          if (!X) continue;
          const [u, v, z] = project(K, s.pose, s.pivot, X);
          if (z > 0.3) out.push({ p: [u, v], q: [u + dx, v + dy] });
        }
      }
    }
    // Frame border: fixed, so the warp stays local to the person.
    for (const [x, y] of [
      [0, 0],
      [W / 2, 0],
      [W, 0],
      [W, H / 2],
      [W, H],
      [W / 2, H],
      [0, H],
      [0, H / 2],
    ])
      out.push({ p: [x, y], q: [x, y] });
    return out;
  }

  /** Screen-space arm fit (screenFit.ts) through the engine's adjustPose seam; lab toggle. */
  armFit = true;
  readonly screenFit = new ScreenFit();

  /**
   * V1's seam (LiveTryOnEngine PoseAdjuster): called every tracked frame, after the engine's
   * smoothing and before posing, so BOTH views show the corrected pose. Returns the pose with its
   * arm DOFs corrected so the posed elbows and wrists land on the landmarks, or null.
   */
  adjustPose(
    frame: LiveFrame,
    pose: AnatomicalPose,
    scene: { fkJoints(pose: AnatomicalPose): Record<string, [number, number, number]> },
  ): AnatomicalPose | null {
    if (!this.armFit) return null;
    // The DRAWN camera (after the collar target shift): the fitted sleeves land on the real arms
    // in the picture as drawn, not in the tracker's unshifted frame.
    const live = this.screenFit.adjust(frame, pose, this.drawnSolution ?? this.tracker.last, (p) =>
      scene.fkJoints(p),
    );
    const lock = this.stillFrame(frame);
    if (!live) return live;
    if (lock.still) return (this.heldPose ??= { ...live });
    this.heldPose = undefined;
    return live;
  }

  /**
   * Stillness lock (stillness.ts, config STILLNESS): while the person is still, the drawn
   * solution, the arm fit and both ends of glue controls hold exactly. The shared detector releases
   * every layer on the same frame. The underlying solve keeps running.
   */
  stillnessOn = true;
  private readonly fallbackStillness = new SharedStillDetector();
  private currentShared: SharedStillState | null = null;
  readonly stillness: { state: StillnessState; noiseRmsPx(): number[] } = {
    state: { engaged: false, hold: 0, heldFrames: 0, lastRelease: null, speed: 0 },
    noiseRmsPx: () => Array.from(this.currentShared?.noiseRmsPx ?? []),
  };
  private heldPose?: AnatomicalPose;
  private heldDrawn?: ArSolution;
  private heldControls = new Map<string, Control[]>();
  /** Each layer's last live glue controls (f1fade: reused while a lost body fades out). */
  private lastControls = new Map<string, Control[]>();

  /** The lock's state for this frame (updated once per frame time). */
  private stillFrame(frame: LiveFrame): SharedStillState {
    const state = sharedStillState(frame) ?? this.fallbackStillness.update(frame, this.stillnessOn);
    this.currentShared = state;
    this.stillness.state = state;
    return state;
  }

  /** A stationary classification holds every projection parameter, including learned spread/focal. */
  private holdDrawn(frame: LiveFrame, live: ArSolution): ArSolution {
    if (!this.stillFrame(frame).still) {
      this.heldDrawn = undefined;
      return live;
    }
    this.heldDrawn ??= {
      ...live,
      intrinsics: { ...live.intrinsics },
      pose: { ...live.pose, t: [...live.pose.t] },
      pivot: [...live.pivot],
    };
    // Keep current tracking diagnostics/fade; only the drawn geometry is held.
    return {
      ...live,
      intrinsics: this.heldDrawn.intrinsics,
      pose: this.heldDrawn.pose,
      pivot: this.heldDrawn.pivot,
    };
  }

  /** Hold both source and target controls: target-only smoothing can still move the warp. */
  private holdControls(frame: LiveFrame, layer: string, live: Control[]): Control[] {
    // ?f1fade=1: a held solution (tracking lost, fading out) keeps the last frame's warp.
    if (this.tracker.last?.held) return this.lastControls.get(layer) ?? live;
    this.lastControls.set(layer, live);
    if (!this.stillFrame(frame).still) {
      this.heldControls.delete(layer);
      return live;
    }
    let held = this.heldControls.get(layer);
    if (!held) {
      held = live.map((control) => ({ ...control, p: [...control.p], q: [...control.q] }));
      this.heldControls.set(layer, held);
    }
    return held;
  }

  /** Lab debugging: draw the posed body in colour, hide the jacket, skip the hand occluders. */
  debug = { bodyColour: false, jacket: true, occluders: true };

  /** Render statistics over the last second (lab / final report). */
  stats = { fps: 0, renderMs: 0, solveMs: 0 };
  private renderTimes: number[] = [];

  /** The stage rectangle inside the container (CSS px) and the source size it shows. */
  get display() {
    const stage = this.stage;
    if (!stage) return null;
    return {
      left: stage.offsetLeft,
      top: stage.offsetTop,
      width: stage.clientWidth,
      height: stage.clientHeight,
      source: { ...this.frameSize },
      mirrorDisplay: this.mirrorDisplay,
    };
  }

  attach(container: HTMLElement, video: HTMLVideoElement | null): void {
    if (this.renderer) this.detach();
    this.container = container;
    this.video = video;
    const renderer = new WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(devicePixelRatio, this.maxPixelRatio));
    renderer.toneMapping = NeutralToneMapping; // Viewer.ts: product colours stay true
    renderer.toneMappingExposure = 0.92;
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 1);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false; // drawn once per frame, in the jacket pass
    const pmrem = new PMREMGenerator(renderer),
      room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, 0.04);
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = 0.62;
    room.dispose();
    pmrem.dispose();
    this.renderer = renderer;
    this.kiosk = new ArKioskJacket(renderer, this.scene, this.camera);
    this.glueRenderer = new ArGlue(GLUE_COLUMNS, GLUE_SCALE_CAP);
    // F3 (?f3warp=1): bounded local warp, no tears; falls back locally to the 3D render (warp.ts).
    if (this.f3.warp)
      this.glueRenderer.bounded = { stretchCap: F3_TORSO_STRETCH, minAreaRatio: F3_MIN_AREA };
    // Sleeves: rigid MLS without a scale cap (a hanging arm is a rotation of the whole sleeve).
    // F3 (?f3arms=1): a finer grid and a bounded warp for the sleeves (D3 shards).
    const sleeveColumns = this.f3.arms ? F3_SLEEVE_COLUMNS : GLUE_COLUMNS;
    this.sleeveGlue = {
      sleeveL: new ArGlue(sleeveColumns, Infinity),
      sleeveR: new ArGlue(sleeveColumns, Infinity),
    };
    if (this.f3.arms)
      for (const g of [this.sleeveGlue.sleeveL, this.sleeveGlue.sleeveR])
        g.bounded = { stretchCap: F3_SLEEVE_STRETCH, minAreaRatio: F3_MIN_AREA };

    this.lend.add(this.kiosk.layer);
    const wrapper = document.createElement('div');
    // Absolutely positioned: nothing in the AR view can change the host's size (and so the scale).
    wrapper.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#000';
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    const stage = document.createElement('div');
    stage.style.cssText = `position:absolute;${this.mirrorDisplay ? 'transform:scaleX(-1);' : ''}`;
    const canvas = renderer.domElement;
    canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block';
    stage.append(canvas);
    this.stage = stage;
    const badge = document.createElement('div');
    badge.textContent = 'alignment approximate';
    badge.style.cssText =
      'position:absolute;left:8px;bottom:8px;padding:3px 8px;border-radius:4px;font:12px system-ui;' +
      'background:rgba(0,0,0,.6);color:#ffd27a;display:none;pointer-events:none';
    // Honesty: the glued view is a visual overlay; every fit number comes from the 3D solve.
    const tag = document.createElement('div');
    tag.textContent = 'visual overlay · fit numbers from 3D';
    tag.style.cssText =
      'position:absolute;right:8px;top:8px;padding:2px 7px;border-radius:4px;font:11px system-ui;' +
      'background:rgba(0,0,0,.45);color:#e8e8e8;pointer-events:none';
    tag.style.display = this.glue ? 'block' : 'none';
    this.overlayTag = tag;
    wrapper.append(stage, badge, tag);
    container.append(wrapper);
    this.wrapper = wrapper;
    this.badge = badge;
    if (video) {
      // VideoTexture: three re-specifies it with texImage2D per frame. A plain Texture of a video
      // takes the texStorage + texSubImage2D path, which Chrome rejects for video frames
      // (GL_INVALID_OPERATION in glCopySubTextureCHROMIUM: black background).
      const texture = new VideoTexture(frameShown(video));
      texture.colorSpace = SRGBColorSpace;
      texture.minFilter = LinearFilter;
      texture.generateMipmaps = false;
      this.videoTexture = texture;
      this.background.material.uniforms.tVideo.value = texture;
      this.fadeQuad.material.uniforms.tVideo.value = texture;
      this.occluder.material.uniforms.tVideo.value = texture;
    }
    this.observer = new ResizeObserver(() => this.layout());
    this.observer.observe(container);
    // Background and occluder programs: tiny, compiled now so the first frame does not stall.
    void this.compileAsync(this.quadScene, [this.background.material, this.occluder.material]);
  }

  /** Fit the canvas to the container with the source's aspect ratio ("contain"). */
  private layout() {
    const renderer = this.renderer,
      container = this.container;
    if (!renderer || !container) return;
    const { width: sw, height: sh } = this.frameSize;
    const cw = container.clientWidth,
      ch = container.clientHeight;
    if (!sw || !sh || !cw || !ch) return;
    // The video's on-screen scale is constant: it changes only with a real container resize
    // (≥ 3 px), never with a host layout that breathes by a pixel (text reflow next to the view).
    const key = `${sw}x${sh}`;
    const last = this.laidOut;
    if (last && last.key === key && Math.abs(last.cw - cw) < 3 && Math.abs(last.ch - ch) < 3)
      return;
    this.laidOut = { key, cw, ch };
    const scale = Math.min(cw / sw, ch / sh);
    const w = Math.max(1, Math.floor(sw * scale)),
      h = Math.max(1, Math.floor(sh * scale));
    // F4 res: ?f4res=1 at least the source's own resolution (the browser then downsamples the
    // canvas for a smaller view: supersampled, never upsampled); ?f4res=2 the display's own device
    // pixels (no 1.5 cap). Both up to RES_MAX_RATIO device pixels per CSS px.
    if (this.f4.res)
      renderer.setPixelRatio(
        Math.min(
          RES_MAX_RATIO,
          this.f4.res === 2
            ? devicePixelRatio
            : Math.max(devicePixelRatio, Math.min(sw / w, sh / h)),
        ),
      );
    renderer.setSize(w, h, false);
    const style = this.stage!.style;
    style.width = `${w}px`;
    style.height = `${h}px`;
    style.left = `${Math.floor((cw - w) / 2)}px`;
    style.top = `${Math.floor((ch - h) / 2)}px`;
  }

  /**
   * F4 light (?f4light=1): the rig follows the scene light the finisher measured on the face
   * (finish/f4.ts venueRig); the kiosk rig otherwise. Called after placeCamera (camera rotation).
   */
  private applyVenueLight() {
    const { key, fill, rim, hemisphere } = this.rig;
    if (!this.f4.light) {
      this.f4LightState = null;
      return;
    }
    const q = this.camera.quaternion;
    const rig = venueRig(this.finisher?.light ?? null, [q.x, q.y, q.z, q.w]);
    const place = (l: DirectionalLight, d: readonly number[], i: number) => {
      l.position.set(d[0] * 5, d[1] * 5, d[2] * 5);
      l.intensity = i;
      l.updateMatrixWorld();
    };
    place(key, rig.key.dir, rig.key.intensity);
    place(fill, rig.fill.dir, rig.fill.intensity);
    place(rim, rig.rim.dir, rig.rim.intensity);
    hemisphere.intensity = rig.hemisphere;
    this.scene.environmentIntensity = rig.environment;
    // The room stays with the camera, not with the avatar (which stands still while the camera
    // orbits it): the environment light turns with the camera's azimuth as the rig does, so the
    // side the camera sees gets the room's light at any yaw. Without it the back view kept the
    // environment's dim rear half (back 0.60 against the front's 0.80; the real back is as bright
    // as the front). three negates the Euler for a PMREM map, so +azimuth turns the lookup back.
    const e = this.camera.matrixWorld.elements;
    this.scene.environmentRotation.set(0, Math.atan2(e[8], e[10]), 0);
    this.f4LightState = rig;
  }

  /** Projection from pinhole intrinsics (principal point honoured) and the solved view. */
  private placeCamera(K: Intrinsics, solution: ArSolution) {
    const left = (-K.cx * NEAR) / K.f,
      right = ((K.width - K.cx) * NEAR) / K.f,
      top = (K.cy * NEAR) / K.f,
      bottom = (-(K.height - K.cy) * NEAR) / K.f;
    this.camera.projectionMatrix.makePerspective(left, right, top, bottom, NEAR, FAR);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    // OpenCV camera (y down, z forward) → three camera (y up, z backward): negate rows 1 and 2.
    const M = viewMatrix(solution.pose, solution.pivot);
    for (const r of [4, 5, 6, 7, 8, 9, 10, 11]) M[r] = -M[r];
    // M is row-major; fromArray reads column-major, hence the transpose.
    this.camera.matrixWorldInverse.fromArray(M).transpose();
    this.camera.matrix.copy(this.camera.matrixWorldInverse).invert();
    this.camera.matrix.decompose(this.camera.position, this.camera.quaternion, this.camera.scale);
    this.camera.matrixWorld.copy(this.camera.matrix);
  }

  /** NDC depth of a point `z` metres in front of the lens. */
  private ndcDepth(z: number) {
    const c = -(FAR + NEAR) / (FAR - NEAR),
      d = (-2 * FAR * NEAR) / (FAR - NEAR);
    return (c * -z + d) / z;
  }

  private uploadMask(mask: LiveFrame['mask']) {
    const uniforms = this.occluder.material.uniforms;
    if (!mask) {
      uniforms.uHasMask.value = 0;
      return;
    }
    const step = Math.max(1, Math.ceil(mask.width / MASK_MAX_WIDTH));
    const w = Math.floor(mask.width / step),
      h = Math.floor(mask.height / step);
    if (
      !this.maskTexture ||
      this.maskTexture.image.width !== w ||
      this.maskTexture.image.height !== h
    ) {
      this.maskTexture?.dispose();
      this.maskBytes = new Uint8Array(w * h);
      this.maskTexture = new DataTexture(this.maskBytes, w, h, RedFormat, UnsignedByteType);
      this.maskTexture.minFilter = this.maskTexture.magFilter = LinearFilter;
      uniforms.tMask.value = this.maskTexture;
    }
    const bytes = this.maskBytes!;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        bytes[y * w + x] = Math.round(
          Math.min(1, Math.max(0, mask.data[y * step * mask.width + x * step])) * 255,
        );
    this.maskTexture.needsUpdate = true;
    uniforms.tMask.value = this.maskTexture;
    uniforms.uHasMask.value = 1;
  }

  /** The posed joints the solve uses (the scene's own: it is never mirrored, contract.ts). */
  jointsOf(scene: LivePosedScene): LivePosedScene['joints'] {
    // The eyes (face anchor, config LANDMARK_OF_JOINT) from the rig's eye bones when the posed
    // scene carries its bone poses (LiveAvatar.last.world + live.rig.bones).
    const avatar = scene as {
      last?: { world?: Float64Array };
      live?: { rig?: { bones: string[] } };
    };
    const world = avatar.last?.world,
      bones = avatar.live?.rig?.bones;
    if (!world || !bones) return scene.joints;
    if (this.eyeBones?.bones !== bones)
      this.eyeBones = { bones, l: bones.indexOf('eye.L'), r: bones.indexOf('eye.R') };
    const { l, r } = this.eyeBones;
    if (l < 0 || r < 0 || world.length < (Math.max(l, r) + 1) * 16) return scene.joints;
    const head = (i: number): [number, number, number] => [
      world[i * 16 + 3],
      world[i * 16 + 7],
      world[i * 16 + 11],
    ];
    return { ...scene.joints, lEye: head(l), rEye: head(r) };
  }
  private eyeBones?: { bones: string[]; l: number; r: number };

  /** Fraction from the upper-arm joint to the acromion for the shoulder correspondences. */
  shoulderMarkBlend = SHOULDER_MARK_BLEND;
  private acromionIds?: { asset: object; ids: number[] };

  /**
   * The joints matched to MediaPipe landmarks: as `jointsOf`, with each shoulder moved toward
   * the posed acromion by `shoulderMarkBlend` (config SHOULDER_MARK_BLEND). The arm fit and the
   * sleeve roots keep the true joints (the arm pivots there).
   */
  landmarkJoints(
    scene: LivePosedScene,
    joints: LivePosedScene['joints'],
  ): LivePosedScene['joints'] {
    const k = this.shoulderMarkBlend;
    if (!(k > 0) || !isKioskJacketSource(scene)) return joints;
    const asset = scene.jacketAsset;
    const arrays = (scene as { bodyArrays?: () => { positions: Float32Array } }).bodyArrays;
    const body = arrays ? arrays.call(scene).positions : undefined;
    const ls = joints.lShoulder,
      rs = joints.rShoulder;
    if (!asset || !body || !ls || !rs) return joints;
    if (this.acromionIds?.asset !== asset)
      this.acromionIds = { asset, ids: acromionVertices(asset, body.length / 3) };
    const marks = shoulderMarks(ls, rs, body, this.acromionIds.ids, k);
    return marks ? { ...joints, lShoulder: marks.l, rShoulder: marks.r } : joints;
  }

  /**
   * Forward-head flexion (lead's option B1; config HEAD_FLEXION; headPose.ts): the person's head
   * angle ahead of the torso axis from MediaPipe's world landmarks (ears over shoulders), minus
   * the rig's own (skull base over the shoulder joints) and the calibration offset, smoothed and
   * clamped; 0 when unsure. Readout for the lab and diagnostics.
   */
  headFlexion: { deg: number; personDeg: number | null; rigDeg: number | null; used: boolean } = {
    deg: 0,
    personDeg: null,
    rigDeg: null,
    used: false,
  };
  private headFlexionFilter = new OneEuroFilter(HEAD_FLEXION.smooth);

  /**
   * `joints` with the rig's eyes rotated about the neck base by the person's forward-head flexion,
   * so the solve does not read a hunch toward the camera as a camera pitch or a face offset. The
   * AR draws no head and the collar stays on the torso. Live AR only: the mirror avatar and
   * recorded physics keep the rig's upright neck (the neck is not a skinning driver).
   */
  headFlexed(frame: LiveFrame, joints: LivePosedScene['joints']): LivePosedScene['joints'] {
    const H = HEAD_FLEXION;
    const w = frame.world;
    const ls = joints.lShoulder,
      rs = joints.rShoulder,
      lh = joints.lHip,
      rh = joints.rHip,
      head = joints.head,
      le = joints.lEye,
      re = joints.rEye;
    let target = 0;
    let personDeg: number | null = null,
      rigDeg: number | null = null;
    const seen = (i: number) => (w?.[i]?.visibility ?? 0) >= H.minVisibility;
    if (w && [0, 7, 8, 11, 12, 23, 24].every(seen) && ls && rs && lh && rh && head && le && re) {
      const mid = (
        a: { x: number; y: number; z: number },
        b: { x: number; y: number; z: number },
      ) => [(a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2] as [number, number, number];
      const xyz = (a: { x: number; y: number; z: number }) =>
        [a.x, a.y, a.z] as [number, number, number];
      // A turned person's sagittal angle is unreliable (single view): unsure beyond maxTurnDeg.
      const turn =
        (Math.abs(Math.atan2(w[11].z - w[12].z, Math.abs(w[11].x - w[12].x) + 1e-9)) * 180) /
        Math.PI;
      personDeg = sagittalHeadAngleDeg({
        lShoulder: xyz(w[11]),
        rShoulder: xyz(w[12]),
        lHip: xyz(w[23]),
        rHip: xyz(w[24]),
        head: mid(w[7], w[8]),
        face: xyz(w[0]),
      });
      const eyes: [number, number, number] = [
        (le[0] + re[0]) / 2,
        (le[1] + re[1]) / 2,
        (le[2] + re[2]) / 2,
      ];
      rigDeg = sagittalHeadAngleDeg({
        lShoulder: ls,
        rShoulder: rs,
        lHip: lh,
        rHip: rh,
        head,
        face: eyes,
      });
      if (personDeg !== null && rigDeg !== null && turn <= H.maxTurnDeg)
        target = Math.max(
          H.rangeDeg[0],
          Math.min(H.rangeDeg[1], personDeg - rigDeg - this.headFlexionOffsetDeg),
        );
    }
    const deg = this.headFlexionFilter.filter(target, frame.t);
    this.headFlexion = { deg, personDeg, rigDeg, used: target !== 0 };
    return this.flexEyes(joints);
  }

  /** `joints` with the eyes rotated by the current head flexion (no state change; lab metrics). */
  flexEyes(joints: LivePosedScene['joints']): LivePosedScene['joints'] {
    const deg = this.headFlexion.deg;
    const ls = joints.lShoulder,
      rs = joints.rShoulder,
      le = joints.lEye,
      re = joints.rEye,
      pivot = joints.neck01 ?? joints.head;
    if (!this.headFlexionOn || !ls || !rs || !le || !re || !pivot || Math.abs(deg) < 0.05)
      return joints;
    // About the person's LEFT axis (posed shoulders): +deg tips the head forward and down.
    const axis: [number, number, number] = [ls[0] - rs[0], ls[1] - rs[1], ls[2] - rs[2]];
    return {
      ...joints,
      lEye: rotateAbout(le, pivot, axis, deg),
      rEye: rotateAbout(re, pivot, axis, deg),
    };
  }
  /** Off until the calibration offset is measured (lab: ?headflex=1 on, ?headflex=0 off). */
  headFlexionOn = false;
  /** Calibration offset (config HEAD_FLEXION.offsetDeg; lab ?headoffset=). */
  headFlexionOffsetDeg: number = HEAD_FLEXION.offsetDeg;

  /** Lend the posed root to this scene for the duration of `draw`. */
  private withPosedScene<T>(scene: LivePosedScene, draw: () => T): T {
    const root = scene.root;
    const parent = root.parent;
    const index = parent ? parent.children.indexOf(root) : -1;
    parent?.updateWorldMatrix(true, false);
    if (parent) this.lend.matrix.copy(parent.matrixWorld);
    else this.lend.matrix.identity();
    this.lend.matrixWorldNeedsUpdate = true;
    this.lend.add(root);
    try {
      return draw();
    } finally {
      this.lend.remove(root);
      if (parent) {
        parent.add(root);
        // Back in its own slot (draw order of the caller's scene unchanged).
        const children = parent.children;
        children.splice(children.indexOf(root), 1);
        children.splice(index, 0, root);
      }
    }
  }

  private materialsOf(object: Object3D) {
    const out = new Set<Material>();
    object.traverse((child) => {
      const material = (child as Mesh).material as Material | Material[] | undefined;
      if (!material || !child.visible) return;
      for (const m of Array.isArray(material) ? material : [material]) out.add(m);
    });
    return out;
  }

  /** Compile (in the background) every program `object` needs; resolves when linked. */
  private compileAsync(object: Object3D, materials: Iterable<Material>) {
    const renderer = this.renderer;
    if (!renderer) return Promise.resolve();
    const list = [...materials];
    renderer.setRenderTarget(null);
    renderer.compile(object, this.camera, this.scene);
    const programs: { isReady(): boolean }[] = [];
    for (const m of list)
      programs.push(...((renderer.properties.get(m) as ProgramState).programs?.values() ?? []));
    return new Promise<void>((resolve) => {
      const poll = () => {
        if (!this.renderer || programs.every((p) => p.isReady())) {
          for (const m of list) this.ready.add(m);
          resolve();
        } else setTimeout(poll, 16);
      };
      poll();
    });
  }

  private drawVideo() {
    const renderer = this.renderer!;
    const u = this.background.material.uniforms;
    u.uSize.value.set(this.frameSize.width, this.frameSize.height);
    renderer.setRenderTarget(null);
    renderer.clear();
    if (this.videoTexture) {
      this.videoTexture.needsUpdate = true;
      renderer.render(this.quadScene, this.quadCamera);
    }
  }

  render(frame: LiveFrame, scene: LivePosedScene): void {
    const renderer = this.renderer;
    if (!renderer) return;
    // F4X (?f4xwarm=1): ask for the kiosk-look jacket at the first frame, before the video plays
    // or a person is tracked, so its programs compile while the person steps into view.
    if (this.f4x.warm && this.kiosk && isKioskJacketSource(scene) && scene.jacketAsset)
      void this.kiosk.setAsset(scene.jacketAsset);
    this.updateFraming(frame);
    this.matchVideo(frame);
    if (frame.width !== this.frameSize.width || frame.height !== this.frameSize.height) {
      this.frameSize = { width: frame.width, height: frame.height };
      this.layout();
    }
    if (!this.video || !this.videoTexture || this.video.readyState < 2) {
      this.status = 'no-video';
      this.tracker.update(
        frame,
        this.landmarkJoints(scene, this.headFlexed(frame, this.jointsOf(scene))),
      );
      this.setBadge();
      return;
    }
    const started = performance.now();
    const joints = this.landmarkJoints(scene, this.headFlexed(frame, this.jointsOf(scene)));
    const solution = this.tracker.update(frame, joints);
    const solved = performance.now();
    this.drawVideo();
    this.lastHands = [];
    if (!solution) {
      this.status = 'no-person';
      // F4X (?f4xwarm=1): nobody in view, nothing to draw: the idle moment to compile the other
      // finish's programs for a later jacket (once; ArKioskJacket.prewarmIdle).
      this.kiosk?.prewarmIdle();
      this.setBadge();
      return;
    }
    const dt =
      this.lastT === undefined ? 0 : Math.min(0.1, Math.max(0, (frame.t - this.lastT) / 1000));
    this.lastT = frame.t;
    const drawn = this.holdDrawn(frame, this.guardCollar(frame, scene, solution, dt));
    this.drawnSolution = drawn;
    this.placeCamera(drawn.intrinsics, drawn);
    this.applyVenueLight();
    // The kiosk look when the posed scene can feed it (LiveAvatar); the scene's own jacket else.
    let kioskOn = false,
      kioskPending = false;
    if (this.kiosk && isKioskJacketSource(scene) && scene.jacketAsset) {
      void this.kiosk.setAsset(scene.jacketAsset);
      // Straight to the canvas (glue off): that pass has its own programs (ArKioskJacket).
      const canvas = !this.glue;
      kioskOn = this.kiosk.update(scene, dt, canvas);
      // F4X (?f4xwarm=1): while the kiosk look loads, no jacket at all, never the plain one.
      kioskPending = !kioskOn && this.kiosk.pending(scene.jacketAsset, canvas);
    }
    this.kioskLook = kioskOn;
    this.withPosedScene(scene, () => {
      if (kioskPending) {
        this.status = 'preparing';
        return;
      }
      const pending = kioskOn
        ? []
        : [...this.materialsOf(scene.jacket)].filter((m) => !this.ready.has(m));
      if (pending.length) {
        this.status = 'preparing';
        if (!this.compiling) {
          this.compiling = true;
          void this.compileAsync(this.scene, pending).finally(() => (this.compiling = false));
        }
        return;
      }
      const glue = this.glue ? this.glueRenderer : undefined;
      const asset = kioskOn ? this.kiosk?.shownAsset : undefined;
      if (this.finisher) this.finisher.garmentColour = asset?.colour ?? null;
      const layered =
        !!glue &&
        this.layeredSleeves &&
        !!this.sleeveGlue &&
        !!asset &&
        !!this.kiosk &&
        this.sleeves.update(this.kiosk.layer, asset);
      this.layeredLast = layered;
      if (glue && layered && this.kiosk && this.sleeveGlue) {
        // Shadow map once, from the whole jacket (the sleeves shade the torso as in the kiosk).
        const restoreAll = this.sleeves.show('all', this.kiosk.layer);
        renderer.setRenderTarget(this.shadowDummy);
        this.drawPosed(scene, kioskOn, true);
        restoreAll();
        const passes: [LayerName, ArGlue][] = [
          ['torso', glue],
          ['sleeveL', this.sleeveGlue.sleeveL],
          ['sleeveR', this.sleeveGlue.sleeveR],
        ];
        for (const [name, g] of passes) {
          g.ensureSize(renderer, frame.width, frame.height);
          renderer.setRenderTarget(g.target);
          renderer.setClearColor(0x000000, 0);
          renderer.clear();
          const restore = this.sleeves.show(name, this.kiosk.layer);
          // F3X: only the body part that may hide this layer (no arm-shaped hole in the torso).
          // F3 (?f3arms=1, wedges): the torso layer is drawn without the ARMS in its depth
          // occluder, so it has no arm-shaped hole where a displaced sleeve would bare the clothes.
          // Both apply: F3X's occlude now runs on every frame (outside-only sleeves) but keeps the
          // full body occluder while its pieces are idle, so the torso subset is set after it.
          const restoreF3x = this.f3x?.occlude(name, this.occluderFor(scene), scene);
          const restoreTorso =
            (this.f3.arms || this.f3.flat) && name === 'torso'
              ? this.torsoOccluder(scene)
              : undefined;
          this.drawPosed(scene, kioskOn, false);
          restoreTorso?.();
          restoreF3x?.();
          restore();
        }
        renderer.setRenderTarget(null);
        renderer.setClearColor(0x000000, 1);
        this.warpTorso(
          frame,
          glue,
          this.holdControls(frame, 'torso', this.glueControls(frame, scene, drawn, false)),
        );
        this.contourAfter(glue);
        this.sleeveGlue.sleeveL.warp(
          this.holdControls(frame, 'sleeveL', this.sleeveControls(scene, drawn, 'L', glue)),
        );
        this.sleeveGlue.sleeveR.warp(
          this.holdControls(frame, 'sleeveR', this.sleeveControls(scene, drawn, 'R', glue)),
        );
        const sleeveGlues = [this.sleeveGlue.sleeveL, this.sleeveGlue.sleeveR];
        // F3X: this frame's sleeve pieces and order; finish() composites them.
        this.f3x?.update({
          frame,
          solution: drawn,
          joints: this.jointsOf(scene),
          torso: glue,
          landmarks: this.glueLandmarks,
          proxies: this.sleeves.proxies,
          camera: this.camera,
          still: this.stillFrame(frame).still,
        });
        this.finishedLast = this.finish(renderer, frame, drawn, joints, glue, sleeveGlues);
        if (!this.finishedLast) {
          glue.draw(renderer, renderer.toneMappingExposure);
          for (const g of sleeveGlues) g.draw(renderer, renderer.toneMappingExposure);
        }
      } else if (glue) {
        glue.ensureSize(renderer, frame.width, frame.height);
        renderer.setRenderTarget(glue.target);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        this.drawPosed(scene, kioskOn);
        renderer.setRenderTarget(null);
        renderer.setClearColor(0x000000, 1);
        this.warpTorso(
          frame,
          glue,
          this.holdControls(frame, 'all', this.glueControls(frame, scene, drawn)),
        );
        this.contourAfter(glue);
        this.finishedLast = this.finish(renderer, frame, drawn, joints, glue, []);
        if (!this.finishedLast) glue.draw(renderer, renderer.toneMappingExposure);
      } else this.drawPosed(scene, kioskOn);
      this.status = 'drawn';
    });
    if (this.overlayTag) this.overlayTag.style.display = this.glue ? 'block' : 'none';
    // d. Hand occluders: the video drawn back over the jacket where a real hand is in front.
    this.uploadMask(frame.mask);
    const u = this.occluder.material.uniforms;
    u.uSize.value.set(frame.width, frame.height);
    this.lastHands = this.f3.arms
      ? this.handHoldOwn.update(frame.t, handCapsules(frame, solution, joints), frame.landmarks2d)
      : handCapsules(frame, solution, joints);
    // With the finisher on, it composited the real hands itself: no second hand pass here.
    if (this.status === 'drawn' && this.debug.occluders && !this.finishedLast)
      for (const hand of this.lastHands) {
        u.uA.value.set(hand.a[0], hand.a[1]);
        u.uB.value.set(hand.b[0], hand.b[1]);
        u.uRadius.value = hand.radius;
        if (this.glue) {
          // The glued jacket leaves no depth on the canvas: a hand wins unless the posed wrist
          // is behind the pelvis plane (a hand behind the back).
          if (hand.depth + HAND_DEPTH_MARGIN_M > drawn.pose.t[2] + 0.1) continue;
          u.uDepth.value = -1;
        } else u.uDepth.value = this.ndcDepth(Math.max(hand.depth, NEAR * 2));
        renderer.render(this.occluderScene, this.quadCamera);
      }
    // F3X: the real hands over the sleeve pieces, each past its own cuff (after the finisher).
    if (this.status === 'drawn')
      this.f3x?.drawHands(
        renderer,
        this.videoTexture ?? null,
        u.uHasMask.value > 0.5 ? (u.tMask.value as Texture | null) : null,
        this.finisher,
      );
    // F3 (?f3head=1): from behind, the real head over the jacket, so the hood lies below it
    // (backHead.ts; capsule round the head x the person mask).
    if (this.status === 'drawn' && this.f3.head && this.debug.occluders) {
      const head = backHeadCapsule(
        frame.landmarks2d,
        !!solution.backView,
        (drawn.pose.yaw * 180) / Math.PI,
      );
      if (head) {
        u.uA.value.set(head.a[0], head.a[1]);
        u.uB.value.set(head.b[0], head.b[1]);
        u.uRadius.value = head.radius;
        u.uDepth.value = -1;
        renderer.render(this.occluderScene, this.quadCamera);
      }
    }
    // Turned beyond FADE_FROM_DEG or showing the back: the video wins (no wrong solve drawn).
    if (this.status === 'drawn' && solution.fade > 0.01) {
      this.fadeQuad.material.uniforms.uAlpha.value = solution.fade;
      renderer.render(this.fadeScene, this.quadCamera);
    }
    this.setBadge();
    const done = performance.now();
    this.renderTimes.push(done);
    while (this.renderTimes.length && done - this.renderTimes[0] > 1000) this.renderTimes.shift();
    const k = 0.1; // exponential means over ~10 frames
    this.stats = {
      fps: this.renderTimes.length,
      renderMs: this.stats.renderMs * (1 - k) + (done - started) * k,
      solveMs: this.stats.solveMs * (1 - k) + (solved - started) * k,
    };
  }

  /** F3 (?f3rigid=1): the torso layer's rigid transform, filtered in time (rigidGlue.ts). */
  private readonly rigidFilter = new RigidFilter();

  /**
   * The torso layer's warp: the free-form MLS glue, or with ?f3rigid=1 ONE similarity fitted to
   * the shoulders and hips (+ a slow, capped width factor from the contour fit), so the stiff
   * coat moves as a rigid body and never jiggles (user verdict 22:05).
   */
  private warpTorso(frame: LiveFrame, glue: ArGlue, controls: Control[]) {
    if (!this.f3.rigid) {
      glue.warp(controls);
      return;
    }
    const torso = controls.filter((c) => !!c.name && /^[lr](Shoulder|Hip)$/.test(c.name));
    const raw = fitSimilarity(torso);
    if (!raw) {
      glue.warp(controls);
      return;
    }
    // Width: the mean outward shift the contour fit asks for, relative to the torso half-width.
    let width = 0;
    const sides = this.contourSides;
    if (sides.length) {
      let d = 0,
        half = 0;
      for (const c of sides) {
        d += c.side === 'L' ? c.jacket[0] - c.targetX : c.targetX - c.jacket[0];
        half += Math.abs(c.jacket[0] - raw.c[0]);
      }
      half /= sides.length;
      if (half > 1) width = d / sides.length / (half * raw.s);
    }
    // The coat hangs from the shoulders: the drawn shoulder span on the real one (the similarity
    // is a compromise between the shoulder and hip spans; a 3D body fuller than the person drew
    // the jacket and its sleeves ~10 % too wide, lead 23:2x). Only while both arms hang: crossed
    // or raised arms move the shoulder landmarks, and the contour's coverage width decides then.
    const ls = torso.find((c) => c.name === 'lShoulder'),
      rs = torso.find((c) => c.name === 'rShoulder');
    if (ls && rs && armsHanging(frame.landmarks2d)) {
      const span = Math.hypot(rs.p[0] - ls.p[0], rs.p[1] - ls.p[1]) * raw.s;
      const real = Math.hypot(rs.q[0] - ls.q[0], rs.q[1] - ls.q[1]);
      if (span > 1) width = real / span - 1;
    }
    // Turned > 25 deg: size and width hold at their frontal values (J3; rigidGlue.ts RIGID).
    const t = this.rigidFilter.apply(
      raw,
      frame.t,
      this.stillFrame(frame).still,
      width,
      this.tracker.headingDeg,
    );
    glue.warpRigid(t, controls);
  }

  /** F3 (?f3arms=1): torso-pass occluder index (trunk + head, no arms; armOccluder.ts), per rig. */
  private torsoOccluderIndex = new WeakMap<object, BufferAttribute>();

  /** Swaps the body occluder to its trunk + head subset; returns the restore, or undefined. */
  private torsoOccluder(scene: LivePosedScene): (() => void) | undefined {
    const occluder = this.occluderFor(scene);
    const rig = (scene as { live?: { rig?: MotionRig } }).live?.rig;
    if (!occluder || !rig) return undefined;
    let index = this.torsoOccluderIndex.get(rig);
    if (!index) {
      // ?f3flat=1: chest, shoulders, neck and head only (the abdomen would poke through the
      // flattened front; flatFront.ts).
      index = new BufferAttribute(
        this.f3.flat ? upperTorsoOccluderIndex(rig) : passOccluderIndex(rig, 'torso'),
        1,
      );
      this.torsoOccluderIndex.set(rig, index);
    }
    const geometry = occluder.geometry as BufferGeometry;
    const saved = geometry.getIndex();
    geometry.setIndex(index);
    return () => geometry.setIndex(saved);
  }

  /**
   * The occluding part of the posed body (torso, arms, head; no hands or legs: occluder.ts),
   * sharing the body's live position attribute. Null when the scene carries no rig (then the
   * whole body occludes).
   */
  private occluderFor(scene: LivePosedScene) {
    let mesh: Mesh | undefined;
    scene.body.traverse((child) => {
      if (!mesh && child instanceof Mesh) mesh = child;
    });
    const rig = (scene as { live?: { rig?: MotionRig } }).live?.rig;
    if (!mesh || !rig) return null;
    const geometry = mesh.geometry as BufferGeometry;
    const position = geometry.getAttribute('position');
    if (!position || position.count !== rig.vertexCount) return null;
    if (this.bodyOccluder?.source !== geometry) {
      if (this.bodyOccluder) {
        this.scene.remove(this.bodyOccluder.mesh);
        this.bodyOccluder.mesh.geometry.dispose();
      }
      const occluder = new BufferGeometry();
      occluder.setAttribute('position', position);
      occluder.setIndex(new BufferAttribute(occluderIndex(rig), 1));
      const m = new Mesh(occluder, this.depthOnly);
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      m.visible = false;
      this.scene.add(m);
      this.bodyOccluder = { source: geometry, mesh: m };
    }
    const m = this.bodyOccluder.mesh;
    mesh.updateWorldMatrix(true, false);
    m.matrix.copy(mesh.matrixWorld);
    m.matrixWorldNeedsUpdate = true;
    return m;
  }

  /**
   * b + c: the body's occluding part into depth only, then the jacket (body hidden) with the
   * kiosk's look and the key light's shadow.
   */
  private drawPosed(scene: LivePosedScene, kioskOn: boolean, updateShadow = true) {
    const renderer = this.renderer!;
    const { root, body, jacket } = scene;
    const layer = this.kiosk?.layer;
    const occluder = this.occluderFor(scene);
    const rootVisible = root.visible,
      bodyVisible = body.visible,
      jacketVisible = jacket.visible;
    try {
      // Pass 1: depth of the occluding body (or, in debug, the whole body in colour).
      if (layer) layer.visible = false;
      if (this.debug.bodyColour || !occluder) {
        jacket.visible = false;
        this.scene.overrideMaterial = this.debug.bodyColour ? null : this.depthOnly;
      } else {
        occluder.visible = true;
        root.visible = false;
      }
      renderer.render(this.scene, this.camera);
      this.scene.overrideMaterial = null;
      // Pass 2: the jacket, shadowed by itself (the shadow map is drawn here, once per frame).
      if (occluder) occluder.visible = false;
      root.visible = rootVisible;
      body.visible = false;
      jacket.visible = jacketVisible && this.debug.jacket && !kioskOn;
      if (layer) layer.visible = kioskOn && this.debug.jacket;
      renderer.shadowMap.needsUpdate = updateShadow;
      renderer.render(this.scene, this.camera);
    } finally {
      this.scene.overrideMaterial = null;
      root.visible = rootVisible;
      body.visible = bodyVisible;
      jacket.visible = jacketVisible;
      if (layer) layer.visible = false;
      if (occluder) occluder.visible = false;
    }
  }

  /** The on-screen honesty line: framing first (it is the cause), then alignment quality. */
  private setBadge() {
    if (!this.badge) return;
    const report = this.tracker.last?.alignment;
    const lines: string[] = [];
    // F4X (?f4xwarm=1): the kiosk-look jacket is loading and nothing is drawn meanwhile.
    if (this.f4x.warm && this.status === 'preparing') lines.push('Preparing your jacket…');
    // ?f1turn=1 draws the jacket's back: no request to turn back.
    if (this.tracker.last?.backView && !this.tracker.turnThrough)
      lines.push('Turn back toward the camera to see the jacket on you');
    // ?f1close=1: a close-up crops the hands by design (the sleeves are cropped with them).
    else if (this.handsOutOfFrame && !this.tracker.closeRange)
      lines.push('Keep your hands in the picture: step back a little');
    if (report?.approximate) lines.push('alignment approximate');
    this.badge.textContent = lines.join(' · ');
    this.badge.style.display = lines.length ? 'block' : 'none';
  }

  /**
   * True when the shoulders are tracked but an elbow or wrist landmark lies outside the frame:
   * the pose then cannot measure that arm (its DOFs fall back), so the sleeve cannot follow.
   */
  handsOutOfFrame = false;
  private updateFraming(frame: LiveFrame) {
    const l = frame.landmarks2d;
    if (!l || Math.min(l[11]?.visibility ?? 0, l[12]?.visibility ?? 0) < MIN_VISIBILITY) {
      this.handsOutOfFrame = false;
      return;
    }
    this.handsOutOfFrame = [13, 14, 15, 16].some((i) => {
      const p = l[i];
      return !!p && (p.x < 0 || p.y < 0 || p.x > frame.width || p.y > frame.height);
    });
  }

  /**
   * Evaluation only: the DISPLAYED (glued) jacket's alpha at the source resolution, the union of
   * the torso layer and, when layered, both sleeve layers; null without the glue. Row 0 = top.
   */
  glueMask(): { data: Uint8Array; width: number; height: number } | null {
    const renderer = this.renderer,
      glue = this.glueRenderer;
    if (!renderer || !this.glue || !glue) return null;
    // F3X: the displayed jacket is its composite, not the glue grids.
    if (this.f3x?.drawnLast && this.layeredLast)
      return this.f3x.readMask(
        renderer,
        glue.warpedTarget,
        this.frameSize.width,
        this.frameSize.height,
      );
    const out = glue.readMask(renderer);
    if (this.layeredLast && this.sleeveGlue)
      for (const g of [this.sleeveGlue.sleeveL, this.sleeveGlue.sleeveR]) {
        const m = g.readMask(renderer);
        if (m.width !== out.width || m.height !== out.height) continue;
        for (let k = 0; k < out.data.length; k++) out.data[k] = Math.max(out.data[k], m.data[k]);
      }
    return out;
  }

  /**
   * Evaluation only: the drawn jacket's silhouette (alpha) at the source resolution, with the
   * body depth prepass, for the last solved frame. Row 0 = image top. Synchronous readback.
   */
  jacketMask(scene: LivePosedScene): { data: Uint8Array; width: number; height: number } | null {
    const renderer = this.renderer,
      solution = this.tracker.last;
    if (!renderer || !solution) return null;
    const { width, height } = this.frameSize;
    const target = new WebGLRenderTarget(width, height, { type: UnsignedByteType });
    const pixels = new Uint8Array(width * height * 4);
    try {
      this.placeCamera(solution.intrinsics, solution);
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      this.withPosedScene(scene, () => this.drawPosed(scene, this.kioskLook));
      // V4's async colour reads may leave a PIXEL_PACK buffer bound: a sync read then fails.
      const gl = renderer.getContext() as WebGL2RenderingContext;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    } finally {
      renderer.setRenderTarget(null);
      renderer.setClearColor(0x000000, 1);
      target.dispose();
    }
    const out = new Uint8Array(width * height);
    // GL rows are bottom-up.
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        out[y * width + x] = pixels[((height - 1 - y) * width + x) * 4 + 3];
    return { data: out, width, height };
  }

  /**
   * Cheap per-frame snapshot for diagnostics recordings (V1's "Record diagnostics"): numbers only.
   * Angles in degrees, depth in m, translation in m (camera frame), errors in source px.
   */
  debugState() {
    const s = this.tracker.last;
    const d = this.drawnSolution;
    const deg = (r: number | undefined) => (r === undefined ? null : (r * 180) / Math.PI);
    const a = s?.alignment ?? null;
    const fit = this.screenFit.last;
    return {
      status: this.status,
      tracked: !!s,
      degenerateSkip: this.tracker.degenerate,
      fade: s?.fade ?? null,
      backView: s?.backView ?? null,
      backEvidence: this.tracker.backEvidence,
      headFlexion: { ...this.headFlexion },
      stillness: { ...this.stillness.state, on: this.stillnessOn },
      headingDeg: this.tracker.headingDeg,
      yawRawDeg: deg(s?.raw.yaw),
      yawDrawnDeg: deg(s?.pose.yaw),
      pitchDeg: deg(s?.pose.pitch),
      rollDeg: deg(s?.pose.roll),
      depthRawM: s?.raw.t[2] ?? null,
      depthDrawnM: d?.pose.t[2] ?? s?.pose.t[2] ?? null,
      /** Drawn size relative to the raw solve (depthRaw / depthDrawn). */
      scaleDrawnVsRaw: s && d ? s.raw.t[2] / d.pose.t[2] : null,
      translationDrawnM: d ? [...d.pose.t] : s ? [...s.pose.t] : null,
      focalPx: s?.intrinsics.f ?? null,
      focalSource: s?.focal.source ?? null,
      landmarkSpread: this.tracker.landmarkSpread,
      alignment: a
        ? {
            score: a.score,
            rmsPx: a.rmsPx,
            rmsFraction: a.rmsFraction,
            rmsPxTrueSize: a.rmsPxTrueSize ?? null,
            approximate: a.approximate,
          }
        : null,
      collar: {
        fired: this.collar.clamped,
        shiftPx: this.collar.shiftPx,
        marginPx: this.collar.marginPx,
        triggered: this.collar.triggered,
        frames: this.collar.frames,
      },
      /** F3X (?f3x=1): the sleeve pieces' order and anchors; null when the flag is off. */
      f3x: this.f3x?.debug ?? null,
      glue:
        this.glue && this.glueRenderer
          ? {
              active: this.status === 'drawn',
              controls: this.glueRenderer.lastControls.length,
              /** Largest |q − p| over the controls this frame (px): how far the glue had to pull. */
              maxControlDisplacementPx: this.glueRenderer.lastControls.reduce(
                (m, c) => Math.max(m, Math.hypot(c.q[0] - c.p[0], c.q[1] - c.p[1])),
                0,
              ),
              /** Post-warp keypoint residual (px) per named control: what V5 scores. */
              residualPx: Object.fromEntries(
                [
                  this.glueRenderer,
                  ...(this.layeredLast && this.sleeveGlue
                    ? [this.sleeveGlue.sleeveL, this.sleeveGlue.sleeveR]
                    : []),
                ].flatMap((g) => Object.entries(g.warped).map(([k, v]) => [k, v.errorPx])),
              ),
              layeredSleeves: this.layeredLast,
              kept: this.glueRenderer.report?.kept ?? null,
              capBound: this.glueRenderer.report?.capBound ?? null,
              maxScaleChange: this.glueRenderer.report?.maxScaleChange ?? null,
              capBoundFrames: this.glueRenderer.stats.capBound,
              frames: this.glueRenderer.stats.frames,
              warpMs: this.glueRenderer.stats.warpMs,
              finisher: !!this.finisher && this.useFinisher,
              contour: this.glueGroups.contour ? { ...this.contour } : null,
            }
          : null,
      armFit: fit
        ? {
            sides: fit.sides.join(''),
            beforePx: fit.beforePx,
            afterPx: fit.afterPx,
            afterJointPx: fit.afterJointPx,
            reach: fit.reach,
          }
        : null,
      handsOutOfFrame: this.handsOutOfFrame,
      kioskLook: this.kioskLook,
      renderMs: this.stats.renderMs,
      solveMs: this.stats.solveMs,
    };
  }

  /** The solution actually drawn last (after the collar guard). */
  drawnSolution: ArSolution | null = null;

  /** Projects scene points with the last solution (source px), for the lab overlay. */
  projectPoints(points: Record<string, Vec3>): Record<string, [number, number]> {
    const s = this.drawnSolution ?? this.tracker.last;
    const out: Record<string, [number, number]> = {};
    if (!s) return out;
    const M = viewMatrix(s.pose, s.pivot);
    for (const [name, X] of Object.entries(points)) {
      const x = M[0] * X[0] + M[1] * X[1] + M[2] * X[2] + M[3];
      const y = M[4] * X[0] + M[5] * X[1] + M[6] * X[2] + M[7];
      const z = M[8] * X[0] + M[9] * X[1] + M[10] * X[2] + M[11];
      if (z <= 0) continue;
      out[name] = [
        (s.intrinsics.f * x) / z + s.intrinsics.cx,
        (s.intrinsics.f * y) / z + s.intrinsics.cy,
      ];
    }
    return out;
  }

  private detach() {
    this.observer?.disconnect();
    this.observer = undefined;
    this.wrapper?.remove();
    this.wrapper = undefined;
    this.laidOut = undefined;
    this.stage = undefined;
    this.badge = undefined;
    this.videoTexture?.dispose();
    this.videoTexture = undefined;
    this.maskTexture?.dispose();
    this.maskTexture = undefined;
    this.environment?.dispose();
    this.environment = undefined;
    this.scene.environment = null;
    this.glueRenderer?.dispose();
    this.glueRenderer = undefined;
    this.sleeveGlue?.sleeveL.dispose();
    this.sleeveGlue?.sleeveR.dispose();
    this.sleeveGlue = undefined;
    this.sleeves.dispose();
    this.f3x?.dispose();
    this.overlayTag = undefined;
    if (this.kiosk) {
      this.lend.remove(this.kiosk.layer);
      this.kiosk.dispose();
      this.kiosk = undefined;
    }
    if (this.bodyOccluder) {
      this.scene.remove(this.bodyOccluder.mesh);
      this.bodyOccluder.mesh.geometry.dispose();
      this.bodyOccluder = undefined;
    }
    this.renderer?.dispose();
    this.renderer = undefined;
    this.ready = new WeakSet();
  }

  dispose(): void {
    this.detach();
    this.background.geometry.dispose();
    this.background.material.dispose();
    this.occluder.geometry.dispose();
    this.occluder.material.dispose();
    this.fadeQuad.geometry.dispose();
    this.fadeQuad.material.dispose();

    this.depthOnly.dispose();
    this.shadowDummy.dispose();
    this.finisher?.dispose?.();
    this.tracker.reset();
  }
}
