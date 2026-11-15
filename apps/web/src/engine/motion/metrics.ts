// Fit-in-motion metrics (P2): belly/back exposure against the trouser waistband, sleeve ride-up
// at the wrist, and where the fabric reaches its stretch limit. Pure functions; units: input
// positions in metres (scene frame), reported values in cm. All numbers are computed from the
// simulated cloth and P1's skinned anchors (services/body/body_service/motion/FORMAT.md).
import { MOTION_FIT, WAISTBANDS, type Waistband } from './config.ts';

/**
 * Hem height relative to a body point along the local torso "up": the hem point used is the
 * one nearest to the line through `p` along `up` (closest point on the hem polyline, measured
 * perpendicular to `up`). Returns (hem − p)·up in metres and the lateral distance of that hem
 * point from the line, or null when the hem has no point within `maxLateral`.
 * Hem above p ⇒ positive (skin between p and the hem is uncovered).
 */
export function hemAbove(
  ring: ArrayLike<number>,
  positions: ArrayLike<number>,
  px: number,
  py: number,
  pz: number,
  ux: number,
  uy: number,
  uz: number,
  maxLateral = MOTION_FIT.hemLineMaxM,
): { height: number; lateral: number } | null {
  // Work in the plane perpendicular to up: q = (h − p) − ((h − p)·u)u.
  let best = Infinity,
    height = 0;
  const n = ring.length;
  for (let s = 0; s < n; s++) {
    const a = ring[s] * 3,
      b = ring[(s + 1) % n] * 3;
    const ax = positions[a] - px,
      ay = positions[a + 1] - py,
      az = positions[a + 2] - pz,
      bx = positions[b] - px,
      by = positions[b + 1] - py,
      bz = positions[b + 2] - pz;
    const ah = ax * ux + ay * uy + az * uz,
      bh = bx * ux + by * uy + bz * uz;
    // Perpendicular components.
    const aqx = ax - ah * ux,
      aqy = ay - ah * uy,
      aqz = az - ah * uz,
      dqx = bx - bh * ux - aqx,
      dqy = by - bh * uy - aqy,
      dqz = bz - bh * uz - aqz;
    const len2 = dqx * dqx + dqy * dqy + dqz * dqz;
    const t =
      len2 > 1e-14 ? Math.max(0, Math.min(1, -(aqx * dqx + aqy * dqy + aqz * dqz) / len2)) : 0;
    const qx = aqx + t * dqx,
      qy = aqy + t * dqy,
      qz = aqz + t * dqz,
      d2 = qx * qx + qy * qy + qz * qz;
    if (d2 < best) {
      best = d2;
      height = ah + t * (bh - ah);
    }
  }
  const lateral = Math.sqrt(best);
  return lateral <= maxLateral ? { height, lateral } : null;
}

export type GarmentTopology = {
  /** Hem ring particle ids (closed loop, no repeated last id). */
  hem: Uint32Array;
  cuff: { L: Uint32Array; R: Uint32Array };
  /** Restriction zone per particle (index into RESTRICTION_ZONES). */
  zone: Uint8Array;
  /** Edge stretch limit as a strain (limit ratio − 1) per solver edge. */
  edgeLimit: Float32Array;
};

export const RESTRICTION_ZONES = [
  'back',
  'shoulders',
  'armpit',
  'elbow',
  'front',
  'sleeves',
  'collar/hood',
] as const;
export type RestrictionZone = (typeof RESTRICTION_ZONES)[number];

type AssetLike = {
  paths: Record<string, number[]>;
  panels: number[];
  triangles: number[];
  elastic: number[];
  body_landmarks: Record<string, number[]>;
  config: Record<string, number>;
};

const ring = (path: number[] | undefined, name: string) => {
  if (!path || path.length < 4) throw new Error(`Garment path ${name} missing`);
  return Uint32Array.from(path[0] === path[path.length - 1] ? path.slice(0, -1) : path);
};

/**
 * Static garment topology for the metrics. Zones are assigned from the frame-0 cloth
 * positions and the body landmarks of the asset (display pose), in priority order: armpit
 * (lowest armhole point ± zoneRadiusM), elbow (sleeve particles near the elbow landmark),
 * shoulders (yoke panel or near the acromion), back panel, front panels, rest of the sleeves,
 * collar and hood. Panel ids: garment/shell.py (0/1 front, 2 back, 3 yoke, 4/5 sleeves,
 * 6 collar, 7 hood).
 */
