// The jacket's front hangs straight from the chest (agent F3, user verdict 21:10 "the torso bulges
// at the belly like a big flat book"; behind ?f3flat=1). Pure.
//
// A jacket hangs from the chest and shoulders: below the chest its front drops almost straight
// to the hem (venue-mac-ao, the real parka and puffer seen from the side, ≈ 70–80 s). Draped on
// the posed body (the default body when the scan is skipped is fuller at the belly than a slim
// wearer) the 3D front followed the belly forward. Here every front-panel vertex below the chest
// ring keeps only FLAT_KEEP of how far it stands in front of the chest ring's front profile at its
// x (blended in over FLAT_BLEND_M below the chest), so the front falls straight like the real
// coat, with a little of the hem's flare left.
//
// The same for the sides (lead 23:0x, RC5c judge strip: a rounder waist in the frontal view once
// f3rigid stopped the free-form glue from squeezing the sides onto the person's outline): below
// the chest every body-panel vertex keeps only FLAT_KEEP of how far it stands outside the straight
// line from the chest ring's side to the hem ring's side (the hem's flare capped at FLAT_HEM_FLARE
// of the chest width), so the silhouette falls straight.
//
// The body that hides the jacket's inside must not then poke through the flattened front: the
// torso layer's depth occluder drops the abdomen and pelvis (`upperTorsoOccluderIndex`); it is
// only needed at the neck opening and the cuffs.
import type { MotionRig } from '../../motion/rig';
import { PANEL } from '../../garmentSurface';
import { NON_OCCLUDING_WEIGHT } from './occluder';

export const FLAT_KEEP = 0.15;
export const FLAT_BLEND_M = 0.06;
/**
 * The side line's widest point at the hem, relative to the chest ring's width. The real FB7675 S
 * measures 108 cm at the chest and 108 cm at the hem (tape, product data) and hangs as a straight
 * column (venue-mac-ao frontal); the draped model's hem ring was ~20 % wider than its chest ring
 * (fixture FB-S: 41.0 vs 34.2 cm), which with f3rigid showed as a swelling lower torso. 10 %
 * leaves the slight hem flare the worn coat shows and keeps the hem wider than the hips.
 */
