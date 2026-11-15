// Studio interaction bridge (agent ZB): pinches in front of the camera -> the garment state on the
// bus -> our cloth solver in the Fit Lab panel.
//
//   perception.onPose  -> body frame (shoulders/hips of the person in the REAL image)
//   perception.onHands -> GestureMachine (pinch on the zip pull / hood / hem, in body units)
//                      -> bus.set({zip | hoodOn | hemPull}, 'pinch')
//   bus (any source: pinch, slider, ui) -> FitLabPhysics -> InteractController (split solver)
//
// The bus is the single truth: the slider and the hood button write it too, and the physics and
// Decart both follow it, so pinch and slider never disagree. Without a Fit Lab (not mounted, or
// the jacket has no zip line) the bus still gets every value; only the 3D physics is missing.
import type { Perception, SharedCamera, StudioBus } from './contract';
import { blendFrames, bodyFrameFromPose, type BodyFrame } from './interact/bodyFrame';
import { applyTuning, BODY } from './interact/config';
import { FitLabPhysics, type FitLabLink, type PhysicsStatus } from './interact/fitLabPhysics';
import {
  GestureMachine,
  type GestureOutput,
  type HandInput,
  type PhysicsEvent,
} from './interact/gesture';
import { drawOverlayFrame, type OverlayState, type OverlayView } from './interact/overlay';

export type { FitLabLink } from './interact/fitLabPhysics';
export type { OverlayView } from './interact/overlay';

export interface BridgeOptions {
  bus: StudioBus;
  perception: Perception;
  /** Frame size for the image aspect (SharedCamera, or its width/height). */
  camera: Pick<SharedCamera, 'width' | 'height'>;
  /** The Fit Lab panel's interaction accessors; can also be set later with setFitLab(). */
  fitLab?: FitLabLink | null;
  /** Draw the grab boxes and the body frame on the overlay (?zbDebug=1). */
  debug?: boolean;
}

export interface BridgeSnapshot {
  bodySeen: boolean;
  grab: GestureOutput['grab'];
  hands: GestureOutput['hands'];
  physics: PhysicsStatus | 'none';
  physicsError?: string;
  /** The Fit Lab solver's zip/hood state (numbers only), when physics is running. */
  physicsUi: ReturnType<NonNullable<FitLabPhysics['interact']>['state']> | null;
}

export interface BridgeStats {
  handFrames: number;
  poseFrames: number;
  pinchPatches: number;
  grabs: Record<string, number>;
  /** Hands frame time -> bus.set (ms, main-thread gesture work; p50 / max). */
  gestureMsP50: number;
  gestureMsMax: number;
  /** Fit Lab: camera frame of the pinch -> first render frame drawing the moved cloth. */
  physics?: ReturnType<FitLabPhysics['stats']>;
  /** StudioPerception.stats(): tracker rates and camera-frame -> result latency (ms). */
  perception?: unknown;
}

export interface StudioBridge {
  setFitLab(link: FitLabLink | null): void;
  /** Enter the Fit Lab physics now (e.g. a "try the zip" button), before any pinch. */
  prewarm(): void;
  /** Diagnostics: the Fit Lab InteractController while physics runs. */
  interact(): FitLabPhysics['interact'];
  /** Draws the current hand cursor / grab feedback into `canvas` once (device-pixel sized). */
  drawOverlay(canvas: HTMLCanvasElement, view?: Partial<OverlayView>): void;
  /** Keeps `canvas` sized to its CSS box and redrawn every display frame. Returns detach(). */
  attachOverlay(canvas: HTMLCanvasElement, view?: Partial<OverlayView>): () => void;
  snapshot(): BridgeSnapshot;
  stats(): BridgeStats;
  /** Gesture events (tests, diagnostics). */
  onGesture(fn: (e: PhysicsEvent) => void): () => void;
  dispose(): void;
}

/** A hand over a handle this long (ms) prewarms the Fit Lab physics. */
const PREWARM_MS = 250;
/** Pose older than this (ms) no longer anchors a new grab. */
const POSE_STALE_MS = 1000;

