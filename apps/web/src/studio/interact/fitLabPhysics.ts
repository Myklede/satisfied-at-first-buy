// The Fit Lab panel's real cloth physics for the zip and hood, following the Studio bus
// (agent ZB). The bus is the single truth: pinch, slider and the hood button all write it; this
// class makes our split cloth solver (engine/interact InteractController + the cloth worker)
// follow it continuously. A pinch on the hood also holds the solver's hood live, so the peel
// follows the hand; when the hand lets go the solver is reconciled with the bus.
//
// Physics mode: the Fit Lab normally shows a skinned live PREVIEW (no cloth solver in the worker).
// On the first grab, or when the bus leaves "zip closed + hood on", the panel is asked to enter
// physics (FL's enterPhysics: pause the live pose, simulate the jacket on the static body, as the
// kiosk's Feel screen). When everything is closed again and idle, it goes back to live.
import { Vector3, type Mesh, type PerspectiveCamera } from 'three';
import { HandPullController } from '../../engine/hand/HandPullController';
import { HAND_PULL } from '../../engine/hand/config';
import type { GarmentLayer } from '../../engine/GarmentLayer';
import { InteractController, type InteractUiState } from '../../engine/interact/InteractController';
import type { GarmentState, StudioBus } from '../contract';
import { THEME, TONE_COLOR } from '../fitlab/ui/theme';
import { HEM_GRAB, HOOD_GRAB } from './config';
import type { PhysicsEvent } from './gesture';

export interface InteractHostLike {
  garment: GarmentLayer;
  camera: PerspectiveCamera;
  container: HTMLElement;
}

/** What the Fit Lab panel (FL) exposes; every member optional (duck-typed). */
export interface FitLabLink {
  /** FL names the layer `garmentLayer`; engine/interact's InteractHost names it `garment`. */
  interactHost?(): {
    garment?: GarmentLayer;
    garmentLayer?: GarmentLayer;
    camera: PerspectiveCamera;
    container: HTMLElement;
  } | null;
  /** If FL builds and prepares the InteractController itself. */
  interact?(): InteractController | null;
  /** Simulate the jacket on the static body (cloth solver in the worker); live pose paused. */
  enterPhysics?(): Promise<void>;
  /** Back to the live preview. */
  exitPhysics?(): void;
  pauseLive?(on: boolean): void;
  /**
   * The opened (split) jacket mesh while the zip is open or the hood is off, else null: style it
   * like the shell (see-through parts). Its geometry carries the shell's attributes (fitZone).
   */
  setInteractMesh?(mesh: Mesh | null): void;
  /** FL: called with false when the panel leaves physics by itself (jacket/size change). */
  onPhysics?(fn: (on: boolean) => void): () => void;
}

export type PhysicsStatus = 'idle' | 'waiting' | 'preparing' | 'ready' | 'unavailable';

/** Torso length of the panel's body (m) for hand travel -> hood motion; Anny default ~0.5 m. */
const BODY_TORSO_M = 0.5;
/** Programmatic hood motion (slider / button / reconcile): duration of the move (ms). */
const HOOD_MOVE_MS = 450;
/**
 * Settle before the split solver is built (simulated s). The kiosk Feel screen relaxes 1.5 s
 * (HAND_PULL.settleSeconds, 6.7 s wall here) because it starts from any state; the Fit Lab has
 * just settled the jacket in Viewer.setGarment, so a short relax only re-arms the live loop.
 */
const PANEL_RELAX_S = 0.2;
/** The hood's zip edge within this distance of the collar (m) counts as back on. */
const HOOD_ARRIVED_M = 0.02;
/** Longest hold while the hood travels back to the collar (ms; the solver moves it at <= 1.2 m/s). */
const HOOD_ARRIVE_MS = 3000;
/**
 * Closed + hood on + restored for this long (ms): leave physics, back to the live preview.
 * Long enough that a second pull right after the first does not wait for the settle again.
 */
const EXIT_IDLE_MS = 15_000;
/** Watchdog period (ms). */
const POLL_MS = 250;
/** Longest wait for each physics step (ms) before reporting it unavailable. */
const STEP_TIMEOUT_MS = 20_000;

