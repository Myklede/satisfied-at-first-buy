// Silhouette offsets between the drawn jacket and the real jacket in the frame (agent V2,
// evaluation). Pure, no DOM: two binary masks at the source resolution + the frame's landmarks
// in, signed edge offsets in px out (the caller converts to cm with the body's px per metre).
//
// Sign convention: offset = ours − real along the measured direction, so
//   shoulder: + = our shoulder line is LOWER than the real one (image y grows down);
//   sleeve:   + = our sleeve's outer edge sticks out FURTHER from the arm axis;
//   cuff:     + = our sleeve is LONGER (its end lies further along elbow → wrist);
//   hem:      + = our hem is LOWER (longer jacket).
// A measurement is null when either mask has no edge where it is looked for (occluded, out of
// frame, arm crossed over the body): never guessed.
import type { ImageLandmark } from '../contract';

export type Mask = { data: Uint8Array; width: number; height: number };

export type SilhouetteOffsets = {
  shoulderL: number | null;
  shoulderR: number | null;
  sleeveL: number | null;
  sleeveR: number | null;
  cuffL: number | null;
  cuffR: number | null;
  hem: number | null;
};

const VIS = 0.5;
const at = (m: Mask, x: number, y: number) => {
  const xi = Math.round(x),
    yi = Math.round(y);
  return xi >= 0 && yi >= 0 && xi < m.width && yi < m.height && m.data[yi * m.width + xi] > 0;
};

