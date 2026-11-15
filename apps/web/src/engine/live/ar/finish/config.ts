// AR finishing pass constants (agent V4, prompt 14). Every number that changes what the finished
// overlay shows lives here, with its source. "Heuristic" = chosen by reasoning and checked by eye on
// the user's recordings, not calibrated against ground truth. "Calibrated" = measured on the
// user's kiosk-camera clips (data/reference-photos/FB7675-100-parka-trang/video/cam-*.mp4, local
// only); the measurement is in the comment. Lengths in source-image pixels unless stated.

/** Selfie multiclass categories (MediaPipe selfie_multiclass_256x256; @satisfy/vision SELFIE_CLASSES). */
export const CLASS = {
  background: 0,
  hair: 1,
  bodySkin: 2,
  faceSkin: 3,
  clothes: 4,
  others: 5,
} as const;

/** A landmark below this MediaPipe visibility is not used (MediaPipe's own 0.5 convention). */
export const MIN_VISIBILITY = 0.5;

/**
 * Upper-body region (where real clothing must be covered), relative to the shoulder-landmark
 * span S and the torso length T (mid-shoulder → mid-hip). Heuristic, from body proportions:
 * - the torso quad's top is lifted 0.1 T above the shoulder landmarks (trapezius and T-shirt
 *   collar sit above MediaPipe's shoulder points; at 0.18 T a hoodie's hood bunched above the
 *   shoulders was filled, third eval cam-tshirt 12.5 s) and widened 0.22 S beyond each shoulder
 *   (the deltoid is outside the landmark);
 * - its bottom is the hip landmarks, widened 0.3 S (the hip landmarks are joint centres ≈ 0.6 S
 *   apart; a clothed waist is ≈ 1.1–1.2 S wide: at 0.12 S the hoodie showed in the waist gaps,
 *   second eval, cam-tshirt 2.5 s);
 * - arm capsules run shoulder → elbow → wrist with radius 0.2 S (a clothed upper arm is
 *   ≈ 0.3–0.35 S wide; the person mask bounds the rest). The forearm capsule is cut flat at the
 *   wrist: the hand is never part of the region.
 */
export const REGION = {
  topLiftOfTorso: 0.1,
  shoulderWidenOfSpan: 0.22,
  hipWidenOfSpan: 0.3,
  armRadiusOfSpan: 0.2,
  /**
   * Shoulder band (classes only: clothes/others, never skin, hair or face): above the torso quad's
   * top edge, widened by the arm radius beyond its corners, up to BAND_UP_OF_CHIN × the shoulder
   * line → chin distance (or 0.45 T without a face). A close-up showed the hoodie's shoulder top
   * above the virtual shoulder and a straight cut where the upper arm's flat start ended the region
   * (cam-tshirt 12.5 s); with the band the fill's edge is the person mask and the near-jacket
   * offset of the jacket's outline.
   */
  bandUpOfChin: 1.2,
  bandUpOfTorsoNoFace: 0.45,
} as const;

/**
 * Head exclusion: an ellipse round the nose, half-width max(0.6 × ear-to-ear, 1.0 × outer-eye
 * distance, 0.25 S) (nose → cheek edge ≈ 7–9 cm; ears ≈ 15 cm, outer eyes ≈ 9 cm apart), down to
 * the chin and 1.7 half-widths up (forehead, hair). An ellipse, not a band: a band's straight sides
 * cut a rectangular notch into the fill at the collar (first eval, cam-tshirt 8 s and 12.5 s). Chin = mouth line + 0.9 ×
 * (nose → mouth) below it (same estimate as ar/config.ts CHIN_FROM_MOUTH, lead's figure).
 * Without the class mask, the neck (a capsule from the mid-shoulder to the chin, radius 0.22 S) is
 * excluded too, so the fill never grows the collar up the bare neck.
 */
export const HEAD = {
  radiusOfEars: 0.6,
  radiusOfEyes: 1.0,
  radiusOfSpan: 0.25,
  /** The ellipse reaches this many radii above the nose (forehead and hair). */
  upOfRadius: 1.7,
  chinFromMouth: 0.9,
  neckHalfWidthOfSpan: 0.22,
} as const;

/**
 * Coverage fill. A real-clothing pixel in the region and not under the jacket is filled when the
 * jacket is within NEAR_OF_SPAN × S beside it, below it (collar, shoulder tops), or up the arm
 * from it (sleeves down to the cuffs). 0.3 S ≈ 10–11 cm at the body: the largest gap the glue
 * leaves on the user's recordings was ≈ 20 px at S ≈ 125 px (diag-151843, cross arms), 0.16 S;
 * twice that for margin. A real garment further than this from the jacket is not hidden: that is
 * a misalignment, and the measured uncovered % reports it.
 */
