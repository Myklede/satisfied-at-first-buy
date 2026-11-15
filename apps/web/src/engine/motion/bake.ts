// Bake one (size, motion): relax the size's shell on the frame-0 body, then step the cloth
// solver through P1's motion frames with the articulated collider, recording the cloth and the
// fit metrics at every 30 fps frame. Uses ClothSolver's public API only (setCollider,
// setRootAnchors, rebuildLayerPairs, step, snapshot). Pure: runs in the worker and in Node.
import { ClothSolver, type ClothAsset } from '../cloth/ClothSolver.ts';
import type { KernelFactory } from '../cloth/wasm/kernels.ts';
import type { ColliderKernelFactory } from './wasm/colliderKernels.ts';
import { ArticulatedCollider, type ArticulatedSdf } from './articulatedCollider.ts';
import { bindArmholes, poseArmholes } from './armhole.ts';
import { cloneState, restoreInto } from './cloneState.ts';
import { MOTION_FIT, WAISTBANDS, type Waistband } from './config.ts';
import {
  cuffBeyondWrist,
  exposedMask,
  garmentTopology,
  hemAboveWaistband,
  restriction,
  summarise,
  type FrameAnchors,
  type FrameMetrics,
  type SizeMotionSummary,
} from './metrics.ts';
import {
  anchorFrame,
  armDrivers,
  driverWeight,
  frameMatrices,
  matricesAt,
  SkinBinding,
  skinVertices,
  vertexBlend,
  type MotionAnchors,
  type MotionFrames,
  type MotionRig,
} from './rig.ts';

export type BakeInput = {
  asset: ClothAsset;
  /** The asset's static grid SDF (only used by the solver constructor). */
  grid: Float32Array;
  rig: MotionRig;
  sdf: ArticulatedSdf;
  frames: MotionFrames;
  anchors: MotionAnchors;
  size: string;
};

export type BakedMotion = {
  motionId: string;
  size: string;
  assetKey: string;
  fps: number;
  frameCount: number;
  particles: number;
  /** (F, N, 3) cloth positions, metres. Frame 0 = relaxed on the neutral body. */
  positions: Float32Array;
  /** (F, N) per-particle peak edge strain, quantised: value / 255 × STRAIN_SCALE. */
  strain: Uint8Array;
  /** (F, E) 1 where the exposure-zone vertex (anchors.exposure_vertices.low order) is exposed. */
  exposed: Uint8Array;
  exposureVertices: Uint32Array;
  /** Per exposure vertex, the highest waistband level that still includes it: 0 low, 1 mid, 2 high. */
  exposureLevel: Uint8Array;
  metrics: FrameMetrics[];
  summary: SizeMotionSummary;
  timings: {
    relaxMs: number;
    relaxSeconds: number;
    /** True when the relaxed frame-0 state came from options.relaxCache (relaxMs = copy time). */
    relaxCached: boolean;
    motionMs: number;
    steps: number;
    meanStepMs: number;
    totalMs: number;
  };
  checks: BakeChecks;
};

export type BakeChecks = {
  finite: boolean;
  /** Deepest cloth particle inside the body over all frames (cm, positive = inside). */
  maxPenetrationCm: number;
  /** Share of particle-frames more than 0.5 cm inside the body. */
  penetratingShare: number;
  maxStrain: number;
  /** Frame-0 (relaxed, neutral) numbers compared with the static analytic fit by the caller. */
  neutral: { shoulderCm: number; hemVsHipCm: number; sleeveCm: number };
};

export const STRAIN_SCALE = 0.12;

export type BakeProgress = { phase: 'relax' | 'motion'; done: number; total: number };