export const FLAT_HEM_FLARE = 0.1;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Flattens the front panels below the chest in place (scene m: Y up, +Z the body's front).
 * Returns the largest protrusion removed (m), 0 when nothing applied.
 */
export function flattenFront(
  positions: Float32Array,
  panels: ArrayLike<number>,
  paths: Partial<Record<string, readonly number[]>>,
  keep = FLAT_KEEP,
  blend = FLAT_BLEND_M,
): number {
  const chest = paths.chest;
  const n = Math.min(panels.length, Math.floor(positions.length / 3));
  if (!chest || chest.length < 8) return 0;
  // The chest ring's front profile: z by x over its front half, sorted by x.
  let cz = 0,
    cy = 0,
    k = 0;
  for (const v of chest) {
    if (!(v >= 0 && v < n)) continue;
    cz += positions[v * 3 + 2];
    cy += positions[v * 3 + 1];
    k++;
  }
  if (!k) return 0;
  cz /= k;
  cy /= k;
  const profile: [number, number][] = [];
  for (const v of chest)
    if (v >= 0 && v < n && positions[v * 3 + 2] > cz)
      profile.push([positions[v * 3], positions[v * 3 + 2]]);
  if (profile.length < 3) return 0;
  profile.sort((a, b) => a[0] - b[0]);
  const frontZ = (x: number) => {
    if (x <= profile[0][0]) return profile[0][1];
    const last = profile[profile.length - 1];
    if (x >= last[0]) return last[1];
    let i = 1;
    while (i < profile.length - 1 && profile[i][0] < x) i++;
    const [x0, z0] = profile[i - 1],
      [x1, z1] = profile[i];
    return z0 + ((z1 - z0) * (x - x0)) / Math.max(1e-9, x1 - x0);
  };
  let removed = 0;
  for (let v = 0; v < n; v++) {
    const p = panels[v];
    if (p !== PANEL.frontL && p !== PANEL.frontR) continue;
    const y = positions[v * 3 + 1];
    if (y >= cy) continue;
    const z = positions[v * 3 + 2];
    const excess = z - frontZ(positions[v * 3]);
    if (excess <= 0) continue;
    const cut = excess * (1 - keep) * smooth(0, blend, cy - y);
    positions[v * 3 + 2] = z - cut;
    removed = Math.max(removed, cut);
  }
  return Math.max(removed, straightenSides(positions, panels, paths, n, cy, keep, blend));
}

/** The side silhouette below the chest: straight from the chest ring's sides to the hem's. */
function straightenSides(
  positions: Float32Array,
  panels: ArrayLike<number>,
  paths: Partial<Record<string, readonly number[]>>,
  n: number,
  cy: number,
  keep: number,
  blend: number,
): number {
  const extent = (ids: readonly number[] | undefined) => {
    let lo = Infinity,
      hi = -Infinity,
      y = 0,
      k = 0;
    for (const v of ids ?? []) {
      if (!(v >= 0 && v < n)) continue;
      lo = Math.min(lo, positions[v * 3]);
      hi = Math.max(hi, positions[v * 3]);
      y += positions[v * 3 + 1];
      k++;
    }
    return k >= 8 ? { lo, hi, y: y / k } : null;
  };
  const chest = extent(paths.chest),
    hem = extent(paths.hem);
  if (!chest || !hem || !(hem.y < cy - 0.05)) return 0;
  const mid = (chest.lo + chest.hi) / 2,
    half = ((chest.hi - chest.lo) / 2) * (1 + FLAT_HEM_FLARE);
  hem.hi = Math.min(hem.hi, mid + half);
  hem.lo = Math.max(hem.lo, mid - half);
  let removed = 0;
  for (let v = 0; v < n; v++) {
    const p = panels[v];
    if (p !== PANEL.frontL && p !== PANEL.frontR && p !== PANEL.back) continue;
    const y = positions[v * 3 + 1];
    if (y >= cy) continue;
    const t = Math.min(1, (cy - y) / (cy - hem.y));
    const hi = chest.hi + t * (hem.hi - chest.hi),
      lo = chest.lo + t * (hem.lo - chest.lo);
    const x = positions[v * 3];
    const excess = x > hi ? x - hi : x < lo ? x - lo : 0;
    if (!excess) continue;
    const cut = excess * (1 - keep) * smooth(0, blend, cy - y);
    positions[v * 3] = x - cut;
    removed = Math.max(removed, Math.abs(cut));
  }
  return removed;
}

/**
 * ?f3flatx=1 (the user's "belly like a dictionary", lead 00:1x): the front panels read as a broad
 * flat plane like the real coat (venue-mac-ao frontal: quilt rows straight across almost the full
 * width, turning down only near the side seams; even light across the front). Per height band
 * the front's depth profile across the width is raised toward a rounded rectangle: the centre
 * (the zip, the deepest point) stays, so the profile never gets thicker; the flanks come forward
 * toward the centre's depth and turn back only over the outer FLATX_TURN of each half-width; the
 * side seam stays where it is (no gap); the back, yoke, collar and hood are not touched. Visual.
 */
export const FLATX = {
  /** Share of each half-width (from the side seam) over which the front turns back. */
  turn: 0.3,
  /** Share of the raise applied (1 = a flat plane up to the turn). */
  strength: 0.85,
  /** Height band (m) of the depth profile; profiles are interpolated between band centres. */
  bandM: 0.02,
  /** Below the neckline ring, the raise fades in over this much height (m). */
  neckFadeM: 0.08,
};

/** Flattens the front across its width in place (scene m: Y up, +Z front). Largest raise (m). */
export function flattenAcross(
  positions: Float32Array,
  panels: ArrayLike<number>,
  paths: Partial<Record<string, readonly number[]>>,
): number {
  const n = Math.min(panels.length, Math.floor(positions.length / 3));
  const front = (v: number) => panels[v] === PANEL.frontL || panels[v] === PANEL.frontR;
  let top = -Infinity,
    bottom = Infinity;
  for (let v = 0; v < n; v++)
    if (front(v)) {
      top = Math.max(top, positions[v * 3 + 1]);
      bottom = Math.min(bottom, positions[v * 3 + 1]);
    }
  if (!(top > bottom)) return 0;
  let neck = top;
  if (paths.neckline?.length) {
    let y = 0,
      k = 0;
    for (const v of paths.neckline)
      if (v >= 0 && v < n) {
        y += positions[v * 3 + 1];
        k++;
      }
    if (k) neck = Math.min(top, y / k);
  }
  const B = Math.max(1, Math.ceil((top - bottom) / FLATX.bandM));
  // Per band: centre depth (max z), side extents (min/max x) and the seam depth on each side.
  const zMax = new Float64Array(B).fill(-Infinity),
    xLo = new Float64Array(B).fill(Infinity),
    xHi = new Float64Array(B).fill(-Infinity),
    zLo = new Float64Array(B),
    zHi = new Float64Array(B);
  const band = (y: number) => Math.min(B - 1, Math.max(0, Math.floor((y - bottom) / FLATX.bandM)));
  for (let v = 0; v < n; v++) {
    if (!front(v)) continue;
    const b = band(positions[v * 3 + 1]);
    const x = positions[v * 3],
      z = positions[v * 3 + 2];
    if (z > zMax[b]) zMax[b] = z;
    if (x < xLo[b]) {
      xLo[b] = x;
      zLo[b] = z;
    }
    if (x > xHi[b]) {
      xHi[b] = x;
      zHi[b] = z;
    }
  }
  // Interpolated band values at height y (bands without vertices borrow their neighbours).
  const at = (arr: Float64Array, y: number) => {
    const f = (y - bottom) / FLATX.bandM - 0.5;
    const i = Math.max(0, Math.min(B - 1, Math.floor(f)));
    const j = Math.min(B - 1, i + 1);
    const t = Math.max(0, Math.min(1, f - i));
    const a = Number.isFinite(arr[i]) ? arr[i] : arr[j],
      c = Number.isFinite(arr[j]) ? arr[j] : arr[i];
    return a + (c - a) * t;
  };
  let raised = 0;
  for (let v = 0; v < n; v++) {
    if (!front(v)) continue;
    const y = positions[v * 3 + 1];
    const fade = smooth(0, FLATX.neckFadeM, neck - y);
    if (!(fade > 0)) continue;
    const lo = at(xLo, y),
      hi = at(xHi, y),
      zm = at(zMax, y);
    if (!(hi - lo > 0.02) || !Number.isFinite(zm)) continue;
    const mid = (lo + hi) / 2,
      x = positions[v * 3];
    const right = x >= mid;
    const u = right ? (x - mid) / (hi - mid) : (mid - x) / (mid - lo);
    const zSide = right ? at(zHi, y) : at(zLo, y);
    // Rounded rectangle: flat (the centre's depth) up to the turn, then down to the seam.
    const g = smooth(1 - FLATX.turn, 1, Math.min(1, Math.max(0, u)));
    const target = zm - (zm - zSide) * g;
    const z = positions[v * 3 + 2];
    if (!(target > z)) continue;
    const lift = (target - z) * FLATX.strength * fade;
    positions[v * 3 + 2] = z + lift;
    raised = Math.max(raised, lift);
  }
  return raised;
}

/** Abdomen and pelvis bones (MakeHuman): below the thorax (spine02/spine01 are the chest). */
const LOWER_TRUNK = /^(root|pelvis|hips|spine05|spine04|spine03)/;
/** Bones whose skin never hides the jacket (hands, legs; occluder.ts NON_OCCLUDING_BONE). */
const NEVER = /^(wrist|finger|metacarpal|upperleg|lowerleg|foot|toe)/;
/** Arm bones: not in the torso layer's occluder either (no arm-shaped hole, f3arms). */
const ARM = /^(upperarm|lowerarm)/;

/**
 * Triangle index of the posed body's chest, shoulders, neck and head only (no arms, abdomen,
 * pelvis, hands or legs): the torso layer's depth occluder under ?f3flat=1.
 */
export function upperTorsoOccluderIndex(
  rig: Pick<
    MotionRig,
    'bones' | 'skinIndices' | 'skinWeights' | 'influences' | 'vertexCount' | 'faces'
  >,
) {
  const out = Uint8Array.from(rig.bones, (name) =>
    LOWER_TRUNK.test(name) || NEVER.test(name) || ARM.test(name) ? 1 : 0,
  );
  const keep = new Uint8Array(rig.vertexCount);
  const K = rig.influences;
  for (let v = 0; v < rig.vertexCount; v++) {
    let w = 0;
    for (let k = 0; k < K; k++)
      if (out[rig.skinIndices[v * K + k]]) w += rig.skinWeights[v * K + k];
    keep[v] = w < NON_OCCLUDING_WEIGHT ? 1 : 0;
  }
  const idx: number[] = [];
  const f = rig.faces;
  for (let t = 0; t < f.length; t += 3)
    if (keep[f[t]] && keep[f[t + 1]] && keep[f[t + 2]]) idx.push(f[t], f[t + 1], f[t + 2]);
  return Uint32Array.from(idx);
}