export const NEAR_OF_SPAN = 0.3;
/**
 * The person mask is soft at its edge (MediaPipe's 256-px model upsampled). It counts as person
 * from PERSON_EDGE[0] (fully at [1]); the clothes class likewise from CLASS_EDGE. Heuristic.
 */
export const PERSON_EDGE: readonly [number, number] = [0.25, 0.55];
export const CLASS_EDGE: readonly [number, number] = [0.3, 0.6];
/** Mask textures are downsampled to at most this width (upload cost; edges are bilinear). */
export const MASK_MAX_WIDTH = 320;
/**
 * The class mask comes from a worker (segment.worker.ts; on the main thread the CPU segmenter cost
 * ≈ 100+ ms per frame, V1's measurement 2026-11-13), so it is a few frames old: it is shifted by
 * the mid-shoulder's motion since its frame, bounded by the current person mask, and used for at
 * most CLASS_MAX_AGE_MS after its frame (older = person-mask fallback).
 */
export const CLASS_MAX_AGE_MS = 600;
/**
 * Segmenter requests are capped at this rate. The GPU delegate returns ≈ 25 masks/s, and each
 * costs the main thread a bitmap request and a texture upload: the finisher took 1.4–1.6 ms/frame
 * at that rate vs ≈ 0.6 ms with ≈ 4 masks/s (CPU). The stale-mask study found a mask 270 ms old
 * still covers as well as a fresh one (person-mask bound), so 15 Hz costs nothing visible.
 */
export const CLASS_REQUEST_HZ = 15;

/**
 * Rest stability (stability.ts). The largest landmark motion per frame, as a fraction of the
 * shoulder span: below motion[0] the person counts as still, above motion[1] as moving (MediaPipe's
 * jitter on a still person is ≈ 1–2 px at a 120–200 px span, ≈ 0.01). When still:
 * - the person mask is blended over frames with factor personBlend, a class mask (≤ 15 Hz) with
 *   classBlend: the model's frame-to-frame edge noise averages out;
 * - the segmenter crop box keeps its place unless an edge moves > rectTolOfSpan × span (so the
 *   blended masks align);
 * - the grade's time constants are gradeSlow × longer, and its targets move only beyond a
 *   deadband (exposureBand absolute, gainBand per channel, liftBand of 0..1).
 * Moving: factors 1, plain time constants: edges follow at once. Heuristic; measured in
 * docs/validation/ar-finish-v4.json "still".
 */
export const STILL = {
  motion: [0.012, 0.04] as const,
  personBlend: 0.25,
  classBlend: 0.35,
  rectTolOfSpan: 0.08,
  gradeSlow: 4,
  exposureBand: 0.03,
  gainBand: 0.015,
  liftBand: 0.01,
};

/**
 * Cuff: the sleeve opening is drawn closed and dark, like a lining in shadow. Opening half-width
 * = 0.16 S (parka cuff ≈ 11 cm across; S ≈ 0.85 × biacromial ≈ 34 cm). Its apparent depth
 * (the ellipse's minor axis) follows the forearm's foreshortening in 2D, at least 0.2 of the
 * half-width (a sleeve end seen edge-on still shows a thin dark gap). Forearm ≈ 0.74 S (≈ 25 cm).
 * Lining in shadow: the jacket colour × liningShade at the centre. Heuristic.
 */
export const CUFF = {
  halfWidthOfSpan: 0.16,
  forearmOfSpan: 0.74,
  minDepth: 0.2,
  liningShade: 0.5,
  /**
   * The closed opening is drawn only when the forearm is foreshortened at least this much (the
   * opening faces the camera: the hollow-tube case). In-plane sleeves show no opening, and a
   * guessed ellipse there read as a dark hole (first eval, cam-tshirt 12.5 s). The 2D estimate
   * read 0.5–0.83 for hands resting in front of the hips (third eval), where the dark disc looked
   * like a hole in the sleeve: only clearly foreshortened forearms (≥ 0.85) qualify.
   */
  minFacing: 0.85,
  /** ... and only when the sleeve end lies within this many half-widths of the wrist. */
  maxEndFromWrist: 1.5,
  /** The march for the sleeve end runs from −1 to +2.5 half-widths along the forearm. */
  marchFrom: -1,
  marchTo: 2.5,
} as const;

/**
 * Real hands: inside the compositor's hand capsules, beyond the cuff opening, the real pixels win
 * where the class mask says body-skin (or, without classes, the person mask). HAND_SOFT = the
 * capsule's soft edge as a fraction of its radius.
 */
export const HAND_SOFT = 0.3;