export type BakeOptions = {
  /** Stop after this many frames (tests and diagnostics); default: the whole motion. */
  maxFrames?: number;
  /** Asset config overrides (diagnostics only; the UI never sets them). */
  config?: Record<string, number>;
  /**
   * Keeps the relaxed frame-0 state between bakes of one garment size (the motion worker holds
   * one per size). Every contract motion starts from the same neutral pose, so the relax is the
   * same for all of them: a later bake copies the state instead of relaxing again, with
   * bit-identical results (bake.test.ts). Reused only for the same asset, rig, SDF, config
   * overrides and frame-0 pose.
   */
  relaxCache?: RelaxCache;
  /**
   * WebAssembly kernels for the relax and motion steps (cloth/wasm/kernels.ts `wasmKernels`),
   * bit-identical to the JS loops. The motion worker passes them once its start-up self-check
   * has passed (motion/wasm/motionKernels.ts); undefined = plain JS.
   */
  kernels?: KernelFactory;
  /**
   * WebAssembly collider queries (motion/wasm/colliderKernels.ts), bit-identical to the JS
   * ArticulatedCollider; the worker passes them once its body-data check has passed.
   */
  colliderKernels?: ColliderKernelFactory;
  /**
   * Root anchors bind to skin whose arm weight is below this (default
   * MOTION_FIT.rootArmWeightMax). Experiments only (hem-lift study, record/tools/hemExperiments);
   * part of the relax-cache key when set. Presets never set it.
   */
  rootArmWeightMax?: number;
  /**
   * Armhole stop for this bake (experiments): on/off, or on with overrides of
   * MOTION_FIT.armholeStop; default MOTION_FIT.armholeStop.enabled.
   */
  armholeStop?:
    | boolean
    | {
        bandM?: number;
        armWeightMin?: number;
        stiffness?: number;
        direction?: 'axis' | 'anchor';
        lra?: number;
        lraMode?: 'euclidean' | 'vertical';
      };
};

/** Opaque holder for BakeOptions.relaxCache. */
export type RelaxCache = { entry?: RelaxEntry };
type RelaxEntry = {
  asset: ClothAsset;
  rig: MotionRig;
  sdf: ArticulatedSdf;
  grid: Float32Array;
  config: string;
  frame0: Float64Array;
  state: { solver: ClothSolver; collider: ArticulatedCollider };
  binding: SkinBinding;
  cuffPaths: { binding: SkinBinding; out: Float64Array }[];
  relaxSeconds: number;
};

export function bakeMotion(
  input: BakeInput,
  onProgress?: (progress: BakeProgress) => void,
  options: BakeOptions = {},
): BakedMotion {
  // The WebAssembly kernels' instances are reused by the next bake of this thread: give them back
  // however the bake ends (one solver and one collider memory per worker).
  const held: Held = {};
  try {
    return bake(input, onProgress, options, held);
  } finally {
    held.solver?.releaseKernels();
    held.collider?.releaseKernels();
  }
}
type Held = { solver?: ClothSolver; collider?: ArticulatedCollider };