const ease = (t: number) => t * t * (3 - 2 * t);

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** The link's host in engine/interact's shape, or null. */
export function hostOf(link: FitLabLink): InteractHostLike | null {
  const h = link.interactHost?.() ?? null;
  const garment = h?.garment ?? h?.garmentLayer;
  return h && garment ? { garment, camera: h.camera, container: h.container } : null;
}

/** The bus state where the jacket is the measured shell (nothing opened). */
export const atRest = (s: Pick<GarmentState, 'zip' | 'hoodOn'>) => s.zip <= 0 && s.hoodOn;

/**
 * Hem pull: hand travel (T) -> displacement of the grabbed hem (m, scene). Down and out to the
 * side only (image down = scene -y, +u = scene +x), capped at HEM_GRAB.maxPullM.
 */
export function hemDisplacement(du: number, dv: number) {
  const d = new Vector3(du * BODY_TORSO_M, -Math.max(0, dv) * BODY_TORSO_M, 0);
  if (d.length() > HEM_GRAB.maxPullM) d.setLength(HEM_GRAB.maxPullM);
  return d;
}

/** Hand travel in body units (T) -> hood zip-edge displacement (m, scene: +x = wearer's left). */
export function hoodDisplacement(
  kind: 'hood-off' | 'hood-on',
  progress: number,
  du: number,
  dv: number,
  offset0: readonly number[],
) {
  if (kind === 'hood-on') return offset0.map((o) => -o * progress);
  // Off: along the hand's direction in the image plane (y flipped: image down = scene -y) plus
  // back behind the head, |d| = progress x physicsOffM (past the solver's detach distance at 1).
  const px = du * BODY_TORSO_M,
    py = -dv * BODY_TORSO_M,
    n = Math.hypot(px, py),
    dir = n > 1e-3 ? [px / n, py / n] : [0, -1],
    m = progress * HOOD_GRAB.physicsOffM;
  return [dir[0] * m * 0.8, dir[1] * m * 0.8, -m * 0.6];
}

export class FitLabPhysics {
  status: PhysicsStatus = 'idle';
  error?: string;
  onStatus?: (status: PhysicsStatus, error?: string) => void;
  private controller?: InteractController;
  private pull?: HandPullController;
  private host?: InteractHostLike;
  /** Hem pull in progress: the grabbed shell point (scene m). */
  private hem?: { point: Vector3 };
  private owned = false;
  private builtAsset?: unknown;
  private entering?: Promise<void>;
  private inPhysics = false;
  private restSince = 0;
  private poll = 0;
  private disposed = false;
  private unsubscribe: () => void;
  private offPhysics?: () => void;
  private retry = 0;
  private retryAt = 0;
  private inputTime?: number;
  private hold?: { kind: 'hood-off' | 'hood-on'; offset0: number[] };
  private anim = 0;
  private animating = false;
  private lastUi?: InteractUiState;
  /** Last cloth worker error (diagnostics). */
  lastWorkerError?: string;

  constructor(
    private readonly link: FitLabLink,
    private readonly bus: StudioBus,
  ) {
    this.unsubscribe = bus.subscribe((next, prev, source) => this.follow(next, prev, source));
    // FL leaves physics by itself on a jacket/size change: drop the solver bound to the old one.
    this.offPhysics = link.onPhysics?.((on) => {
      if (on || !this.inPhysics) return;
      this.inPhysics = false;
      this.leave();
      this.demandLater();
    });
    if (!atRest(bus.get())) this.demand();
    this.poll = setInterval(this.watch, POLL_MS);
  }

  /**
   * Start entering physics now (a hand is hovering a handle, or the shell's "try the zip"): the
   * panel's settle takes seconds, so it should not start only at the pinch.
   */
  prewarm() {
    this.demand();
    this.restSince = 0;
  }

  /** Camera frame time of the pinch that is about to change the bus (latency stats). */
  setInputTime(frameTime: number | undefined) {
    this.inputTime = frameTime;
  }

