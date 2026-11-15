// Scene light from the face (agent V4): a first-order spherical-harmonics (L1) fit of the face
// skin's shading, I(n) ≈ a0 + a·n, over the face crop the colour match already reads. Pure, no
// DOM. Camera coordinates: x = image right, y = image up, z = toward the camera; source image,
// never mirrored.
//
// What the face can and cannot tell: the crop (cheeks, nose, upper lip) spans normals of only
// ≈ ±30° sideways and ±17° vertically, all facing the camera, so the shading GRADIENT gives the
// key light's sideways and vertical direction well, but its component toward the camera is not
// separable from the ambient term (nz ≈ 1 everywhere). That component comes from a prior: the
// key light is assumed KEY_ELEVATION_RAD off the view axis whenever a gradient is measured. The
// light rig is unaffected unless the lead routes this estimate to it.
import type { Rgb } from './colour';
import { luminance } from './colour';
import { SKIN_CHROMA } from './config';

export type Vec3 = [number, number, number];

export type LightEstimate = {
  /** Unit direction TOWARD the key light, camera coordinates (x right, y up, z to the camera). */
  dir: Vec3;
  /** Key light strength relative to the skin's mean luminance (0 = flat, all ambient). */
  keyIntensity: number;
  /**
   * Ambient light colour (the room's illuminant, skin chroma divided out), scaled by the share of
   * the face's light that is ambient; luminance = that share (0..1).
   */
  ambientRGB: Rgb;
  /** 0..1: fit quality × sample count × gradient strength. */
  confidence: number;
};

/** Face crop half-extent in normal components: sideways and vertical (see the header). */
export const FACE_NORMAL_SPAN = { x: 0.5, y: 0.3 };
/** Prior angle of the key light off the view axis when only its sideways/vertical part is seen. */
export const KEY_ELEVATION_RAD = Math.PI / 4;
/** Below this relative gradient the light is called frontal (no direction). */
export const MIN_GRADIENT = 0.04;

/** The face's normal at crop position (u right, v down, both −1..1): an ellipsoidal cap. */
export function faceNormal(u: number, v: number): Vec3 {
  const nx = u * FACE_NORMAL_SPAN.x,
    ny = -v * FACE_NORMAL_SPAN.y;
  return [nx, ny, Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny))];
}

/**
 * Fits the L1 shading of skin samples (normal, linear colour). Null with too few samples. The
 * luminance fit gives the direction; each channel's own fit at that gradient gives the ambient.
 */
export function fitFaceLight(samples: readonly { n: Vec3; c: Rgb }[]): LightEstimate | null {
  const N = samples.length;
  if (N < 24) return null;
  // Luminance Y = a0 + ax·nx + ay·ny (the nz term is not separable from a0: see the header).
  let s1 = 0,
    sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0,
    syy = 0,
    t0 = 0,
    tx = 0,
    ty = 0;
  const ys = samples.map((s) => luminance(s.c));
  for (let i = 0; i < N; i++) {
    const [x, y] = samples[i].n,
      Y = ys[i];
    s1 += 1;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    t0 += Y;
    tx += x * Y;
    ty += y * Y;
  }
  const A = [
    [s1, sx, sy],
    [sx, sxx, sxy],
    [sy, sxy, syy],
  ];
  const sol = solve3(A, [t0, tx, ty]);
  if (!sol) return null;
  const [a0, ax, ay] = sol;
  const meanY = t0 / N;
  if (!(meanY > 1e-4)) return null;
  // Fit quality.
  let ssRes = 0,
    ssTot = 0;
  for (let i = 0; i < N; i++) {
    const [x, y] = samples[i].n;
    const r = ys[i] - (a0 + ax * x + ay * y);
    ssRes += r * r;
    ssTot += (ys[i] - meanY) ** 2;
  }
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  const g = Math.hypot(ax, ay) / meanY; // relative gradient
  let dir: Vec3 = [0, 0, 1];
  let key = 0;
  if (g >= MIN_GRADIENT) {
    const s = Math.sin(KEY_ELEVATION_RAD);
    dir = [
      (ax / Math.hypot(ax, ay)) * s,
      (ay / Math.hypot(ax, ay)) * s,
      Math.cos(KEY_ELEVATION_RAD),
    ];
    key = g / s;
  }
  // Ambient: the share of the skin's mean light that is not the key's frontal part, coloured by
  // the room's illuminant (the skin's colour over its own chroma, config SKIN_CHROMA), with unit
  // luminance before that share.
  const mean: Rgb = [0, 0, 0];
  for (const s of samples) for (let k = 0; k < 3; k++) mean[k] += s.c[k] / N;
  const illum: Rgb = [mean[0] / SKIN_CHROMA[0], mean[1], mean[2] / SKIN_CHROMA[1]];
  const iy = luminance(illum) || 1;
  const share = Math.max(0, 1 - key * dir[2]);
  const ambientRGB = illum.map((c) => (c / iy) * share) as Rgb;
  const confidence = Math.min(1, N / 150) * r2 * Math.min(1, g / (2 * MIN_GRADIENT));
  return { dir, keyIntensity: key, ambientRGB, confidence };
}

function solve3(A: number[][], b: number[]): Vec3 | null {
  const det = (M: number[][]) =>
    M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
    M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
    M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  const d = det(A);
  if (Math.abs(d) < 1e-9) return null;
  const col = (k: number) => A.map((row, r) => row.map((v, c) => (c === k ? b[r] : v)));
  return [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d];
}

/** Smooths an estimate toward a new one (time constant tau, s), weighted by its confidence. */
export function smoothLight(
  prev: LightEstimate | null,
  next: LightEstimate,
  dt: number,
  tau: number,
): LightEstimate {
  if (!prev) return next;
  const a = (dt > 0 ? 1 - Math.exp(-dt / tau) : 1) * next.confidence;
  const mix = (p: number, q: number) => p + a * (q - p);
  const d: Vec3 = [
    mix(prev.dir[0], next.dir[0]),
    mix(prev.dir[1], next.dir[1]),
    mix(prev.dir[2], next.dir[2]),
  ];
  const n = Math.hypot(d[0], d[1], d[2]) || 1;
  return {
    dir: [d[0] / n, d[1] / n, d[2] / n],
    keyIntensity: mix(prev.keyIntensity, next.keyIntensity),
    ambientRGB: prev.ambientRGB.map((v, k) => mix(v, next.ambientRGB[k])) as Rgb,
    confidence: mix(prev.confidence, next.confidence),
  };
}