/**
 * Integration. Contact shadow on the real body just outside the jacket (neck under the collar,
 * wrists, hands at the cuffs): radius 0.045 S (≈ 1.5 cm), strength 0.35. Enclosed gaps (armpits,
 * between the arms and the torso) darken by up to 0.3 when the jacket surrounds them (blurred
 * jacket cover over 0.14 S above 0.5). Inner shadow on the jacket where the collar meets the neck:
 * 0.25 within 0.03 S of its edge. Heuristic look values; never on the background (no halo).
 */
export const SHADOW = {
  contactRadiusOfSpan: 0.045,
  contactStrength: 0.35,
  enclosureRadiusOfSpan: 0.14,
  enclosureStrength: 0.3,
  innerRadiusOfSpan: 0.03,
  innerStrength: 0.25,
} as const;

/**
 * Softness: the jacket is rendered sharper than the webcam image (MSAA at canvas resolution vs a
 * 960×540 stream with denoise and compression, upscaled). It is blurred by BLUR_SOURCE_PX (σ, in
 * source pixels, ≈ the edge spread of the video at the person's outline) and its alpha edge
 * feathered over FEATHER_SOURCE_PX. Heuristic, checked on the edge-width numbers in
 * docs/validation/ar-finish-v4.json.
 */
export const BLUR_SOURCE_PX = 0.7;
export const FEATHER_SOURCE_PX = 1.2;

/**
 * Colour match to the room, with the face skin as the reference for the light falling on the
 * person (the face and the torso share it).
 *
 * Calibration, measured in the finisher harness (eval/run-finish-eval.mjs --calibrate,
 * docs/validation/ar-finish-v4.json "calibration"): cam-parka.mp4 (the user in the real FB7675
 * optic-white parka, Integrated Camera, office light) at 2.5, 12.5, 13.5 and 14.5 s, with the
 * runtime's own face crop (geometry.ts faceBox) and the real parka's chest panels:
 * - real parka chest: linear Y 0.59–0.82, r/g 0.81–0.86, b/g 1.16–1.32 (the camera renders the
 *   white parka cool);
 * - face: linear Y 0.21–0.29, r/g 1.46–1.52, b/g 0.72–0.74.
 * A neutral white seen through this camera and light has the parka's cast, so the skin's own
 * chroma is face ÷ parka cast: SKIN_CHROMA = (1.775, 0.579) (median of 4; per frame r/g
 * 1.69–1.86, b/g 0.55–0.64). That is the user's skin; typical skin spans r/g 1.6–2.0, b/g
 * 0.55–0.75, so another person's cast estimate is off by up to ≈ ±15 % (a known gap).
 *
 * White balance: the jacket's linear colour × (face chroma ÷ SKIN_CHROMA)^WB_STRENGTH, normalised
 * to unit luminance; WB_STRENGTH < 1 keeps the product's own colour identity dominant.
 * Exposure: E = EXPOSURE_AT_REF × (face Y ÷ FACE_Y_REF)^EXPOSURE_GAMMA, clamped. FACE_Y_REF = the
 * calibration face (median 0.273). The exposure at which our parka's chest matches the real one
 * measured 0.39–0.57 on the frontal frames, but that match sits on the tone curve's shoulder (our
 * chest Y moves only 0.80 → 0.91 for E 0.7 → 1.15), where it is unstable, and below ≈ 0.7 the
 * shaded panels turn grey. EXPOSURE_AT_REF = 0.75 is a judged compromise, not a fit. Gamma 0.5
 * halves the dependence on the person's skin tone while still following the room's light.
 */
export const SKIN_CHROMA: readonly [number, number] = [1.775, 0.579];
/**
 * The skin's chroma through the iPhone via Camo (the demo camera since 19:25; URL cam=Camo), for
 * ?f4light's white balance. Measured (F4, 19:5x) on camo-test-1.mp4 against the white paper the
 * user holds at 9–15 s: paper r/g 1.24, b/g 0.87 (this camera keeps the room warm); cheeks
 * r/g 2.53, b/g 0.62 → face ÷ paper ≈ (2.04, 0.71) at 12 s, (1.93, 0.69) median over 13 frames.
 * With the office value (1.775, 0.579) the gains came out r/g 1.35, b/g 1.05 against the paper's
 * 1.24 / 0.87: the white parka read pink. With these: 1.22 / 0.90.
 */
export const SKIN_CHROMA_CAMO: readonly [number, number] = [2.0, 0.7];
/**
 * 0.6 of the cast, each channel within ±15 %: at 0.8 / ±30 % the first eval turned the parka
 * visibly light blue on cam-tshirt (gains 0.75/1.03/1.30, the clamp), losing its optic white.
 */
