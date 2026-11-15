// Start-up self-check for the WebAssembly kernels: a tiny deterministic cloth (two overlapping
// 8 × 8 sheets with tethers, a collar ring, an elastic row, layer pairs and particle
// self-contact) is stepped against a moving sphere with the JS solver and with the kernels, and
// every float64 of the cloth is compared after every step. Any difference, or a module that
// fails to compile or run, means "use JS" (motion.worker.ts). A few ms; no network, no DOM.
import { ClothSolver, type ClothAsset } from '../ClothSolver.ts';
import type { BodyCollider } from '../collider.ts';
import { wasmKernels, type KernelFactory } from './kernels.ts';

const SIDE = 8,
  SPACING = 0.012,
  STEPS = 8;

/** A sphere moving at constant velocity (m/s); exact distance, gradient and surface velocity. */
class MovingSphere implements BodyCollider {
  motionBound = 0;
  private x = 0;
  private y = 0.97;
  private z = -0.1;
  private radius: number;
  private v: [number, number, number];
  constructor(radius: number, v: [number, number, number]) {
    this.radius = radius;
    this.v = v;
  }
  move(dt: number) {
    this.x += this.v[0] * dt;
    this.y += this.v[1] * dt;
    this.z += this.v[2] * dt;
    this.motionBound = Math.sqrt(this.v[0] ** 2 + this.v[1] ** 2 + this.v[2] ** 2) * dt;
  }
  distance(x: number, y: number, z: number, gradient?: Float64Array, threshold = Infinity) {
    const dx = x - this.x,
      dy = y - this.y,
      dz = z - this.z,
      length = Math.sqrt(dx * dx + dy * dy + dz * dz),
      value = length - this.radius;
    if (gradient && value < threshold && length > 0) {
      gradient[0] = dx / length;
      gradient[1] = dy / length;
      gradient[2] = dz / length;
    }
    return value;
  }
  surfaceVelocity(_x: number, _y: number, _z: number, out: Float64Array) {
    out[0] = this.v[0];
    out[1] = this.v[1];
    out[2] = this.v[2];
  }
}

/**
 * The fixture cloth: sheet A (panel 0, under) and B (panel 4, 1.5 mm in front of A). Only the
 * fields the solver reads are filled in (render and fit fields are not used by a step).
 */
export function selfCheckAsset(config: Record<string, number>): ClothAsset {
  const positions: number[] = [],
    triangles: number[] = [],
    panels: number[] = [],
    elastic: number[] = [],
    tethers: number[] = [],
    lengths: number[] = [];
  const id = (sheet: number, i: number, j: number) => sheet * SIDE * SIDE + j * SIDE + i;
  for (let sheet = 0; sheet < 2; sheet++)
    for (let j = 0; j < SIDE; j++)
      for (let i = 0; i < SIDE; i++) {
        // A gentle curve around the sphere, B slightly sheared so the layers are not parallel.
        const x = (i - (SIDE - 1) / 2) * SPACING + sheet * 0.0007 * j,
          y = 1.02 - j * SPACING,
          z = 0.004 * Math.cos(x * 20) + sheet * 0.0015;
        positions.push(x, y, z);
        panels.push(sheet ? 4 : 0);
        elastic.push(j === SIDE - 1 ? 1 : 0);
      }
  for (let sheet = 0; sheet < 2; sheet++)
    for (let j = 0; j + 1 < SIDE; j++)
      for (let i = 0; i + 1 < SIDE; i++) {
        const a = id(sheet, i, j),
          b = id(sheet, i + 1, j),
          c = id(sheet, i, j + 1),
          d = id(sheet, i + 1, j + 1);
        triangles.push(a, b, d, a, d, c);
      }
  // Tethers from each sheet's top row to every particle below it in the same column.
  for (let sheet = 0; sheet < 2; sheet++)
    for (let i = 0; i < SIDE; i++)
      for (let j = 1; j < SIDE; j++) {
        tethers.push(id(sheet, i, 0), id(sheet, i, j));
        lengths.push(j * SPACING);
      }
  const ring = [0, 1, 2, 3, 4, 5, 6, 7, 15, 23, 22, 21, 20, 19, 18, 17, 16, 8, 0];
  return {
    key: 'wasm-self-check',
    pose: 'self-check',
    rest: positions,
    initial: positions,
    triangles,
    panels,
    elastic,
    stitch: positions.map(() => 0),
    loft: positions.map(() => 0.002),
    welds: [id(0, 0, SIDE - 1), id(1, 0, SIDE - 1)],
    tethers,
    tether_lengths: lengths,
    cuff_colliders: {},
    paths: { neckline: ring, hem: Array.from({ length: SIDE }, (_, i) => id(1, i, SIDE - 1)) },
    landmarks: {},
    body_landmarks: {},
    body_positions: [],
    body_triangles: [],
    sdf: { sdf_id: 'self-check', origin: [-1, 0, -1], dimensions: [2, 2, 2], spacing: 2 },
    config,
    rest_measurements_cm: {},
    colour: '#000000',
    finish: 'self-check',
    layer_m: 0.001,
    stretch_max_source: 'self-check',
    build_ms: 0,
    fabric_surface: 'neutral',
  } as unknown as ClothAsset;
}

