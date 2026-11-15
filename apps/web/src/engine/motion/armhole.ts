// Armhole stop for motion bakes (cloth/armholeStop.ts; agent V3, hem-lift study): which particles
// form each underarm seam, their anchors on the upper-arm skin, and the humerus axis per frame.
// Pure (rig + asset + positions), runs in the worker and in Node.
import { buildGeodesicTethers, type ArmholeTethers } from '../cloth/armholeStop.ts';
import { SkinBinding, driverWeight, type MotionRig } from './rig.ts';

export type ArmholeConfig = {
  /** Seam particles within this height (m) above the armhole's lowest point form the underarm. */
  bandM: number;
  /** Anchors bind to skin whose weight on that side's upper arm is at least this. */
  armWeightMin: number;
  /** Share of the violation corrected per substep (1 = hard). */
  stiffness?: number;
  /** Push direction (cloth/armholeStop.ts). */
  direction?: 'axis' | 'anchor';
  /** Long-range attachments from the stop points to the body panels and sleeves (1 = on). */
  lra?: number;
  /** Their projection (cloth/armholeStop.ts ArmholeTethers.mode). */
  lraMode?: 'euclidean' | 'vertical';
};

type Side = {
  ids: Uint32Array;
  binding: SkinBinding;
  anchors: Float64Array;
  axis: Float64Array;
  shoulder: number;
  elbow: number;
};
export type ArmholeBinding = {
  sides: Side[];
  stiffness: number;
  direction: 'axis' | 'anchor';
  /** Long-range attachments (cloth/armholeStop.ts), or null. */
  tethers: ArmholeTethers | null;
};

const SLEEVE_PANELS = [4, 5]; // garment/shell.py: 4 / 5 sleeves, 0-3 body and yoke

/** World position of a bone's head from the driver matrices (bone follows its driver rigidly). */
export function boneHead(rig: MotionRig, m: ArrayLike<number>, bone: number, out: Float64Array) {
  const d = rig.driverOfBone[bone] * 12,
    r = bone * 16,
    R = rig.restWorld,
    x = R[r + 3],
    y = R[r + 7],
    z = R[r + 11];
  for (let i = 0; i < 3; i++)
    out[i] = m[d + i * 4] * x + m[d + i * 4 + 1] * y + m[d + i * 4 + 2] * z + m[d + i * 4 + 3];
  return out;
}

/** Sleeve particles that share a triangle with a body or yoke particle (the armhole seam). */
export function armholeRing(
  panels: ArrayLike<number>,
  triangles: ArrayLike<number>,
  panel: number,
) {
  const out = new Set<number>();
  for (let t = 0; t < triangles.length; t += 3) {
    const ids = [triangles[t], triangles[t + 1], triangles[t + 2]];
    if (!ids.some((i) => panels[i] === panel) || !ids.some((i) => panels[i] <= 3)) continue;
    for (const i of ids) if (panels[i] === panel) out.add(i);
  }
  return Array.from(out).sort((a, b) => a - b);
}

/**
 * Binds each sleeve's underarm seam (armhole particles within cfg.bandM of its lowest point) to
 * the nearest upper-arm skin of the side whose shoulder is closest, at the relaxed frame-0 state.
 * Null when the garment has no sleeves.
 */
