// Forward-head flexion for the AR registration (agent V2, lead's option B1, 2026-11-13). Pure.
//
// The live rig's head rides rigidly on the chest (the neck is not one of the 18 skinning
// drivers), so a person who leans their head forward and down toward a laptop camera looks to
// the solve like a camera pitch or a face offset (cam-tshirt: the rig's eyes drawn ~5 cm above
// the real ones, body scale). The AR never draws the head; it only reads the rig's eyes as
// correspondences. So the eyes are rotated about the neck base by the person's measured head
// flexion before the solve. The collar stays on the torso (the real neck base): a tucked chin
// still brings a zipped collar toward the mouth, as on the real person.
type V3 = readonly [number, number, number] | readonly number[];

const sub = (a: V3, b: V3): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: V3): [number, number, number] => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};
const mid = (a: V3, b: V3): [number, number, number] => [
  (a[0] + b[0]) / 2,
  (a[1] + b[1]) / 2,
  (a[2] + b[2]) / 2,
];

export interface HeadPoints {
  lShoulder: V3;
  rShoulder: V3;
  lHip: V3;
  rHip: V3;
  /** A point on the head's axis at ear / skull-base height (ears' midpoint, or the head bone). */
  head: V3;
  /** A point in front of the face (the nose, or the eyes' midpoint): fixes the forward sign. */
  face: V3;
}

/**
 * The sagittal angle of the head point above the shoulders' midpoint, degrees: 0 = straight
 * above along the torso axis (hips → shoulders), + = forward (toward the face). Works in any
 * right- or left-handed frame (the forward sign comes from `face`); null when degenerate.
 */
export function sagittalHeadAngleDeg(p: HeadPoints): number | null {
  const shoulders = mid(p.lShoulder, p.rShoulder);
  const up = unit(sub(shoulders, mid(p.lHip, p.rHip)));
  const lateral = unit(sub(p.lShoulder, p.rShoulder));
  let forward = unit(cross(lateral, up));
  if (dot(forward, sub(p.face, p.head)) < 0) forward = [-forward[0], -forward[1], -forward[2]];
  const v = sub(p.head, shoulders);
  const along = dot(v, up),
    ahead = dot(v, forward);
  if (Math.hypot(along, ahead) < 1e-6) return null;
  return (Math.atan2(ahead, along) * 180) / Math.PI;
}

/** `point` rotated by `deg` about the axis through `pivot` along unit `axis` (Rodrigues). */
export function rotateAbout(point: V3, pivot: V3, axis: V3, deg: number): [number, number, number] {
  const k = unit(axis);
  const v = sub(point, pivot);
  const a = (deg * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  const kxv = cross(k, v);
  const kv = dot(k, v);
  return [
    pivot[0] + v[0] * c + kxv[0] * s + k[0] * kv * (1 - c),
    pivot[1] + v[1] * c + kxv[1] * s + k[1] * kv * (1 - c),
    pivot[2] + v[2] * c + kxv[2] * s + k[2] * kv * (1 - c),
  ];
}

/**
 * The rotation axis and sign that tip the head FORWARD about the neck base in the rig's frame
 * (Y up, +Z front, X = the subject's left): a forward flexion turns +Y toward +Z, i.e. a
 * rotation about +X by +angle.
 */
export const RIG_FLEXION_AXIS: [number, number, number] = [1, 0, 0];