function bake(
  input: BakeInput,
  onProgress: ((progress: BakeProgress) => void) | undefined,
  options: BakeOptions,
  held: Held,
): BakedMotion {
  const started = performance.now();
  const { rig, frames } = input;
  // Motion solver settings (MOTION_FIT.solver) over the asset's shell config. The hand stop
  // (guides = 2) stays on: its arm paths are skinned to the forearm/hand every step
  // (setCuffPaths below), so the cuff band cannot ride over the moving hand.
  const asset: ClothAsset = {
    ...input.asset,
    config: { ...input.asset.config, ...MOTION_FIT.solver, ...options.config },
  };
  const dt = asset.config.dt;
  const drivers = rig.drivers.length * 12;
  const current = new Float64Array(drivers),
    previous = new Float64Array(drivers);
  frameMatrices(frames, 0, current);
  const cache = options.relaxCache,
    configKey = JSON.stringify(
      options.rootArmWeightMax === undefined
        ? (options.config ?? {})
        : { ...options.config, rootArmWeightMaxOverride: options.rootArmWeightMax },
    ),
    hit = cache?.entry;
  const reuse =
    hit !== undefined &&
    hit.asset === input.asset &&
    hit.rig === rig &&
    hit.sdf === input.sdf &&
    hit.grid === input.grid &&
    hit.config === configKey &&
    hit.frame0.length === current.length &&
    hit.frame0.every((v, i) => Object.is(v, current[i]));
  const shared = new Set<unknown>([input.asset, asset, rig, input.sdf, input.grid]);
  let solver: ClothSolver,
    collider: ArticulatedCollider,
    binding: SkinBinding,
    cuffPaths: { binding: SkinBinding; out: Float64Array }[],
    relaxSeconds: number,
    relaxMs: number;
  if (reuse) {
    // Same relaxed state as a fresh relax would produce (it is deterministic): copy it.
    const relaxStart = performance.now();
    // Fresh objects from the constructors, then the relaxed state copied into them.
    collider = restoreInto(new ArticulatedCollider(input.sdf, rig), hit.state.collider, shared);
    solver = restoreInto(
      new ClothSolver(asset, input.grid),
      hit.state.solver,
      shared,
      new Map([[hit.state.collider, collider]]),
    );
    ({ binding, cuffPaths } = hit);
    held.solver = solver;
    held.collider = collider;
    relaxSeconds = hit.relaxSeconds;
    relaxMs = performance.now() - relaxStart;
  } else {
    solver = new ClothSolver(asset, input.grid);
    // Same as cloth.worker.ts for no-relax assets: start from the exact mesh-space wrap.
    if (asset.config.maxSeconds === 0) {
      solver.positions.set(asset.initial);
      solver.previous.set(asset.initial);
    }
    collider = new ArticulatedCollider(input.sdf, rig).setFrame(current);
    held.solver = solver;
    held.collider = collider;
    solver.setCollider(collider);
    const skin0 = skinVertices(rig, current, new Float32Array(rig.vertexCount * 3));
    // Shoulder/neck root anchors ride on the trunk and shoulder girdle, never on arm skin: the
    // LBS skin over the deltoid swings with the humerus (measured 6–7 cm at reach_up_both),
    // which dragged the tethered yoke up with the arm.
    const arms = armDrivers(rig);
    binding = new SkinBinding(
      rig,
      solver.rootAnchors,
      current,
      skin0,
      (v) => driverWeight(rig, v, arms) < (options.rootArmWeightMax ?? MOTION_FIT.rootArmWeightMax),
    );
    solver.setRootAnchors(binding.pose(current, new Float64Array(solver.rootAnchors.length)));
    // Hand-stop arm paths ride on the forearm and hand skin (nearest arm/hand vertex, LBS).
    cuffPaths = solver.cuffPathNames.map((name) => {
      const points = Float64Array.from(input.asset.cuff_colliders![name].path.flat());
      return {
        binding: new SkinBinding(
          rig,
          points,
          current,
          skin0,
          (v) => driverWeight(rig, v, arms) > 0.5,
        ),
        out: new Float64Array(points.length),
      };
    });
    if (cuffPaths.length)
      solver.setCuffPaths(
        cuffPaths.map((c) => c.binding.pose(current, c.out)),
        true,
      );

    // 1. Quiet relax on the neutral (frame 0) body.
    useKernels(solver, collider, options);
    const relaxStart = performance.now();
    const relaxSteps = Math.ceil(MOTION_FIT.relaxMaxSeconds / dt);
    for (let s = 0; s < relaxSteps; s++) {
      solver.step();
      if (!Number.isFinite(solver.energy)) throw new Error('Cloth relax became non-finite');
      onProgress?.({ phase: 'relax', done: s + 1, total: relaxSteps });
      if (
        solver.elapsed >= MOTION_FIT.relaxMinSeconds &&
        solver.energy < asset.config.kineticEpsilon
      )
        break;
    }
    relaxSeconds = solver.elapsed;
    relaxMs = performance.now() - relaxStart;
    if (cache) {
      // The cached copy holds plain arrays (cloneState refuses the kernels' functions); the
      // kernels are attached again below, with the same numbers.
      solver.detachKernels();
      collider.detachKernels();
      cache.entry = {
        asset: input.asset,
        rig,
        sdf: input.sdf,
        grid: input.grid,
        config: configKey,
        frame0: current.slice(),
        state: cloneState({ solver, collider }, shared),
        binding,
        cuffPaths,
        relaxSeconds,
      };
    }
  }
  useKernels(solver, collider, options);
  // Armhole stop (MOTION_FIT.armholeStop): bound on the relaxed frame-0 state after the relax, so
  // the relax and frame 0 are unchanged; a no-op until the arm moves.
  const armholes =
    (options.armholeStop ?? MOTION_FIT.armholeStop.enabled === 1) !== false
      ? bindArmholes(
          rig,
          asset,
          solver.positions,
          current,
          skinVertices(rig, current, new Float32Array(rig.vertexCount * 3)),
          {
            ...MOTION_FIT.armholeStop,
            ...(typeof options.armholeStop === 'object' ? options.armholeStop : {}),
          },
          solver.edges,
        )
      : null;
  if (armholes) {
    solver.setArmholeStops(poseArmholes(rig, armholes, current), true);
    solver.setArmholeTethers(armholes.tethers);
  }
  const anchorsOut = new Float64Array(solver.rootAnchors.length);
  const moveCuffPaths = (m: Float64Array) => {
    if (cuffPaths.length)
      solver.setCuffPaths(
        cuffPaths.map((c) => c.binding.pose(m, c.out)),
        false,
      );
  };

  const n = solver.positions.length / 3,
    F = Math.min(frames.count, options.maxFrames ?? frames.count);
  const positions = new Float32Array(F * n * 3),
    strain = new Uint8Array(F * n);
  const topology = garmentTopology(asset, solver.positions, solver.edges);
  const low = Uint32Array.from(input.anchors.exposure_vertices.low);
  const levelSets = WAISTBANDS.map((l) => new Set(input.anchors.exposure_vertices[l]));
  const exposureLevel = Uint8Array.from(low, (v) =>
    levelSets[2].has(v) ? 2 : levelSets[1].has(v) ? 1 : 0,
  );
  const exposed = new Uint8Array(F * low.length);
  const exposureSkin = new Float64Array(low.length * 3),
    exposureUp = new Float64Array(low.length * 3),
    blend = new Float64Array(12);
  const metrics: FrameMetrics[] = [];
  let maxPenetration = 0,
    penetrating = 0,
    penetrationSamples = 0,
    maxStrain = 0,
    finite = true;

  const record = (f: number) => {
    const snap = solver.snapshot({ strain: true, gap: false });
    positions.set(snap.positions, f * n * 3);
    for (let i = 0; i < n; i++) {
      const s = snap.strain[i];
      if (s > maxStrain) maxStrain = s;
      strain[f * n + i] = Math.max(0, Math.min(255, Math.round((s / STRAIN_SCALE) * 255)));
    }
    const p = solver.positions;
    for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) finite = false;
    // Penetration against the posed body (the collider's own distance; cloth surface offset
    // by its layer/loft is not subtracted: this checks the cloth mid-surface is outside skin).
    // Every MOTION_FIT.penetrationEveryFrames-th frame (an exact query per particle costs as
    // much as a solver step); the share is over the sampled particle-frames.
    if (f % MOTION_FIT.penetrationEveryFrames === 0)
      for (let i = 0; i < n; i++) {
        const d = collider.distance(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
        if (-d > maxPenetration) maxPenetration = -d;
        if (d < -0.005) penetrating++;
        penetrationSamples++;
      }
    const anchors = frameAnchors(frames, f);
    // Exposure-zone skin at this frame (position and carried rest +Y, like P1's up vectors).
    frameMatrices(frames, f, current);
    for (let k = 0; k < low.length; k++) {
      const v = low[k];
      vertexBlend(rig, v, current, blend);
      const x = rig.restVertices[v * 3],
        y = rig.restVertices[v * 3 + 1],
        z = rig.restVertices[v * 3 + 2];
      exposureSkin[k * 3] = blend[0] * x + blend[1] * y + blend[2] * z + blend[3];
      exposureSkin[k * 3 + 1] = blend[4] * x + blend[5] * y + blend[6] * z + blend[7];
      exposureSkin[k * 3 + 2] = blend[8] * x + blend[9] * y + blend[10] * z + blend[11];
      const l = Math.hypot(blend[1], blend[5], blend[9]) || 1;
      exposureUp[k * 3] = blend[1] / l;
      exposureUp[k * 3 + 1] = blend[5] / l;
      exposureUp[k * 3 + 2] = blend[9] / l;
    }
    exposedMask(
      topology,
      p,
      exposureSkin,
      exposureUp,
      exposed.subarray(f * low.length, (f + 1) * low.length),
    );
    metrics.push({
      hemAboveCm: hemAboveWaistband(topology, p, anchors),
      cuffBeyondWristCm: cuffBeyondWrist(topology, p, anchors),
      zones: restriction(topology, solver.edges, solver.edgeStrain),
    });
  };
  record(0);
  const neutral = neutralOffsets(asset, solver.positions);

  // 2. Motion: two solver steps per 30 fps frame (dt = 1/60), collider and shoulder anchors
  // moved with the body before every step.
  const motionStart = performance.now();
  const perFrame = Math.max(1, Math.round(1 / (frames.fps * dt)));
  let steps = 0;
  frameMatrices(frames, 0, previous);
  for (let f = 1; f < F; f++) {
    for (let s = 1; s <= perFrame; s++) {
      const t = (f - 1 + s / perFrame) / frames.fps;
      matricesAt(frames, t, current);
      collider.setFrame(current, previous, dt);
      solver.setCollider(collider);
      solver.setRootAnchors(binding.pose(current, anchorsOut));
      moveCuffPaths(current);
      if (armholes) solver.setArmholeStops(poseArmholes(rig, armholes, current), false);
      solver.step();
      steps++;
      previous.set(current);
      if (!Number.isFinite(solver.energy)) throw new Error(`Cloth became non-finite at frame ${f}`);
    }
    if (f % MOTION_FIT.layerPairEveryFrames === 0) solver.rebuildLayerPairs();
    record(f);
    onProgress?.({ phase: 'motion', done: f, total: F - 1 });
  }
  const motionMs = performance.now() - motionStart;
  return {
    motionId: frames.motion.id,
    size: input.size,
    assetKey: asset.key,
    fps: frames.fps,
    frameCount: F,
    particles: n,
    positions,
    strain,
    exposed,
    exposureVertices: low,
    exposureLevel,
    metrics,
    summary: summarise(input.size, metrics),
    timings: {
      relaxMs,
      relaxSeconds,
      relaxCached: reuse,
      motionMs,
      steps,
      meanStepMs: steps ? motionMs / steps : 0,
      totalMs: performance.now() - started,
    },
    checks: {
      finite,
      maxPenetrationCm: maxPenetration * 100,
      penetratingShare: penetrationSamples ? penetrating / penetrationSamples : 0,
      maxStrain,
      neutral,
    },
  };
}