export const WB_STRENGTH = 0.6;
export const WB_GAIN_RANGE: readonly [number, number] = [0.85, 1.15];
export const FACE_Y_REF = 0.273;
/**
 * Lit skin, linear (calibration faces: r/g 1.46–1.52, b/g 0.72–0.74, Y 0.21–0.29; typical skin
 * r/g 1.3–2.1 under room light). Heuristic bounds that reject hair, hoods and dark clothing.
 */
export const FACE_SKIN = { minRG: 1.15, maxBG: 0.95, minY: 0.03, maxY: 0.7 };
export const EXPOSURE_AT_REF = 0.75;
export const EXPOSURE_GAMMA = 0.5;
export const EXPOSURE_RANGE: readonly [number, number] = [0.6, 1.2];
/**
 * Black level: the webcam lifts its blacks (cam-parka frames: luma p1 = 37–45 of 255), our render
 * does not (zipper tape at 0). The jacket's sRGB is lifted to LIFT_OF_P1 × the frame's p1 luma,
 * at most LIFT_MAX. Heuristic: 0.8 keeps the jacket's blacks just under the darkest real ones.
 */
export const LIFT_OF_P1 = 0.8;
export const LIFT_MAX = 0.2;
/**
 * Colour statistics: measured every Nth frame (asynchronous GPU readback, probe.ts) and smoothed
 * with τ = MATCH_TAU_S. The face is used only when frontal (nose within FRONTAL_NOSE of the eye
 * midpoint, in eye spacings): a turned or tilted face changes its own shading, not the room's
 * light (first eval: exposure 0.55–1.12 across poses of one clip). The black level moves with
 * whatever dark clothing fills the frame, so it is smoothed much more slowly (LIFT_TAU_S).
 */
export const MATCH_EVERY_FRAMES = 6;
/** The scene-light estimate (light.ts) is smoothed with this τ (s), weighted by its confidence. */
export const LIGHT_TAU_S = 3;
export const MATCH_TAU_S = 2.5;
export const LIFT_TAU_S = 6;
export const FRONTAL_NOSE = 0.25;
/**
 * Coverage fill shading: the fill carries the real garment's folds, as the luminance of the video
 * over its local mean (radius FILL_SHADE.radiusOfSpan × S) to the power `strength`, clamped to
 * `range`; and it darkens toward the person's outline (the side of the body turning away) down to
 * `edge`. Heuristic: a flat fill read as a cut-out (first eval, cam-tshirt 12.5 s); at strength
 * 0.5 the texture of a dark hoodie turned mottled (third eval).
 */
export const FILL_SHADE = {
  radiusOfSpan: 0.08,
  strength: 0.3,
  range: [0.88, 1.08] as const,
  edge: 0.85,
};

/** Size of the small copy of the video used for the statistics (width; height keeps aspect). */
export const MATCH_WIDTH = 96;

/**
 * F4 (prompt 23, defects D4 D6 D11), every change behind a URL flag (f4.ts readF4Flags):
 * - f4edge: the jacket's own MSAA alpha is its edge (no softness blur, no feather), and the person
 *   mask's outline (the coverage fill's edge) is refined against the full-resolution camera frame
 *   by a joint-bilateral upsampling (Kopf et al. 2007) where the low-res mask is undecided.
 *   EDGE_JBU.tapOfTexel: tap spacing in mask texels (7×7 taps); rangeSigma: colour distance (sRGB
 *   0..1) at which a tap's weight falls to e^−½; spatialSigma in taps; band: the refined mask
 *   counts as person from band[0], fully at band[1] (narrower than PERSON_EDGE: the guide makes
 *   the transition sharp). Heuristic, checked by eye on venue-khong-ao (F4 sheets).
 * - f4res: the canvas renders at least at the source video's resolution (a smaller on-screen
 *   view is downsampled by the browser: supersampled, never upsampled), device pixel ratio up to
 *   RES_MAX_RATIO.
 */