  get interact() {
    return this.controller;
  }

  /** Numbers only: the controller's own stats (input -> first render frame with the moved cloth). */
  stats() {
    const c = this.controller?.stats();
    return c
      ? {
          ...c,
          enter: { ...this.timing },
          hand: this.pull?.stats(),
          handNow: this.pull?.snapshot(),
        }
      : undefined;
  }

  /** Last physics entry (ms): FL enterPhysics, cloth settle, split solver build, total. */
  readonly timing = { enterPhysicsMs: NaN, settleMs: NaN, prepareMs: NaN, totalMs: NaN };

  /** Pinch gesture events from the bridge (hood: live hold; zip/hem follow the bus values). */
  onGesture(e: PhysicsEvent) {
    if (e.phase === 'start') this.demand();
    const c = this.controller;
    if (!c || this.status !== 'ready') return;
    if (e.kind === 'hem') return this.onHem(e);
    if (e.kind !== 'hood-off' && e.kind !== 'hood-on') return;
    if (e.phase === 'start') {
      this.stopAnim();
      const offset0 = c.hoodHandOffset();
      if (c.holdHood(e.timeMs)) this.hold = { kind: e.kind, offset0 };
    } else if (e.phase === 'move' && this.hold) {
      c.moveHood(
        hoodDisplacement(this.hold.kind, e.progress, e.du, e.dv, this.hold.offset0),
        e.timeMs,
      );
    } else if (e.phase === 'end' && this.hold) {
      const hold = this.hold;
      this.hold = undefined;
      if (hold.kind === 'hood-on' && this.bus.get().hoodOn) {
        // Putting it on: the solver's hood follows the hand at a speed limit, so keep holding it
        // at the collar until it has arrived, then let go (it zips on).
        this.finishAttach(c, hold.offset0);
        return;
      }
      c.end(e.timeMs);
      // The bus already holds the gesture's verdict; let the solver settle, then match it.
      setTimeout(() => this.reconcileHood(), 350);
    }
  }

  dispose() {
    this.disposed = true;
    this.unsubscribe();
    this.offPhysics?.();
    clearInterval(this.poll);
    clearTimeout(this.retry);
    this.stopAnim();
    this.leave();
  }

  // ------------------------------------------------------------------ internals

  private setStatus(status: PhysicsStatus, error?: string) {
    if (this.status === status && this.error === error) return;
    this.status = status;
    this.error = error;
    this.onStatus?.(status, error);
  }

  private releaseController() {
    if (this.owned) {
      this.hem = undefined;
      // HandPullController.dispose also disposes its InteractController, stops the live loop and
      // restores the shown shape.
      if (this.pull) this.pull.dispose();
      else this.controller?.dispose();
      this.pull = undefined;
      try {
        this.link.setInteractMesh?.(null);
      } catch (error) {
        console.warn('[studio/physics] setInteractMesh failed:', error);
      }
    }
    this.controller = undefined;
    this.owned = false;
    this.hold = undefined;
    this.builtAsset = undefined;
  }

  /** Back to the live preview. */
  private leave() {
    this.releaseController();
    if (this.inPhysics) {
      this.inPhysics = false;
      try {
        if (this.link.exitPhysics) this.link.exitPhysics();
        else this.link.pauseLive?.(false);
      } catch (error) {
        console.warn('[studio/physics] exitPhysics failed:', error);
      }
    }
    if (this.status !== 'unavailable') this.setStatus('idle');
  }

  /**
   * Re-enter after the panel switched jackets (FL's own bus follow runs async: it must load the
   * new jacket before enterPhysics reads it).
   */
  private demandLater(ms = 1500) {
    clearTimeout(this.retry);
    this.retryAt = performance.now() + ms;
    this.retry = setTimeout(() => {
      this.retryAt = 0;
      if (!this.disposed && !atRest(this.bus.get())) this.demand();
    }, ms);
  }

  /** Something wants the jacket opened: enter physics (once) and build the controller. */
  private demand() {
    if (performance.now() < this.retryAt) return;
    if (this.disposed || this.entering || this.status === 'ready' || this.status === 'unavailable')
      return;
    this.entering = this.enter().finally(() => (this.entering = undefined));
  }

