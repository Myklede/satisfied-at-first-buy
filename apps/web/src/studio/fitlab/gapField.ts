// Per-particle inner gap (cm) of the live Fit Lab jacket, for the heatmap. Two parts:
//
// 1. REST: the cloth solver's own gap formula (engine/cloth/ClothSolver.ts snapshot(), the value
//    the kiosk heatmap shows) evaluated on the server's built shell (asset.initial) against the
//    server's body SDF (asset.sdf, the same collision field the solver uses). At the neutral pose
//    the live heatmap is therefore exactly the solver's gap of the shell on screen.
// 2. LIVE: the posed jacket is an LBS-skinned preview (no cloth solve). Each particle is bound to
//    its nearest body vertex at the neutral pose, within its own region (sleeves to their arm,
//    body panels to the torso: the same region rule as engine/live/garmentSkin.ts bindGarment).
//    Per frame the change of its signed distance along that vertex's normal is added to the rest
//    outer distance, and the solver formula is applied again. This is a geometric measurement of
//    the shown preview, not a cloth solve: the panel labels it "preview".
import type { BodyCollider } from '../../engine/cloth/collider';
import type { MotionRig } from '../../engine/motion/rig';
import { SLEEVE_ARM_WEIGHT_MIN, TORSO_LIMB_WEIGHT_MAX } from '../../engine/live/garmentSkin';

/** Solver constants the gap formula needs, from the cloth asset (never defaulted here). */
export interface GapParams {
  layerM: number;
  loftMinimumRatio: number;
  collisionMargin: number;
  /** asset.fabric_surface === 'neutral': the loft is drawn by the renderer, effective 0. */
  neutralSurface: boolean;
}

export class GapFieldError extends Error {}

/** Reads GapParams from a cloth asset; throws if the server did not send a needed constant. */
export function gapParams(asset: {
  layer_m: number;
  config: Record<string, number>;
  fabric_surface?: string;
}): GapParams {
  const ratio = asset.config.loftMinimumRatio,
    margin = asset.config.collisionMargin;
  if (!Number.isFinite(ratio) || !Number.isFinite(margin))
    throw new GapFieldError('Cloth asset lacks loftMinimumRatio/collisionMargin: no heatmap.');
  return {
    layerM: asset.layer_m,
    loftMinimumRatio: ratio,
    collisionMargin: margin,
    neutralSurface: asset.fabric_surface === 'neutral',
  };
}

/**
 * ClothSolver.snapshot() gap, verbatim: outer = body distance (m, SDF + bias);
 * effective = min(loft or 0, max(loft·loftMinimumRatio, outer − layer − collisionMargin));
 * gap = (outer − effective − layer) · 100 cm.
 */
export function solverGapCm(outerM: number, loftM: number, p: GapParams): number {
  const effective = Math.min(
    p.neutralSurface ? 0 : loftM,
    Math.max(loftM * p.loftMinimumRatio, outerM - p.layerM - p.collisionMargin),
  );
  return (outerM - effective - p.layerM) * 100;
}

/** Outer body distance (m) of each particle: collider distance + the asset's SDF bias. */
export function restOuterDistances(
  positions: ArrayLike<number>,
  collider: BodyCollider,
  biasM: number,
): Float32Array {
  const n = positions.length / 3;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++)
    out[i] =
      collider.distance(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]) + biasM;
  return out;
}

/** Body vertex region: 0 = left arm, 1 = right arm, 2 = torso, 3 = neither (legs, joints). */
export type Region = 0 | 1 | 2 | 3;

/** Per body vertex region from the rig's skin weights (garmentSkin.ts limbWeights thresholds). */
export function bodyRegions(
  rig: Pick<
    MotionRig,
    'bones' | 'drivers' | 'skinWeights' | 'vertexDrivers' | 'influences' | 'vertexCount'
  >,
): Uint8Array {
  const group = (re: RegExp) => {
    const out = new Set<number>();
    rig.drivers.forEach((bone, d) => {
      if (re.test(rig.bones[bone])) out.add(d);
    });
    return out;
  };
  const armL = group(/^(upperarm01|lowerarm01)\.L$/),
    armR = group(/^(upperarm01|lowerarm01)\.R$/),
    leg = group(/^(upperleg01|lowerleg01|foot)\.[LR]$/);
  const K = rig.influences;
  const regions = new Uint8Array(rig.vertexCount);
  for (let v = 0; v < rig.vertexCount; v++) {
    let l = 0,
      r = 0,
      g = 0;
    for (let k = 0; k < K; k++) {
      const w = rig.skinWeights[v * K + k];
      if (!w) continue;
      const d = rig.vertexDrivers[v * K + k];
      if (armL.has(d)) l += w;
      else if (armR.has(d)) r += w;
      else if (leg.has(d)) g += w;
    }
    regions[v] =
      l >= SLEEVE_ARM_WEIGHT_MIN
        ? 0
        : r >= SLEEVE_ARM_WEIGHT_MIN
          ? 1
          : l + r < TORSO_LIMB_WEIGHT_MAX && g < TORSO_LIMB_WEIGHT_MAX
            ? 2
            : 3;
  }
  return regions;
}

/** Cloth panel ids of the sleeves (engine/live/garmentSkin.ts PANEL_SLEEVE_L / _R). */
const SLEEVE_PANELS = new Set([4, 5]);
/** Grid cell for the nearest-vertex search (m); garmentSkin.ts uses 0.04. */
const CELL_M = 0.04;