export const EDGE_JBU = {
  /**
   * Camera-matched softness (lead 16:58, Anywear study: "crisp" = no halo, smear or stair-steps,
   * judged against the camera's own edge sharpness, not razor-sharp CG). Measured with F4's edge
   * estimator (contrast / peak slope, calibrated on synthetic AA edges blurred by a known σ) at
   * 1280×720: the camera's own person outline on venue-khong-ao 2.16–2.18 (true 10–90 % ≈ 1.9 px),
   * the real parka's outline in venue-mac-ao ≈ 2.55; the f4edge jacket with the Catmull-Rom copy
   * ≈ 1.55 (true ≈ 1.0 px, sharper than the camera); a perfect AA edge 1.50; + σ 0.5 → 1.86,
   * + σ 0.8 → 2.40. So σ ≈ 0.6 source px on the jacket layer (edge and interior alike) lands on
   * the camera. The old default (blur 0.7 + feather 1.2 + bilinear glue) measured 2.8–2.9.
   */
  cameraSigmaSrc: 0.6,
  /** Unsharp-mask gain inside the jacket (0 = off: the camera-matched blur replaces it). */
  sharpen: 0,
  // 7×7 taps one mask texel apart (± 3 texels ≈ ± 12 source px at 1280): a narrower window
  // (5×5 at 0.75 texel) left the low-res mask's offset ramp at 0.38–0.47 on the background side
  // of the true edge (edge.test.ts), i.e. a see-through fill there.
  tapOfTexel: 1,
  rangeSigma: 0.09,
  spatialSigma: 2.5,
  band: [0.4, 0.6] as const,
};
export const RES_MAX_RATIO = 2;
/**
 * ?f4hands=1: a hand unseen for at most this long keeps its last capsule (hand landmarks drop
 * below MediaPipe's 0.5 visibility for a few frames in crossed arms; 0.8 s ≈ 12–24 frames).
 */
export const HANDS_BRIDGE_MS = 800;
/**
 * ?f4grain=1 temporal noise estimate (ArFinish.updateGrain): a `patch`² background patch read on
 * two frames every `intervalMs`, median of the last `keep` readings. Judge: grain ratio = the
 * jacket's temporal std / the background's in the same recording (band 0.7–1.4).
 */
export const GRAIN_F4 = { patch: 32, intervalMs: 2000, keep: 5 };
/**
 * ?f4stable=1: mask edge stability (free-local-ar-upgrades #4). Existing before it: while the
 * shared still lock holds, the person and class masks are blended (STILL.personBlend 0.25,
 * classBlend 0.35) and then frozen, the crop box has hysteresis (STILL.rectTolOfSpan), the
 * geometry is held; while MOVING the raw masks were used as they came. Added: an EMA while moving
 * too (`moving` = weight of the new mask ≈ 0.7-frame lag) and a hysteresis band on the person mask
 * round its 0.5 edge (bytes: in stays in down to band[0], out stays out up to band[1]). Heuristic.
 */
export const MASK_STABLE = { moving: 0.65, band: [96, 160] as const };
/** ?f4mask capture path: cut the class crop on every Nth 'posecapture' frame (F4, fps budget). */
export const MASK_CAPTURE_EVERY = 2;
/**
 * ?f4sharp=1 (with f4edge; user feedback 19:00 "crisp and detailed"): the jacket blur adapts to
 * the camera's MEASURED edge sharpness (sharpness.ts, a crop across the person's upper-arm outline
 * read every `intervalMs` then `steadyIntervalMs`, median over rows, smoothed τ = tauS, clamped to `range` source px),
 * but the jacket's edge transition never exceeds `floorDisplayPx` DISPLAY pixels: a soft 960×540
 * webcam no longer softens the jacket past 1.2 px on screen; a sharp camera (an iPhone as webcam)
 * gives a sharper jacket automatically. `jacketCanvasPx` = the jacket's own MSAA + Catmull-Rom
 * edge (canvas px; F4 calibration ≈ 1.0, true 10–90 %).
 */
export const SHARPNESS = {
  /** One reading per intervalMs until settleReadings landed, then per steadyIntervalMs. */
  intervalMs: 1500,
  settleReadings: 4,
  steadyIntervalMs: 10000,
  tauS: 3,
  range: [0.7, 4] as const,
  floorDisplayPx: 1.2,
  // Look job 710d49 (lab, DPR 1.612, f4sharp with 1.0 here): the result read ≈ 1.6 px true, softer
  // than the 1.2 floor: the jacket's own MSAA + Catmull-Rom edge is ≈ 1.25 canvas px, not 1.0.
  jacketCanvasPx: 1.25,
};
/**
 * ?f4shadow=1 directional contact shadow on the real body next to the jacket (collar → neck and
 * chin, hem → trousers, cuff → hand): reach in shoulder spans (0.07 S ≈ 2.5 cm at the body) toward
 * the key light (finish/f4.ts keyDirCamera: the face estimate, else the venue's overhead prior),
 * strength at full occlusion. venue-mac-ao shows a soft dark band of about that width under the
 * hem and at the collar, darker on the lit side's opposite; subtle by design. Heuristic, by eye.
 */
