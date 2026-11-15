// Body guard for the pose-space correctives (agent V7). An interpolated correction is a blend of
// true solves, not a solve itself: near the skin a blend can point into the body. In the AR view
// that matters most: the body is drawn depth-only as an occluder, so cloth inside the body is a
// hole in the jacket that shows the real video (lead, 2026-11-13; measured as "jacket holes",
// docs/STATUS-psd.md). The guard keeps every corrected particle outside the posed skin of its own
// body region:
//   d = (p − x_v) · n_v ≥ min(d_LBS, PSD.guardMarginM)
// with x_v, n_v the posed position and normal of the candidate skin vertex nearest the corrected
// particle (candidates chosen at bind, spread over the skin the particle can reach, as V6's
// dynamics collisions do). A correction never moves a particle deeper than the skinned jacket had
// it, and never below the margin when it started outside. Only the inward part along n_v is
// removed; nothing is added that a solve did not produce. Sleeves use their own arm's skin, the
// rest the trunk's (garmentSkin.ts binding rules). Pure, no DOM.
import { smoothNormals } from '../../../cloth/normals.ts';
import { skinVertices, type MotionRig } from '../../../motion/rig.ts';
import { particleBlend, type SkinArrays } from './localFrame.ts';

/** Candidate skin vertices per particle (the nearest few, then spread by farthest-point). */
export const GUARD_CANDIDATES = 6;
const NEAREST = 3;
/** Candidates are taken within this distance of the neutral particle (m). */
const GUARD_SEARCH_M = 0.15;
/** No skin of its region within this (m) at neutral: the particle is not near the body. */
const GUARD_NEAR_M = 0.08;
const CELL_M = 0.04;
const ARM_WEIGHT_MIN = 0.3; // garmentSkin.SLEEVE_ARM_WEIGHT_MIN
const LIMB_WEIGHT_MAX = 0.5; // garmentSkin.TORSO_LIMB_WEIGHT_MAX
const PANEL_SLEEVE_L = 4,
  PANEL_SLEEVE_R = 5;
/** Unused candidate slot. */
export const NO_GUARD = 0xffffffff;

export type PsdGuard = {
  /** (N, GUARD_CANDIDATES) body vertex indices, NO_GUARD for unused slots / unguarded particles. */
  candidates: Uint32Array;
  /** Per particle, its neutral distance to its nearest candidate (m). */
  distance: Float32Array;
  /**
   * Fallback where no candidate is near the corrected particle: the nearest skin normal at the
   * neutral pose in the particle's LBS local frame (N·3), and the particle's neutral clearance
   * along it (m). The correction's inward part along that direction is limited to
   * clearance − margin.
   */
  normal: Float32Array;
  clearance: Float32Array;
};

function limbWeights(rig: MotionRig) {
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
  const out = new Float32Array(rig.vertexCount * 3);
  for (let v = 0; v < rig.vertexCount; v++)
    for (let k = 0; k < K; k++) {
      const w = rig.skinWeights[v * K + k];
      if (!w) continue;
      const d = rig.vertexDrivers[v * K + k];
      if (armL.has(d)) out[v * 3] += w;
      else if (armR.has(d)) out[v * 3 + 1] += w;
      else if (leg.has(d)) out[v * 3 + 2] += w;
    }
  return out;
}

class VertexGrid {
  private cells = new Map<string, number[]>();
  private points: ArrayLike<number>;
  constructor(points: ArrayLike<number>, count: number, allowed: (v: number) => boolean) {
    this.points = points;
    for (let v = 0; v < count; v++) {
      if (!allowed(v)) continue;
      const key = this.key(points[v * 3], points[v * 3 + 1], points[v * 3 + 2]);
      const cell = this.cells.get(key);
      if (cell) cell.push(v);
      else this.cells.set(key, [v]);
    }
  }
  private key(x: number, y: number, z: number) {
    return `${Math.floor(x / CELL_M)},${Math.floor(y / CELL_M)},${Math.floor(z / CELL_M)}`;
  }
  /** Vertices within `radius` of (x, y, z) with their squared distances. */
  within(x: number, y: number, z: number, radius: number) {
    const p = this.points;
    const cx = Math.floor(x / CELL_M),
      cy = Math.floor(y / CELL_M),
      cz = Math.floor(z / CELL_M),
      reach = Math.ceil(radius / CELL_M);
    const out: [number, number][] = [];
    const r2 = radius * radius;
    for (let i = -reach; i <= reach; i++)
      for (let j = -reach; j <= reach; j++)
        for (let l = -reach; l <= reach; l++) {
          const cell = this.cells.get(`${cx + i},${cy + j},${cz + l}`);
          if (!cell) continue;
          for (const v of cell) {
            const d = (p[v * 3] - x) ** 2 + (p[v * 3 + 1] - y) ** 2 + (p[v * 3 + 2] - z) ** 2;
            if (d <= r2) out.push([v, d]);
          }
        }
    return out;
  }
}