  private async enter() {
    const key = this.jacketKey();
    this.setStatus('preparing');
    const t0 = performance.now();
    let t = t0;
    const lap = (k: 'enterPhysicsMs' | 'settleMs' | 'prepareMs') => {
      const now = performance.now();
      this.timing[k] = now - t;
      t = now;
    };
    try {
      const given = this.link.interact?.() ?? null;
      if (!given) {
        this.inPhysics = true;
        if (this.link.enterPhysics)
          await withTimeout(this.link.enterPhysics(), STEP_TIMEOUT_MS, 'Fit Lab enterPhysics');
        else this.link.pauseLive?.(true);
        lap('enterPhysicsMs');
      }
      if (this.disposed || key !== this.jacketKey()) throw new Error('superseded');
      let controller = given;
      if (!controller) {
        const host = await this.waitForHost();
        // The kiosk's Feel-screen controller: saves the shown shape, settles, runs the solver live,
        // builds the split (zip/hood) solver, and owns the real hand pull (hem) with its tension.
        const pull = new HandPullController(host, {
          settleSeconds: PANEL_RELAX_S,
          followColour: TONE_COLOR.good,
          tautColour: TONE_COLOR.snug,
          // U's calm card: white, near-black text (ui/theme.ts).
          readoutBackground: 'rgba(255, 255, 255, 0.94)',
          readoutTautBackground: 'rgba(255, 248, 236, 0.96)',
          readoutText: THEME.text,
        });
        pull.onError = (message) => {
          console.error('[studio/physics] cloth worker error:', message);
          this.lastWorkerError = message;
        };
        this.pull = pull;
        if (!pull.interact) {
          pull.dispose();
          this.pull = undefined;
          throw new Error('no zip line on this jacket (zip/hood unavailable)');
        }
        controller = pull.interact;
        this.controller = controller;
        this.owned = true;
        this.builtAsset = host.garment.pickTarget?.asset;
        this.host = host;
        await withTimeout(pull.start(), STEP_TIMEOUT_MS, 'cloth settle');
        if (this.disposed || this.controller !== controller) throw new Error('superseded');
        lap('settleMs');
      } else {
        this.controller = controller;
        this.owned = false;
      }
      this.attachUi(controller);
      await withTimeout(controller.prepare(), STEP_TIMEOUT_MS, 'zip/hood solver');
      lap('prepareMs');
      this.timing.totalMs = performance.now() - t0;
      if (this.disposed || this.controller !== controller) throw new Error('superseded');
      const ui = controller.state();
      if (ui.error) throw new Error(ui.error);
      this.restSince = 0;
      this.setStatus('ready');
      // Start from the bus (the single truth).
      const s = this.bus.get();
      if (s.zip > 0) controller.setZipOpen(s.zip);
      this.reconcileHood();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'superseded') {
        this.leave();
        return;
      }
      console.warn('[studio/physics] zip/hood physics unavailable:', message);
      this.leave();
      this.setStatus('unavailable', message);
      // Retry on a later demand (e.g. FL adds enterPhysics, or another jacket).
      setTimeout(() => {
        if (!this.disposed && this.status === 'unavailable') this.setStatus('idle');
      }, 5000);
    }
  }

  private async waitForHost(): Promise<InteractHostLike> {
    const started = performance.now();
    for (;;) {
      const host = hostOf(this.link);
      if (host?.garment.pickTarget) return host;
      if (performance.now() - started > STEP_TIMEOUT_MS)
        throw new Error(
          host ? 'no jacket in the Fit Lab' : 'Fit Lab not mounted (no interactHost)',
        );
      await new Promise((r) => setTimeout(r, 100));
      if (this.disposed) throw new Error('superseded');
    }
  }

  private jacketKey() {
    const s = this.bus.get();
    return `${s.jacket}:${s.size}`;
  }

  /** Leaves physics after a jacket change or once everything is closed and idle. */
  private watch = () => {
    if (this.disposed || this.status !== 'ready') return;
    const c = this.controller;
    if (!c) return;
    const host = hostOf(this.link);
    if (
      this.owned &&
      host &&
      this.builtAsset &&
      host.garment.pickTarget?.asset !== this.builtAsset
    ) {
      // The panel loaded another jacket under us.
      this.leave();
      if (!atRest(this.bus.get())) this.demand();
      return;
    }
    const busy = !!this.hold || this.animating || c.isDragging || c.state().open;
    if (busy || !atRest(this.bus.get())) {
      this.restSince = 0;
      return;
    }
    const now = performance.now();
    if (!this.restSince) this.restSince = now;
    else if (now - this.restSince >= EXIT_IDLE_MS) this.leave();
  };

  /** Mouse/touch on the panel moves the solver directly: write that back to the bus ('ui'). */
  private attachUi(c: InteractController) {
    c.onSplitShown = (mesh) => {
      try {
        this.link.setInteractMesh?.(mesh);
      } catch (error) {
        console.warn('[studio/physics] setInteractMesh failed:', error);
      }
    };
    const previous = c.onUi;
    c.onUi = (state) => {
      previous?.(state);
      const before = this.lastUi;
      this.lastUi = state;
      if (this.hold || this.animating || this.status !== 'ready' || this.controller !== c) return;
      const bus = this.bus.get();
      if (state.dragging === 'pull' && Math.abs(state.zipOpen - bus.zip) > 0.01)
        this.bus.set({ zip: state.zipOpen }, 'ui');
      if (before?.hood !== state.hood && before?.dragging === 'hood') {
        if (state.hood === 'detached' && bus.hoodOn) this.bus.set({ hoodOn: false }, 'ui');
        if (state.hood === 'attached' && !bus.hoodOn) this.bus.set({ hoodOn: true }, 'ui');
      }
    };
  }

  private follow(next: GarmentState, prev: GarmentState, source: string) {
    const time = source === 'pinch' ? this.inputTime : undefined;
    this.inputTime = undefined;
    if (next.jacket !== prev.jacket || next.size !== prev.size) {
      // FL reloads the jacket for the new choice; leave physics and come back on demand.
      if (this.status === 'ready' || this.entering) this.leave();
      if (!atRest(next)) this.demandLater();
      return;
    }
    if (!atRest(next)) this.demand();
    const c = this.controller;
    if (!c || this.status !== 'ready') return;
    if (next.zip !== prev.zip) {
      const shown = c.state();
      // A closed zip on a shell that was never opened stays the measured shell (no activation).
      if (!(next.zip === 0 && !shown.open) && !(source === 'ui' && shown.dragging === 'pull'))
        c.setZipOpen(next.zip, time ?? performance.now());
    }
    if (next.hoodOn !== prev.hoodOn && !this.hold) this.reconcileHood();
  }

  /** Moves the solver's hood to the bus's hoodOn (programmatic hold, eased; physics does the rest). */
  private reconcileHood() {
    const c = this.controller;
    if (!c || this.status !== 'ready' || this.hold || !c.hasHood) return;
    const want = this.bus.get().hoodOn,
      hood = c.state().hood;
    if (!hood) return;
    const isOn = hood === 'attached' || hood === 'attaching';
    if (want === isOn) return;
    this.stopAnim();
    const offset0 = c.hoodHandOffset();
    const kind = want ? 'hood-on' : 'hood-off';
    if (!c.holdHood()) return;
    this.animating = true;
    const started = performance.now();
    const step = () => {
      if (this.disposed || this.controller !== c) {
        this.animating = false;
        return;
      }
      const t = Math.min(1, (performance.now() - started) / HOOD_MOVE_MS),
        p = ease(t);
      // Off: straight down the back; on: the zip edge back to the collar.
      c.moveHood(hoodDisplacement(kind, p, 0, p * HOOD_GRAB.offTravel, offset0));
      if (t < 1) this.anim = requestAnimationFrame(step);
      else if (kind === 'hood-on') this.finishAttach(c, offset0, true);
      else {
        c.end(performance.now());
        this.animating = false;
      }
    };
    this.anim = requestAnimationFrame(step);
  }

  /**
   * Holds the hood at the collar (zip edge displacement -offset0) until the solver's hood edge
   * has arrived (or HOOD_ARRIVE_MS), then lets go so the hood zip snaps on.
   */
  private finishAttach(c: InteractController, offset0: readonly number[], fromReconcile = false) {
    this.animating = true;
    const started = performance.now();
    const target = offset0.map((o) => -o);
    const step = () => {
      if (this.disposed || this.controller !== c) {
        this.animating = false;
        return;
      }
      c.moveHood(target);
      const left = Math.hypot(...c.hoodHandOffset());
      if (left > HOOD_ARRIVED_M && performance.now() - started < HOOD_ARRIVE_MS) {
        this.anim = requestAnimationFrame(step);
        return;
      }
      c.end(performance.now());
      this.animating = false;
      if (!fromReconcile) setTimeout(() => this.reconcileHood(), 350);
    };
    this.anim = requestAnimationFrame(step);
  }

  /**
   * Hem pull: the kiosk's real hand pull (HandPullController: pullBegin/Move/End on the cloth
   * worker, its tension readout and grab highlight). The pinch is placed on the shell's front hem
   * and moved by the hand's body-space travel (torso units -> metres). Only on a closed jacket
   * (HandPullController: an opened jacket is not the measured shell).
   */
  private onHem(e: PhysicsEvent) {
    const pull = this.pull,
      host = this.host;
    if (!pull || !host) return;
    const send = (type: 'start' | 'move' | 'end', point: Vector3) => {
      const v = point.clone().project(host.camera),
        a = HAND_PULL.activeBox;
      pull.handlePinch({
        type,
        hand: 'right',
        // handlePinch maps tracker NDC through toViewport (/ activeBox): pre-scale so the
        // viewport point is exactly the projected shell point.
        ndc: { x: Math.max(-1, Math.min(1, v.x)) * a, y: Math.max(-1, Math.min(1, v.y)) * a },
        depthDelta: 0,
        frameTime: e.timeMs,
        confidence: 1,
      });
    };
    if (e.phase === 'start') {
      const point = this.hemPoint(host);
      if (!point) return;
      this.hem = { point };
      send('start', point);
    } else if (this.hem && e.phase === 'move') {
      send('move', this.hem.point.clone().add(hemDisplacement(e.du, e.dv)));
    } else if (this.hem && e.phase === 'end') {
      send('end', this.hem.point);
      this.hem = undefined;
    }
  }

  /** The shown shell's front hem point at the centre line (scene m), just above the edge. */
  private hemPoint(host: InteractHostLike): Vector3 | null {
    const target = host.garment.pickTarget;
    if (!target) return null;
    const mesh = target.mesh,
      p = mesh.geometry.getAttribute('position'),
      v = new Vector3();
    mesh.updateMatrixWorld();
    let minY = Infinity,
      maxZ = -Infinity,
      cx = 0,
      n = 0;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
      minY = Math.min(minY, v.y);
      maxZ = Math.max(maxZ, v.z);
      cx += v.x;
      n++;
    }
    if (!n) return null;
    cx /= n;
    // Front vertices in the hem band, nearest the centre line beside the zip (HEM_GRAB.offsetM to
    // the wearer's right, so the pinch is on fabric, not on the zip tape), and frontmost.
    const wantX = cx - HEM_GRAB.offsetM;
    let best: Vector3 | null = null,
      bestD = Infinity;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
      if (v.y > minY + HEM_GRAB.bandM || v.y < minY + HEM_GRAB.bandM * 0.3) continue;
      const d = Math.abs(v.x - wantX) + (maxZ - v.z) * 2;
      if (d < bestD) {
        bestD = d;
        best = v.clone();
      }
    }
    return best;
  }

  private stopAnim() {
    cancelAnimationFrame(this.anim);
    if (this.animating) {
      this.controller?.end(performance.now());
      this.animating = false;
    }
  }
}