// First look (F4 look jobs 8683ae/ebd59a, venue-khong-ao 3.5 s, 1280): at 0.07 S / 0.32 the
// trousers under the parka hem went 32 % darker over ~14 px, against ≈ 9–10 % fading over ≈ 30 px
// under the real parka in venue-mac-ao (45 s): weaker and a little longer.
export const CONTACT_F4 = { reachOfSpan: 0.1, strength: 0.16 };
/**
 * f4mask: the colour statistics' readbacks are the finisher's main-thread cost (F2's profile
 * 14:05: getBufferSubData 291 ms per 8 s with the pose worker; each async readback's final copy is
 * a synchronous IPC to a busy GPU process). Their grade is smoothed with τ = MATCH_TAU_S (2.5 s),
 * so sampling every 15 frames (≈ 1 s at 14 fps) changes nothing visible; the noise σ every 90.
 */
export const MATCH_EVERY_FRAMES_F4 = 15;
export const NOISE_EVERY_FRAMES_F4 = 90;

/**
 * f4light (F4X, prompt 23 D11): the jacket as the venue camera would film it. Four parts, all from
 * the camera image (the face), so they follow any room, not only the venue clip:
 * 1. the light rig's key comes from the direction measured on the face (light.ts), VENUE_LIGHT;
 * 2. the exposure follows the face's luminance, VENUE_EXPOSURE;
 * 3. the white balance is the camera's cast measured on the face skin, VENUE_WB (colour.ts);
 * 4. the camera's own adaptation to a large light garment, CAMERA_ADAPT.
 *
 * Ground truth (F4X, local frames under .cache/f4x/gt, boxes.py; linear sRGB, chroma = r/g, b/g):
 * - real parka, venue-mac-ao 47.3 s: chest Y p25/p50/p75 0.48/0.60/0.94 with 34 % of the chest
 *   clipped, chroma 0.84/1.31; lower panels 0.77–0.79/1.30–1.33; sleeve 0.82/1.27; white paper in
 *   the same clip (16 s, unclipped) 0.82/1.34. The camera films white as a cool blue-white.
 * - real puffer, venue-mac-ao 66.5 s: chest Y 0.57/0.65/0.97, 34 % clipped, chroma 0.76/1.18;
 *   sleeves 0.80–0.84/1.09–1.16; belly (77.2 s) 0.73/1.25. A pale ivory, far paler than its
 *   paper-calibrated albedo #cdb89f under a neutral white: the camera's white balance moved cooler
 *   with the cream jacket in frame (white paper in that clip: r/g 0.61).
 * - the camera's exposure and white balance differ from clip to clip (wall p50 0.019–0.07), so the
 *   clips compare through what stays the same: the person's light-grey trousers. Jacket chest ÷
 *   trousers, luminance: parka 1.55 (51.4 s; 63.7 s is clipped), puffer 1.02–1.05 (66.5, 87.8,
 *   146.3 s) = the ratio of their albedos (0.86 vs 0.50, plus sheen). Chroma ÷ trousers: parka
 *   1.04/1.04 (the trousers are near neutral), puffer 1.16–1.20/0.74–0.84 = its paper-calibrated
 *   albedo #cdb89f (1.27/0.73) thinned by the sheen: the product colour is right.
 * - venue-khong-ao (the AR input): trousers Y 0.42–0.43, chroma 0.69–0.71/1.28–1.33. So the real
 *   jackets in THIS picture: parka chest ≈ 0.65–0.70 at 0.72–0.77/1.33–1.38, puffer chest ≈
 *   0.43–0.45 at 0.82–0.86/1.00–1.12, crowns up to the clip. F4's first hookup matched the parka
 *   clip's absolute level instead (E ≈ 0.36) and turned both jackets grey (chest Y 0.25–0.29).
 * - AR before f4light (r1, E 0.77, gains clamped ±15 %): parka chest Y 0.58/0.71/0.76, never above
 *   0.78, chroma 0.83/1.16 (too little blue); puffer chest Y 0.50, chroma 1.05/0.82 (tan).
 */
