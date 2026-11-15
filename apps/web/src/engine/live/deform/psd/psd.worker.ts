// Pose-space corrective bake worker (agent V7): bakes chains of key poses with the motion bake
// (bakeSamples.ts → motion/bake.ts, the WebAssembly kernels after their self-checks, like
// motion.worker.ts) and fits the model off the main thread. Body data stays in memory.
import type { ClothAsset } from '../../../cloth/ClothSolver.ts';
import { parseArticulatedSdf, type ArticulatedSdf } from '../../../motion/articulatedCollider.ts';
import type { RelaxCache } from '../../../motion/bake.ts';
import { parseFrames, parseRig, type MotionAnchors, type MotionRig } from '../../../motion/rig.ts';
import type { ColliderKernelFactory } from '../../../motion/wasm/colliderKernels.ts';
import { checkColliderKernels, motionKernels } from '../../../motion/wasm/motionKernels.ts';
import { bakeChain, type SettleStat } from './bakeSamples.ts';
import { bodyGuard, type PsdGuard } from './guard.ts';
import { fitModel, type PsdModelData, type PsdSample } from './model.ts';
import type { PsdChain } from './poses.ts';

export type PsdWorkerRequest =
  | {
      kind: 'init';
      rig: ArrayBuffer;
      sdf: ArrayBuffer;
      anchors: MotionAnchors;
      asset: ClothAsset;
      grid: ArrayBuffer;
      size: string;
      count: number;
      skinDrivers: Uint8Array;
      skinWeights: Float32Array;
      bound: Float32Array;
      key: string;
      wasm?: boolean;
    }
  | { kind: 'chain'; id: number; chain: PsdChain; sampleTimes: number[]; frames: ArrayBuffer }
  | { kind: 'fit'; id: number; samples: PsdSample[] };

export type PsdWorkerResponse =
  | {
      kind: 'samples';
      id: number;
      samples: PsdSample[];
      settle: SettleStat[];
      ms: number;
      steps: number;
      meanStepMs: number;
    }
  | { kind: 'model'; id: number; model: PsdModelData; ms: number }
  | { kind: 'error'; id: number; message: string };

let state:
  | {
      rig: MotionRig;
      sdf: ArticulatedSdf;
      anchors: MotionAnchors;
      asset: ClothAsset;
      grid: Float32Array;
      size: string;
      skin: { count: number; skinDrivers: Uint8Array; skinWeights: Float32Array };
      bound: Float32Array;
      key: string;
      wasm: boolean;
      colliderKernels?: ColliderKernelFactory;
      relaxCache: RelaxCache;
      /** Neutral drivers (frame 0 of the first chain) and the body guard built from them. */
      neutralDrivers?: Float64Array;
      guard?: PsdGuard;
    }
  | undefined;

const post = (message: PsdWorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer);

self.onmessage = (event: MessageEvent<PsdWorkerRequest>) => {
  const m = event.data;
  try {
    if (m.kind === 'init') {
      const rig = parseRig(m.rig);
      const sdf = parseArticulatedSdf(m.sdf, rig);
      const wasm = m.wasm !== false;
      state = {
        rig,
        sdf,
        anchors: m.anchors,
        asset: m.asset,
        grid: new Float32Array(m.grid),
        size: m.size,
        skin: { count: m.count, skinDrivers: m.skinDrivers, skinWeights: m.skinWeights },
        bound: m.bound,
        key: m.key,
        wasm,
        colliderKernels: motionKernels(wasm) ? checkColliderKernels(sdf, rig) : undefined,
        relaxCache: {},
      };
    } else if (m.kind === 'chain') {
      if (!state) throw new Error('PSD worker is not initialised');
      const started = performance.now();
      const frames = parseFrames(m.frames, state.rig.drivers.length);
      const result = bakeChain(
        { ...state, skin: state.skin, bound: state.bound },
        m.chain,
        m.sampleTimes,
        frames,
        {
          relaxCache: state.relaxCache,
          kernels: motionKernels(state.wasm),
          colliderKernels: state.colliderKernels,
        },
      );
      state.neutralDrivers ??= result.neutralDrivers;
      post(
        {
          kind: 'samples',
          id: m.id,
          samples: result.samples,
          settle: result.settle,
          ms: performance.now() - started,
          steps: result.timings.steps,
          meanStepMs: result.timings.meanStepMs,
        },
        result.samples.map((s) => s.field.buffer),
      );
    } else if (m.kind === 'fit') {
      if (!state) throw new Error('PSD worker is not initialised');
      const started = performance.now();
      if (!state.guard && state.neutralDrivers)
        state.guard = bodyGuard(
          state.rig,
          state.neutralDrivers,
          state.skin,
          state.bound,
          state.asset.panels,
        );
      const model = fitModel(
        m.samples,
        state.rig.neutralPose,
        state.bound,
        state.key,
        {},
        state.guard ?? null,
      );
      post({ kind: 'model', id: m.id, model, ms: performance.now() - started }, [
        model.basis.buffer,
      ]);
    }
  } catch (error) {
    post({
      kind: 'error',
      id: m.kind === 'init' ? -1 : m.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
