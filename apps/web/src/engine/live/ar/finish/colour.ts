// Colour match of the jacket to the room (agent V4). Pure, no DOM: the finisher feeds it small
// RGBA copies of the video frame. Constants and their calibration: ./config.ts.
import {
  EXPOSURE_AT_REF,
  EXPOSURE_GAMMA,
  EXPOSURE_RANGE,
  FACE_SKIN,
  FACE_Y_REF,
  LIFT_MAX,
  LIFT_OF_P1,
  SKIN_CHROMA,
  SKIN_CHROMA_CAMO,
  VENUE_FACE_SKIN,
  VENUE_WB,
  WB_GAIN_RANGE,
  WB_STRENGTH,
} from './config';
import { camoCamera, readF4Flags } from './f4';

export type Rgb = [number, number, number];

/** ?f4light=1 (f4.ts), read once: the venue white balance (config VENUE_WB). */
const VENUE_FLAG = readF4Flags().light;

/**
 * The skin chroma for the camera in use (read once): the iPhone via Camo (URL cam=Camo, the demo
 * camera) renders skin against white differently from the laptop camera (config SKIN_CHROMA_CAMO).
 */
export function skinChromaFor(search?: string): readonly [number, number] {
  return camoCamera(search) ? SKIN_CHROMA_CAMO : SKIN_CHROMA;
}
const SKIN_CHROMA_CAM = skinChromaFor();
/** The iPhone via Camo is the camera in use (read once): its own gain bounds (VENUE_WB.rangeCamo). */
const CAMO = camoCamera();

/**
 * ?f4xdebug=1 (F4X diagnosis only): the first face readings are traced with console.error, which
 * the render service keeps in its result.json. Never on by default; at most 16 lines per page.
 */
const TRACE =
  typeof location !== 'undefined' &&
  !!location?.search &&
  new URLSearchParams(location.search).get('f4xdebug') === '1';
/**
 * Venue face reading: the least share of the crop that must be skin-coloured. The venue face
 * with its blown nose and forehead keeps ≈ 60 %; hair or a hood with a few reddish pixels do not
 * reach a quarter. Heuristic.
 */
const FACE_SKIN_SHARE = 0.25;
let traced = 0;
function trace(what: string, data: () => unknown) {
  if (!TRACE || traced >= 16) return;
  traced++;
  const r3 = (v: unknown): unknown =>
    typeof v === 'number' ? Math.round(v * 1000) / 1000 : Array.isArray(v) ? v.map(r3) : v;
  const entries = Object.entries(data() as Record<string, unknown>).map(([k, v]) => [k, r3(v)]);
  console.error(`[F4X] ${what} ${JSON.stringify(Object.fromEntries(entries))}`);
}

/** sRGB (0..1) → linear (IEC 61966-2-1). */
export const srgbToLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

/** Rec. 709 luminance of a linear colour. */
export const luminance = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * Mean linear colour of the face skin in an RGBA crop. With `isSkin` (from the class mask) only
 * those pixels count; otherwise the pixels between the 30th and 90th luma percentile (drops eyes,
 * brows, nostrils, hair and specular highlights). Null when too few pixels.
 *
 * `venue` (default: the page's ?f4light=1): only skin-COLOURED pixels count (plausibleSkin per
 * pixel), from the class-marked ones when they hold enough, else from the whole crop, trimmed to
 * their 10th–90th luma percentile. Why (F4X trace through the render service, venue clip, person
 * standing still from the first frame): the venue's spot light blows out the nose bridge and
 * forehead, more than the top 10 % of the crop, so the mean read 0.36/0.33/0.31 (r/g 1.09, under
 * FACE_SKIN.minRG) on both the class and the percentile path and NO face reading landed until
 * the head moved: the jacket had no white balance for the first seconds. The skin-coloured
 * pixels alone read the same 1.22/0.90 as later in the clip. The caller still requires a frontal
 * face and plausibleSkin(), which reject a hood, hair or dark clothing.
 */
export function faceSkinColour(
  rgba: Uint8ClampedArray | Uint8Array,
  isSkin?: (index: number) => boolean,
  venue = VENUE_FLAG,
): Rgb | null {
  type Item = { y: number; c: Rgb };
  const n = rgba.length / 4;
  const collect = (keep?: (index: number) => boolean) => {
    const out: Item[] = [];
    for (let i = 0; i < n; i++) {
      if (keep && !keep(i)) continue;
      const c: Rgb = [
        srgbToLinear(rgba[i * 4] / 255),
        srgbToLinear(rgba[i * 4 + 1] / 255),
        srgbToLinear(rgba[i * 4 + 2] / 255),
      ];
      out.push({ y: luminance(c), c });
    }
    return out;
  };
  const mean = (kept: Item[]): Rgb => {
    const sum: Rgb = [0, 0, 0];
    for (const { c } of kept) for (let k = 0; k < 3; k++) sum[k] += c[k];
    return sum.map((v) => v / kept.length) as Rgb;
  };
  const trimmed = (items: Item[], lo: number, hi: number) => {
    const sorted = [...items].sort((a, b) => a.y - b.y);
    return sorted.slice(Math.floor(sorted.length * lo), Math.ceil(sorted.length * hi));
  };
  if (!venue) {
    const items = collect(isSkin);
    if (items.length < 8) return null;
    return mean(isSkin ? items : trimmed(items, 0.3, 0.9));
  }
  const skinOf = (items: Item[]) => {
    const skin = items.filter(({ c }) => plausibleSkin(c, true));
    // Enough of the crop: a few reddish pixels in hair or a hood are not a face.
    return skin.length >= Math.max(8, FACE_SKIN_SHARE * items.length) ? skin : null;
  };
  const marked = isSkin ? collect(isSkin) : [];
  const all = collect();
  const skin = (marked.length >= 8 ? skinOf(marked) : null) ?? skinOf(all);
  trace('face', () => ({
    t: performance.now(),
    marked: marked.length,
    skin: skin?.length ?? 0,
    of: all.length,
    colour: skin ? mean(trimmed(skin, 0.1, 0.9)) : null,
    crop: all.length ? mean(all) : null,
  }));
  return skin ? mean(trimmed(skin, 0.1, 0.9)) : null;
}

