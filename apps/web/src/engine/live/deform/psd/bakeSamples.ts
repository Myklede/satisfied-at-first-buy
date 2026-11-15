// True-solve samples for the pose-space correctives (agent V7). Each chain of key poses is baked
// by the motion bake itself (motion/bake.ts bakeMotion: the same ClothSolver, collider, anchors,
// armhole stop and MOTION_FIT constants as "Try moves" and "Record a move"), from the relaxed
// neutral drape; at the end of each key pose's hold the particles are recorded and turned into a
// local correction field (localFrame.ts). Pure: runs in the PSD worker and in Node.
import type { ClothAsset } from '../../../cloth/ClothSolver.ts';
import type { KernelFactory } from '../../../cloth/wasm/kernels.ts';
import type { ArticulatedSdf } from '../../../motion/articulatedCollider.ts';
import {
  bakeMotion,
  type BakedMotion,
  type BakeProgress,
  type RelaxCache,
} from '../../../motion/bake.ts';
import {
  frameMatrices,
  type MotionAnchors,
  type MotionFrames,
  type MotionRig,
} from '../../../motion/rig.ts';
import type { ColliderKernelFactory } from '../../../motion/wasm/colliderKernels.ts';
import { PSD } from './config.ts';
import { localOffsets, type SkinArrays } from './localFrame.ts';
import type { PsdSample } from './model.ts';
import type { PsdChain } from './poses.ts';

export type PsdBakeInput = {
  asset: ClothAsset;
  grid: Float32Array;
  rig: MotionRig;
  sdf: ArticulatedSdf;
  anchors: MotionAnchors;
  size: string;
  /** The live binding (LiveGarmentBinding): skin arrays and the neutral particle positions. */
  skin: SkinArrays;
  bound: ArrayLike<number>;
};

export type PsdBakeOptions = {
  relaxCache?: RelaxCache;
  kernels?: KernelFactory;
  colliderKernels?: ColliderKernelFactory;
  onProgress?: (progress: BakeProgress) => void;
  /** Keep the solved world positions of each sample (validation tools). */
  keepSolved?: boolean;
  /** Bake rate (frames per second fed to bakeMotion); default PSD.bakeFps. */
  fps?: number;
  /** bakeMotion options passed through (experiments only, e.g. the armhole stop). */
  bakeOptions?: Record<string, unknown>;
};

export type SettleStat = { id: string; meanCm: number; p95Cm: number; maxCm: number };

export type ChainResult = {
  chainId: string;
  samples: PsdSample[];
  /** B(neutral)⁻¹ · (relaxed neutral drape − bound), N·3: what the bake's relax changed (local). */
  neutralLocal: Float32Array;
  /** Per sample: particle travel over the last bake frame of its hold (1 / fps s), cm. */
  settle: SettleStat[];
  timings: BakedMotion['timings'];
  checks: BakedMotion['checks'];
  /** Per sample, the solved world positions and the frame's driver matrices (keepSolved only). */
  solved?: { positions: Float32Array; drivers: Float64Array }[];
  neutralDrivers: Float64Array;
};

/**
 * The 30 fps service frames resampled to `fps` (every k-th frame, k = 30 / fps an integer): the
 * same poses and anchors at the kept frames; bakeMotion interpolates the drivers between them.
 */
export function decimateFrames(frames: MotionFrames, fps: number): MotionFrames {
  const k = Math.round(frames.fps / fps);
  if (k < 1 || Math.abs(frames.fps / k - fps) > 1e-9)
    throw new Error(`Cannot resample ${frames.fps} fps frames to ${fps} fps`);
  if (k === 1) return frames;
  const keep: number[] = [];
  for (let f = 0; f < frames.count; f += k) keep.push(f);
  const n = frames.matrices.length / frames.count;
  const matrices = new Float32Array(keep.length * n);
  keep.forEach((f, j) => matrices.set(frames.matrices.subarray(f * n, (f + 1) * n), j * n));
  const anchors = new Map<string, { data: Float32Array; perFrame: number }>();
  for (const [name, entry] of frames.anchors) {
    const data = new Float32Array(keep.length * entry.perFrame);
    keep.forEach((f, j) =>
      data.set(
        entry.data.subarray(f * entry.perFrame, (f + 1) * entry.perFrame),
        j * entry.perFrame,
      ),
    );
    anchors.set(name, { data, perFrame: entry.perFrame });
  }
  return {
    ...frames,
    fps,
    count: keep.length,
    matrices,
    frames: keep.map((f) => frames.frames[f]),
    poses: keep.map((f) => frames.poses[f]),
    anchors,
  };
}