/** Attaches the WebAssembly kernels; if that fails (e.g. no memory), that part stays on JS. */
function useKernels(solver: ClothSolver, collider: ArticulatedCollider, options: BakeOptions) {
  const attach = (what: string, run: () => void) => {
    try {
      run();
    } catch (error) {
      console.warn(`Motion bake runs its ${what} on JS: WebAssembly kernels failed`, error);
    }
  };
  if (options.kernels) attach('solver', () => solver.attachKernels(options.kernels!));
  if (options.colliderKernels)
    attach('collider', () => collider.attachKernels(options.colliderKernels!));
}

export function frameAnchors(frames: MotionFrames, f: number): FrameAnchors {
  const rings = {} as FrameAnchors['rings'];
  for (const level of WAISTBANDS)
    rings[level as Waistband] = {
      points: anchorFrame(frames, `ring.waistband_${level}`, f),
      up: anchorFrame(frames, `up.waistband_${level}`, f),
    };
  return {
    rings,
    points: anchorFrame(frames, 'points', f),
    joints: anchorFrame(frames, 'joints', f),
  };
}

/**
 * The static gate formulas of scripts/check_realism.py `offsets()` on the relaxed frame-0
 * cloth: shoulder seam along the upper arm from the acromion, cuff past the wrist along the
 * forearm, back hem height vs the hip level (cm). Body landmarks are the asset's (display pose).
 */
