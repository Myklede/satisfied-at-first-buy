// Hand pull (M4, prompts/05) constants. Every value that changes what the judge feels or what
// the tests accept lives here, with its source. Scene units: metres, Y up, +Z = body front.
// "uncalibrated" = a feel/UX choice, not a measured property.

export const HAND_PULL = {
  // ---- Part A: mapping and cursor ----
  /**
   * Centred box of the camera frame (fraction of each axis) that maps to the whole viewport,
   * so a judge at 0.5–1 m never has to reach the frame edges (prompts/05 Part A: ~70 %).
   */
  activeBox: 0.7,
  /** Screen-space grab tolerance around the cursor (px), prompts/05 interaction rule 3. */
  pickTolerancePx: 24,
  /** Cursor ring diameter (px), UX. */
  cursorPx: 44,

  // ---- Part B: grab patch and depth ----
  /** Patch radius around the hit point (m): "hit triangle + neighbours within ~2–3 cm". */
  patchRadiusM: 0.025,
  /** Patch weight at the patch border relative to its centre (smooth falloff, no spike). */
  patchEdgeWeight: 0.35,
  /**
   * depthDelta (metres-equivalent from apparent hand size, + = toward the camera) → fabric
   * displacement along the view direction. Halved because the hand-size depth estimate is
   * noisy (tracker docs); uncalibrated.
   */
  depthScale: 0.5,
  /** Largest depth displacement (m) the hand can request, toward or away from the camera. */
  depthMaxM: 0.06,
  /** Largest total displacement (m) ever requested from a grab (safety; the clamp acts first). */
  maxReachM: 0.15,
  /** Largest target speed (m/s): a fast or glitched hand never flings the cloth. */
  maxTargetSpeed: 1.2,

  // ---- Part B: physical safety (strain clamp) ----
  /**
   * Visual margin above the fabric's own limit (asset.config.stretchMax, from the product file
   * or CLOTH_CONFIG; elastic bands: elasticStretchMax). Edge length / rest may reach
   * limit + this, never more. 0.02 = 2 percentage points, chosen so the stretch is visible in
   * the tension map without exceeding the woven fabric bound by more than a few per cent.
   */
  strainMargin: 0.02,
  /** Reach growth per second while the requested pull is beyond the accepted one (m/s). */
  reachGrowth: 0.6,
  /** Trial steps per frame when the clamp rejects a candidate (each ≈ one region step). */
  clampTrials: 3,
  /** Each rejected trial shrinks the candidate displacement by this factor. */
  clampShrink: 0.75,
  /**
   * Edges the clamp covers: midpoint within this distance (m) of the grab point = the patch
   * border, where the pull's strain concentrates. Farther edges are reported (region strain),
   * not clamped: on the ~05:00 WIP shell, collar/hood edges 10+ cm away fluctuated 14–30 %
   * under the solver alone (full-mesh steps, no hand), which no hand target can correct.
   */
  clampRadiusM: 0.08,
  /** Hard strain passes after the accepted step (safety net, clamp edges only). */
  clampPasses: 24,
  /** Requested minus applied displacement (m) above which the cursor shows resistance. */
  resistShowM: 0.008,

  // ---- Part C: local high-rate region ----
  /** Region radius (m, Euclidean from the grab point; prompts/05: ~15–20 cm). */
  regionRadiusM: 0.18,
  /**
   * Panels kept kinematic inside the region: 7 = hood (shell.py panel ids). It lies folded on
   * the back (not reachable from the front view), and on the 2026-11-12 ~05:00 WIP shell it was
   * unstable under the small-steps solver (hood edges 1.6–4.3× rest in full-mesh steps).
   */
  regionFrozenPanels: [7] as readonly number[],
  /** Outer band (m) blended to the kinematic remainder. */
  regionBlendM: 0.05,
  /** Worker loop rate while live (Hz). 10 substeps each → 600 Hz substeps. */
  liveHz: 60,
  /** After release, keep stepping the region until its kinetic energy is below this (J)... */
  settleEnergy: 1e-7,
  /** ...but at least this long (s) and at most `releaseMaxS`. */
  releaseMinS: 0.6,
  releaseMaxS: 4,
  /** Tension map fade-out after release (s). */
  tensionFadeS: 1.5,

  // ---- Feel-the-fabric flow (Part D) ----
  /** Full-garment settle before grabs are enabled (s simulated; S's shells converge ≤ 0.92 s). */
  settleSeconds: 1.5,
  /** Exit "Feel the fabric" after this long with no hand in view (prompts/05 Part D). */
  noHandExitMs: 20_000,
} as const;

export type HandPullConfig = typeof HAND_PULL;

/**
 * Tension readout (prompts/06 F3). Observation only: none of these values reaches the solver.
 * "Follow" = how far the grabbed fabric has moved from where it rested at grab start, measured
 * on the solver's particles (tension.ts patchFollow). "Gap" = hand request minus that follow.
 */
export const HAND_TENSION = {
  /**
   * Taut needs the hand at least this far ahead of the fabric (m). Equal to
   * HAND_PULL.resistShowM, so the "taut" label and the amber cursor use the same threshold.
   */
  tautGapM: 0.008,
  /** Taut ends when the gap falls below this (m): hysteresis, so the label does not flicker. */
  tautExitGapM: 0.005,
  /**
   * Plateau window (s). 0.25 s = 15 solver frames at 60 Hz: longer than the driver's 10-frame
   * probe pause at the fabric limit (pullDriver HOLD_FRAMES), so one pause cannot fake a plateau.
   */
  plateauWindowS: 0.25,
  /**
   * The fabric has "stopped following" when it gained at most this much (m) over the window.
   * 1.5 mm = three of the driver's smallest reach probes (0.5 mm, pullDriver MIN_PROBE_M). With
   * the hand ≥ tautGapM ahead, fabric that is free to follow closes the gap at the driver's
   * reach growth (HAND_PULL.reachGrowth 0.6 m/s = 15 cm per window), so gaining ≤ 1.5 mm in
   * the window means the strain clamp is holding it back.
   */
  plateauGrowthM: 0.0015,

  // ---- Standard pull ("Measure" button): same pull path, fixed point and direction ----
  /**
   * Grab point, as fractions of the jacket's on-screen box: 10 % of its width right of the
   * centre (the wearer's left chest, clear of the stiff zip line) and 68 % of its height up
   * from the hem (chest), the same placement as the e2e's chest target.
   */
  standardAtX: 0.1,
  standardAtY: 0.68,
  /**
   * Requested pull (m), straight out of the jacket toward the camera (away from the body).
   * 10 cm is far beyond any accepted pull measured so far (≤ 8 cm), so the result is the
   * fabric's own limit, not the request.
   */
  standardPullM: 0.1,
  /**
   * Solver frames the pull is held (60 Hz → 1.5 s). The request reaches full size after
   * 0.1 m / 1.2 m/s ≈ 5 frames; the remaining frames show whether the fabric plateaus.
   */
  standardFrames: 90,
} as const;

export type HandTensionConfig = typeof HAND_TENSION;
