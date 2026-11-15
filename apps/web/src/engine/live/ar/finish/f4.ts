// F4 (prompt 23: crisp edges, light, the real-jacket look): URL flags and the venue light rig.
// Pure, no DOM access beyond reading the URL once; no GL. Every F4 change is behind a flag,
// default OFF, until the judge's A/B and the lead's "OK flip".
//   ?f4edge=1   the jacket's own alpha edge, edge-aware person mask (shaders.ts, ArFinish.ts)
//   ?f4res=1    the canvas renders at ≥ the source video's resolution (ArCompositor layout);
//   ?f4res=2    the display's own device pixels (no 1.5 cap)
//   ?f4light=1  the measured scene light drives the renderer's rig; venue exposure (here)
//   ?f4mask=1   fresher class masks: no request-rate cap, latency breakdown (segmenterClient.ts)
//   ?f4fill=1   the coverage fill mirrors the jacket's texture across its edge (shaders.ts)
//   ?f4hands=1  real hands stay visible while the still lock holds the rest (ArFinish.ts);
//   ?f4hands=2  also their skin from the live frame's colour while held
//   ?f4shadow=1 directional contact shadows toward the key light (shaders.ts, ArFinish.ts)
//   ?f4sharp=1  (with f4edge) jacket blur adapted to the camera's measured sharpness, crisp floor
//   ?f4nocuff=1 no closed dark cuff opening (it read as a hole round the real hand, Anywear A2)
//   ?f4grain=1  temporal grain at the camera's measured noise (a new pattern every frame)
//   ?f4stable=1 mask EMA while moving + hysteresis on the person mask edge
import type { LightEstimate, Vec3 } from './light';
import { CAMERA_ADAPT, VENUE_EXPOSURE, VENUE_LIGHT } from './config';

export type F4Flags = {
  edge: boolean;
  /** 0 off, 1 ≥ source resolution, 2 native display pixels. */
  res: 0 | 1 | 2;
  light: boolean;
  mask: boolean;
  fill: boolean;
  hands: boolean;
  /** ?f4hands=2 (implies hands). */
  handsLive: boolean;
  shadow: boolean;
  sharp: boolean;
  noCuff: boolean;
  grain: boolean;
  stable: boolean;
};

/**
 * True when the camera in use is the iPhone via Camo (URL cam=Camo, the demo camera): its colour
 * calibrations differ from the laptop camera's (config SKIN_CHROMA_CAMO, VENUE_WB.rangeCamo,
 * CAMERA_ADAPT.chromaCamo). Default: the page's own URL; false outside a browser.
 */
export function camoCamera(search?: string) {
  const q = search ?? (typeof location !== 'undefined' && location?.search ? location.search : '');
  return /camo/i.test(new URLSearchParams(q).get('cam') ?? '');
}
const CAMO = camoCamera();

/** The F4 flags from a query string (default: the page's own; none outside a browser). */
export function readF4Flags(search?: string): F4Flags {
  const q = search ?? (typeof location !== 'undefined' && location?.search ? location.search : '');
  const p = new URLSearchParams(q);
  const on = (k: string) => p.get(k) === '1';
  return {
    edge: on('f4edge'),
    res: p.get('f4res') === '1' ? 1 : p.get('f4res') === '2' ? 2 : 0,
    light: on('f4light'),
    mask: on('f4mask'),
    fill: on('f4fill'),
    hands: on('f4hands') || p.get('f4hands') === '2',
    handsLive: p.get('f4hands') === '2',
    shadow: on('f4shadow'),
    sharp: on('f4sharp'),
    noCuff: on('f4nocuff'),
    grain: on('f4grain'),
    stable: on('f4stable'),
  };
}

const norm = (v: Vec3): Vec3 => {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
};

