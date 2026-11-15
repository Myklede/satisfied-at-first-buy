// Garment and body anchor points for the AR registration (agent V2): the visible collar top that
// the collar target aims at the face, and the shoulder points matched to MediaPipe's shoulder
// landmarks. Pure functions over the cloth asset and the posed arrays (scene metres).
import type { ClothAsset } from '../../../api';
import { PANEL } from '../../garmentSurface';
import type { CollarTargetKind } from './config';
import type { Vec3 } from './cameraModel';

type Point = readonly [number, number, number] | readonly number[];

/**
 * The highest VISIBLE collar point within `halfWidth` of the front centre line (x of
 * `midShoulder`, in front of it), or null. Candidates: the asset's `collar_top` path (the collar's
 * top edge ring), else every particle off the hood panel. Never the hood panel's rim strips: the
 * shell keeps them hidden (H2's padded hood is drawn instead), and taking them read a collar
 * several cm above the visible one (agent CH, 2026-11-13).
 */
export function visibleCollarTop(
  positions: ArrayLike<number>,
  asset: Pick<ClothAsset, 'paths' | 'panels'>,
  midShoulder: Point,
  halfWidth: number,
): Vec3 | null {
  const n = Math.floor(positions.length / 3);
  const ring = asset.paths?.collar_top;
  let ids: readonly number[] = [];
  if (ring?.length) ids = ring;
  else if (asset.panels.length === n) {
    const off: number[] = [];
    for (let i = 0; i < n; i++) if (asset.panels[i] !== PANEL.hood) off.push(i);
    ids = off;
  }
  let best: Vec3 | null = null;
  for (const v of ids) {
    if (!(v >= 0 && v < n)) continue;
    const i = v * 3;
    const x = positions[i],
      y = positions[i + 1],
      z = positions[i + 2];
    if (Math.abs(x - midShoulder[0]) > halfWidth || z < midShoulder[2]) continue;
    if (!best || y > best[1]) best = [x, y, z];
  }
  return best;
}

/**
 * The face point a product's collar top is aimed at (config COLLAR_TARGET_FROM_MOUTH): a
 * removable hood (asset path `hood_zip`) is the funnel-collar puffer, zipped to the lower lip;
 * else the parka's collar stand, at the chin.
 */
export function collarTargetKind(asset: Pick<ClothAsset, 'paths'> | undefined): CollarTargetKind {
  return asset?.paths?.hood_zip?.length ? 'lowerLip' : 'chin';
}

/**
 * The rig vertices nearest the asset body's acromion landmarks (display pose; the asset body has
 * the rig's topology), or [] when the asset has no acromions or another topology.
 */
export function acromionVertices(
  asset: Pick<ClothAsset, 'body_positions' | 'body_landmarks'>,
  vertexCount: number,
): number[] {
  const ref = asset.body_positions;
  if (ref.length !== vertexCount * 3) return [];
  const ids: number[] = [];
  for (const key of ['acromion_L', 'acromion_R']) {
    const a = asset.body_landmarks[key];
    if (!a) return [];
    let best = -1,
      bestD = Infinity;
    for (let v = 0; v < ref.length; v += 3) {
      const d = (ref[v] - a[0]) ** 2 + (ref[v + 1] - a[1]) ** 2 + (ref[v + 2] - a[2]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = v / 3;
      }
    }
    ids.push(best);
  }
  return ids;
}

/**
 * The shoulder points matched to MediaPipe's shoulder landmarks: each shoulder joint moved toward
 * its posed acromion by `k` (0 = the joint, 1 = the acromion; config SHOULDER_MARK_BLEND). Each
 * acromion is paired with the nearer shoulder joint (no reliance on the _L/_R naming). Null when
 * the inputs are missing.
 */
export function shoulderMarks(
  lShoulder: Point,
  rShoulder: Point,
  body: ArrayLike<number>,
  acromions: readonly number[],
  k: number,
): { l: [number, number, number]; r: [number, number, number] } | null {
  if (acromions.length !== 2) return null;
  const at = (v: number): Vec3 => [body[v * 3], body[v * 3 + 1], body[v * 3 + 2]];
  const a = at(acromions[0]),
    b = at(acromions[1]);
  if (![...a, ...b].every(Number.isFinite)) return null;
  const d2 = (x: Vec3, y: Point) => (x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2;
  const [al, ar] =
    d2(a, lShoulder) + d2(b, rShoulder) <= d2(a, rShoulder) + d2(b, lShoulder) ? [a, b] : [b, a];
  const blend = (j: Point, x: Vec3): [number, number, number] => [
    j[0] + k * (x[0] - j[0]),
    j[1] + k * (x[1] - j[1]),
    j[2] + k * (x[2] - j[2]),
  ];
  return { l: blend(lShoulder, al), r: blend(rShoulder, ar) };
}
