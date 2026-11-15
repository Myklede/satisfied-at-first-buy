// Articulated synthetic hand for unit tests (not exported from index.ts). Upright hand, palm facing
// the camera, fingers pointing up (−y); curling bends fingers toward the camera (−z) and back
// toward the palm, like a real flexion. Units: isotropic image units (image heights); the same
// coordinates serve as "world" landmarks since every feature is divided by the hand size.

import type { Landmark } from './pinch';

export type ThumbSpec =
  /** Thumb tip `gap` hand sizes to the left of the index tip (tip pinch when small). */
  | { kind: 'tip'; gap: number }
  /** Thumb tip beside and slightly behind the index middle phalanx (lateral / key grip). */
  | { kind: 'side'; gap: number }
  /** Thumb abducted away from the index (open hand). */
  | { kind: 'away' };

export interface SynthHandSpec {
  /** Middle-finger MCP position (landmark 9), image heights. */
  u: number;
  v: number;
  /** |wrist − middle MCP| in image heights. */
  scale: number;
  /** Curl 0 (straight) .. 1 (fully curled) of middle/ring/pinky. */
  curl: number;
  /** Curl of the index finger (defaults to `curl`). */
  indexCurl?: number;
  thumb: ThumbSpec;
}

const MCP: Array<[number, number]> = [
  [-0.33, 0.04],
  [0, 0],
  [0.3, 0.05],
  [0.55, 0.15],
];
const SEGMENTS: number[][] = [
  [0.42, 0.25, 0.2],
  [0.47, 0.28, 0.21],
  [0.43, 0.27, 0.2],
  [0.33, 0.2, 0.18],
];
/** Joint flexion at full curl: MCP 70°, PIP 100°, DIP 70°. */
const FULL_FLEX = [70, 100, 70].map((d) => (d * Math.PI) / 180);

export function synthHandIso(spec: SynthHandSpec): Landmark[] {
  const { u, v, scale: s } = spec;
  const p: Landmark[] = new Array(21);
  p[0] = { x: u, y: v + s, z: 0 };
  for (let f = 0; f < 4; f++) {
    const c = f === 0 ? (spec.indexCurl ?? spec.curl) : spec.curl;
    const base = 5 + f * 4;
    let q: Landmark = { x: u + MCP[f][0] * s, y: v + MCP[f][1] * s, z: 0 };
    p[base] = q;
    let theta = 0;
    for (let k = 0; k < 3; k++) {
      theta += c * FULL_FLEX[k];
      const len = SEGMENTS[f][k] * s;
      q = { x: q.x, y: q.y - len * Math.cos(theta), z: q.z - len * Math.sin(theta) };
      p[base + k + 1] = q;
    }
  }
  const cmc: Landmark = { x: u - 0.45 * s, y: v + 0.75 * s, z: 0 };
  let tip: Landmark;
  if (spec.thumb.kind === 'tip') {
    tip = { x: p[8].x - spec.thumb.gap * s, y: p[8].y, z: p[8].z };
  } else if (spec.thumb.kind === 'side') {
    const mid = {
      x: (p[6].x + p[7].x) / 2,
      y: (p[6].y + p[7].y) / 2,
      z: (p[6].z + p[7].z) / 2,
    };
    tip = { x: mid.x - spec.thumb.gap * s, y: mid.y, z: mid.z + 0.03 * s };
  } else {
    tip = { x: u - 1.0 * s, y: v + 0.15 * s, z: 0 };
  }
  const lerp = (a: Landmark, b: Landmark, t: number): Landmark => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  });
  p[1] = cmc;
  p[2] = { ...lerp(cmc, tip, 0.4), x: lerp(cmc, tip, 0.4).x - 0.05 * s };
  p[3] = lerp(cmc, tip, 0.72);
  p[4] = tip;
  return p;
}

/** Normalised image landmarks (x divided by the aspect ratio), as MediaPipe reports them. */
export function synthHandNormalized(spec: SynthHandSpec, aspect: number): Landmark[] {
  return synthHandIso(spec).map((l) => ({ x: l.x / aspect, y: l.y, z: l.z / aspect }));
}
