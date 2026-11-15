// Main-thread side of the hand pull (M4). Plain DOM + Three.js; no React.
//
// Input: PinchEvent / HandFrame from @satisfy/vision (live tracker or a replayed recording,
// same path). Output: grab/move/release messages to the cloth worker, a hand cursor drawn every
// render frame, the grab highlight and the live tension map. The render thread never waits:
// the worker steps the local region on its own fixed-rate loop and posts frames back.
import { Plane, Raycaster, Vector2, Vector3, type PerspectiveCamera } from 'three';
import type { HandFrame, PinchEvent } from '@satisfy/vision';
import type { GarmentLayer } from '../GarmentLayer';
import type { PullMessage, RelaxResult } from '../cloth/ClothClient';
import { HAND_PULL, HAND_TENSION } from './config';
import { formatFollow, parseAssetKey, TautDetector } from './tension';
import { InteractController } from '../interact/InteractController';
import {
  cursorState,
  ndcToPixels,
  percentile,
  pinchPoint,
  selectPatch,
  toViewport,
  vertexAdjacency,
  type Adjacency,
  type CursorState,
  type Ndc,
} from './mapping';

export interface HandPullHost {
  garment: GarmentLayer;
  camera: PerspectiveCamera;
  /** Element holding the viewer canvas; the cursor overlay is appended to it. */
  container: HTMLElement;
}

/** Optional presentation knobs (agent ZB's Studio Fit Lab; defaults = the kiosk's look). */
export interface HandPullOptions {
  /** Whole-garment settle before grabs (simulated s); default HAND_PULL.settleSeconds. */
  settleSeconds?: number;
  /** Readout accent while following / when taut (CSS colours). */
  followColour?: string;
  tautColour?: string;
  /** Readout card colours (background while following / taut, and text). */
  readoutBackground?: string;
  readoutTautBackground?: string;
  readoutText?: string;
}

export interface HandPullUiState {
  ready: boolean;
  cursor: CursorState;
  /** A hand is in view (any hand, last 300 ms). */
  handSeen: boolean;
  /** Ambiguous grip being confirmed (tracker dwell): the ring is amber. */
  ambiguous: boolean;
  overGarment: boolean;
}

export interface HandPullStats {
  /** Render frames (rAF) per second while the pull UI runs: p50 and p5 (slow frames). */
  fpsP50: number;
  fpsP5: number;
  frames: number;
  /** Camera frame (PinchEvent.frameTime) → first render frame drawing the moved cloth (ms). */
  latencyP50: number;
  latencyP95: number;
  latencySamples: number;
  /** Solver work per live frame (ms, all trials) and delivered live frame rate (Hz). */
  stepP50: number;
  stepP95: number;
  deliveredHz: number;
  grabs: number;
  /** Closed hands while the cursor was not over the garment (nothing grabbed). */
  missedGrabs: number;
  /** Largest region strain excess over the fabric limit seen (ratio points). */
  maxExcess: number;
  /**
   * Largest pre-grab excess left in a region by the settle (solver residue the 20 cleanup
   * passes could not remove); the clamp then holds max(strainMargin, this).
   */
  maxBaseline: number;
  /** Largest per-edge clamp violation (relative length); ≤ 1e-6 = the clamp held. */
  maxOverClamp: number;
  maxShellRatio: number;
  /** Largest region particle count. */
  regionParticles: number;
  resistingFrames: number;
  pullFrames: number;
  /** Largest follow (m) measured on the grabbed particles over all grabs (tension readout). */
  followMaxM: number;
  /** Pulling frames flagged taut (tension.ts TautDetector). */
  tautFrames: number;
  /** Render frames where the readout intersected the jacket's on-screen box (want 0). */
  readoutOverlapFrames: number;
}

/** One finished pull, measured on the solver's particles (observation only). */
export interface PullFollow {
  fit: string;
  size: string;
  /** Largest follow during the pull (m). */
  followMaxM: number;
  /** The fabric went taut (stopped following the hand) at least once. */
  taut: boolean;
  /** Pulling frames received. */
  frames: number;
}

/** Result of measureStandardPull(): same pull path, fixed point and direction. */
export interface StandardPull extends PullFollow {
  /** Taut in the last frame (the pull ended held at the fabric's limit). */
  tautAtEnd: boolean;
  /** Follow in the last frame (m). */
  followEndM: number;
  /** Requested displacement (m) and grab point (viewport NDC). */
  requestM: number;
  at: Ndc;
}

interface Grab {
  hand: PinchEvent['hand'];
  point: Vector3;
  plane: Plane;
  toCamera: Vector3;
  ids: number[];
  weights: number[];
  /** Jacket bounding box on screen at grab start (px), to dock the readout beside it. */
  box: { minX: number; maxX: number; minY: number; maxY: number };
  frames: number;
}

