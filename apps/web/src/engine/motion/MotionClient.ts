// Main-thread side of fit-in-motion: fetches P1's motion data for a body (rig, articulated
// SDF, anchors, frames) and the garment's cloth assets, runs one bake worker per size and caches
// the baked (size, motion) sequences. Requested bakes jump the queue; the rest are precomputed
// in the background in the order given to prefetch().
import { z } from 'zod';
import { api, type ClothAsset } from '../../api';
import type { BakedMotion, BakeProgress } from './bake.ts';
import { bakeBytes, type BakeStore } from './BakeQueue.ts';
import type { MotionWorkerRequest, MotionWorkerResponse } from './motion.worker.ts';
import {
  parseFrames,
  parseRig,
  type MotionAnchors,
  type MotionFrames,
  type MotionPreset,
  type MotionRig,
} from './rig.ts';

const ID = /^[a-f0-9]{64}$/;
/** `?motionwasm=0` makes the workers bake with the JS solver (A/B tests; same results, slower). */
export const motionWasmRequested = (search = globalThis.location?.search ?? '') =>
  new URLSearchParams(search).get('motionwasm') !== '0';
const finite = z.number().finite();
const attachment = z.strictObject({
  vertices: z.array(z.array(z.number().int().min(0))),
  weights: z.array(z.array(finite)),
  rest: z.array(z.array(finite)),
});
const anchorsSchema: z.ZodType<MotionAnchors> = z.strictObject({
  version: z.string(),
  frame: z.string(),
  ring_samples: z.number().int().positive(),
  ring_index: z.record(z.string(), z.number().int()),
  rings: z.record(z.string(), attachment),
  tapes: z.record(z.string(), attachment),
  points: z.record(z.string(), z.number().int().min(0)),
  heights_m: z.record(z.string(), finite),
  exposure_vertices: z.record(z.string(), z.array(z.number().int().min(0))),
  waistband_default: z.string(),
});
const presetsSchema: z.ZodType<MotionPreset[]> = z.array(
  z.strictObject({
    id: z.string().regex(/^[a-z_]{1,32}$/),
    label: z.string(),
    duration_s: finite.positive(),
    hold: z.strictObject({ start_s: finite.min(0), end_s: finite.min(0) }),
    keyframes: z.array(z.strictObject({ t_s: finite.min(0), pose: z.record(z.string(), finite) })),
  }),
);

async function binary(path: string, signal?: AbortSignal) {
  const response = await fetch(`/api${path}`, { cache: 'no-store', signal });
  if (response.status === 404) throw new Error('Body expired from memory. Build your body again.');
  if (!response.ok) throw new Error(`Motion data unavailable (${response.status})`);
  return response.arrayBuffer();
}
async function json<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal) {
  const response = await fetch(`/api${path}`, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`Motion data unavailable (${response.status})`);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new Error('The body service returned invalid motion data.');
  return parsed.data;
}

/**
 * A cloth asset; asked once more after HTTP 410. The service answers 410 when a session reset
 * cancelled the build, and today any client's reset cancels every pending build on that
 * service (docs/requests/M-to-lead.md), so the fit can still be valid. Our own reset aborts
 * `signal` first and is never retried. The browser still logs the first 410 itself.
 */
export async function clothAsset(fitId: string, size: string, signal: AbortSignal) {
  try {
    return await api.cloth(fitId, size, signal);
  } catch (error) {
    if (signal.aborted || !(error instanceof Error) || !/\(410\)/.test(error.message)) throw error;
    return api.cloth(fitId, size, signal);
  }
}

type Job = {
  motionId: string;
  resolve: (bake: BakedMotion) => void;
  reject: (error: Error) => void;
  promise: Promise<BakedMotion>;
  /** A judge's request (never preempted, runs even while background bakes are paused). */
  urgent: boolean;
  /** Solver overrides and frame limit (custom bakes only; motion.worker.ts). */
  config?: Record<string, number>;
  maxFrames?: number;
};