/**
 * White-balance gains (linear, per channel) from the face skin's colour: the light's cast is the
 * face chroma over the skin's own chroma (config SKIN_CHROMA); the jacket gets that cast to the
 * power WB_STRENGTH, normalised to unit luminance (white balance never changes the exposure) and
 * clamped per channel to WB_GAIN_RANGE. `venue` (default: the page's ?f4light=1) uses the venue
 * calibration instead (config VENUE_WB: the camera's real cast, wider bounds).
 */
export function whiteBalanceGains(face: Rgb, venue = VENUE_FLAG, camo = CAMO): Rgb {
  if (!(face[1] > 1e-4)) return [1, 1, 1];
  const strength = venue ? VENUE_WB.strength : WB_STRENGTH,
    range = venue ? (camo ? VENUE_WB.rangeCamo : VENUE_WB.range) : WB_GAIN_RANGE;
  // The venue (f4light) path uses the skin chroma of the camera in use (Camo vs laptop camera).
  const sc = venue ? SKIN_CHROMA_CAM : SKIN_CHROMA;
  const cast: Rgb = [face[0] / face[1] / sc[0], 1, face[2] / face[1] / sc[1]];
  const g = cast.map((c) => Math.pow(Math.max(1e-3, c), strength)) as Rgb;
  const y = luminance(g);
  const gains = g.map((c) => Math.min(range[1], Math.max(range[0], c / y))) as Rgb;
  trace('wb landed', () => ({ t: performance.now(), face, gains, venue }));
  return gains;
}

/**
 * A face crop is used as the light reference only if it looks like lit skin (config FACE_SKIN):
 * reddish (r/g, b/g) and neither black nor blown out. Rejects the hood or hair of a back view
 * (second eval: Y ≈ 1.0) and dark clothing when the face is cut off (Y 0.005–0.075). `venue`
 * (default: the page's ?f4light=1) uses the looser VENUE_FACE_SKIN (a cool-balanced camera).
 */
export function plausibleSkin(c: Rgb, venue = VENUE_FLAG) {
  const gate = venue ? VENUE_FACE_SKIN : FACE_SKIN;
  const y = luminance(c);
  if (!(c[1] > 1e-4) || y < gate.minY || y > gate.maxY) return false;
  return c[0] / c[1] >= gate.minRG && c[2] / c[1] <= gate.maxBG;
}

/** Tone-mapping exposure from the face's linear luminance (config EXPOSURE_*). */
export function exposureFromFace(faceY: number) {
  if (!(faceY > 1e-4)) return EXPOSURE_AT_REF;
  const e = EXPOSURE_AT_REF * Math.pow(faceY / FACE_Y_REF, EXPOSURE_GAMMA);
  return Math.min(EXPOSURE_RANGE[1], Math.max(EXPOSURE_RANGE[0], e));
}

/** The p-th percentile (0..1) of the sRGB luma (0..1) of an RGBA buffer. */
export function lumaPercentile(rgba: Uint8ClampedArray | Uint8Array, p: number) {
  const hist = new Uint32Array(256);
  const n = rgba.length / 4;
  for (let i = 0; i < n; i++)
    hist[Math.round(0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2])]++;
  const want = p * n;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= want) return v / 255;
  }
  return 1;
}

/** Black lift for the jacket's display colour (0..LIFT_MAX) from the frame's p1 luma. */
export const liftFromP1 = (p1: number) => Math.min(LIFT_MAX, Math.max(0, LIFT_OF_P1 * p1));

/**
 * Noise σ (8-bit levels) of an RGBA patch's luma: Immerkær, "Fast noise variance estimation"
 * (CVIU 1996): σ = √(π/2) / (6 (W−2)(H−2)) Σ |I ∗ N|, N = [1 −2 1; −2 4 −2; 1 −2 1]. Robust to
 * smooth shading (N annihilates planes); texture inflates it, so the finisher measures the
 * flattest of a few patches.
 */
export function noiseSigma(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number) {
  if (width < 3 || height < 3) return 0;
  const Y = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++)
    Y[i] = 0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2];
  let sum = 0;
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v =
        Y[i - width - 1] -
        2 * Y[i - width] +
        Y[i - width + 1] -
        2 * Y[i - 1] +
        4 * Y[i] -
        2 * Y[i + 1] +
        Y[i + width - 1] -
        2 * Y[i + width] +
        Y[i + width + 1];
      sum += Math.abs(v);
    }
  return (Math.sqrt(Math.PI / 2) * sum) / (6 * (width - 2) * (height - 2));
}

/** Exponential smoothing step toward `target` over dt seconds with time constant tau. */
export function smoothToward(current: number, target: number, dt: number, tau: number) {
  if (!Number.isFinite(current)) return target;
  const a = dt > 0 ? 1 - Math.exp(-dt / tau) : 1;
  return current + a * (target - current);
}