export function garmentTopology(
  asset: AssetLike,
  positions: ArrayLike<number>,
  edges: Uint32Array,
): GarmentTopology {
  const panels = asset.panels,
    n = panels.length,
    lm = asset.body_landmarks,
    r2 = MOTION_FIT.zoneRadiusM ** 2;
  // Armholes: sleeve particles sharing a triangle with a torso/yoke particle; armpit = lowest.
  const armpit: Record<'L' | 'R', number[] | null> = { L: null, R: null };
  for (const [side, panel] of [
    ['L', 4],
    ['R', 5],
  ] as const) {
    let lowest = Infinity;
    for (let t = 0; t < asset.triangles.length; t += 3) {
      const ids = [asset.triangles[t], asset.triangles[t + 1], asset.triangles[t + 2]];
      if (!ids.some((i) => panels[i] === panel) || !ids.some((i) => panels[i] <= 3)) continue;
      for (const i of ids)
        if (panels[i] === panel && positions[i * 3 + 1] < lowest) {
          lowest = positions[i * 3 + 1];
          armpit[side] = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
        }
    }
  }
  const near = (i: number, p: number[] | null | undefined) =>
    !!p &&
    (positions[i * 3] - p[0]) ** 2 +
      (positions[i * 3 + 1] - p[1]) ** 2 +
      (positions[i * 3 + 2] - p[2]) ** 2 <
      r2;
  const zone = new Uint8Array(n);
  const index = (z: RestrictionZone) => RESTRICTION_ZONES.indexOf(z);
  for (let i = 0; i < n; i++) {
    const p = panels[i],
      sleeve = p === 4 || p === 5;
    if (near(i, armpit.L) || near(i, armpit.R)) zone[i] = index('armpit');
    else if (sleeve && (near(i, lm.elbow_L) || near(i, lm.elbow_R))) zone[i] = index('elbow');
    else if (p === 3 || near(i, lm.acromion_L) || near(i, lm.acromion_R))
      zone[i] = index('shoulders');
    else if (p === 2) zone[i] = index('back');
    else if (p === 0 || p === 1) zone[i] = index('front');
    else if (sleeve) zone[i] = index('sleeves');
    else zone[i] = index('collar/hood');
  }
  const woven = asset.config.stretchMax,
    elastic = asset.config.elasticStretchMax ?? woven;
  const edgeLimit = new Float32Array(edges.length / 2);
  for (let e = 0; e < edgeLimit.length; e++)
    edgeLimit[e] =
      (asset.elastic[edges[e * 2]] > 0.5 && asset.elastic[edges[e * 2 + 1]] > 0.5
        ? elastic
        : woven) - 1;
  return {
    hem: ring(asset.paths.hem, 'hem'),
    cuff: { L: ring(asset.paths.cuff_L, 'cuff_L'), R: ring(asset.paths.cuff_R, 'cuff_R') },
    zone,
    edgeLimit,
  };
}

export type FrameAnchors = {
  /** waistband_<level> ring points (32×3) and their local up vectors (32×3). */
  rings: Record<Waistband, { points: ArrayLike<number>; up: ArrayLike<number> }>;
  /** wrist_L, wrist_R, elbow_L, elbow_R surface points (4×3). */
  points: ArrayLike<number>;
  /** wrist.L, wrist.R, lowerarm01.L, lowerarm01.R joint centres (4×3). */
  joints: ArrayLike<number>;
};

export type FrameMetrics = {
  /** Hem height above the waistband per ring point, cm (positive = skin exposed). */
  hemAboveCm: Record<Waistband, Float32Array>;
  /** Cuff edge beyond the wrist landmark along the forearm, cm (negative = wrist exposed). */
  cuffBeyondWristCm: { L: number; R: number };
  /** Per restriction zone: edges at their stretch limit (count) and the peak strain. */
  zones: { atLimit: number; edges: number; peakStrain: number }[];
};

/** Hem height above each waistband ring point (FORMAT.md recipe), in cm. */
export function hemAboveWaistband(
  topology: GarmentTopology,
  positions: ArrayLike<number>,
  anchors: FrameAnchors,
): Record<Waistband, Float32Array> {
  const out = {} as Record<Waistband, Float32Array>;
  for (const level of WAISTBANDS) {
    const { points, up } = anchors.rings[level],
      count = points.length / 3,
      values = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const hit = hemAbove(
        topology.hem,
        positions,
        points[i * 3],
        points[i * 3 + 1],
        points[i * 3 + 2],
        up[i * 3],
        up[i * 3 + 1],
        up[i * 3 + 2],
      );
      values[i] = hit ? hit.height * 100 : NaN;
    }
    out[level] = values;
  }
  return out;
}