/** Quaternion (x, y, z, w) rotation of a vector. */
export function rotate(q: readonly [number, number, number, number], v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // t = 2 q.xyz × v; v' = v + w t + q.xyz × t
  const tx = 2 * (y * v[2] - z * v[1]),
    ty = 2 * (z * v[0] - x * v[2]),
    tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/**
 * The key direction in camera coordinates (toward the light): the estimate when confident,
 * else the prior; never behind the person or from below (VENUE_LIGHT.minToCamera / minUp).
 */
export function keyDirCamera(est: LightEstimate | null): Vec3 {
  const prior = norm([...VENUE_LIGHT.priorDir] as Vec3);
  let d: Vec3 = prior;
  if (est && est.confidence >= VENUE_LIGHT.minConfidence) {
    // Blend toward the estimate by its confidence (a weak fit stays near the prior).
    const k = Math.min(1, est.confidence / VENUE_LIGHT.fullConfidence);
    d = norm([
      prior[0] + k * (est.dir[0] - prior[0]),
      prior[1] + k * (est.dir[1] - prior[1]),
      prior[2] + k * (est.dir[2] - prior[2]),
    ]);
  }
  // Clamp on the unit sphere: y and z raised to their floors, x shortened to fit, z fills the rest.
  const y = Math.max(VENUE_LIGHT.minUp, d[1]);
  const zMin = Math.max(VENUE_LIGHT.minToCamera, d[2]);
  const xMax = Math.sqrt(Math.max(0, 1 - y * y - zMin * zMin));
  const x = Math.sign(d[0]) * Math.min(Math.abs(d[0]), xMax);
  return [x, y, Math.sqrt(Math.max(0, 1 - x * x - y * y))];
}

export type VenueRig = {
  /** World directions toward each light (unit) and intensities. */
  key: { dir: Vec3; intensity: number };
  fill: { dir: Vec3; intensity: number };
  rim: { dir: Vec3; intensity: number };
  hemisphere: number;
  environment: number;
};

/**
 * ?f4xdebug=1 (diagnosis only, as colour.ts): the light estimate and the key it gives, traced
 * with console.error (render service result.json) on the 1st, 30th and 60th rig of a page.
 */
const RIG_TRACE =
  typeof location !== 'undefined' &&
  !!location?.search &&
  new URLSearchParams(location.search).get('f4xdebug') === '1';
let rigs = 0;
function traceRig(est: LightEstimate | null, key: Vec3) {
  if (!RIG_TRACE) return;
  rigs++;
  if (rigs !== 1 && rigs !== 30 && rigs !== 60) return;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  console.error(
    `[F4X] rig ${JSON.stringify({ n: rigs, est: est ? { dir: est.dir.map(r3), confidence: r3(est.confidence) } : null, key: key.map(r3) })}`,
  );
}

/**
 * The renderer's light rig from the scene-light estimate. `cameraQuat` = the AR camera's world
 * rotation (three camera axes = light.ts camera coordinates: x right, y up, z toward the viewer).
 */
export function venueRig(
  est: LightEstimate | null,
  cameraQuat: readonly [number, number, number, number],
): VenueRig {
  const keyCam = keyDirCamera(est);
  traceRig(est, keyCam);
  // Fill: mirrored sideways, low, from the camera side; rim: from behind and above.
  const fillCam = norm([-keyCam[0] * 0.8 - Math.sign(keyCam[0] || 1) * 0.3, 0.1, 0.9]);
  const rimCam: Vec3 = norm([0, 0.6, -0.8]);
  const share = est && est.confidence >= VENUE_LIGHT.minConfidence ? ambientShare(est) : null;
  const k =
    share === null
      ? 1
      : Math.min(
          VENUE_LIGHT.shareRange[1],
          Math.max(VENUE_LIGHT.shareRange[0], share / VENUE_LIGHT.shareRef),
        );
  return {
    key: { dir: rotate(cameraQuat, keyCam), intensity: VENUE_LIGHT.key },
    fill: { dir: rotate(cameraQuat, fillCam), intensity: VENUE_LIGHT.fill },
    rim: { dir: rotate(cameraQuat, rimCam), intensity: VENUE_LIGHT.rim },
    hemisphere: VENUE_LIGHT.hemisphere * k,
    environment: VENUE_LIGHT.environment * k,
  };
}

/** The ambient share of the face's light (light.ts ambientRGB has that luminance). */
export function ambientShare(est: LightEstimate) {
  const [r, g, b] = est.ambientRGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** sRGB hex (#rrggbb) → linear RGB, or null. */
export function hexToLinear(hex: string | null | undefined): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return null;
  const v = parseInt(m[1], 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return [lin((v >> 16) & 255), lin((v >> 8) & 255), lin(v & 255)];
}

/**
 * The camera's adaptation to the garment (config CAMERA_ADAPT): chroma gains (unit luminance)
 * and an exposure factor, from the product's colour. Identity without a colour. `camo` (default:
 * the page's camera, camoCamera) takes the iPhone's chroma exponent (CAMERA_ADAPT.chromaCamo).
 */
export function cameraAdaptation(
  hex: string | null | undefined,
  camo = CAMO,
): {
  gain: [number, number, number];
  exposure: number;
} {
  const a = hexToLinear(hex);
  if (!a) return { gain: [1, 1, 1], exposure: 1 };
  const Y = 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  if (!(Y > 1e-3)) return { gain: [1, 1, 1], exposure: 1 };
  const [lo, hi] = CAMERA_ADAPT.gainRange;
  const k = camo ? CAMERA_ADAPT.chromaCamo : CAMERA_ADAPT.chroma;
  const g = a.map((c) => Math.min(hi, Math.max(lo, Math.pow(c / Y, -k)))) as [
    number,
    number,
    number,
  ];
  const gy = 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2];
  return {
    gain: g.map((c) => c / gy) as [number, number, number],
    exposure: Math.pow(CAMERA_ADAPT.whiteY / Y, CAMERA_ADAPT.luma),
  };
}

/** Venue exposure from the face's linear luminance (config VENUE_EXPOSURE, γ = 1). */
export function venueExposure(faceY: number) {
  const { atRef, faceYRef, gamma, range } = VENUE_EXPOSURE;
  if (!(faceY > 1e-4)) return atRef;
  return Math.min(range[1], Math.max(range[0], atRef * Math.pow(faceY / faceYRef, gamma)));
}