/** Region a particle binds to: sleeves by side (x ≥ 0 = left arm, as garmentSkin.ts), else torso. */
export function particleRegion(panel: number, x: number): Region {
  return SLEEVE_PANELS.has(panel) ? (x >= 0 ? 0 : 1) : 2;
}

/** Nearest body vertex of each particle within its region (brute force inside a cell grid). */
export function bindNearest(
  particles: ArrayLike<number>,
  panels: ArrayLike<number>,
  body: ArrayLike<number>,
  regions: Uint8Array,
): Uint32Array {
  const grids = [
    new Map<string, number[]>(),
    new Map<string, number[]>(),
    new Map<string, number[]>(),
  ];
  const key = (x: number, y: number, z: number) =>
    `${Math.floor(x / CELL_M)},${Math.floor(y / CELL_M)},${Math.floor(z / CELL_M)}`;
  for (let v = 0; v < regions.length; v++) {
    const r = regions[v];
    if (r > 2) continue;
    const k = key(body[v * 3], body[v * 3 + 1], body[v * 3 + 2]);
    const cell = grids[r].get(k);
    if (cell) cell.push(v);
    else grids[r].set(k, [v]);
  }
  const n = particles.length / 3;
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const x = particles[i * 3],
      y = particles[i * 3 + 1],
      z = particles[i * 3 + 2];
    const grid = grids[particleRegion(panels[i], x)];
    const cx = Math.floor(x / CELL_M),
      cy = Math.floor(y / CELL_M),
      cz = Math.floor(z / CELL_M);
    let best = -1,
      bestD = Infinity;
    for (let r = 0; r <= 16; r++) {
      for (let a = -r; a <= r; a++)
        for (let b = -r; b <= r; b++)
          for (let c = -r; c <= r; c++) {
            if (Math.max(Math.abs(a), Math.abs(b), Math.abs(c)) !== r) continue;
            const cell = grid.get(`${cx + a},${cy + b},${cz + c}`);
            if (!cell) continue;
            for (const v of cell) {
              const d = Math.hypot(body[v * 3] - x, body[v * 3 + 1] - y, body[v * 3 + 2] - z);
              if (d < bestD) {
                bestD = d;
                best = v;
              }
            }
          }
      // Every vertex closer than r·CELL has been visited once shell r is done.
      if (best >= 0 && bestD <= r * CELL_M) break;
    }
    if (best < 0) throw new GapFieldError('A jacket particle found no body vertex in its region.');
    out[i] = best;
  }
  return out;
}

/** Signed distance of particle i from its bound body vertex along that vertex's normal (m). */
export function normalDistances(
  particles: ArrayLike<number>,
  body: ArrayLike<number>,
  normals: ArrayLike<number>,
  bound: Uint32Array,
  out: Float32Array,
): Float32Array {
  for (let i = 0; i < bound.length; i++) {
    const v = bound[i] * 3;
    const nx = normals[v],
      ny = normals[v + 1],
      nz = normals[v + 2];
    const len = Math.hypot(nx, ny, nz) || 1;
    out[i] =
      ((particles[i * 3] - body[v]) * nx +
        (particles[i * 3 + 1] - body[v + 1]) * ny +
        (particles[i * 3 + 2] - body[v + 2]) * nz) /
      len;
  }
  return out;
}

/** The live gap field of one bound jacket. */
export class LiveGapField {
  readonly gap: Float32Array;
  private distances: Float32Array;
  constructor(
    private readonly outerRest: Float32Array,
    private readonly loft: ArrayLike<number>,
    private readonly params: GapParams,
    private readonly bound: Uint32Array,
    /** normalDistances() of the bound (neutral) jacket on the neutral body. */
    private readonly reference: Float32Array,
  ) {
    const n = outerRest.length;
    if (loft.length !== n || bound.length !== n || reference.length !== n)
      throw new GapFieldError('Gap field arrays disagree in length.');
    this.gap = new Float32Array(n);
    this.distances = new Float32Array(n);
    this.restGap();
  }

  /** The rest gap (solver formula on the built shell): what the field shows at the neutral pose. */
  restGap(): Float32Array {
    for (let i = 0; i < this.gap.length; i++)
      this.gap[i] = solverGapCm(this.outerRest[i], this.loft[i], this.params);
    return this.gap;
  }

  /** Gap of the posed jacket on the posed body (cm per particle); returns the live array. */
  update(
    jacket: ArrayLike<number>,
    body: ArrayLike<number>,
    normals: ArrayLike<number>,
  ): Float32Array {
    normalDistances(jacket, body, normals, this.bound, this.distances);
    for (let i = 0; i < this.gap.length; i++)
      this.gap[i] = solverGapCm(
        this.outerRest[i] + (this.distances[i] - this.reference[i]),
        this.loft[i],
        this.params,
      );
    return this.gap;
  }
}

/** Share of particles per heatmap band (tight ≤ tightCm < good < looseCm ≤ loose). */
export function bandShares(gap: ArrayLike<number>, tightCm: number, looseCm: number) {
  let tight = 0,
    loose = 0;
  for (let i = 0; i < gap.length; i++) {
    if (gap[i] <= tightCm) tight++;
    else if (gap[i] >= looseCm) loose++;
  }
  const n = gap.length || 1;
  return { tight: tight / n, good: (gap.length - tight - loose) / n, loose: loose / n };
}
