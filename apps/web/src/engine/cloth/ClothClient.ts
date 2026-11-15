import { api, type ClothAsset } from '../../api';
import type { ClothSnapshot, SnapshotOptions } from './ClothSolver';
import type { PullMessage } from './cloth.worker';
import type { GrabKind, InteractFrame } from '../interact/InteractDriver';
import type { ZipLine } from '../interact/seam';

export type { PullMessage };

/** Split asset of the interactive zip/hood solver, as the worker built it (agent Z). */
export interface InteractReady {
  buildMs: number;
  assetKey: string;
  triangles: Int32Array;
  /** Original vertex of every split vertex (identity below the original count). */
  source: Int32Array;
  zip: ZipLine;
  hood: ZipLine | null;
  panels: Int32Array;
}

/** One frame of the interaction solver: split-asset positions and its state. */
export interface InteractMessage {
  positions: Float32Array;
  frame: InteractFrame;
  /** Input time (main-thread performance.now) first applied in this frame, else 0. */
  frameTime: number;
  intervalMs: number;
}
export type RelaxResult = {
  elapsedMs: number;
  frames: number;
  simulatedSeconds: number;
  energy: number;
  meanStepMs: number | null;
};

export type SettledCloth = ClothSnapshot & {
  elapsedMs: number;
  cached: boolean;
  meanStepMs: number | null;
  stopReason: 'cache' | 'kinetic' | 'time_limit' | 'static';
};
export class ClothClient {
  private worker = new Worker(new URL('./cloth.worker.ts', import.meta.url), { type: 'module' });
  private pending?: { resolve: (value: SettledCloth) => void; reject: (reason: Error) => void };
  onFrame?: (snapshot: ClothSnapshot) => void;
  private fieldIds = new Set<string>();
  private options: SnapshotOptions = {};
  private framePending = false;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private requestedGeneration = 0;
  private frameObservers = new Set<(time: number, stepMs: number) => void>();
  private relaxPending?: { resolve: (value: RelaxResult) => void; reject: (reason: Error) => void };
  /** Hand pull (M4): one message per live solver frame, after onFrame applied its positions. */
  onPull?: (pull: PullMessage) => void;
  /** Errors outside a settle/relax request (e.g. the live loop stopped). */
  onError?: (message: string) => void;
  private strainOutput = false;
  /** Interactive zip/hood (agent Z): split-solver frames; the buffer is recycled after it. */
  onInteract?: (message: InteractMessage) => void;
  private interactReady?: { resolve: (value: InteractReady) => void; reject: (e: Error) => void };
  constructor() {
    this.worker.onmessage = (
      event: MessageEvent<
        SettledCloth &
          RelaxResult & { kind: string; message?: string; stepMs?: number; pull?: PullMessage }
      >,
    ) => {
      const kind = event.data.kind;
      if (kind === 'iframe') {
        const data = event.data as unknown as InteractMessage;
        this.onInteract?.(data);
        this.worker.postMessage({ kind: 'irecycle', positions: data.positions }, [
          data.positions.buffer,
        ]);
        return;
      }
      if (kind === 'interact-ready') {
        this.interactReady?.resolve(event.data as unknown as InteractReady);
        this.interactReady = undefined;
        return;
      }
      if (event.data.kind === 'error') {
        const message = event.data.message ?? 'Cloth worker error';
        this.interactReady?.reject(new Error(message));
        this.interactReady = undefined;
        if (!this.pending && !this.relaxPending) this.onError?.(message);
        this.pending?.reject(new Error(message));
        this.pending = undefined;
        this.relaxPending?.reject(new Error(message));
        this.relaxPending = undefined;
      } else if (event.data.kind === 'relaxed') {
        this.relaxPending?.resolve(event.data);
        this.relaxPending = undefined;
      } else if (event.data.kind === 'settled') {
        this.pending?.resolve(event.data);
        this.pending = undefined;
      } else {
        this.framePending = false;
        this.onFrame?.(event.data);
        if (event.data.pull) this.onPull?.(event.data.pull);
        const { positions, gap, strain, compression } = event.data;
        this.worker.postMessage(
          { kind: 'recycle', buffers: { positions, gap, strain, compression } },
          [positions.buffer, gap.buffer, strain.buffer, compression.buffer],
        );
        if (event.data.stepMs != null)
          for (const observer of this.frameObservers)
            observer(performance.now(), event.data.stepMs);
      }
    };
    this.worker.onerror = (event) => {
      this.pending?.reject(new Error(event.message));
      this.pending = undefined;
    };
  }
  settle(
    asset: ClothAsset,
    restore?: Pick<SettledCloth, 'positions' | 'energy' | 'simulatedSeconds'>,
  ) {
    const generation = ++this.requestedGeneration;
    // The 16 MB collision field downloads now, even while an earlier settle is still queued.
    const field = this.fieldIds.has(asset.sdf.sdf_id) ? undefined : api.sdf(asset);
    field?.catch(() => undefined); // rejection is reported by the task below
    const task = this.queue.then(async () => {
      if (this.disposed) throw new Error('Cloth viewer closed');
      if (generation !== this.requestedGeneration)
        throw new DOMException('Cloth request superseded', 'AbortError');
      let sdf: ArrayBuffer | undefined;
      if (!this.fieldIds.has(asset.sdf.sdf_id)) sdf = (await (field ?? api.sdf(asset))).slice(0);
      if (generation !== this.requestedGeneration)
        throw new DOMException('Cloth request superseded', 'AbortError');
      return new Promise<SettledCloth>((resolve, reject) => {
        this.pending = { resolve, reject };
        this.worker.postMessage(
          { kind: 'settle', asset, sdf, restore, options: this.options },
          sdf ? [sdf] : [],
        );
        this.fieldIds.add(asset.sdf.sdf_id);
        if (this.fieldIds.size > 4) this.fieldIds.delete(this.fieldIds.keys().next().value!);
      });
    });
    this.queue = task.catch(() => undefined);
    this.settling = task;
    return task;
  }
  /** Latest settle request; physics calls (feel, relax, frame benchmark) wait for it. */
  private settling?: Promise<SettledCloth>;
  /** Resolves when the worker holds the shown garment's solver (rejects if that failed). */
  async ready() {
    if (this.settling) await this.settling;
  }
  setMode(mode: 'normal' | 'xray' | 'heatmap' | 'tension') {
    this.mode = mode;
    this.options = { gap: mode === 'heatmap', strain: mode === 'tension' || this.strainOutput };
    if (!this.pending) this.worker.postMessage({ kind: 'mode', options: this.options });
  }
  private mode: 'normal' | 'xray' | 'heatmap' | 'tension' = 'normal';
  /** Per-vertex strain in every frame (hand-pull tension map), whatever the display mode. */
  setStrainOutput(on: boolean) {
    this.strainOutput = on;
    this.setMode(this.mode);
  }
  /** Hand pull session: on saves the shown shape; off stops the loop and restores it. */
  feel(on: boolean) {
    // After the shown garment's solver exists (the static shell is shown before it is built).
    void this.ready()
      .catch(() => undefined)
      .then(() => this.worker.postMessage({ kind: 'feel', on }));
  }
  /** Full-garment settle from the current state (feel-the-fabric entry). */
  async relax(seconds: number) {
    await this.ready();
    if (this.pending) throw new Error('Cloth is still settling');
    this.relaxPending?.reject(new Error('Relax superseded'));
    return new Promise<RelaxResult>((resolve, reject) => {
      this.relaxPending = { resolve, reject };
      this.worker.postMessage({ kind: 'relax', seconds });
    });
  }
  /** Worker-driven fixed-rate loop for the hand pull (the render thread never waits). */
  setLive(on: boolean) {
    this.worker.postMessage({ kind: 'live', on });
  }
  pullBegin(ids: number[], weights: number[], centre: number[], frameTime: number) {
    this.worker.postMessage({ kind: 'pull-begin', ids, weights, centre, frameTime });
  }
  pullMove(displacement: number[], frameTime: number) {
    this.worker.postMessage({ kind: 'pull-move', displacement, frameTime });
  }
  pullEnd(frameTime: number) {
    this.worker.postMessage({ kind: 'pull-end', frameTime });
  }
  /**
   * Builds the split solver for the zip/hood from the current shown state (feel mode only).
   * Resolves with the split asset's topology; frames then arrive on onInteract.
   */
  interactStart(hood: boolean) {
    this.interactReady?.reject(new Error('Superseded'));
    return new Promise<InteractReady>((resolve, reject) => {
      this.interactReady = { resolve, reject };
      this.worker.postMessage({ kind: 'interact-start', hood });
    });
  }
  /** Starts the split solver from the shown (base) state; input messages follow in order. */
  interactActivate() {
    this.worker.postMessage({ kind: 'interact-activate' });
  }
  interactSlider(arc: number, frameTime: number) {
    this.worker.postMessage({ kind: 'interact-slider', arc, frameTime });
  }
  interactGrab(grab: GrabKind, ids: number[], weights: number[], frameTime: number) {
    this.worker.postMessage({ kind: 'interact-grab', grab, ids, weights, frameTime });
  }
  interactMove(displacement: number[], frameTime: number) {
    this.worker.postMessage({ kind: 'interact-move', displacement, frameTime });
  }
  interactRelease(frameTime: number) {
    this.worker.postMessage({ kind: 'interact-release', frameTime });
  }
  /** The hood starts off, resting by the right foot (HOOD_DEFAULT 'off-resting'). */
  interactHoodOff() {
    this.worker.postMessage({ kind: 'interact-hood-off' });
  }
  /** Drops the split solver; the worker re-sends the base (measured) solver's frame. */
  interactStop() {
    this.worker.postMessage({ kind: 'interact-stop' });
  }
  grab(ids: number[], positions: number[]) {
    this.worker.postMessage({ kind: 'grab', ids, positions });
  }
  move(ids: number[], positions: number[]) {
    this.worker.postMessage({ kind: 'move', ids, positions });
  }
  release() {
    this.worker.postMessage({ kind: 'release' });
  }
  step() {
    if (this.framePending || this.pending) return;
    this.framePending = true;
    this.worker.postMessage({ kind: 'step' });
  }
  async measureFrames(count = 180) {
    await this.ready();
    if (this.pending) throw new Error('Cloth is still settling');
    return new Promise<{ deliveredHz: number; meanStepMs: number; p95StepMs: number }>(
      (resolve, reject) => {
        const started = performance.now(),
          times: number[] = [];
        const timeout = setTimeout(() => {
          this.frameObservers.delete(observer);
          reject(new Error('Interactive worker benchmark timed out'));
        }, 30000);
        const observer = (time: number, stepMs: number) => {
          times.push(stepMs);
          if (times.length >= count) {
            clearTimeout(timeout);
            this.frameObservers.delete(observer);
            const sorted = times.slice().sort((a, b) => a - b);
            resolve({
              deliveredHz: (count * 1000) / (time - started),
              meanStepMs: times.reduce((a, b) => a + b, 0) / count,
              p95StepMs: sorted[Math.floor(sorted.length * 0.95)],
            });
          } else this.step();
        };
        this.frameObservers.add(observer);
        this.step();
      },
    );
  }
  dispose() {
    this.disposed = true;
    this.worker.terminate();
    this.pending?.reject(new Error('Cloth viewer closed'));
    this.pending = undefined;
    this.relaxPending?.reject(new Error('Cloth viewer closed'));
    this.relaxPending = undefined;
  }
}