/** Cuff ring centroid projected on the forearm axis (elbow → wrist joint) minus the wrist. */
export function cuffBeyondWrist(
  topology: GarmentTopology,
  positions: ArrayLike<number>,
  anchors: FrameAnchors,
): { L: number; R: number } {
  const result = { L: 0, R: 0 };
  (['L', 'R'] as const).forEach((side, s) => {
    const ids = topology.cuff[side];
    let cx = 0,
      cy = 0,
      cz = 0;
    for (const i of ids) {
      cx += positions[i * 3] / ids.length;
      cy += positions[i * 3 + 1] / ids.length;
      cz += positions[i * 3 + 2] / ids.length;
    }
    const j = anchors.joints,
      w = s * 3,
      e = (s + 2) * 3;
    let ax = j[w] - j[e],
      ay = j[w + 1] - j[e + 1],
      az = j[w + 2] - j[e + 2];
    const l = Math.hypot(ax, ay, az) || 1;
    ax /= l;
    ay /= l;
    az /= l;
    const p = anchors.points;
    result[side] = ((cx - p[w]) * ax + (cy - p[w + 1]) * ay + (cz - p[w + 2]) * az) * 100;
  });
  return result;
}

/** Edges at their stretch limit and the peak strain per zone. `strain` = per-edge len/rest − 1. */
export function restriction(
  topology: GarmentTopology,
  edges: Uint32Array,
  strain: ArrayLike<number>,
) {
  const zones = RESTRICTION_ZONES.map(() => ({ atLimit: 0, edges: 0, peakStrain: 0 }));
  for (let e = 0; e < strain.length; e++) {
    const z = zones[topology.zone[edges[e * 2]]];
    z.edges++;
    if (strain[e] > z.peakStrain) z.peakStrain = strain[e];
    if (strain[e] >= topology.edgeLimit[e] - MOTION_FIT.strainLimitSlack) z.atLimit++;
  }
  return zones;
}

/**
 * Exposed-skin mask for the body highlight: exposure-zone vertices (P1 /anchors
 * exposure_vertices[level], torso skin between the waistband and the chest line) that the hem
 * has ridden above. `skin` = skinned positions of those vertices, `up` their carried rest +Y.
 */
export function exposedMask(
  topology: GarmentTopology,
  positions: ArrayLike<number>,
  skin: ArrayLike<number>,
  up: ArrayLike<number>,
  out: Uint8Array,
) {
  let count = 0;
  for (let v = 0; v < out.length; v++) {
    const hit = hemAbove(
      topology.hem,
      positions,
      skin[v * 3],
      skin[v * 3 + 1],
      skin[v * 3 + 2],
      up[v * 3],
      up[v * 3 + 1],
      up[v * 3 + 2],
    );
    out[v] = hit && hit.height > MOTION_FIT.exposedVertexMarginM ? 1 : 0;
    count += out[v];
  }
  return count;
}

export type SizeMotionSummary = {
  size: string;
  /** Peak exposure over the motion, cm (0 = covered), per waistband level. */
  exposure: Record<
    Waistband,
    { front: number; back: number; left: number; right: number; any: number }
  >;
  /** Exposure at frame 0 (neutral), same layout: the garment's standing coverage. */
  neutralExposure: Record<
    Waistband,
    { front: number; back: number; left: number; right: number; any: number }
  >;
  /** Cuff beyond the wrist, cm: at neutral, the minimum during the motion, and ride-up. */
  wrist: Record<'L' | 'R', { neutral: number; minimum: number; rideUp: number; exposed: number }>;
  /** Per zone: peak strain and peak share of edges at the limit (motion vs neutral). */
  restriction: {
    zone: RestrictionZone;
    peakStrain: number;
    neutralShare: number;
    peakShare: number;
  }[];
  peakFrame: number;
};

const RING_KEYS = { front: 0, left: 8, back: 16, right: 24 } as const;