const median = (values: number[]) => {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Along the ray p + s·d (s from s0 to s1, step 1 px), the last s of the masked run that contains
 * (or first starts after) s0. Null when the ray never enters the mask.
 */
export function runEnd(m: Mask, p: [number, number], d: [number, number], s0: number, s1: number) {
  let s = s0;
  const step = s1 >= s0 ? 1 : -1;
  // Enter the mask (allow a short gap: the joint may sit just outside a thin sleeve edge).
  while ((step > 0 ? s <= s1 : s >= s1) && !at(m, p[0] + s * d[0], p[1] + s * d[1])) s += step;
  if (step > 0 ? s > s1 : s < s1) return null;
  let last = s;
  let gap = 0;
  for (; step > 0 ? s <= s1 : s >= s1; s += step) {
    if (at(m, p[0] + s * d[0], p[1] + s * d[1])) {
      last = s;
      gap = 0;
    } else if (++gap > 2) break; // tolerate 2 px of mask noise
  }
  return last;
}

/** Topmost masked pixel of column x within [y0, y1] (scanning down), or null. */
function topEdge(m: Mask, x: number, y0: number, y1: number) {
  for (let y = Math.max(0, Math.round(y0)); y <= Math.min(m.height - 1, Math.round(y1)); y++)
    if (at(m, x, y)) return y;
  return null;
}

function visible(l: ImageLandmark | undefined): l is ImageLandmark {
  return !!l && l.visibility >= VIS;
}

/** Signed offsets (px) between our jacket mask and the real one, measured at the landmarks. */
export function silhouetteOffsets(
  ours: Mask,
  real: Mask,
  l: readonly ImageLandmark[],
): SilhouetteOffsets {
  const out: SilhouetteOffsets = {
    shoulderL: null,
    shoulderR: null,
    sleeveL: null,
    sleeveR: null,
    cuffL: null,
    cuffR: null,
    hem: null,
  };
  const ls = l[11],
    rs = l[12];
  if (!visible(ls) || !visible(rs)) return out;
  const width = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  if (width < 8) return out; // side view: no frontal shoulder line to measure
  const mid: [number, number] = [(ls.x + rs.x) / 2, (ls.y + rs.y) / 2];

  // Shoulder line: columns 70–90 % of the way from the neck to each shoulder landmark, top edge
  // searched from 0.6 shoulder widths above to 0.3 below the landmark.
  for (const [key, s] of [
    ['shoulderL', ls],
    ['shoulderR', rs],
  ] as const) {
    const diffs: number[] = [];
    for (const f of [0.7, 0.75, 0.8, 0.85, 0.9]) {
      const x = mid[0] + (s.x - mid[0]) * f;
      const y = mid[1] + (s.y - mid[1]) * f;
      const a = topEdge(ours, x, y - 0.6 * width, y + 0.3 * width);
      const b = topEdge(real, x, y - 0.6 * width, y + 0.3 * width);
      if (a !== null && b !== null) diffs.push(a - b);
    }
    out[key] = diffs.length >= 3 ? median(diffs) : null;
  }

  // Sleeves: outer edge at 35/50/65 % of the upper arm and of the forearm, perpendicular to the
  // bone, on the side away from the body's midline. Cuff: the end of the masked run along
  // elbow → wrist, searched from the elbow to 0.6 forearm lengths past the wrist.
  const centreX = mid[0];
  for (const [side, si, ei, wi] of [
    ['L', 11, 13, 15],
    ['R', 12, 14, 16],
  ] as const) {
    const s = l[si],
      e = l[ei],
      w = l[wi];
    const diffs: number[] = [];
    const segments: [ImageLandmark, ImageLandmark][] = [];
    if (visible(s) && visible(e)) segments.push([s, e]);
    if (visible(e) && visible(w)) segments.push([e, w]);
    for (const [a, b] of segments) {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 10) continue;
      const d: [number, number] = [(b.x - a.x) / len, (b.y - a.y) / len];
      let n: [number, number] = [-d[1], d[0]];
      for (const f of [0.35, 0.5, 0.65]) {
        const p: [number, number] = [a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f];
        // Outward = away from the body's midline (by x); skip when the arm is across the body.
        if ((p[0] - centreX) * n[0] < 0) n = [-n[0], -n[1]];
        if (Math.abs(p[0] - centreX) < 0.25 * width) continue;
        const reach = 0.5 * width;
        const o = runEnd(ours, p, n, 0, reach);
        const r = runEnd(real, p, n, 0, reach);
        if (o !== null && r !== null && o < reach && r < reach) diffs.push(o - r);
      }
    }
    out[`sleeve${side}`] = diffs.length >= 2 ? median(diffs) : null;
    if (visible(e) && visible(w)) {
      const len = Math.hypot(w.x - e.x, w.y - e.y);
      if (len >= 10) {
        const d: [number, number] = [(w.x - e.x) / len, (w.y - e.y) / len];
        const o = runEnd(ours, [e.x, e.y], d, 0, 1.6 * len);
        const r = runEnd(real, [e.x, e.y], d, 0, 1.6 * len);
        if (o !== null && r !== null && o < 1.6 * len && r < 1.6 * len) out[`cuff${side}`] = o - r;
      }
    }
  }

  // Hem: columns across the middle 60 % of the torso, the end of the masked run going down from
  // the waist (halfway between the shoulder and hip lines: inside even a cropped jacket),
  // searched to 1.6 shoulder widths below the hip line.
  const lh = l[23],
    rh = l[24];
  if (visible(lh) && visible(rh)) {
    const diffs: number[] = [];
    for (const f of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      const top: [number, number] = [rs.x + (ls.x - rs.x) * f, rs.y + (ls.y - rs.y) * f];
      const hip: [number, number] = [rh.x + (lh.x - rh.x) * f, rh.y + (lh.y - rh.y) * f];
      const start: [number, number] = [(top[0] + hip[0]) / 2, (top[1] + hip[1]) / 2];
      const reach = hip[1] - start[1] + 1.6 * width;
      const o = runEnd(ours, start, [0, 1], 0, reach);
      const r = runEnd(real, start, [0, 1], 0, reach);
      if (o !== null && r !== null && o < reach && r < reach) diffs.push(o - r);
    }
    out.hem = diffs.length >= 3 ? median(diffs) : null;
  }
  return out;
}
