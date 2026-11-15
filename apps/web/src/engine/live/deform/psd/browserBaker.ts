// Browser bake for the pose-space correctives (agent V7): fetches this body's motion data from the
// local body service (/api, loopback), asks it for the motion frames of each chain of key poses
// (POST /motion/{body_id}/custom/frames.bin, the "Record a move" path), and bakes the chains in a
// small pool of Web Workers (psd.worker.ts), most important first. Each worker refits the model
// after its chain, so the live jacket gets the first correctives after one chain. Nothing leaves
// the machine and nothing is stored.
import { api, type ClothAsset } from '../../../../api.ts';
import { motionWasmRequested } from '../../../motion/MotionClient.ts';
import { parseRig, type MotionAnchors } from '../../../motion/rig.ts';
import type { LiveGarmentBinding } from '../../contract.ts';
import { fetchCustomFrames } from '../../record/customRequest.ts';
import { PSD } from './config.ts';
import type { PsdModelData, PsdSample } from './model.ts';
import { PsdNotEnabledError, type PsdBaker } from './PoseCorrectives.ts';
import { scheduleChain, TRAINING_CHAINS } from './poses.ts';
import type { PsdWorkerRequest, PsdWorkerResponse } from './psd.worker.ts';

const ID = /^[a-f0-9]{64}$/;

/** The product id of a binding key `<body_id>|<product_id>|…` (LiveAvatar's key), or null. */
export function productIdFromKey(key: string): string | null {
  const field = key.split('|')[1] ?? '';
  return ID.test(field) ? field : null;
}

/** Whether the product of `productId` has one of `styles` (the service's product list). */
export function styleAllowed(
  products: { product_id: string; style: string }[],
  productId: string | null,
  styles: readonly string[],
) {
  const style = products.find((p) => p.product_id === productId)?.style;
  return { style: style ?? null, allowed: style !== undefined && styles.includes(style) };
}

/** The body id of a binding whose key starts with it: `<body_id>|…` (LiveAvatar's key). */
export function bodyIdFromKey(key: string): string | null {
  const head = key.split('|')[0];
  return ID.test(head) ? head : null;
}

async function binary(path: string, signal: AbortSignal) {
  const response = await fetch(`/api${path}`, { cache: 'no-store', signal });
  if (response.status === 404) throw new Error('Body expired from memory');
  if (!response.ok) throw new Error(`Motion data unavailable (${response.status})`);
  return response.arrayBuffer();
}

function anchorsOf(value: unknown): MotionAnchors {
  const a = value as Partial<MotionAnchors> | null;
  if (!a || typeof a !== 'object' || !a.rings || !a.exposure_vertices || !a.points)
    throw new Error('The body service returned invalid motion anchors');
  return a as MotionAnchors;
}

export type BrowserBakerOptions = {
  /** Body id of a binding (default: the key's first `|` field). */
  bodyId?: (binding: LiveGarmentBinding) => string | null;
  /** Bake workers (default PSD.workers). */
  workers?: number;
  /** Product styles to bake for, or 'all' (`?psd=1`); default PSD.defaultOnStyles. */
  styles?: readonly string[] | 'all';
};

type Pending = { resolve: (m: PsdWorkerResponse) => void; reject: (e: Error) => void };

class PsdWorker {
  private worker = new Worker(new URL('./psd.worker.ts', import.meta.url), { type: 'module' });
  private pending = new Map<number, Pending>();
  private initError: Error | null = null;
  constructor() {
    this.worker.onmessage = (event: MessageEvent<PsdWorkerResponse>) => {
      const m = event.data;
      if (m.kind === 'error' && m.id === -1) {
        this.initError = new Error(m.message);
        for (const p of this.pending.values()) p.reject(this.initError);
        this.pending.clear();
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.kind === 'error') p.reject(new Error(m.message));
      else p.resolve(m);
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'PSD worker failed');
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    };
  }
  post(message: PsdWorkerRequest, transfer: Transferable[] = []) {
    this.worker.postMessage(message, transfer);
  }
  call<K extends PsdWorkerResponse['kind']>(
    message: PsdWorkerRequest & { id: number },
    transfer: Transferable[] = [],
  ): Promise<Extract<PsdWorkerResponse, { kind: K }>> {
    if (this.initError) return Promise.reject(this.initError);
    return new Promise((resolve, reject) => {
      this.pending.set(message.id, {
        resolve: resolve as (m: PsdWorkerResponse) => void,
        reject,
      });
      this.post(message, transfer);
    });
  }
  terminate() {
    this.worker.terminate();
    const error = new DOMException('The bake was cancelled', 'AbortError');
    for (const p of this.pending.values()) p.reject(error as unknown as Error);
    this.pending.clear();
  }
}