/**
 * Bakes one chain (frames: the service's 30 fps frames of scheduleChain's request) and returns
 * its samples' correction fields. `sampleTimes` from scheduleChain (s, on the bake's grid).
 */
export function bakeChain(
  input: PsdBakeInput,
  chain: PsdChain,
  sampleTimes: number[],
  frames30: MotionFrames,
  options: PsdBakeOptions = {},
): ChainResult {
  if (sampleTimes.length !== chain.poses.length) throw new Error('One sample time per key pose');
  const fps = options.fps ?? PSD.bakeFps;
  const frames = decimateFrames(frames30, fps);
  const index = sampleTimes.map((t) => Math.round(t * fps));
  for (let s = 0; s < index.length; s++)
    if (
      Math.abs(index[s] / fps - sampleTimes[s]) > 1e-6 ||
      index[s] >= frames.count ||
      index[s] < 1
    )
      throw new Error(`Sample ${chain.poses[s].id} is off the bake's frame grid`);
  const last = Math.max(...index);
  const bake = bakeMotion(
    {
      asset: input.asset,
      grid: input.grid,
      rig: input.rig,
      sdf: input.sdf,
      frames,
      anchors: input.anchors,
      size: input.size,
    },
    options.onProgress,
    {
      ...(options.bakeOptions ?? {}),
      relaxCache: options.relaxCache,
      kernels: options.kernels,
      colliderKernels: options.colliderKernels,
      maxFrames: last + 1,
    },
  );
  const n = input.skin.count;
  if (bake.particles !== n) throw new Error('The cloth asset does not match the live binding');
  const D = input.rig.drivers.length * 12;
  const m0 = frameMatrices(frames, 0, new Float64Array(D));
  const at = (f: number) => bake.positions.subarray(f * n * 3, (f + 1) * n * 3);
  const neutralLocal = localOffsets(input.skin, input.bound, m0, m0, at(0));
  const samples: PsdSample[] = [];
  const settle: SettleStat[] = [];
  const solved: ChainResult['solved'] = options.keepSolved ? [] : undefined;
  chain.poses.forEach((key, s) => {
    const f = index[s];
    const m = frameMatrices(frames, f, new Float64Array(D));
    const positions = at(f);
    const field = localOffsets(input.skin, input.bound, m0, m, positions);
    for (let i = 0; i < field.length; i++) field[i] -= neutralLocal[i];
    samples.push({ id: key.id, kind: key.kind, pose: { ...key.pose }, field, mirror: key.mirror });
    settle.push(settleStat(key.id, at(f - 1), positions));
    solved?.push({ positions: positions.slice(), drivers: m });
  });
  return {
    chainId: chain.id,
    samples,
    neutralLocal,
    settle,
    timings: bake.timings,
    checks: bake.checks,
    solved,
    neutralDrivers: m0,
  };
}

/** Per-particle travel between two frames, cm: mean, 95th percentile, max. */
export function settleStat(id: string, a: ArrayLike<number>, b: ArrayLike<number>): SettleStat {
  const n = a.length / 3;
  const d = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    d[i] = Math.hypot(
      b[i * 3] - a[i * 3],
      b[i * 3 + 1] - a[i * 3 + 1],
      b[i * 3 + 2] - a[i * 3 + 2],
    );
    sum += d[i];
  }
  d.sort();
  return {
    id,
    meanCm: (sum / Math.max(1, n)) * 100,
    p95Cm: (d[Math.min(n - 1, Math.floor(0.95 * n))] ?? 0) * 100,
    maxCm: (d[n - 1] ?? 0) * 100,
  };
}
