// Studio pinch interaction (agent ZB): every constant that shapes how a pinch in front of the
// camera maps to the zip, the hood and the hem. These are INTERACTION tolerances (where a hand
// counts as "on the zip pull"), not fit measurements: no fit number depends on them.
//
// Units: body units "T" = the person's torso length in the image (shoulder-joint midpoint to
// hip-joint midpoint, MediaPipe pose landmarks 11/12 and 23/24). u = across the body (+ toward
// the person's LEFT shoulder, landmark 11), v = down the body (0 at the shoulder line, 1 at the
// hip line). On an adult T is ~50 cm, so 0.1 T ~ 5 cm. Using T (not pixels, not the panel)
// makes the gesture independent of how far the person stands and of how any view is laid out.
//
// LIVE TUNING (user test): open the Studio with ?zbDebug=1 to see every grab box drawn on the big
// view, and override any number below from the URL without a rebuild, e.g.
//   ?zbDebug=1&zbTune=zip.halfWidth:0.3,zip.halfHeight:0.25,hood.maxV:-0.25,hem.travel:0.4
// Keys are <group>.<field> with group = body | zip | hood | hem. Unknown keys are ignored (and
// logged). Then copy the values that worked back into this file.
import type { JacketId } from '../contract';

export const BODY = {
  /**
   * Torso length / shoulder-joint span when the hips are out of frame (webcam close-up). Adult
   * MediaPipe shoulder joints sit ~0.35-0.37 m apart and ~0.50 m above the hip joints (Anny
   * default proportions, the lab avatar), ratio ~1.4. Used ONLY as a fallback scale.
   */
  torsoPerShoulder: 1.4,
  /** Landmark visibility below which a hip is treated as not seen. */
  minHipVisibility: 0.5,
  /** Landmark visibility below which a shoulder is treated as not seen (no body frame). */
  minShoulderVisibility: 0.4,
  /** Smoothing of the body frame between pose frames (0 = frozen, 1 = raw); jitter vs lag. */
  smoothing: 0.5,
};

/**
 * Where the zip line runs on the person, per jacket (v at the top stop and at the hem). The top
 * stop is the stand collar under the chin (~0.2 T above the shoulder joints); the hem from the
 * product's length: the parka (FB7675-100) is hip length plus, the puffer (DQ4920-206) ends at
 * the hip. Approximate on purpose: a pull is mapped RELATIVE to where it was grabbed, so these
 * only set how far the hand travels for a full open (vHem - vTop torso lengths, ~65 cm).
 */
export const ZIP_LINE: Record<JacketId, { vTop: number; vHem: number }> = {
  'FB7675-100': { vTop: -0.2, vHem: 1.15 },
  'DQ4920-206': { vTop: -0.2, vHem: 1.0 },
};

export const ZIP_GRAB = {
  /** TUNE: half width of the grab box round the pull, T (0.2 ~ 10 cm each side of the zip). */
  halfWidth: 0.2,
  /** TUNE: half height of the grab box round the pull, T (0.2 ~ 10 cm above and below). */
  halfHeight: 0.2,
  /** Let go within this fraction of a stop: the zip runs to the stop (as engine/interact snapSlider). */
  snap: 0.06,
  /** Smallest zip change pushed to the bus (fraction): avoids flooding subscribers with noise. */
  minStep: 0.004,
};

export const HOOD_GRAB = {
  /** TUNE: a pinch above this v (toward the head: -0.3 ~ chin level and up) is on the hood. */
  maxV: -0.3,
  /** TUNE: ...and within this |u| of the body's centre line, T (0.6 ~ 30 cm each side). */
  halfWidth: 0.6,
  /** TUNE: hand travel (T, any direction) that takes the hood fully off (0.45 ~ 22 cm). */
  offTravel: 0.45,
  /**
   * Putting it back on: a pinch that starts beside the neck or on the shoulders (v between
   * onStartMinV and onStartMaxV, |u| up to onHalfWidth) and is lifted onTravel (T) upward.
   */
  onStartMinV: -0.5,
  onStartMaxV: 0.45,
  onHalfWidth: 1.0,
  /** TUNE: lift (T) that puts the hood back on (0.4 ~ 20 cm). */
  onTravel: 0.4,
  /** Physics: hood zip-edge displacement (m) at full travel; > solver detach distance 0.18 m. */
  physicsOffM: 0.26,
};

export const HEM_GRAB = {
  /** TUNE: a pinch within [vHem - above, vHem + below] and |u| <= halfWidth grabs the hem. */
  above: 0.3,
  below: 0.25,
  halfWidth: 0.85,
  /** TUNE: downward travel (T) for a full hem pull (hemPull = 1), 0.3 ~ 15 cm. */
  travel: 0.3,
  /** Physics: the hem grab is placed this high above the shell's lowest point (m)... */
  bandM: 0.05,
  /** ...this far to the wearer's right of the centre line (m), on fabric beside the zip tape. */
  offsetM: 0.06,
  /** Physics: the hand's pull on the hem is capped at this displacement (m); the solver's own
   *  strain clamp decides how far the fabric actually follows (the "give"). */
  maxPullM: 0.2,
};

/** Hands: the tracker's rate cap (Hz). 0 = every camera frame (busy frames are skipped). */
export const HANDS_MAX_HZ = 0;

const GROUPS: Record<string, Record<string, number>> = {
  body: BODY,
  zip: ZIP_GRAB,
  hood: HOOD_GRAB,
  hem: HEM_GRAB,
};

/**
 * Applies `?zbTune=group.field:value,...` to the constants above (in place). Returns the keys it
 * applied. Only finite numbers for existing fields are accepted.
 */
export function applyTuning(search: string): string[] {
  const raw = new URLSearchParams(search).get('zbTune');
  if (!raw) return [];
  const applied: string[] = [];
  for (const item of raw.split(',')) {
    const [key, value] = item.split(':');
    const [group, field] = (key ?? '').trim().split('.');
    const target = GROUPS[group ?? ''];
    const n = Number(value);
    if (target && field && field in target && Number.isFinite(n)) {
      target[field] = n;
      applied.push(`${group}.${field}=${n}`);
    } else console.warn('[studio/interact] zbTune ignored:', item);
  }
  return applied;
}