export function createBrowserBaker(options: BrowserBakerOptions = {}): PsdBaker {
  return async (binding, onModel, signal) => {
    const bodyId = (options.bodyId ?? ((b) => bodyIdFromKey(b.key)))(binding);
    if (!bodyId) throw new Error('the jacket binding names no body');
    // The bake runs in Web Workers: without them (Node, tests) there is nothing to run.
    if (typeof Worker === 'undefined') throw new PsdNotEnabledError('no Web Workers here');
    const styles = options.styles ?? PSD.defaultOnStyles;
    if (styles !== 'all') {
      const products = (await api.products(signal)) as { product_id: string; style: string }[];
      const { style, allowed } = styleAllowed(products, productIdFromKey(binding.key), styles);
      if (!allowed)
        throw new PsdNotEnabledError(
          `not validated for ${style ?? 'this product'} yet (PSD.defaultOnStyles)`,
        );
    }
    const asset = binding.asset as ClothAsset;
    const [rig, sdf, anchorsJson, grid] = await Promise.all([
      binary(`/motion/${bodyId}/rig.bin`, signal),
      binary(`/motion/${bodyId}/sdf.bin`, signal),
      fetch(`/api/motion/${bodyId}/anchors`, { cache: 'no-store', signal }).then((r) => {
        if (!r.ok) throw new Error(`Motion anchors unavailable (${r.status})`);
        return r.json() as Promise<unknown>;
      }),
      api.sdf(asset),
    ]);
    const anchors = anchorsOf(anchorsJson);
    const parsed = parseRig(rig);
    if (asset.body_positions.length !== parsed.vertexCount * 3)
      throw new Error('the jacket was built on another body');
    if (binding.count * 3 !== asset.initial.length)
      throw new Error('the binding does not match its cloth asset');
    const neutral = parsed.neutralPose;
    const chains = TRAINING_CHAINS.map((chain) => ({
      chain,
      schedule: scheduleChain(
        chain.poses.map((p) => p.pose),
        neutral,
      ),
    }));
    const total = chains.reduce((s, c) => s + c.chain.poses.length, 0);
    const count = Math.max(1, Math.min(options.workers ?? PSD.workers, chains.length));
    const workers = Array.from({ length: count }, () => new PsdWorker());
    const stop = () => workers.forEach((w) => w.terminate());
    signal.addEventListener('abort', stop, { once: true });
    try {
      const init: PsdWorkerRequest = {
        kind: 'init',
        rig,
        sdf,
        anchors,
        asset,
        grid,
        size: asset.key.split(':')[1] ?? '',
        count: binding.count,
        skinDrivers: Uint8Array.from(binding.skinDrivers),
        skinWeights: Float32Array.from(binding.skinWeights),
        bound: Float32Array.from(binding.bound),
        key: binding.key,
        wasm: motionWasmRequested(),
      };
      for (const w of workers) w.post(init); // structured clone: each worker gets its own copy
      const samples: PsdSample[] = [];
      let next = 0,
        id = 0,
        emitted = 0,
        latest: PsdModelData | null = null;
      const emit = (model: PsdModelData, done: boolean) => {
        if (model.samples.length < emitted || (!done && model.samples.length === emitted)) return;
        emitted = model.samples.length;
        latest = model;
        onModel(model, { learnt: model.samples.length, total }, done);
      };
      const loop = async (w: PsdWorker) => {
        while (next < chains.length && !signal.aborted) {
          const { chain, schedule } = chains[next++];
          const frames = await fetchCustomFrames(bodyId, schedule.request, signal);
          const baked = await w.call<'samples'>(
            { kind: 'chain', id: ++id, chain, sampleTimes: schedule.sampleTimes, frames },
            [frames],
          );
          samples.push(...baked.samples);
          if (samples.length === total) return; // the final fit follows
          const fit = await w.call<'model'>({ kind: 'fit', id: ++id, samples: [...samples] });
          emit(fit.model, false);
        }
      };
      await Promise.all(workers.map(loop));
      if (signal.aborted) return;
      if (latest && emitted === samples.length) emit(latest, true);
      else {
        const fit = await workers[0].call<'model'>({ kind: 'fit', id: ++id, samples });
        emit(fit.model, true);
      }
    } finally {
      signal.removeEventListener('abort', stop);
      stop();
    }
  };
}