export function neutralOffsets(
  asset: Pick<ClothAsset, 'body_landmarks' | 'landmarks' | 'paths'>,
  p: ArrayLike<number>,
) {
  const lm = asset.body_landmarks,
    at = (i: number) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
  const sub = (a: number[], b: number[]) => a.map((x, i) => x - b[i]);
  const unit = (a: number[]) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return a.map((x) => x / l);
  };
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  let shoulder = 0,
    sleeve = 0;
  for (const side of ['L', 'R']) {
    const acro = lm[`acromion_${side}`],
      elbow = lm[`elbow_${side}`],
      wrist = lm[`wrist_${side}`];
    const seam = at(asset.landmarks[`seam_${side}`]);
    const ids = asset.paths[`cuff_${side}`].slice(0, -1);
    const cuff = [0, 1, 2].map((k) => ids.reduce((s, i) => s + p[i * 3 + k], 0) / ids.length);
    shoulder += (dot(sub(seam, acro), unit(sub(elbow, acro))) * 100) / 2;
    sleeve += (dot(sub(cuff, wrist), unit(sub(wrist, elbow))) * 100) / 2;
  }
  const hem = at(asset.landmarks.hem_back);
  return {
    shoulderCm: shoulder,
    hemVsHipCm: (hem[1] - lm.hip_level[1]) * 100,
    sleeveCm: sleeve,
  };
}