export function bindArmholes(
  rig: MotionRig,
  asset: {
    panels: ArrayLike<number>;
    triangles: ArrayLike<number>;
    config: Record<string, number>;
  },
  positions: ArrayLike<number>,
  matrices: ArrayLike<number>,
  skin: ArrayLike<number>,
  cfg: ArmholeConfig,
  edges?: ArrayLike<number>,
): ArmholeBinding | null {
  const bones = {
    L: [rig.bones.indexOf('upperarm01.L'), rig.bones.indexOf('lowerarm01.L')],
    R: [rig.bones.indexOf('upperarm01.R'), rig.bones.indexOf('lowerarm01.R')],
  };
  if (
    Object.values(bones)
      .flat()
      .some((b) => b < 0)
  )
    throw new Error('Rig has no arm bones');
  const head = new Float64Array(3);
  const sides: Side[] = [];
  for (const panel of SLEEVE_PANELS) {
    const ring = armholeRing(asset.panels, asset.triangles, panel);
    if (!ring.length) continue;
    let low = Infinity;
    for (const i of ring) low = Math.min(low, positions[i * 3 + 1]);
    const ids = Uint32Array.from(ring.filter((i) => positions[i * 3 + 1] <= low + cfg.bandM));
    const c = [0, 1, 2].map(
      (k) => ring.reduce((s, i) => s + positions[i * 3 + k], 0) / ring.length,
    );
    let side: 'L' | 'R' = 'L',
      best = Infinity;
    for (const s of ['L', 'R'] as const) {
      boneHead(rig, matrices, bones[s][0], head);
      const d = (head[0] - c[0]) ** 2 + (head[1] - c[1]) ** 2 + (head[2] - c[2]) ** 2;
      if (d < best) {
        best = d;
        side = s;
      }
    }
    const [shoulder, elbow] = bones[side];
    const driver = new Set([rig.driverOfBone[shoulder]]);
    const points = new Float64Array(ids.length * 3);
    ids.forEach((id, j) =>
      points.set([positions[id * 3], positions[id * 3 + 1], positions[id * 3 + 2]], j * 3),
    );
    const binding = new SkinBinding(
      rig,
      points,
      matrices,
      skin,
      (v) => driverWeight(rig, v, driver) >= cfg.armWeightMin,
    );
    sides.push({
      ids,
      binding,
      anchors: new Float64Array(ids.length * 3),
      axis: new Float64Array(3),
      shoulder,
      elbow,
    });
  }
  if (!sides.length) return null;
  let tethers: ArmholeTethers | null = null;
  if (cfg.lra && edges) {
    // Body panels (0-2) below the higher armhole bottom, and both sleeves: within their rest
    // geodesic distance of the nearest stop point x the fabric's own stretch limit.
    let armholeLow = -Infinity;
    for (const side of sides)
      for (const id of side.ids) armholeLow = Math.max(armholeLow, positions[id * 3 + 1]);
    const sources = new Set<number>(sides.flatMap((side) => Array.from(side.ids)));
    const candidates: number[] = [];
    for (let i = 0; i < asset.panels.length; i++) {
      if (sources.has(i)) continue;
      const panel = asset.panels[i];
      if ((panel <= 2 && positions[i * 3 + 1] < armholeLow) || SLEEVE_PANELS.includes(panel))
        candidates.push(i);
    }
    tethers = {
      ...buildGeodesicTethers(
        edges,
        positions,
        Array.from(sources),
        candidates,
        asset.config.stretchMax ?? 1,
      ),
      mode: cfg.lraMode ?? 'euclidean',
    };
  }
  return { sides, stiffness: cfg.stiffness ?? 1, direction: cfg.direction ?? 'axis', tethers };
}

/** Anchors and unit humerus axes for the driver matrices `m` (reuses the binding's buffers). */
export function poseArmholes(rig: MotionRig, armholes: ArmholeBinding, m: ArrayLike<number>) {
  const a = new Float64Array(3),
    b = new Float64Array(3);
  return armholes.sides.map((s) => {
    s.binding.pose(m, s.anchors);
    boneHead(rig, m, s.shoulder, a);
    boneHead(rig, m, s.elbow, b);
    const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1;
    s.axis[0] = (b[0] - a[0]) / l;
    s.axis[1] = (b[1] - a[1]) / l;
    s.axis[2] = (b[2] - a[2]) / l;
    return {
      ids: s.ids,
      anchors: s.anchors,
      axis: s.axis,
      stiffness: armholes.stiffness,
      direction: armholes.direction,
    };
  });
}
