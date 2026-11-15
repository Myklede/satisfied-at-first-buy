// Fit-in-motion bake worker: one worker per garment size, so S and M bake in parallel. Parses
// P1's rig / articulated SDF once per body, keeps the size's cloth asset, and bakes motions on
// request (bake.ts; ClothSolver public API only). Body data stays in memory.
import type { ClothAsset } from '../cloth/ClothSolver.ts';
import { parseArticulatedSdf, type ArticulatedSdf } from './articulatedCollider.ts';
import { bakeMotion, type BakedMotion, type RelaxCache } from './bake.ts';
import { parseFrames, parseRig, type MotionAnchors, type MotionRig } from './rig.ts';
import { checkColliderKernels, motionKernels } from './wasm/motionKernels.ts';
import type { ColliderKernelFactory } from './wasm/colliderKernels.ts';

export type MotionWorkerRequest =
  | {
      kind: 'body';
      bodyKey: string;
      rig: ArrayBuffer;
      sdf: ArrayBuffer;
      anchors: MotionAnchors;
      /** false = bake with the JS solver (`?motionwasm=0`); default: WebAssembly if it checks out. */
      wasm?: boolean;
    }
  | { kind: 'garment'; size: string; asset: ClothAsset; grid: ArrayBuffer }
  | {
      kind: 'bake';
      id: number;
      motionId: string;
      frames: ArrayBuffer;
      /**
       * Solver overrides for this bake only (bake.ts BakeOptions.config). Presets never send
       * it. A recorded move faster than the presets is baked with a smaller step (dt), see
       * engine/live/record/subdivision.ts.
       */
      config?: Record<string, number>;
      /** Stop after this many frames (custom bakes: the recorded window's end). */
      maxFrames?: number;
    };

export type MotionWorkerResponse =
  | { kind: 'progress'; id: number; phase: 'relax' | 'motion'; done: number; total: number }
  | { kind: 'baked'; id: number; bake: BakedMotion }
  | { kind: 'error'; id: number; message: string };

let rig: MotionRig | undefined;
let sdf: ArticulatedSdf | undefined;
let anchors: MotionAnchors | undefined;
let garment: { size: string; asset: ClothAsset; grid: Float32Array } | undefined;
/** The size's relaxed frame-0 state, shared by its motions (bake.ts BakeOptions.relaxCache). */
let relaxCache: RelaxCache = {};
/** Relaxed states of bakes with solver overrides, one per override (never the presets' one). */
let overrideCaches = new Map<string, RelaxCache>();
const cacheFor = (config: Record<string, number> | undefined) => {
  if (!config) return relaxCache;
  const key = JSON.stringify(config);
  let cache = overrideCaches.get(key);
  if (!cache) overrideCaches.set(key, (cache = {}));
  return cache;
};
/** Bake with the WebAssembly kernels (after their self-check, motionKernels) unless false. */
let wasm = true;
/** WebAssembly collider queries for this body (checked on its data), or undefined for JS. */
let colliderKernels: ColliderKernelFactory | undefined;

const post = (message: MotionWorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer);

self.onmessage = (event: MessageEvent<MotionWorkerRequest>) => {
  const m = event.data;
  try {
    if (m.kind === 'body') {
      rig = parseRig(m.rig);
      sdf = parseArticulatedSdf(m.sdf, rig);
      anchors = m.anchors;
      relaxCache = {};
      overrideCaches = new Map();
      wasm = m.wasm !== false;
      // Self-checks now (solver once per worker, collider per body), not at a click's bake.
      colliderKernels = motionKernels(wasm) ? checkColliderKernels(sdf, rig) : undefined;
    } else if (m.kind === 'garment') {
      garment = { size: m.size, asset: m.asset, grid: new Float32Array(m.grid) };
      relaxCache = {};
      overrideCaches = new Map();
    } else if (m.kind === 'bake') {
      if (!rig || !sdf || !anchors || !garment) throw new Error('Motion worker is not initialised');
      const frames = parseFrames(m.frames, rig.drivers.length);
      let last = 0;
      const bake = bakeMotion(
        { ...garment, rig, sdf, frames, anchors },
        (p) => {
          const now = performance.now();
          if (now - last < 200 && p.done !== p.total) return;
          last = now;
          post({ kind: 'progress', id: m.id, ...p });
        },
        {
          relaxCache: cacheFor(m.config),
          kernels: motionKernels(wasm),
          colliderKernels,
          ...(m.config ? { config: m.config } : {}),
          ...(m.maxFrames ? { maxFrames: m.maxFrames } : {}),
        },
      );
      post({ kind: 'baked', id: m.id, bake }, [
        bake.positions.buffer,
        bake.strain.buffer,
        bake.exposed.buffer,
      ]);
    }
  } catch (error) {
    post({
      kind: 'error',
      id: m.kind === 'bake' ? m.id : -1,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