class SizeWorker {
  worker!: Worker;
  queue: Job[] = [];
  running?: Job & { id: number };
  private nextId = 1;
  constructor(
    readonly size: string,
    private client: MotionClient,
  ) {
    this.spawn();
  }
  private spawn() {
    const worker = new Worker(new URL('./motion.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    const client = this.client,
      size = this.size;
    worker.onmessage = (event: MessageEvent<MotionWorkerResponse>) => {
      if (worker !== this.worker) return;
      const m = event.data,
        job = this.running;
      if (m.kind === 'progress') {
        if (job && job.id === m.id) client.reportProgress(size, job.motionId, m);
        return;
      }
      if (!job || (m.id !== job.id && m.id !== -1)) return;
      this.running = undefined;
      if (m.kind === 'baked') job.resolve(m.bake);
      else job.reject(new Error(m.message));
      this.pump();
    };
    worker.onerror = (event) => {
      if (worker !== this.worker) return;
      const job = this.running;
      this.running = undefined;
      job?.reject(new Error(event.message || 'Motion worker failed'));
      this.pump();
    };
  }
  /**
   * Stops a running BACKGROUND bake and puts it back at the front of the queue. The solver loop
   * runs synchronously inside the worker and cannot be paused, so the worker is replaced (its
   * body and garment re-posted from the client's copies). The bake starts over when resumed; its
   * relax is cached again by then or recomputed (bit-identical either way).
   */
  preempt() {
    const job = this.running;
    if (!job || job.urgent) return false;
    this.worker.terminate();
    this.running = undefined;
    this.client.clearProgress(this.size, job.motionId);
    const { id: _id, ...requeued } = job;
    void _id;
    this.queue = [requeued, ...this.queue];
    this.spawn();
    if (this.client.ready) this.client.initWorker(this);
    return true;
  }
  /**
   * Drops one job, queued or running, and rejects it with `error`. A running bake cannot be
   * interrupted inside the worker (synchronous solver loop), so the worker is replaced like in
   * preempt(); unlike preempt() the job is not requeued.
   */
  cancel(motionId: string, error: Error) {
    const queued = this.queue.find((j) => j.motionId === motionId);
    if (queued) {
      this.queue = this.queue.filter((j) => j !== queued);
      queued.reject(error);
      return;
    }
    const job = this.running;
    if (!job || job.motionId !== motionId) return;
    this.worker.terminate();
    this.running = undefined;
    this.client.clearProgress(this.size, motionId);
    job.reject(error);
    this.spawn();
    if (this.client.ready) this.client.initWorker(this);
    void this.pump();
  }
  post(message: MotionWorkerRequest, transfer: Transferable[] = []) {
    this.worker.postMessage(message, transfer);
  }
  enqueue(
    motionId: string,
    urgent: boolean,
    custom: Pick<Job, 'config' | 'maxFrames'> = {},
  ): Promise<BakedMotion> {
    const existing =
      this.running?.motionId === motionId
        ? this.running
        : this.queue.find((j) => j.motionId === motionId);
    if (existing) {
      if (urgent) {
        existing.urgent = true;
        if (existing !== this.running)
          this.queue = [existing, ...this.queue.filter((j) => j !== existing)];
        this.pump();
      }
      return existing.promise;
    }
    let resolve!: (bake: BakedMotion) => void, reject!: (error: Error) => void;
    const promise = new Promise<BakedMotion>((a, b) => {
      resolve = a;
      reject = b;
    });
    const job: Job = { motionId, resolve, reject, promise, urgent, ...custom };
    this.queue = urgent ? [job, ...this.queue] : [...this.queue, job];
    this.pump();
    return promise;
  }
  async pump() {
    if (this.running || !this.queue.length || !this.client.ready) return;
    if (this.client.backgroundPaused && !this.queue[0].urgent) return;
    const job = this.queue.shift()!;
    const id = this.nextId++;
    const running = { ...job, id };
    this.running = running;
    try {
      const frames = (await this.client.framesBuffer(job.motionId)).slice(0);
      if (this.running !== running) return; // preempted while the frames were loading
      this.post(
        {
          kind: 'bake',
          id,
          motionId: job.motionId,
          frames,
          ...(job.config ? { config: job.config } : {}),
          ...(job.maxFrames ? { maxFrames: job.maxFrames } : {}),
        },
        [frames],
      );
    } catch (error) {
      this.running = undefined;
      job.reject(error instanceof Error ? error : new Error(String(error)));
      this.pump();
    }
  }
  dispose() {
    this.worker.terminate();
    const error = new Error('Motion view closed');
    this.running?.reject(error);
    for (const job of this.queue) job.reject(error);
    this.queue = [];
  }
}

export type MotionData = {
  rig: MotionRig;
  anchors: MotionAnchors;
  presets: MotionPreset[];
  assets: Record<string, ClothAsset>;
};

export class MotionClient {
  readonly bodyId: string;
  readonly fitId: string;
  readonly sizes: string[];
  ready = false;
  onProgress?: (size: string, motionId: string, progress: BakeProgress) => void;
  /**
   * Shared memory cap over every client's cached bakes (the kiosk holds one per jacket).
   * Set by the host before the first bake.
   */
  store?: BakeStore;
  /** True when a host queue (MotionBakeQueue) precomputes the other motions: prefetch() is a no-op. */
  managed = false;
  /** Urgent (judge-requested) bakes not finished yet: the background queue waits for them. */
  urgentPending = 0;
  backgroundPaused = false;
  /** Background bakes stopped by pauseBackground() (diagnostics). */
  preemptions = 0;
  private init?: {
    rigBuffer: ArrayBuffer;
    sdfBuffer: ArrayBuffer;
    anchors: MotionAnchors;
    assets: ClothAsset[];
    grids: ArrayBuffer[];
  };
  private listeners = new Set<() => void>();
  private progress = new Map<string, BakeProgress>();
  private workers: SizeWorker[];
  private bakes = new Map<string, BakedMotion>();
  private frameBuffers = new Map<string, Promise<ArrayBuffer>>();
  private parsedFrames = new Map<string, MotionFrames>();
  private data?: MotionData;
  /** dispose() cancels in-flight downloads (kiosk reset forgets the body right after). */
  private abort = new AbortController();

  constructor(bodyId: string, fitId: string, sizes: string[]) {
    if (!ID.test(bodyId) || !ID.test(fitId)) throw new Error('Invalid body or fit ID');
    this.bodyId = bodyId;
    this.fitId = fitId;
    this.sizes = sizes;
    this.workers = sizes.map((size) => new SizeWorker(size, this));
  }

  private loading?: Promise<MotionData>;

  /** Loads once; a second caller (e.g. a view mounted on a client the kiosk pre-warmed) shares it. */
  load(): Promise<MotionData> {
    this.loading ??= this.loadOnce();
    this.loading.catch(() => (this.loading = undefined));
    return this.loading;
  }

  private async loadOnce(): Promise<MotionData> {
    const id = this.bodyId;
    const signal = this.abort.signal;
    const [rigBuffer, sdfBuffer, anchors, presets, assets] = await Promise.all([
      binary(`/motion/${id}/rig.bin`, signal),
      binary(`/motion/${id}/sdf.bin`, signal),
      json(`/motion/${id}/anchors`, anchorsSchema, signal),
      json('/motion/presets', presetsSchema, signal),
      Promise.all(this.sizes.map((size) => clothAsset(this.fitId, size, signal))),
    ]);
    const rig = parseRig(rigBuffer);
    // Fetch every motion's frames now: the API keeps a body only in a small in-memory LRU, so
    // background bakes must not depend on it later.
    await Promise.all(presets.map((p) => this.framesBuffer(p.id)));
    const grids = await Promise.all(assets.map((asset) => api.sdf(asset)));
    this.init = { rigBuffer, sdfBuffer, anchors, assets, grids };
    this.workers.forEach((w) => this.initWorker(w));
    this.ready = true;
    this.data = {
      rig,
      anchors,
      presets,
      assets: Object.fromEntries(this.sizes.map((s, i) => [s, assets[i]])),
    };
    return this.data;
  }

  /** Posts the body and this size's garment to a (new) worker; copies, the originals stay here. */
  initWorker(w: SizeWorker) {
    if (!this.init) throw new Error('Motion data not loaded');
    const { rigBuffer, sdfBuffer, anchors, assets, grids } = this.init;
    const i = this.sizes.indexOf(w.size);
    w.post({
      kind: 'body',
      bodyKey: this.bodyId,
      rig: rigBuffer.slice(0),
      sdf: sdfBuffer.slice(0),
      anchors,
      wasm: motionWasmRequested(),
    });
    w.post({ kind: 'garment', size: w.size, asset: assets[i], grid: grids[i].slice(0) });
  }

  /**
   * Hand pull / scan screens: stop the background bakes now (a running one is preempted, see
   * SizeWorker.preempt) and start no new background job until resumeBackground(). A judge's
   * request (urgent) still runs.
   */
  pauseBackground() {
    this.backgroundPaused = true;
    let any = false;
    for (const w of this.workers) {
      if (w.preempt()) {
        any = true;
        this.preemptions++;
      }
    }
    if (any) this.emit();
    return any;
  }
  resumeBackground() {
    if (!this.backgroundPaused) return;
    this.backgroundPaused = false;
    for (const w of this.workers) void w.pump();
  }

  framesBuffer(motionId: string) {
    // A custom motion's frames are registered by bakeCustom() under a 'custom:<n>' key.
    let pending = this.frameBuffers.get(motionId);
    if (!pending) {
      if (!/^[a-z_]{1,32}$/.test(motionId)) throw new Error('Invalid motion ID');
      pending = binary(`/motion/${this.bodyId}/${motionId}/frames.bin`, this.abort.signal);
      this.frameBuffers.set(motionId, pending);
      pending.catch(() => this.frameBuffers.delete(motionId));
    }
    return pending;
  }

  async frames(motionId: string): Promise<MotionFrames> {
    const cached = this.parsedFrames.get(motionId);
    if (cached) return cached;
    if (!this.data) throw new Error('Motion data not loaded');
    const parsed = parseFrames(await this.framesBuffer(motionId), this.data.rig.drivers.length);
    this.parsedFrames.set(motionId, parsed);
    return parsed;
  }

  cached(size: string, motionId: string) {
    return this.bakes.get(`${size}:${motionId}`);
  }

  /** Bytes of the typed arrays held by this client's cached bakes. */
  cachedBytes() {
    let total = 0;
    for (const bake of this.bakes.values()) total += bakeBytes(bake);
    return total;
  }

  /** Drops one cached bake (BakeStore LRU eviction); a later request bakes it again. */
  evict(key: string) {
    this.bakes.delete(key);
    this.emit();
  }

  /** Real per-step progress of the bake running for (size, motion), if one is running. */
  progressOf(size: string, motionId: string): BakeProgress | undefined {
    return this.progress.get(`${size}:${motionId}`);
  }

  /** Calls back whenever a bake starts, advances or finishes. Returns the unsubscribe. */
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  private emit() {
    for (const listener of this.listeners) listener();
  }
  clearProgress(size: string, motionId: string) {
    this.progress.delete(`${size}:${motionId}`);
  }
  /** Worker progress (throttled to ~5 per second per worker in motion.worker.ts). */
  reportProgress(size: string, motionId: string, progress: BakeProgress) {
    this.progress.set(`${size}:${motionId}`, progress);
    this.onProgress?.(size, motionId, progress);
    this.emit();
  }

  /** Bake (or return the cached bake of) one size and motion. `urgent` jumps the queue. */
  bake(size: string, motionId: string, urgent = true): Promise<BakedMotion> {
    const key = `${size}:${motionId}`;
    const hit = this.cached(size, motionId);
    if (hit) {
      this.store?.touch(this, key);
      return Promise.resolve(hit);
    }
    const worker = this.workers.find((w) => w.size === size);
    if (!worker) return Promise.reject(new Error(`Size ${size} is not loaded`));
    if (urgent) this.urgentPending++;
    return worker
      .enqueue(motionId, urgent)
      .then((bake) => {
        this.bakes.set(key, bake);
        this.store?.add(this, key, bakeBytes(bake));
        return bake;
      })
      .finally(() => {
        if (urgent) this.urgentPending--;
        this.progress.delete(key);
        this.emit();
      });
  }

  private customCount = 0;

  /**
   * Bakes a custom motion (a recorded move: POST /motion/{body_id}/custom/frames.bin, the same
   * motion-frames container as a preset) with this size's worker and the same bakeMotion as the
   * presets. Urgent (jumps the queue, the background queue waits for it). Not cached here: the
   * caller owns the result. `signal` cancels it, queued or running. `onProgress` gets the
   * worker's real per-step progress. `config`: solver overrides for this bake only (e.g. a
   * smaller dt for a move faster than the presets). `maxFrames`: simulate only that many frames.
   */
  bakeCustom(
    size: string,
    frames: ArrayBuffer,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: BakeProgress) => void;
      config?: Record<string, number>;
      maxFrames?: number;
    } = {},
  ): Promise<BakedMotion> {
    const { signal, onProgress, config, maxFrames } = options;
    const worker = this.workers.find((w) => w.size === size);
    if (!worker) return Promise.reject(new Error(`Size ${size} is not loaded`));
    const aborted = () => new DOMException('The bake was cancelled', 'AbortError');
    if (signal?.aborted) return Promise.reject(aborted());
    const key = `custom:${++this.customCount}`;
    this.frameBuffers.set(key, Promise.resolve(frames));
    const unsubscribe = onProgress
      ? this.subscribe(() => {
          const p = this.progressOf(size, key);
          if (p) onProgress(p);
        })
      : undefined;
    const cancel = () => worker.cancel(key, aborted());
    signal?.addEventListener('abort', cancel, { once: true });
    this.urgentPending++;
    return worker.enqueue(key, true, { config, maxFrames }).finally(() => {
      this.urgentPending--;
      signal?.removeEventListener('abort', cancel);
      unsubscribe?.();
      this.frameBuffers.delete(key);
      this.progress.delete(`${size}:${key}`);
      this.emit();
    });
  }

  /** Background precompute, in this order, after any urgent requests (standalone use only). */
  prefetch(motionIds: string[]) {
    if (this.managed) return;
    for (const motionId of motionIds)
      for (const size of this.sizes) this.bake(size, motionId, false).catch(() => undefined);
  }

  dispose() {
    this.abort.abort();
    for (const w of this.workers) w.dispose();
    this.bakes.clear();
    this.store?.forget(this);
    this.listeners.clear();
  }
}
