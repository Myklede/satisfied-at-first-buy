// The REAL jacket in a video frame (evaluation ground truth, agent V2): person segmentation mask
// (LiveFrame.mask) ∩ pixels of the jacket's own colour, sampled on the chest. In memory only;
// only the offsets computed from it leave the page.
//
// Colour test (heuristic, checked by eye on .cache/v2 debug sheets, never committed): same
// chromaticity as the chest sample within CHROMA_TOLERANCE, luminance between LUMA_MIN and
// LUMA_MAX × the chest's. This separates the white parka / cream puffer from skin (more
// saturated) and from the grey sweatpants (darker); deep fabric folds can drop out (holes), which
// the edge scans tolerate up to 2 px.
import type { ImageLandmark, LiveFrame } from '../../engine/live/contract';
import type { Mask } from '../../engine/live/ar/silhouette';

export const CHROMA_TOLERANCE = 0.03;
export const LUMA_MIN = 0.6;
export const LUMA_MAX = 1.35;
const PERSON = 0.5;

export type JacketColour = { r: number; g: number; b: number; luma: number };

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Median colour of a patch on the chest (35 % down from the shoulder line). */
export function chestColour(pixels: ImageData, l: readonly ImageLandmark[]): JacketColour | null {
  const ls = l[11],
    rs = l[12],
    lh = l[23],
    rh = l[24];
  if (![ls, rs, lh, rh].every((p) => p && p.visibility >= 0.5)) return null;
  const sx = (ls.x + rs.x) / 2,
    sy = (ls.y + rs.y) / 2,
    hx = (lh.x + rh.x) / 2,
    hy = (lh.y + rh.y) / 2;
  const cx = sx + (hx - sx) * 0.35,
    cy = sy + (hy - sy) * 0.35;
  const half = Math.max(4, Math.round(Math.hypot(ls.x - rs.x, ls.y - rs.y) * 0.08));
  const rs_: number[] = [],
    gs: number[] = [],
    bs: number[] = [];
  for (let y = Math.round(cy) - half; y <= Math.round(cy) + half; y++)
    for (let x = Math.round(cx) - half; x <= Math.round(cx) + half; x++) {
      if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) continue;
      const i = (y * pixels.width + x) * 4;
      rs_.push(pixels.data[i]);
      gs.push(pixels.data[i + 1]);
      bs.push(pixels.data[i + 2]);
    }
  if (!rs_.length) return null;
  const med = (v: number[]) => v.sort((a, b) => a - b)[v.length >> 1];
  const r = med(rs_),
    g = med(gs),
    b = med(bs);
  return { r, g, b, luma: luma(r, g, b) };
}

/** The real jacket mask (1 = jacket) at the frame's resolution. */
export function realJacketMask(
  pixels: ImageData,
  person: NonNullable<LiveFrame['mask']>,
  colour: JacketColour,
): Mask {
  const { width, height } = pixels;
  const raw = new Uint8Array(width * height);
  const sum0 = colour.r + colour.g + colour.b || 1;
  const cr = colour.r / sum0,
    cg = colour.g / sum0;
  const sx = person.width / width,
    sy = person.height / height;
  for (let y = 0; y < height; y++) {
    const py = Math.min(person.height - 1, Math.floor(y * sy));
    for (let x = 0; x < width; x++) {
      const px = Math.min(person.width - 1, Math.floor(x * sx));
      if (person.data[py * person.width + px] < PERSON) continue;
      const i = (y * width + x) * 4;
      const r = pixels.data[i],
        g = pixels.data[i + 1],
        b = pixels.data[i + 2];
      const sum = r + g + b || 1;
      if (Math.abs(r / sum - cr) > CHROMA_TOLERANCE || Math.abs(g / sum - cg) > CHROMA_TOLERANCE)
        continue;
      const y_ = luma(r, g, b);
      if (y_ < LUMA_MIN * colour.luma || y_ > LUMA_MAX * colour.luma) continue;
      raw[y * width + x] = 1;
    }
  }
  // 3×3 majority filter: removes speckle, fills pinholes.
  const data = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) n += raw[(y + dy) * width + x + dx];
      data[y * width + x] = n >= 5 ? 1 : 0;
    }
  return { data, width, height };
}
