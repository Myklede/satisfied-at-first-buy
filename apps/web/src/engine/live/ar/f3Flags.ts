// URL flags of agent F3's AR fixes (prompt 23, defects D3 D5 D7 D8 D10). Every change ships
// behind a flag, default OFF, until the judge's A/B and the lead flip it (prompt 23a §5).
//   ?f3warp=1  bounded local glue warp: no folded or over-stretched triangles; where the warp
//              would tear, it falls back locally to the rigid posed 3D jacket (warp.ts).
//   ?f3arms=1  the sleeve path: sleeves warped as bounded layers with controls along the bones,
//              the arm fit's ray–sphere branches from the world depth, held hand capsules and
//              the sleeve caps in the torso layer (D3, D8).
//   ?f3depth=1 the depth-only body pushed back along the view rays (D5 collar teeth, D3 holes).
//   ?f3collar=1 the drawn collar's front lowered so its top reaches the chin (D7, collarFit.ts).
//   ?f3head=1  from behind, the real head drawn over the jacket (the hood lies below it).
//   ?f3hood=1  the padded hood draped down on the upper back like the real one (hoodDrape.ts).
//   ?f3flat=1  the jacket's front hangs straight from the chest (no belly bulge; flatFront.ts).
//   ?f3side=1  the contour fit reaches the front/back edges of a turned person (U5 uncovered).
//   ?f3rigid=1 the torso layer placed by one filtered similarity, no free-form warp (no jelly).
//   ?f3shoulder=1 the dropped shoulder's cap drawn with its sleeve (no square pad, no step).
//              With it the upper sleeves are pulled in to one straight tube (sleeveTube.ts);
//              ?f3tube=0 turns only that part off (A/B).
//   ?f3flatx=1 the front across its width as a broad flat plane (flatFront.ts flattenAcross).
//   ?f3armfree=1 the body panels skinned without arm/clavicle influence outside a narrow armhole
//              band (garmentSkin.ts ARM_FREE; read by LiveAvatar when it binds the jacket).
//              ?f3armband=<cm> (6..30) sets that band's geodesic width for the A/B.
// Read once per compositor from the page URL (the kiosk and the AR lab construct it alike).

export type F3Flags = {
  warp: boolean;
  arms: boolean;
  depth: boolean;
  collar: boolean;
  head: boolean;
  hood: boolean;
  flat: boolean;
  side: boolean;
  rigid: boolean;
  shoulder: boolean;
  armFree: boolean;
  /** ?f3flatx=1: the front flattened across its width (flatFront.ts flattenAcross). */
  flatX: boolean;
  /** ?f3tube (default: ?f3shoulder): the upper sleeves as one straight tube (sleeveTube.ts). */
  tube: boolean;
  /** ?f3armband=<cm>: the armhole band's width in metres (null = ARM_FREE.bandM). */
  armBandM: number | null;
};

/** `?name=1` → true, `?name=0` → false, absent → the default. */
export function f3Flag(search: string, name: string, fallback = false): boolean {
  const value = new URLSearchParams(search).get(name);
  return value === '1' ? true : value === '0' ? false : fallback;
}

export function readF3Flags(search?: string): F3Flags {
  const s = search ?? (typeof location === 'undefined' ? '' : location.search);
  return {
    warp: f3Flag(s, 'f3warp'),
    arms: f3Flag(s, 'f3arms'),
    depth: f3Flag(s, 'f3depth'),
    collar: f3Flag(s, 'f3collar'),
    head: f3Flag(s, 'f3head'),
    hood: f3Flag(s, 'f3hood'),
    flat: f3Flag(s, 'f3flat'),
    side: f3Flag(s, 'f3side'),
    rigid: f3Flag(s, 'f3rigid'),
    shoulder: f3Flag(s, 'f3shoulder'),
    armFree: f3Flag(s, 'f3armfree'),
    flatX: f3Flag(s, 'f3flatx'),
    tube: f3Flag(s, 'f3tube', f3Flag(s, 'f3shoulder')),
    armBandM: armBand(new URLSearchParams(s).get('f3armband')),
  };
}

function armBand(value: string | null): number | null {
  const cm = value === null ? NaN : Number(value);
  return Number.isFinite(cm) && cm >= 6 && cm <= 30 ? cm / 100 : null;
}

/**
 * F3 constants (visual; no fit number depends on them).
 * - F3_SLEEVE_COLUMNS: grid columns of the sleeve layers' warp with ?f3arms=1. Kept at the glue's
 *   24: measured (vitest, a 40/80 px elbow/wrist pull) 48 columns cost 14 ms per sleeve and the
 *   bound then attenuated 96 % of the grid (kept 0.37), against 2.1 ms and kept 0.66 at 24.
 * - F3_TORSO_STRETCH / F3_SLEEVE_STRETCH / F3_MIN_AREA: the bounded warp's principal-stretch caps
 *   and smallest area ratio. They bound TEARS (folds, which the FrontSide grid culls into holes,
 *   and extreme stretch), not registration: at the old ±15 % (torso) / ±35 % (sleeves) the bound
 *   held the shoulders 10–22 px off their landmarks with the arms up and attenuated the sleeves
 *   to keep 0.1–0.3 on the venue clip (my harness, 14:40), where the global area cap had kept
 *   1.0. Principal stretch is stricter than the old isotropic area measure. Heuristic.
 * - F3_BODY_PUSH_M (?f3depth=1): the depth-only posed body is drawn this far further from the
 *   lens along each view ray (silhouette unchanged). The body still hides the jacket's inside
 *   (the back panel behind the neck is ≥ 8 cm behind the neck's front), but a collar or sleeve
 *   that the skinning pushes up to this deep into the body is no longer cut along the
 *   intersection (the collar "teeth" of D5, sleeve holes of D3). Heuristic, 3 cm.
 */
export const F3_SLEEVE_COLUMNS = 24;
export const F3_TORSO_STRETCH = 0.5;
export const F3_SLEEVE_STRETCH = 0.6;
export const F3_MIN_AREA = 0.3;
export const F3_BODY_PUSH_M = 0.03;
/**
 * ?f3collar=1 (D7): the largest drop of the collar (m; collarFit.ts also caps it at 95 % of the
 * collar's height, 7.6 cm on the 8 cm funnel), the time constant (s) it eases back with, and the
 * collar's ceiling below the mouth line in nose-to-mouth lengths (chin ≈ 1.0–1.4, lead 19:2x;
 * 1.5 = just under the chin). Heuristic.
 */
export const F3_COLLAR_MAX_DROP_M = 0.09;
export const F3_CHIN_FROM_MOUTH = 1.5;
export const F3_COLLAR_TAU_S = 0.4;
/**
 * ?f3side=1: half the torso's depth incl. the jacket's loft (m): how far beyond the shoulder and
 * hip landmarks the person-edge walk may go, × |sin yaw| (a chest ≈ 0.22–0.25 m deep plus the
 * coat). Heuristic.
 */
export const F3_TORSO_HALF_DEPTH_M = 0.16;