/**
 * The guard of a binding: per particle, GUARD_CANDIDATES skin vertices of its region on the
 * neutral body (the rig skinned with the neutral drivers m0): the nearest NEAREST, then spread
 * over the skin within GUARD_SEARCH_M (farthest-point), so a particle the solve slides along the
 * body still finds the skin under it.
 */
export function bodyGuard(
  rig: MotionRig,
  m0: ArrayLike<number>,
  skin: SkinArrays,
  bound: ArrayLike<number>,
  panels: ArrayLike<number>,
): PsdGuard {
  const count = skin.count;
  const G = skin.skinDrivers.length / count;
  const V = rig.vertexCount;
  const body = skinVertices(rig, m0, new Float32Array(V * 3));
  const normals = new Float32Array(V * 3);
  smoothNormals(body, rig.faces, normals);
  const normal = new Float32Array(count * 3);
  const clearance = new Float32Array(count);
  const blend = new Float64Array(12);
  const limbs = limbWeights(rig);
  const grids = {
    L: new VertexGrid(body, V, (v) => limbs[v * 3] >= ARM_WEIGHT_MIN),
    R: new VertexGrid(body, V, (v) => limbs[v * 3 + 1] >= ARM_WEIGHT_MIN),
    trunk: new VertexGrid(
      body,
      V,
      (v) =>
        limbs[v * 3] + limbs[v * 3 + 1] < LIMB_WEIGHT_MAX && limbs[v * 3 + 2] < LIMB_WEIGHT_MAX,
    ),
  };
  const A = GUARD_CANDIDATES;
  const candidates = new Uint32Array(count * A).fill(NO_GUARD);
  const distance = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const x = bound[i * 3],
      y = bound[i * 3 + 1],
      z = bound[i * 3 + 2];
    const panel = panels[i];
    const grid =
      panel === PANEL_SLEEVE_L || panel === PANEL_SLEEVE_R
        ? x >= 0
          ? grids.L
          : grids.R
        : grids.trunk;
    const near = grid.within(x, y, z, GUARD_SEARCH_M).sort((a, b) => a[1] - b[1]);
    if (!near.length || near[0][1] > GUARD_NEAR_M * GUARD_NEAR_M) continue;
    distance[i] = Math.sqrt(near[0][1]);
    {
      // Fallback direction: the nearest vertex's normal, into the particle's local frame
      // (transpose of the blend's linear part ≈ its inverse for a near-rotation).
      const v = near[0][0];
      const nx = normals[v * 3],
        ny = normals[v * 3 + 1],
        nz = normals[v * 3 + 2];
      particleBlend(skin, G, i, m0, blend);
      let lx = blend[0] * nx + blend[4] * ny + blend[8] * nz,
        ly = blend[1] * nx + blend[5] * ny + blend[9] * nz,
        lz = blend[2] * nx + blend[6] * ny + blend[10] * nz;
      const l = Math.hypot(lx, ly, lz) || 1;
      lx /= l;
      ly /= l;
      lz /= l;
      normal[i * 3] = lx;
      normal[i * 3 + 1] = ly;
      normal[i * 3 + 2] = lz;
      clearance[i] =
        (x - body[v * 3]) * nx + (y - body[v * 3 + 1]) * ny + (z - body[v * 3 + 2]) * nz;
    }
    const picked: number[] = [];
    for (let k = 0; k < Math.min(NEAREST, near.length); k++) picked.push(near[k][0]);
    // Farthest-point spread over the rest.
    const minD = near.map(([v]) =>
      Math.min(
        ...picked.map(
          (u) =>
            (body[v * 3] - body[u * 3]) ** 2 +
            (body[v * 3 + 1] - body[u * 3 + 1]) ** 2 +
            (body[v * 3 + 2] - body[u * 3 + 2]) ** 2,
        ),
      ),
    );
    while (picked.length < Math.min(A, near.length)) {
      let best = -1,
        bestD = 0;
      for (let k = 0; k < near.length; k++)
        if (minD[k] > bestD) {
          bestD = minD[k];
          best = k;
        }
      if (best < 0) break;
      const u = near[best][0];
      picked.push(u);
      for (let k = 0; k < near.length; k++) {
        const v = near[k][0];
        const d =
          (body[v * 3] - body[u * 3]) ** 2 +
          (body[v * 3 + 1] - body[u * 3 + 1]) ** 2 +
          (body[v * 3 + 2] - body[u * 3 + 2]) ** 2;
        if (d < minD[k]) minD[k] = d;
      }
    }
    picked.forEach((v, k) => (candidates[i * A + k] = v));
  }
  return { candidates, distance, normal, clearance };
}