export function createBridge(options: BridgeOptions): StudioBridge {
  const { bus, perception, camera } = options;
  const aspect = camera.width / camera.height;
  const machine = new GestureMachine();
  let frame: BodyFrame | null = null,
    frameAt = -Infinity,
    last: GestureOutput = { patch: null, events: [], grab: null, hands: [] },
    physics: FitLabPhysics | undefined,
    hoverSince = 0,
    disposed = false;
  const listeners = new Set<(e: PhysicsEvent) => void>();
  const stats = {
    handFrames: 0,
    poseFrames: 0,
    pinchPatches: 0,
    grabs: {} as Record<string, number>,
  };
  const gestureMs: number[] = [];

  const setFitLab = (link: FitLabLink | null) => {
    physics?.dispose();
    physics = link ? new FitLabPhysics(link, bus) : undefined;
  };
  if (options.fitLab) setFitLab(options.fitLab);

  const offPose = perception.onPose((p) => {
    stats.poseFrames++;
    const f = bodyFrameFromPose(p.image, aspect);
    if (!f) return;
    frame = blendFrames(frame, f, BODY.smoothing);
    frameAt = p.timeMs;
  });

  const offHands = perception.onHands((h) => {
    if (disposed) return;
    stats.handFrames++;
    const t0 = performance.now();
    const usable =
      frame && h.timeMs - frameAt <= POSE_STALE_MS ? frame : machine.current ? frame : null;
    const hands: HandInput[] = h.hands.map((x) => ({
      handedness: x.handedness,
      pinching: x.pinching,
      pinchPoint: x.pinchPoint,
    }));
    const state = bus.get();
    last = machine.update(h.timeMs, usable, hands, state);
    // A hand resting on a handle for PREWARM_MS: start the Fit Lab's physics before the pinch.
    if (last.hands.some((x) => x.target)) {
      hoverSince ||= h.timeMs;
      if (h.timeMs - hoverSince >= PREWARM_MS) physics?.prewarm();
    } else hoverSince = 0;
    for (const e of last.events) {
      if (e.phase === 'start') stats.grabs[e.kind] = (stats.grabs[e.kind] ?? 0) + 1;
      // Hood start before the bus write, so the live hold begins from the solver's current hood.
      physics?.onGesture(e);
      for (const l of listeners) l(e);
    }
    if (last.patch) {
      stats.pinchPatches++;
      physics?.setInputTime(h.timeMs);
      bus.set(last.patch, 'pinch');
    }
    gestureMs.push(performance.now() - t0);
    if (gestureMs.length > 600) gestureMs.shift();
  });

  const overlayState = (): OverlayState => ({
    frame,
    hands: last.hands,
    grab: last.grab,
    values: bus.get(),
    debug: options.debug,
    note: options.debug
      ? `physics ${physics?.status ?? 'none'}${physics?.error ? ': ' + physics.error : ''} · grab ${last.grab?.kind ?? '-'}`
      : physics?.status === 'unavailable'
        ? 'Fit Lab physics off'
        : null,
  });

  const fullView = (view?: Partial<OverlayView>): OverlayView => ({
    mirrored: view?.mirrored ?? true,
    fit: view?.fit ?? 'cover',
    sourceWidth: view?.sourceWidth ?? camera.width,
    sourceHeight: view?.sourceHeight ?? camera.height,
  });

  const drawOverlay = (canvas: HTMLCanvasElement, view?: Partial<OverlayView>) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawOverlayFrame(
      ctx,
      overlayState(),
      fullView(view),
      canvas.width,
      canvas.height,
      window.devicePixelRatio || 1,
    );
  };

  const attachOverlay = (canvas: HTMLCanvasElement, view?: Partial<OverlayView>) => {
    let raf = 0;
    const loop = () => {
      const dpr = window.devicePixelRatio || 1,
        w = Math.max(1, Math.round(canvas.clientWidth * dpr)),
        h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      drawOverlay(canvas, view);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    };
  };

  const sorted = () => [...gestureMs].sort((a, b) => a - b);

  return {
    setFitLab,
    prewarm: () => physics?.prewarm(),
    interact: () => physics?.interact,
    drawOverlay,
    attachOverlay,
    snapshot: () => ({
      bodySeen: !!frame,
      grab: last.grab,
      hands: last.hands,
      physics: physics?.status ?? 'none',
      physicsError: physics?.error,
      physicsUi: physics?.interact?.state() ?? null,
    }),
    stats: () => {
      const s = sorted();
      return {
        ...stats,
        grabs: { ...stats.grabs },
        gestureMsP50: s.length ? s[Math.floor(s.length / 2)] : NaN,
        gestureMsMax: s.length ? s[s.length - 1] : NaN,
        physics: physics?.stats(),
        perception: (perception as { stats?: () => unknown }).stats?.(),
      };
    },
    onGesture(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      disposed = true;
      offPose();
      offHands();
      physics?.dispose();
      physics = undefined;
      listeners.clear();
    },
  };
}