export const VENUE_LIGHT = {
  // venue-khong-ao 3.5 s face: forehead, hair crown and nose bridge lit, cheeks symmetric, the
  // underside of the nose dark: a high, centred key (≈ 53° above the view axis). The real jackets
  // agree: every quilting channel is lit on top and shaded underneath.
  priorDir: [0, 0.8, 0.6] as const,
  /** Below this confidence the prior alone; the estimate's weight reaches 1 at `fullConfidence`. */
  minConfidence: 0.1,
  // The venue face gives confidence 0.17–0.26 (direction 0.07–0.13, 0.70, 0.71, steady over the
  // clip): at 0.5 the measured side was barely used.
  fullConfidence: 0.3,
  /** The key never comes from behind the person or below the horizon (camera coordinates). */
  minToCamera: 0.3,
  minUp: -0.1,
  // A soft key from the measured side plus a strong frontal fill, little sky. Look jobs (venue,
  // arms up 10 s, chest / belly against the trousers 0.50): with the kiosk's own levels (key 2.2
  // high, fill 0.42, hemisphere 0.32, environment 0.62) the jackets fell off downwards (parka
  // 0.84 → 0.64, puffer 0.46 → 0.37) where the real ones are even from chest to hem (parka
  // 0.48/0.55/0.50, puffer 0.60/0.61): the venue's light is a large frontal source plus spots.
  // key 1.6, fill 1.2, hemisphere 0.12, environment 0.55 gave parka 0.71 → 0.63 and puffer
  // 0.56 → 0.50 (sheet .cache/f4x/sheets/w1.jpg); the rim (behind) only outlines the shoulders.
  key: 1.6,
  fill: 1.2,
  rim: 0.4,
  hemisphere: 0.12,
  environment: 0.55,
  /** Ambient (hemisphere + environment) × clamp(share / shareRef, range). */
  shareRef: 0.5,
  shareRange: [0.8, 1.25] as const,
};
/**
 * f4light white balance: the camera's cast from the face skin (colour.ts whiteBalanceGains) at
 * `strength`, each gain within `range` after normalising to unit luminance. Venue face chroma
 * 1.22/0.90 over SKIN_CHROMA gives a cast of 0.69/1.55; at 0.85 and the blue bound that is
 * 0.73/1.37 = a white object in the AR input's own balance (the near-neutral trousers read
 * 0.68/1.33–1.36). Look jobs at 10 s: at 0.7 the puffer's shade stood at 0.86/1.14, at 0.85 at
 * 0.81/1.17 (real shade, 87.8 s: 0.81–0.84/1.10–1.13). The red floor 0.74 holds the still-pose
 * reading (a brighter, paler face: 0.70 unbounded) at the 10 s one. The default path's 0.6 and ±15 %
 * stopped the blue at 1.16, which next to the camera's blue-white read as grey-beige.
 */
export const VENUE_WB = {
  strength: 0.85,
  range: [0.74, 1.4] as const,
  /**
   * The same bounds for the iPhone via Camo (URL cam=Camo). Its picture of the venue is warm, so
   * the blue gain must go lower than the laptop camera's floor: on the user's live5 recording
   * (F4T, look jobs 7bdfcc / a7beb3, 3.0 s) the face reads r/g 2.52, b/g 0.476, the gains want
   * blue 0.70 and the 0.74 floor stopped it: the parka stood at r/g 1.185, b/g 0.803 against the
   * white things in the same frame (a badge card and two white objects: 1.15–1.26 / 0.73–0.85,
   * mean 1.21 / 0.77), i.e. +4.5 % blue. With 0.6 the gain is free: parka 1.184 / 0.766 (−2 % /
   * −0.5 %: neutral).
   */
  rangeCamo: [0.6, 1.4] as const,
};
/**
 * f4light skin gate for the face reading (colour.ts plausibleSkin): looser than FACE_SKIN. The
 * venue camera balances so cool that the lit face reads r/g 1.08–1.22, b/g 0.87–0.96 (trace
 * through the render service: 0.366/0.339/0.326 at the still pose, 0.32/0.27/0.24 at 10 s), so
 * FACE_SKIN's r/g ≥ 1.15 rejected EVERY face pixel at the still pose and no white balance landed
 * until the head moved. Still rejected: a white hood or wall (this camera: r/g 0.7–0.85, b/g
 * 1.2–1.4), and by luminance dark hair and clothing or a blown highlight. Heuristic bounds.
 */
export const VENUE_FACE_SKIN = { minRG: 1.03, maxBG: 1.0, minY: 0.03, maxY: 0.7 };
/**
 * f4light camera adaptation: gains = (albedo chroma)^−chroma and exposure × (whiteY / albedo
 * Y)^luma, from the product colour.
 * - chroma 0 (F4T, 2026-11-14 night; was 0.35). The 0.35 copied the ABSOLUTE chroma of the real
 *   puffer in venue-mac-ao (0.82–0.85 / 1.08–1.15), where the laptop camera had balanced cooler
 *   because a large cream jacket was in its picture (the white paper in that clip: r/g 0.61). In
 *   the AR the camera never sees the jacket and keeps its balance, so the same absolute chroma
 *   is too pale against everything else in the frame: on the user's live-puffer recording
 *   (built-in webcam, look jobs at 10 s) the puffer stood at 0.849 / 1.132 next to the cream
 *   trousers' 0.830 / 1.166, i.e. the same bluish white (the user: "grey-white, not cream").
 *   What holds in every clip is the jacket against a WHITE in the same picture: real puffer ÷
 *   paper 1.25 (r/g, venue-mac-ao 66.5 s) and 1.21 / 0.72 (the user's iPhone flat-lay with a
 *   white sheet) = its albedo #cdb89f (1.27 / 0.72). With 0 the jacket is its albedo under the
 *   frame's own white (the white-balance gains): live-puffer 0.92 / 1.03 (÷ the gains' white
 *   1.27 / 0.75), Camo live5 1.215 / 0.73 against the white things in the frame.
 *   History: at 0.5 the AR puffer stood at 0.80–0.82/1.15–1.19, F4's 0.8 was grey.
 * - luma 0.45. Against the trousers the real puffer is 1.03–1.19× at the chest and 1.05–1.15× at
 *   the belly (66.5 and 146.3 s; the 87.8 s shade alone is 1.0×); at luma 0 the AR stood at
 *   0.92× / 0.74× and read as light grey next to the real cream-white, at 0.45 at 1.12× / 1.0×.
 */
