// Constants of the interactive zip and detachable hood (agent Z). One place for every number
// that changes what the judge sees; each carries its source or says it is a UX/numerical choice.
/**
 * How the puffer's detachable hood starts when a judge opens Feel the fabric (user's choice,
 * pending; lead 2026-11-13):
 *  - 'attached': on the collar (the measured shell);
 *  - 'off-resting': taken off and standing on the floor beside the right foot (H's
 *    restingTransform), for the judge to pick up and zip onto the collar.
 * Only the Feel screen's interaction shows it: the result screen, X-ray and size switches always
 * show the measured shell with the hood on, and the fit numbers never change. Every new Feel
 * session (and a kiosk reset) starts from this value again.
 */
export type HoodDefault = 'attached' | 'off-resting';
export const HOOD_DEFAULT: HoodDefault = 'attached';

export const INTERACT = {
  /** Slider travel past the last pair (m): the separating pin leaves the box (numerical). */
  zipEndM: 0.002,
  /** A slider let go this close (m) to the collar top or the hem runs to that stop (UX). */
  snapM: 0.04,
  /**
   * Open fronts: fraction of the way from the worn (constructed) hinge rest to the flat pattern
   * piece (lead's direction 2026-11-13: fabric's natural bending state is flat). 1 = fully flat;
   * the padding's own stiffness stays in the hinge compliance. Not measured against a real
   * jacket.
   */
  frontFlatFraction: 1,
  /**
   * Panel-scale bending of an open front: rows held at their flat length over this span (m of
   * material arc; ~ the chest's curve, numerical) with this correction per substep (0..1; a
   * compliant pull, so gravity and contact still win where they must; numerical, tuned for
   * settling within ~1.5 s without flapping).
   */
  frontFlatSpanM: 0.1,
  frontFlatStiffness: 0.05,
  /** Band (m of arc from the zip) of each open front kept on its own side of the midline. */
  frontEdgeBandM: 0.06,
  /** Blend time (s) of that rest change when the zip opens / closes (no snap, numerical). */
  frontFlatBlendS: 0.5,
  /** Slider speed limit (m/s along the zip): a fast or glitched hand never rips the zip (UX). */
  sliderSpeed: 1.2,
  /** Cursor → slider search window (m of zip arc) around the current slider (continuity, UX). */
  sliderWindowM: 0.25,
  /**
   * Largest approach per substep (m) of two separated teeth while the slider closes them
   * (600 Hz substeps → 1.2 m/s, the same speed limit as the hand target in HAND_PULL).
   */
  weldStepM: 0.002,
  /**
   * Moving region of the interaction solver: particles within this distance (m) of the zip
   * line or the hood run; farther cloth (back, sleeves) stays where it is. 0.30 m reaches the
   * side seams of the fronts (front panel arc ≤ 0.33 m on the 172 cm reference, fixture).
   */
  regionRadiusM: 0.3,
  /** Outer band of the region blended into the static remainder (m), as HAND_PULL. */
  regionBlendM: 0.06,
  /** Hood: hand travel (m) before its zip starts to open (fabric slack, UX). */
  hoodSlackM: 0.02,
  /** Hood: further hand travel (m) that opens its whole zip (UX; ~ the hood's depth). */
  hoodTravelM: 0.16,
  /**
   * The hood zip's frontier runs this arc (m) past the line's end at full progress, so the last
   * teeth open smoothly (numerical).
   */
  hoodPeelM: 0.06,
  /**
   * Hood peel width as a fraction of the seam (agent H's HOOD.peelWidth, 0.35, contract in
   * docs/requests/H-to-Z.md): the teeth's open/closed boundary follows H's frontier.
   */
  hoodPeelWidth: 0.35,
  /**
   * Semi-rigid hood: over the last fraction of the unzip progress its turn about the frontier
   * blends into a plain translation with the hand (continuity, numerical).
   */
  hoodFreeBlend: 0.3,
  /**
   * A hood let go fully off is set down beside the jacket (lead's UX direction 2026-11-13, not
   * physics): its centre this far (m) outside the jacket's widest point (sleeves included), this
   * far above the hem, eased in with this time constant (s).
   */
  hoodRestSideM: 0.2,
  hoodRestAboveHemM: 0.15,
  hoodRestTauS: 0.18,
  /** A hood let go within this fraction of off / on finishes coming off / zipping on (UX). */
  hoodSnap: 0.15,
  /** Bringing a hood back: let go within this fraction of on, it zips on (UX). */
  hoodAttachSnap: 0.5,
  /** Largest hood offset (m) from its place on the collar (safety; covers the resting place). */
  hoodMaxReachM: 1.0,
  /**
   * Held cloth (hood, open front) may stretch the region's shell edges to at most
   * max(stretchMax, their state at grab start) + this (ratio points). Beyond it the held patch
   * stops following the hand (it "slips"), like the hand pull's clamp (HAND_PULL.strainMargin 0.02
   * on the patch border; here region-wide, so a little wider).
   */
  grabStrainMargin: 0.03,
  /**
   * Held core of a grab patch: particles whose patch weight is at least this fraction of the
   * centre's (HAND_PULL patch fall-off 1 → 0.35 over 3 cm: 0.75 ≈ the inner 1.5 cm).
   */
  grabCoreWeight: 0.75,
  /** Hood grab target speed limit (m/s), as HAND_PULL.maxTargetSpeed. */
  hoodTargetSpeed: 1.2,
  /** Hood grab patch radius (m), as HAND_PULL.patchRadiusM. */
  hoodPatchM: 0.03,
  /**
   * After the zip closes fully (and the hood is on), the interaction solver keeps running
   * until no particle moves more than `settleMotionM` (m, L1 per frame) for `settleMinS`, or
   * `settleMaxS` (s) have passed, then
   * the view returns to the measured shell (the original solver) over `restoreBlendS`. The
   * blend is a visual cross-fade between two simulated states, not physics.
   */
  settleMotionM: 1e-4,
  settleMinS: 0.4,
  settleMaxS: 2.5,
  restoreBlendS: 0.3,
  /**
   * Hood view: camera distance × the front framing's. The orbit keeps looking at the jacket's
   * centre (the kiosk's orbit target), so the feet and the floor beside them come into view only
   * from ~2.8× (half-height 0.41 m at 1× vs 1.15 m from the centre down to the floor): a
   * full-body view (UX).
   */
  hoodViewZoom: 2.9,
  /** A hood taken off is set down on the floor this far (m) outside the right foot (UX). */
  hoodFloorSideM: 0.25,
  /** Eased drop of the hood to its resting pose (s), UX. */
  hoodDropS: 0.6,
  /** Hover glow / grab pick radius around the zip pull (px), UX. */
  pullPickPx: 30,
} as const;