const HAND_SEEN_MS = 300;
const MISSED_SHOW_MS = 700;
/** Cursor smoothing time constant (s): renders at 60 fps from 30 Hz hand frames, no jumps. */
const CURSOR_TAU_S = 0.03;
const SAMPLE_LIMIT = 2000;
/** Rays (≈1 ms each) spent confirming tolerance candidates for one pick. */
const PICK_CONFIRM_RAYS = 6;
/** Readout colours: following (green, as the grabbing cursor) and taut (amber, as resisting). */
const FOLLOW_COLOUR = '#3ddc84';
const TAUT_COLOUR = '#ffb020';
/** A standard pull gives up when the worker sends no frame for this long (ms). */
const STANDARD_TIMEOUT_MS = 15_000;

export class HandPullController {
  onUi?: (state: HandPullUiState) => void;
  onError?: (message: string) => void;
  private ready = false;
  private disposed = false;
  private adjacency?: Adjacency;
  private assetKey?: string;
  private grab?: Grab;
  /** Pinch that started off the garment: its moves/end are ignored. */
  private missedHand?: PinchEvent['hand'];
  private missedAt = -Infinity;
  private cursorHand?: PinchEvent['hand'];
  private target?: { x: number; y: number };
  private shown?: { x: number; y: number };
  private progress = 0;
  private ambiguous = false;
  private overGarment = false;
  private lastHandAt = -Infinity;
  private resisting = false;
  private fade = 0;
  private releasedAt = -Infinity;
  private raf = 0;
  private lastRaf = 0;
  private pendingLatency: number[] = [];
  private readonly raycaster = new Raycaster();
  private readonly cursor: HTMLDivElement;
  private readonly ring: SVGCircleElement;
  private readonly dot: SVGCircleElement;
  private lastUi = '';
  private readonly band: SVGLineElement;
  private readonly bandSvg: SVGSVGElement;
  /** Tension readout beside the jacket at the cursor's height (follow in cm/in, taut). */
  private readonly readout: HTMLDivElement;
  private readonly readoutValue: HTMLSpanElement;
  private readonly readoutState: HTMLSpanElement;
  private readonly taut = new TautDetector();
  private follow = 0;
  private gap = 0;
  private lastReadout = '';
  private readoutSize: [number, number] = [0, 0];
  /** A hand pull ended (not fired for standard pulls, which resolve their own promise). */
  onGrabEnd?: (pull: PullFollow) => void;
  private measuring?: {
    lastFrameAt: number;
    request: number;
    at: Ndc;
    resolve: (result: StandardPull) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setInterval>;
  };
  /**
   * Interactive zip and hood (agent Z): a pinch that starts on the zip pull, the hood or an
   * opened front drives them instead of the hand pull; mouse/touch drags go to it directly.
   */
  readonly interact?: InteractController;
  /** Hand holding the zip/hood (its moves and end go to `interact`). */
  private interactHand?: PinchEvent['hand'];
  /** Every pinch start: viewport point and whether it grabbed (gating audit, numbers only). */
  private starts: Array<{ x: number; y: number; grabbed: boolean }> = [];
  private samples = {
    frameMs: [] as number[],
    latency: [] as number[],
    step: [] as number[],
    interval: [] as number[],
  };
  private counters = {
    grabs: 0,
    missed: 0,
    maxExcess: -Infinity,
    maxBaseline: 0,
    maxOverClamp: -Infinity,
    maxShellRatio: 0,
    regionParticles: 0,
    resisting: 0,
    pull: 0,
    followMax: 0,
    readoutOverlap: 0,
    taut: 0,
  };

  private followColour: string;
  private tautColour: string;