/** FNV-1a (32-bit) over the raw bytes of float64 arrays. */
function fnv(hash: number, ...arrays: Float64Array[]) {
  for (const values of arrays) {
    const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
    for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 16777619);
  }
  return hash >>> 0;
}

/** Steps the fixture; returns one hash per step (positions, previous, velocity, energy). */
export function selfCheckRun(config: Record<string, number>, kernels?: KernelFactory) {
  const asset = selfCheckAsset(config),
    grid = new Float32Array(8).fill(1),
    solver = new ClothSolver(asset, grid),
    sphere = new MovingSphere(0.11, [0.05, 0.3, 0.2]),
    hashes: number[] = [];
  if (kernels) solver.attachKernels(kernels);
  for (let s = 0; s < STEPS; s++) {
    sphere.move(config.dt);
    solver.setCollider(sphere);
    solver.setRootAnchors(solver.rootAnchors.map((v, k) => (k % 3 === 1 ? v + 0.001 * s : v)));
    solver.step();
    if (s % 5 === 4) solver.rebuildLayerPairs();
    hashes.push(
      fnv(
        2166136261,
        solver.positions,
        solver.previous,
        solver.velocity,
        Float64Array.of(solver.energy),
      ),
    );
  }
  solver.detachKernels(); // gives the pooled instance back
  return hashes;
}

/**
 * Solver settings of a motion bake that the fixture exercises (the asset shell config merged
 * with MOTION_FIT.solver, as bake.ts does), with the tiny sheet's own contact sizes.
 */
export const SELF_CHECK_CONFIG: Record<string, number> = {
  dt: 1 / 60,
  substeps: 10,
  iterations: 2,
  gravity: -9.81,
  damping: 0.985,
  stretchCompliance: 1e-8,
  bendCompliance: 0.0002,
  seamBendCompliance: 0.02,
  elasticCompliance: 0.00002,
  stretchMax: 1.03,
  friction: 0.35,
  collisionMargin: 0.002,
  selfRadius: 0.001,
  kineticEpsilon: 0.00001,
  maxSeconds: 0,
  particleMass: 0.0001,
  bendMaxCorrection: 0.003,
  bendRestEdgeFraction: 0.25,
  velocityLimit: 2,
  collarCompression: 0.9,
  selfEvery: 2,
  loftMinimumRatio: 0.25,
  loftCompliance: 0.3,
  ringCorrectionLimit: 0.002,
  smallSteps: 1,
  strainLimitPasses: 2,
  oneWayTethers: 1,
  supportCompliance: 0.3,
  rootCompliance: 0.1,
  hingeCompliance: 1,
  dampingPerSecond: 3,
  guides: 2,
  contactFromInitial: 1,
  hingeSkipElastic: 1,
  elasticStretchMax: 1.1,
  layerPairRadius: 0.015,
  layerPairsPerVertex: 3,
  layerGap: 0.002,
  contactCompliance: 0.3,
  contactHardMin: -0.004,
  finalStrainPasses: 16,
  contactPlaneRadius: 0.005,
  contactHardElastic: 1,
  rootLiftFree: 1,
};

export type SelfCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * JS and kernels on the fixture, with the motion settings and with 3 final strain passes (which
 * leave edges above their limit, so the next step's hot-list passes have work); ok only when
 * every step hashes the same.
 */
export function selfCheck(kernels: KernelFactory = wasmKernels): SelfCheckResult {
  try {
    for (const config of [SELF_CHECK_CONFIG, { ...SELF_CHECK_CONFIG, finalStrainPasses: 3 }]) {
      const js = selfCheckRun(config),
        wasm = selfCheckRun(config, kernels);
      const step = js.findIndex((hash, s) => hash !== wasm[s]);
      if (step >= 0)
        return {
          ok: false,
          reason: `differs from JS at fixture step ${step + 1} of ${STEPS} (final strain passes ${config.finalStrainPasses})`,
        };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