export interface StartBridgeDeps {
  bus: StudioBus;
  perception: Perception;
  camera: Pick<SharedCamera, 'width' | 'height'>;
  /** Layer over the big view (DC); CSS-mirrored together with the video when `.mirror` is set. */
  overlayHost?: HTMLElement;
  /** The Fit Lab panel object (FL); duck-typed for interactHost / enterPhysics / exitPhysics. */
  fitLab?: unknown;
}

const asFitLabLink = (value: unknown): FitLabLink | null =>
  value && typeof value === 'object' && ('interactHost' in value || 'interact' in value)
    ? (value as FitLabLink)
    : null;

/**
 * The shell's entry point (DC's main.ts): starts the bridge, adds the overlay canvas to
 * `overlayHost`, and wires the Fit Lab when given. Returns the bridge (dispose() included).
 */
export function startBridge(deps: StartBridgeDeps): StudioBridge {
  const search = typeof location === 'undefined' ? '' : location.search;
  // Live tuning on the user's test: ?zbTune=zip.halfWidth:0.3,... (see interact/config.ts).
  const tuned = applyTuning(search);
  if (tuned.length) console.info('[studio/interact] tuning applied:', tuned.join(', '));
  const bridge = createBridge({
    debug: new URLSearchParams(search).get('zbDebug') === '1',
    bus: deps.bus,
    perception: deps.perception,
    camera: deps.camera,
    fitLab: asFitLabLink(deps.fitLab),
  });
  let detach: (() => void) | undefined;
  let canvas: HTMLCanvasElement | undefined;
  const host = deps.overlayHost;
  if (host) {
    canvas = document.createElement('canvas');
    canvas.className = 'zb-pinch-overlay';
    Object.assign(canvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    host.append(canvas);
    const view: Partial<OverlayView> = { fit: 'contain', mirrored: false };
    const shown = canvas;
    // The host is mirrored by CSS together with the video. Flip the canvas back and mirror the
    // coordinates ourselves, so the cursor stays on the hand and the labels stay readable.
    const sync = () => {
      const mirrored = !!host.closest('.mirror');
      view.mirrored = mirrored;
      shown.style.transform = mirrored ? 'scaleX(-1)' : '';
      const video = host.parentElement?.querySelector('video');
      view.sourceWidth = video?.videoWidth || deps.camera.width;
      view.sourceHeight = video?.videoHeight || deps.camera.height;
    };
    sync();
    const timer = window.setInterval(sync, 500);
    const off = bridge.attachOverlay(canvas, view);
    detach = () => {
      clearInterval(timer);
      off();
    };
  }
  const dispose = bridge.dispose;
  bridge.dispose = () => {
    detach?.();
    canvas?.remove();
    dispose();
  };
  if (typeof window !== 'undefined') {
    // Diagnostics (numbers only): the bridge and the bus it writes.
    const w = window as unknown as { __studioBridge?: StudioBridge; __studioBus?: StudioBus };
    w.__studioBridge = bridge;
    w.__studioBus = deps.bus;
    (window as unknown as { __studioFitLab?: unknown }).__studioFitLab = deps.fitLab;
  }
  return bridge;
}