/** Reduce per-frame metrics to the per-size summary of one motion. */
export function summarise(size: string, frames: FrameMetrics[]): SizeMotionSummary {
  const exposure = {} as SizeMotionSummary['exposure'],
    neutralExposure = {} as SizeMotionSummary['neutralExposure'];
  let peakFrame = 0,
    peakValue = -Infinity;
  const floor = (cm: number) => (Number.isFinite(cm) && cm > MOTION_FIT.exposureFloorCm ? cm : 0);
  for (const level of WAISTBANDS) {
    const peak = { front: 0, back: 0, left: 0, right: 0, any: 0 };
    frames.forEach((f, i) => {
      const v = f.hemAboveCm[level];
      for (const [key, index] of Object.entries(RING_KEYS) as [keyof typeof RING_KEYS, number][])
        peak[key] = Math.max(peak[key], floor(v[index]));
      let any = 0;
      for (const x of v) any = Math.max(any, floor(x));
      peak.any = Math.max(peak.any, any);
      if (level === 'mid') {
        let worst = -Infinity;
        for (const x of v) if (Number.isFinite(x)) worst = Math.max(worst, x);
        if (worst > peakValue) {
          peakValue = worst;
          peakFrame = i;
        }
      }
    });
    exposure[level] = peak;
    const first = frames[0].hemAboveCm[level];
    let any = 0;
    for (const x of first) any = Math.max(any, floor(x));
    neutralExposure[level] = {
      front: floor(first[RING_KEYS.front]),
      back: floor(first[RING_KEYS.back]),
      left: floor(first[RING_KEYS.left]),
      right: floor(first[RING_KEYS.right]),
      any,
    };
  }
  const wrist = {} as SizeMotionSummary['wrist'];
  for (const side of ['L', 'R'] as const) {
    const neutral = frames[0].cuffBeyondWristCm[side];
    const minimum = Math.min(...frames.map((f) => f.cuffBeyondWristCm[side]));
    wrist[side] = {
      neutral,
      minimum,
      rideUp: Math.max(0, neutral - minimum),
      exposed: minimum < -MOTION_FIT.wristFloorCm ? -minimum : 0,
    };
  }
  const restrictionRows = RESTRICTION_ZONES.map((zone, z) => {
    const share = (f: FrameMetrics) =>
      f.zones[z].edges ? f.zones[z].atLimit / f.zones[z].edges : 0;
    return {
      zone,
      peakStrain: Math.max(...frames.map((f) => f.zones[z].peakStrain)),
      neutralShare: share(frames[0]),
      peakShare: Math.max(...frames.map(share)),
    };
  });
  return { size, exposure, neutralExposure, wrist, restriction: restrictionRows, peakFrame };
}

const cm = (x: number) => `${x.toFixed(1)} cm`;

/** One sentence per motion, from the numbers only. */
export function summarySentence(label: string, level: Waistband, sizes: SizeMotionSummary[]) {
  const parts: string[] = [];
  const belly = sizes.map((s) => `${s.size} ${cm(s.exposure[level].front)}`).join(', ');
  const back = sizes.map((s) => `${s.size} ${cm(s.exposure[level].back)}`).join(', ');
  const anyExposed = sizes.some((s) => s.exposure[level].any > 0);
  parts.push(
    anyExposed
      ? `belly exposed at the front: ${belly}; lower back: ${back}`
      : `no skin shows above the ${level} waistband in ${sizes.map((s) => s.size).join(' or ')}`,
  );
  const wrists = sizes.map((s) => {
    const worst = Math.max(s.wrist.L.exposed, s.wrist.R.exposed);
    const ride = Math.max(s.wrist.L.rideUp, s.wrist.R.rideUp);
    return worst > 0
      ? `${s.size} sleeve rides ${cm(ride)} and shows ${cm(worst)} of wrist`
      : `${s.size} sleeve rides ${cm(ride)}, wrist covered`;
  });
  parts.push(wrists.join('; '));
  const tight = sizes
    .map((s) => {
      const zones = s.restriction
        .filter((r) => r.peakShare - r.neutralShare > 0.02)
        .sort((a, b) => b.peakShare - a.peakShare)
        .slice(0, 2)
        .map((r) => r.zone);
      return zones.length ? `${s.size} at its limit across the ${zones.join(' and ')}` : '';
    })
    .filter(Boolean);
  if (tight.length) parts.push(`fabric ${tight.join('; ')}`);
  return `${label}: ${parts.join('. ')}.`;
}