  constructor(
    private host: HandPullHost,
    private options: HandPullOptions = {},
  ) {
    this.followColour = options.followColour ?? FOLLOW_COLOUR;
    this.tautColour = options.tautColour ?? TAUT_COLOUR;
    this.cursor = document.createElement('div');
    this.cursor.className = 'hp-cursor';
    const size = HAND_PULL.cursorPx;
    Object.assign(this.cursor.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: `${size}px`,
      height: `${size}px`,
      marginLeft: `${-size / 2}px`,
      marginTop: `${-size / 2}px`,
      pointerEvents: 'none',
      zIndex: '5',
      opacity: '0',
      transition: 'opacity 150ms',
      willChange: 'transform',
    } satisfies Partial<CSSStyleDeclaration>);
    const ns = 'http://www.w3.org/2000/svg',
      svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 44 44');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    const track = document.createElementNS(ns, 'circle');
    for (const [k, v] of Object.entries({
      cx: '22',
      cy: '22',
      r: '18',
      fill: 'none',
      stroke: 'rgba(255,255,255,0.9)',
      'stroke-width': '2.5',
    }))
      track.setAttribute(k, v);
    track.style.filter = 'drop-shadow(0 0 2px rgba(0,0,0,0.55))';
    this.ring = document.createElementNS(ns, 'circle');
    for (const [k, v] of Object.entries({
      cx: '22',
      cy: '22',
      r: '18',
      fill: 'none',
      'stroke-width': '4.5',
      'stroke-linecap': 'round',
      transform: 'rotate(-90 22 22)',
      'stroke-dasharray': `${2 * Math.PI * 18}`,
    }))
      this.ring.setAttribute(k, v);
    this.dot = document.createElementNS(ns, 'circle');
    for (const [k, v] of Object.entries({ cx: '22', cy: '22', r: '4', fill: '#fff' }))
      this.dot.setAttribute(k, v);
    svg.append(track, this.ring, this.dot);
    this.cursor.append(svg);
    host.container.append(this.cursor);
    // Rubber band from the held patch to the hand while the fabric holds it back (slip).
    this.bandSvg = document.createElementNS(ns, 'svg');
    Object.assign(this.bandSvg.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: '4',
    } satisfies Partial<CSSStyleDeclaration>);
    this.band = document.createElementNS(ns, 'line');
    for (const [k, v] of Object.entries({
      stroke: '#ffb020',
      'stroke-width': '3',
      'stroke-dasharray': '6 6',
      'stroke-linecap': 'round',
      opacity: '0',
    }))
      this.band.setAttribute(k, v);
    this.bandSvg.append(this.band);
    host.container.append(this.bandSvg);
    this.readout = document.createElement('div');
    this.readout.className = 'hp-readout';
    Object.assign(this.readout.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      padding: '8px 14px',
      borderRadius: '10px',
      borderLeft: `5px solid ${this.followColour}`,
      background: options.readoutBackground ?? 'rgba(17, 24, 28, 0.84)',
      color: options.readoutText ?? '#fff',
      font: '600 15px/1.25 system-ui, sans-serif',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
      zIndex: '6',
      opacity: '0',
      transition: 'opacity 150ms, background-color 200ms, border-color 200ms',
      willChange: 'transform',
    } satisfies Partial<CSSStyleDeclaration>);
    const label = document.createElement('span');
    label.textContent = 'Fabric followed your hand';
    label.style.opacity = '0.8';
    this.readoutValue = document.createElement('span');
    Object.assign(this.readoutValue.style, { fontSize: '24px', fontWeight: '700' });
    this.readoutState = document.createElement('span');
    this.readout.append(label, this.readoutValue, this.readoutState);
    host.container.append(this.readout);
    const cloth = host.garment.cloth;
    cloth.onPull = (pull) => this.onPull(pull);
    cloth.onError = (message) => {
      this.finishMeasure(new Error(message));
      this.endGrab(performance.now());
      this.onError?.(message);
    };
    cloth.setStrainOutput(true);
    cloth.feel(true);
    try {
      this.interact = new InteractController({
        garment: host.garment,
        camera: host.camera,
        container: host.container,
      });
      // A zip/hood failure disables only the zip panel (InteractUiState.error), not the pull.
    } catch (error) {
      // No zip line on this garment: the hand pull works as before, without the zip/hood.
      console.warn('Zip/hood interaction unavailable:', error);
    }
    this.raf = requestAnimationFrame(this.animate);
  }

  /** Settles the whole garment from its shown shape, then enables grabs. */
  async start(): Promise<RelaxResult> {
    const result = await this.host.garment.cloth.relax(
      this.options.settleSeconds ?? HAND_PULL.settleSeconds,
    );
    if (this.disposed) return result;
    this.host.garment.cloth.setLive(true);
    this.ready = true;
    this.emitUi();
    // The split solver for the zip/hood builds in the worker now (≈0.3 s), not on first touch.
    void this.interact?.prepare().catch(() => undefined);
    return result;
  }

  get isReady() {
    return this.ready;
  }

  /** Harness/diagnostics view of the interaction state (numbers only). */
  snapshot() {
    return {
      ready: this.ready,
      grabbing: !!this.grab,
      resisting: this.resisting,
      grabs: this.counters.grabs,
      missed: this.counters.missed,
      fade: this.fade,
      measuring: !!this.measuring,
      /** Tension readout (m): measured follow, hand-to-fabric gap, taut flag, max this grab. */
      followM: this.follow,
      gapM: this.gap,
      taut: this.taut.taut,
      grabFollowMaxM: this.taut.maxFollow,
    };
  }

  /** Fit id and size of the jacket on screen (from its cloth asset key). */
  identity() {
    const key = this.host.garment.pickTarget?.asset.key;
    return key ? parseAssetKey(key) : undefined;
  }

  /** Per tracker frame: cursor position, grab progress and hover. */
  handleFrame(frame: HandFrame) {
    if (this.disposed) return;
    const hands = frame.hands;
    if (hands.length) this.lastHandAt = performance.now();
    let hand = this.grab ? hands.find((h) => h.hand === this.grab!.hand) : undefined;
    hand ??= hands.find((h) => h.hand === this.cursorHand);
    if (!hand || (!this.grab && hand.grabProgress < 0.05))
      hand = hands.reduce<(typeof hands)[number] | undefined>(
        (best, h) => (!best || h.grabProgress > best.grabProgress ? h : best),
        hand,
      );
    if (!hand) return;
    this.cursorHand = hand.hand;
    this.progress = hand.grabProgress;
    this.ambiguous = hand.gripConfidence === 'ambiguous';
    // Grabbing: the cursor follows the pinch events (same point as the cloth target).
    if (this.grab) return;
    const raw: Ndc =
      'pinchNdc' in hand ? (hand as { pinchNdc: Ndc }).pinchNdc : pinchPoint(hand.landmarks);
    const vp = toViewport(raw);
    this.setTarget(vp);
    // Hover is cosmetic (cursor dot): one direct ray per tracker frame. The grab gate at a
    // pinch start uses the full screen tolerance.
    this.overGarment = this.ready && !!this.pick(vp, 0);
    if (this.ready) this.interact?.setHover(vp);
  }

  handlePinch(event: PinchEvent) {
    if (this.disposed || this.measuring) return;
    this.lastHandAt = performance.now();
    const vp = toViewport(event.ndc);
    if (this.interactHand !== undefined && event.hand === this.interactHand) {
      this.setTarget(vp);
      if (event.type === 'move') this.interact?.move(vp, event.frameTime, event.depthDelta);
      else if (event.type === 'end') {
        this.interact?.end(event.frameTime);
        this.interactHand = undefined;
      }
      return;
    }
    if (event.type === 'start') {
      if (this.grab || this.interact?.isDragging) return; // one grab at a time
      this.cursorHand = event.hand;
      this.setTarget(vp);
      if (this.ready && this.interact?.begin(vp, 'pinch', event.frameTime, event.hand)) {
        this.interactHand = event.hand;
        this.missedHand = undefined;
        return;
      }
      // An opened jacket is not the measured shell: no fit pull until it is closed again.
      if (this.interact?.isOpen) {
        this.missedHand = event.hand;
        this.missedAt = performance.now();
        return;
      }
      const hit = this.ready ? this.pick(vp) : undefined;
      if (this.starts.length < 500) this.starts.push({ x: vp.x, y: vp.y, grabbed: !!hit });
      if (!hit) {
        // Rule 3: closing the hand over empty space does nothing.
        this.missedHand = event.hand;
        this.missedAt = performance.now();
        this.counters.missed++;
        return;
      }
      this.beginGrab(event.hand, event.frameTime, hit);
    } else if (this.grab && event.hand === this.grab.hand) {
      this.setTarget(vp);
      if (event.type === 'move') this.moveGrab(event, vp);
      else this.endGrab(event.frameTime);
    } else if (event.type === 'end' && event.hand === this.missedHand) {
      this.missedHand = undefined;
    }
  }

  private setTarget(vp: Ndc) {
    const { clientWidth: w, clientHeight: h } = this.host.container;
    this.target = ndcToPixels(vp, w, h);
    this.shown ??= { ...this.target };
  }

  /**
   * Garment under the cursor: exact ray hit, else the nearest visible vertex within the screen
   * tolerance (pickTolerancePx), confirmed by a ray landing within 1.5 cm of it.
   */
  pick(vp: Ndc, tolerancePx: number = HAND_PULL.pickTolerancePx) {
    const target = this.host.garment.pickTarget;
    if (!target) return undefined;
    const { mesh, asset } = target,
      camera = this.host.camera;
    if (this.assetKey !== asset.key) {
      this.adjacency = vertexAdjacency(asset.triangles, asset.panels.length);
      this.assetKey = asset.key;
    }
    mesh.updateMatrixWorld();
    const cast = (ndc: Ndc) => {
      this.raycaster.setFromCamera(new Vector2(ndc.x, ndc.y), camera);
      const hit = this.raycaster.intersectObject(mesh, false)[0];
      return hit?.face
        ? { point: hit.point.clone(), face: [hit.face.a, hit.face.b, hit.face.c] }
        : undefined;
    };
    const direct = cast(vp);
    if (direct || !(tolerancePx > 0)) return direct;
    const { clientWidth: w, clientHeight: h } = this.host.container,
      tol = tolerancePx,
      positions = mesh.geometry.getAttribute('position'),
      v = new Vector3();
    // Candidates within the tolerance, nearest first; the nearest few are confirmed by a ray
    // (an occluded vertex, e.g. behind the collar at the shoulder silhouette, is skipped).
    const candidates: Array<{ i: number; d: number; x: number; y: number }> = [];
    for (let i = 0; i < positions.count; i++) {
      v.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld).project(camera);
      if (v.z > 1) continue;
      const dx = ((v.x - vp.x) * w) / 2,
        dy = ((v.y - vp.y) * h) / 2,
        d = dx * dx + dy * dy;
      if (d <= tol * tol) candidates.push({ i, d, x: v.x, y: v.y });
    }
    candidates.sort((a, b) => a.d - b.d);
    for (const c of candidates.slice(0, PICK_CONFIRM_RAYS)) {
      const hit = cast({ x: c.x, y: c.y });
      if (!hit) continue;
      v.fromBufferAttribute(positions, c.i).applyMatrix4(mesh.matrixWorld);
      if (hit.point.distanceTo(v) < 0.015) return hit;
    }
    return undefined;
  }

  /** Jacket bounding box on screen (viewport NDC), from its projected vertices. */
  private screenBox() {
    const target = this.host.garment.pickTarget;
    if (!target) return undefined;
    const positions = target.mesh.geometry.getAttribute('position'),
      v = new Vector3(),
      box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    target.mesh.updateMatrixWorld();
    for (let i = 0; i < positions.count; i++) {
      v.fromBufferAttribute(positions, i).applyMatrix4(target.mesh.matrixWorld);
      v.project(this.host.camera);
      if (v.z > 1) continue;
      box.minX = Math.min(box.minX, v.x);
      box.maxX = Math.max(box.maxX, v.x);
      box.minY = Math.min(box.minY, v.y);
      box.maxY = Math.max(box.maxY, v.y);
    }
    return Number.isFinite(box.minX) ? box : undefined;
  }

  private beginGrab(
    hand: PinchEvent['hand'],
    frameTime: number,
    hit: { point: Vector3; face: number[] },
  ) {
    const target = this.host.garment.pickTarget!;
    const positions = target.mesh.geometry.getAttribute('position').array;
    const point = [hit.point.x, hit.point.y, hit.point.z];
    const patch = selectPatch(positions, this.adjacency!, hit.face, point);
    const toCamera = this.host.camera.position.clone().sub(hit.point).normalize();
    const { clientWidth: w, clientHeight: h } = this.host.container,
      ndc = this.screenBox() ?? { minX: -1, maxX: 1, minY: -1, maxY: 1 },
      topLeft = ndcToPixels({ x: ndc.minX, y: ndc.maxY }, w, h),
      bottomRight = ndcToPixels({ x: ndc.maxX, y: ndc.minY }, w, h);
    this.grab = {
      hand,
      point: hit.point,
      plane: new Plane().setFromNormalAndCoplanarPoint(toCamera, hit.point),
      toCamera,
      ids: patch.ids,
      weights: patch.weights,
      box: { minX: topLeft.x, maxX: bottomRight.x, minY: topLeft.y, maxY: bottomRight.y },
      frames: 0,
    };
    this.taut.reset();
    this.follow = 0;
    this.gap = 0;
    this.counters.grabs++;
    this.missedHand = undefined;
    this.host.garment.cloth.pullBegin(patch.ids, patch.weights, point, frameTime);
    // Tension map weight: 1 at the grab, 0 at the region radius (smoothstep).
    const near = new Float32Array(positions.length / 3),
      r = HAND_PULL.regionRadiusM;
    for (let i = 0; i < near.length; i++) {
      const d = Math.hypot(
        positions[i * 3] - point[0],
        positions[i * 3 + 1] - point[1],
        positions[i * 3 + 2] - point[2],
      );
      const t = Math.max(0, Math.min(1, 1 - d / r));
      near[i] = t * t * (3 - 2 * t);
    }
    this.host.garment.setGrabHighlight(patch, near);
    this.fade = 1;
    this.resisting = false;
  }

  private moveGrab(event: PinchEvent, vp: Ndc) {
    const grab = this.grab!;
    this.raycaster.setFromCamera(new Vector2(vp.x, vp.y), this.host.camera);
    const onPlane = this.raycaster.ray.intersectPlane(grab.plane, new Vector3());
    if (!onPlane) return;
    // Screen-plane displacement follows the cursor 1:1 at the grab depth; depthDelta (hand
    // toward the camera = +) moves the patch along the view direction, scaled and clamped.
    const depth = Math.max(
      -HAND_PULL.depthMaxM,
      Math.min(HAND_PULL.depthMaxM, event.depthDelta * HAND_PULL.depthScale),
    );
    const d = onPlane.sub(grab.point).addScaledVector(grab.toCamera, depth);
    this.host.garment.cloth.pullMove([d.x, d.y, d.z], event.frameTime);
  }

  private endGrab(frameTime: number) {
    const grab = this.grab;
    if (!grab) return;
    this.grab = undefined;
    this.host.garment.cloth.pullEnd(frameTime);
    this.releasedAt = performance.now();
    this.resisting = false;
    const id = this.identity();
    if (!this.measuring && id && grab.frames > 0)
      this.onGrabEnd?.({
        ...id,
        followMaxM: this.taut.maxFollow,
        taut: this.taut.tautSamples > 0,
        frames: grab.frames,
      });
  }

  /**
   * Standard pull for comparing sizes: the same pull path as a hand (pullBegin/pullMove/pullEnd
   * → worker → PullDriver), grabbed at a fixed point of the jacket's on-screen box and pulled
   * HAND_TENSION.standardPullM straight toward the camera (out from the body) for
   * HAND_TENSION.standardFrames solver frames, then released. Live hand input is ignored
   * meanwhile. Resolves with the follow measured on the solver's particles.
   */
  measureStandardPull(): Promise<StandardPull> {
    const cfg = HAND_TENSION;
    if (!this.ready) return Promise.reject(new Error('The fabric is still settling'));
    if (this.grab || this.measuring) return Promise.reject(new Error('A pull is in progress'));
    if (this.interact?.isOpen || this.interact?.isDragging)
      return Promise.reject(
        new Error('The jacket is open: close it to measure (open, not measured)'),
      );
    const box = this.screenBox();
    if (!box || !this.identity()) return Promise.reject(new Error('No jacket on screen'));
    const at = {
      x: (box.minX + box.maxX) / 2 + cfg.standardAtX * (box.maxX - box.minX),
      y: box.minY + cfg.standardAtY * (box.maxY - box.minY),
    };
    const hit = this.pick(at);
    if (!hit) return Promise.reject(new Error('The standard grab point is not on the jacket'));
    return new Promise<StandardPull>((resolve, reject) => {
      const timer = setInterval(() => {
        const m = this.measuring;
        if (m && performance.now() - m.lastFrameAt > STANDARD_TIMEOUT_MS)
          this.finishMeasure(new Error('The cloth solver sent no frames'));
      }, 500);
      const now = performance.now();
      this.measuring = { lastFrameAt: now, request: cfg.standardPullM, at, resolve, reject, timer };
      this.setTarget(at);
      this.beginGrab('right', now, hit);
      const d = this.grab!.toCamera.clone().multiplyScalar(cfg.standardPullM);
      this.host.garment.cloth.pullMove([d.x, d.y, d.z], now);
    });
  }

  private finishMeasure(error?: Error) {
    const m = this.measuring;
    if (!m) return;
    clearInterval(m.timer);
    const id = this.identity();
    const result: StandardPull | undefined = id && {
      ...id,
      followMaxM: this.taut.maxFollow,
      taut: this.taut.tautSamples > 0,
      tautAtEnd: this.taut.taut,
      followEndM: this.follow,
      frames: this.grab?.frames ?? 0,
      requestM: m.request,
      at: m.at,
    };
    this.endGrab(performance.now());
    this.measuring = undefined;
    if (error || !result) m.reject(error ?? new Error('No jacket on screen'));
    else m.resolve(result);
  }

  private onPull(pull: PullMessage) {
    if (pull.phase === 'pulling') {
      this.counters.pull++;
      this.resisting = pull.resisting;
      if (pull.resisting) this.counters.resisting++;
      this.counters.maxExcess = Math.max(this.counters.maxExcess, pull.strain.maxExcess);
      this.counters.maxBaseline = Math.max(this.counters.maxBaseline, pull.baselineExcess);
      this.counters.maxOverClamp = Math.max(this.counters.maxOverClamp, pull.overClamp);
      this.counters.maxShellRatio = Math.max(
        this.counters.maxShellRatio,
        pull.strain.maxShellRatio,
      );
      // Tension readout: follow measured on the particles by the driver (read-only), judged here.
      if (this.grab) {
        this.grab.frames++;
        this.follow = Math.hypot(...pull.follow);
        this.gap = pull.gap;
        if (this.taut.update({ t: performance.now() / 1000, follow: this.follow, gap: this.gap }))
          this.counters.taut++;
        this.counters.followMax = Math.max(this.counters.followMax, this.follow);
        const m = this.measuring;
        if (m) {
          m.lastFrameAt = performance.now();
          if (this.grab.frames >= HAND_TENSION.standardFrames) this.finishMeasure();
        }
      }
    }
    this.counters.regionParticles = Math.max(this.counters.regionParticles, pull.particles);
    push(this.samples.step, pull.stepMs);
    if (pull.intervalMs > 0) push(this.samples.interval, pull.intervalMs);
    // Positions are applied (onFrame ran first); the next render frame draws them.
    if (pull.frameTime > 0) this.pendingLatency.push(pull.frameTime);
  }

  private animate = (time: number) => {
    if (this.disposed) return;
    const dt = this.lastRaf ? Math.min(0.1, (time - this.lastRaf) / 1000) : 0;
    if (this.lastRaf) push(this.samples.frameMs, time - this.lastRaf);
    this.lastRaf = time;
    const now = performance.now();
    for (const t of this.pendingLatency) push(this.samples.latency, now - t);
    this.pendingLatency = [];
    // Cursor: exponential follow at render rate.
    if (this.target && this.shown) {
      const a = 1 - Math.exp(-dt / CURSOR_TAU_S);
      this.shown.x += (this.target.x - this.shown.x) * a;
      this.shown.y += (this.target.y - this.shown.y) * a;
      this.cursor.style.transform = `translate(${this.shown.x}px, ${this.shown.y}px)`;
    }
    const handSeen =
      now - this.lastHandAt < HAND_SEEN_MS || !!this.grab || this.interactHand !== undefined;
    this.cursor.style.opacity = handSeen && this.ready ? '1' : '0';
    const missed = this.missedHand !== undefined || now - this.missedAt < MISSED_SHOW_MS;
    const state = cursorState({
      grabbing: !!this.grab || this.interactHand !== undefined,
      resisting: this.resisting,
      missed,
      grabProgress: this.progress,
    });
    const circumference = 2 * Math.PI * 18,
      fill = state === 'grabbing' || state === 'resisting' ? 1 : this.progress;
    this.ring.setAttribute('stroke-dashoffset', String(circumference * (1 - fill)));
    const colour =
      state === 'grabbing'
        ? '#3ddc84'
        : state === 'resisting' || (state === 'confirming' && this.ambiguous)
          ? '#ffb020'
          : state === 'missed'
            ? '#ff6b5b'
            : '#ffffff';
    this.ring.setAttribute('stroke', colour);
    this.dot.setAttribute('fill', this.overGarment || this.grab ? colour : 'rgba(255,255,255,0.5)');
    // Rubber band: projected patch centre → cursor while resisting.
    const target = this.host.garment.pickTarget;
    if (this.grab && this.resisting && this.shown && target) {
      const p = target.mesh.geometry.getAttribute('position'),
        c = new Vector3(),
        v = new Vector3();
      let total = 0;
      this.grab.ids.forEach((id, j) => {
        c.addScaledVector(v.fromBufferAttribute(p, id), this.grab!.weights[j]);
        total += this.grab!.weights[j];
      });
      c.divideScalar(total).applyMatrix4(target.mesh.matrixWorld).project(this.host.camera);
      const { clientWidth: w, clientHeight: h } = this.host.container,
        q = ndcToPixels({ x: c.x, y: c.y }, w, h);
      this.band.setAttribute('x1', String(q.x));
      this.band.setAttribute('y1', String(q.y));
      this.band.setAttribute('x2', String(this.shown.x));
      this.band.setAttribute('y2', String(this.shown.y));
      this.band.setAttribute('opacity', '0.9');
    } else this.band.setAttribute('opacity', '0');
    this.drawReadout();
    // Tension map: full while pulling, fades after release.
    if (!this.grab && this.fade > 0) {
      this.fade = Math.max(0, 1 - (now - this.releasedAt) / 1000 / HAND_PULL.tensionFadeS);
      if (this.fade === 0) this.host.garment.setGrabHighlight(null);
    }
    const stretchMax = this.host.garment.pickTarget?.asset.config.stretchMax ?? 1.03;
    this.host.garment.setGrabFade(
      this.fade,
      !!this.grab || !!this.interact?.tinting,
      stretchMax - 1 + HAND_PULL.strainMargin,
    );
    this.emitUi(state, handSeen);
    this.raf = requestAnimationFrame(this.animate);
  };

  /**
   * Readout docked just outside the jacket's on-screen box (right side unless there is no room),
   * at the cursor's height, so it never covers the jacket. Green while the fabric follows, amber
   * once it is taut.
   */
  private drawReadout() {
    const grab = this.grab;
    if (!grab || !this.shown) {
      this.readout.style.opacity = '0';
      return;
    }
    const taut = this.taut.taut,
      value = formatFollow(this.follow),
      ahead = formatFollow(this.gap).split(' · ')[0],
      key = `${value}|${taut}|${ahead}`;
    if (key !== this.lastReadout) {
      this.lastReadout = key;
      this.readoutValue.textContent = value;
      this.readoutState.textContent = taut
        ? `Taut: no more give · hand ${ahead} ahead`
        : 'Following';
      this.readoutState.style.color = taut ? this.tautColour : this.followColour;
      this.readout.style.borderLeftColor = taut ? this.tautColour : this.followColour;
      this.readout.style.backgroundColor = taut
        ? (this.options.readoutTautBackground ?? 'rgba(74, 50, 6, 0.92)')
        : (this.options.readoutBackground ?? 'rgba(17, 24, 28, 0.84)');
      // Size read only when the text changed (one layout then, none on other frames).
      this.readoutSize = [this.readout.offsetWidth, this.readout.offsetHeight];
    }
    const { clientWidth: w, clientHeight: h } = this.host.container,
      [rw, rh] = this.readoutSize,
      margin = 24,
      right = grab.box.maxX + margin,
      left = grab.box.minX - margin - rw;
    // Right of the jacket; else left of it; else (no room either side) beside the cursor.
    const x =
      right + rw <= w - 8 ? right : left >= 8 ? left : Math.min(w - rw - 8, this.shown.x + 32);
    // Docked right: stay below the camera preview (top right, 24 + 135 px). Above the footer.
    const top = x === right ? 176 : 8,
      y = Math.max(top, Math.min(h - rh - 120, this.shown.y - rh / 2));
    this.readout.style.transform = `translate(${x}px, ${y}px)`;
    // Audit (e2e): render frames where the readout box intersects the jacket box.
    if (x < grab.box.maxX && x + rw > grab.box.minX && y < grab.box.maxY && y + rh > grab.box.minY)
      this.counters.readoutOverlap++;
    this.readout.style.opacity = '1';
  }

  private emitUi(cursor: CursorState = 'open', handSeen = false) {
    const state: HandPullUiState = {
      ready: this.ready,
      cursor,
      handSeen,
      ambiguous: this.ambiguous,
      overGarment: this.overGarment,
    };
    const key = JSON.stringify(state);
    if (key === this.lastUi) return;
    this.lastUi = key;
    this.onUi?.(state);
  }

  stats(): HandPullStats {
    const fps = this.samples.frameMs.map((ms) => 1000 / ms);
    const interval = percentile(this.samples.interval, 50);
    return {
      fpsP50: percentile(fps, 50),
      fpsP5: percentile(fps, 5),
      frames: fps.length,
      latencyP50: percentile(this.samples.latency, 50),
      latencyP95: percentile(this.samples.latency, 95),
      latencySamples: this.samples.latency.length,
      stepP50: percentile(this.samples.step, 50),
      stepP95: percentile(this.samples.step, 95),
      deliveredHz: interval > 0 ? 1000 / interval : NaN,
      grabs: this.counters.grabs,
      missedGrabs: this.counters.missed,
      maxExcess: this.counters.maxExcess,
      maxBaseline: this.counters.maxBaseline,
      maxOverClamp: this.counters.maxOverClamp,
      maxShellRatio: this.counters.maxShellRatio,
      regionParticles: this.counters.regionParticles,
      resistingFrames: this.counters.resisting,
      pullFrames: this.counters.pull,
      followMaxM: this.counters.followMax,
      tautFrames: this.counters.taut,
      readoutOverlapFrames: this.counters.readoutOverlap,
    };
  }

  /** Pinch starts since the last resetStats(): viewport point and whether each grabbed. */
  startLog() {
    return this.starts.map((s) => ({ ...s }));
  }

  resetStats() {
    this.starts = [];
    for (const list of Object.values(this.samples)) list.length = 0;
    Object.assign(this.counters, {
      grabs: 0,
      missed: 0,
      maxExcess: -Infinity,
      maxBaseline: 0,
      maxOverClamp: -Infinity,
      maxShellRatio: 0,
      regionParticles: 0,
      resisting: 0,
      pull: 0,
      followMax: 0,
      readoutOverlap: 0,
      taut: 0,
    });
  }

  /** Stops the loop, restores the shown garment shape and removes the cursor. */
  dispose() {
    if (this.disposed) return;
    this.finishMeasure(new Error('Feel the fabric closed'));
    this.endGrab(performance.now());
    this.interact?.dispose();
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    const cloth = this.host.garment.cloth;
    cloth.onPull = undefined;
    cloth.onError = undefined;
    cloth.setLive(false);
    cloth.feel(false);
    cloth.setStrainOutput(false);
    this.host.garment.setGrabHighlight(null);
    this.host.garment.setGrabFade(0, false);
    this.cursor.remove();
    this.bandSvg.remove();
    this.readout.remove();
  }
}

function push(list: number[], value: number) {
  list.push(value);
  if (list.length > SAMPLE_LIMIT) list.shift();
}