export const CAMERA_ADAPT = {
  chroma: 0,
  /**
   * The chroma exponent for the iPhone via Camo (URL cam=Camo), kept apart so each camera can
   * be tuned on its own (?f4xset C.chromaCamo). Measured by F4T on the user's live5 recording
   * (look jobs, 3.0 s, jacket ÷ the white things in the same frame): at 0.35 the cream puffer
   * read r/g 1.14, b/g 0.85 (pale and pinkish: too little yellow), at 0 it reads 1.225 / 0.745,
   * the real puffer against the white sheet in the user's iPhone flat-lay photo: 1.21 / 0.72
   * (scripts/f4t-textures.py). The white parka is not affected (its chroma is ≈ 1).
   */
  chromaCamo: 0,
  luma: 0.45,
  /** Linear luminance of the reference white the camera exposes for (the optic-white parka). */
  whiteY: 0.864,
  /** Per-channel bound of the chroma gains. */
  gainRange: [0.7, 1.4] as const,
};
/**
 * f4xlook: the shell's material in AR (ArKioskJacket.applyArLook), absolute values per finish.
 * The kiosk's glossy ripstop (roughness 0.3, environment 0.95, from the user's close flat-lays)
 * mirrors the room environment as narrow streaks: at the AR's distance the real puffer is matte,
 * with broad soft crowns and soft channel shadows (venue-mac-ao 66.5 s). The parka's satin is
 * already close; slightly rougher and less environment so its crowns do not glare. By eye, F4X.
 */
export const AR_LOOK = {
  glossy_ripstop: {
    roughness: 0.74,
    specularIntensity: 0.4,
    envMapIntensity: 0.55,
    sheen: 0.35,
    sheenRoughness: 0.6,
  },
  satin_matte: {
    roughness: 0.7,
    specularIntensity: 0.5,
    envMapIntensity: 0.8,
    sheen: 0.3,
    sheenRoughness: 0.55,
  },
};
/**
 * f4light exposure from the face's linear luminance: E = atRef × (faceY / faceYRef)^gamma,
 * clamped, under the camera tone curve (shaders.ts F4_CAMERA: each channel clips on its own).
 * Calibrated on real renders with the white balance landed (F4X harness, 1191 px canvas,
 * .cache/f4x/sheets/seed-parka.jpg): at E 0.79 the parka's chest stood at linear 1.36 = display Y
 * 0.94 with 70 % clipped (real still pose: 0.69, 41 % clipped; lit and scaled to the AR input's
 * exposure by the trousers ≈ 0.8) and its mid-tones lost the camera's blue (b/g 1.15 against the
 * real 1.3: blue sat on the curve's shoulder); the puffer's chest stood at 0.58 against ≈ 0.50.
 * Both jackets asked for ≈ 0.8× that (0.62); with the fill-heavy rig (VENUE_LIGHT) the parka's
 * chest then stood at 0.71 with 10 % clipped against the real 0.69 with 41 %; at 0.66 at 0.81–0.87
 * with 25–54 % clipped (and the puffer at 1.3× the trousers, real 1.03–1.19×): 0.63. gamma 0.5 as
 * the default path (EXPOSURE_GAMMA): half the dependence on the person's skin tone.
 */
export const VENUE_EXPOSURE = {
  atRef: 0.63,
  faceYRef: 0.273,
  gamma: 0.5,
  range: [0.5, 1.1] as const,
};

/**
 * Grain: luminance noise added to the jacket with the camera's own σ, estimated every
 * NOISE_EVERY_FRAMES on a 64×64 full-resolution crop of the flattest frame corner (Laplacian MAD,
 * Immerkær 1996). cam-parka.mp4: σ ≈ 0.2 (wall) – 1.0 (parka) 8-bit levels after H.264; the live
 * stream is uncompressed and measured live. Capped at GRAIN_MAX_8BIT.
 */
export const NOISE_EVERY_FRAMES = 30;
export const NOISE_PATCH = 64;
export const GRAIN_MAX_8BIT = 4;
