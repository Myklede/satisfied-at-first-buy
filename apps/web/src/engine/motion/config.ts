// Fit-in-motion (P2) constants. Every value that changes a number shown to the user has a
// source or is marked as an uncalibrated engineering choice. Units: metres / seconds unless
// the name says cm.

export const MOTION_FIT = {
  // --- Articulated collider ---------------------------------------------------------------
  /** Rings of arm skin added around each elbow zone (prompt 07 D2, variant E5; 0 = P1's zone).
   * Engineering choice, measured on the fixture (docs/STATUS-kiosk.md "D2"): cross_arms worst
   * shell edge 3.00 -> 2.10; accepted by the lead with +0.1/+0.2 cm crease penetration. */
  elbowZoneRings: 3,
  /** Arm skin = upper-arm + forearm weight at least this (anatomical majority). */
  armZoneWeightMin: 0.5,
  /** Zone-triangle grid cell (m). ≈ 2× the Anny edge length (~1 cm); a speed setting only,
   * the zone query stays exact within its search radius. */
  zoneCellM: 0.02,
  /** Largest zone search radius (m). Equals P1's segment grid padding (SDF_PADDING_M = 6 cm):
   * beyond it the rigid grids already return upper bounds only. */
  zoneSearchMaxM: 0.06,
  /** Extra zone search beyond the solver's contact threshold (m), so slack values near the
   * threshold stay exact. Speed setting. */
  zoneSearchMarginM: 0.01,
  /** Linearised per-frame query cache: a repeat query within this distance of a cached exact
   * query returns d0 + ∇d0·Δ. Error ≈ |Δ|²·curvature/2 (< 0.05 mm on ≥ 1 cm radii) except at
   * a rigid/zone switch, where it is bounded by 2|Δ| = 2 mm. Speed setting (the solver
   * re-queries each contact particle in all 10 substeps of a step while the body is fixed). */
  cacheRadiusM: 0.001,

  // --- Solver settings for motion bakes (merged over the asset's shell cloth config) ---------
  // Measured on reach_up_both / cross_arms (agent S2, docs/STATUS.md "Cloth physics pass 2"):
  // with the static-relax settings a raised arm drove edges to 2.7–6.2× because (1) the hinge
  // bending (1e-3 m/N, as stiff as stretch) kept the wrapped shape and (2) the hard body
  // projection ran last, so where the garment is too small for the posed body (the S bicep has
  // −0.2 cm inner ease) contact won over the fabric limit every substep.
  solver: {
    /** m/N, cross-edge bending: soft enough that the cap and armhole can change shape when the
     * arm rises (uncalibrated; static relax keeps the asset's stiffer 1e-3). */
    hingeCompliance: 1,
    /** m/N per particle, compliant body contact above the hard floor (uncalibrated: lets the
     * lining sink into soft tissue/fill where the jacket is tight instead of stretching it).
     * Measured: 1 m/N let the forearm slide out of the sleeve in cross_arms (cuff 28–38 cm
     * from the wrist); 0.3 keeps it on (12–16 cm) with a little more strain on reach_up. */
    contactCompliance: 0.3,
    /** m from the skin: the cloth mid-surface never goes deeper than 4 mm into the body. */
    contactHardMin: -0.004,
    /** Hard strain-limit passes after contact each substep (fabric limit wins; numerical). */
    finalStrainPasses: 16,
    /** m, per-particle tangent-plane reuse of the exact articulated distance within a step
     * (error ≈ |Δ|²·curvature/2 < 0.5 mm; speed setting, measured: 1 cm was worse). */
    contactPlaneRadius: 0.005,
    /** Elastic rib bands (cuffs, hem) keep hard contact: a compliant cuff let the hand slip out
     * of the sleeve in cross_arms (measured: cuff ring 50 cm from the wrist). */
    contactHardElastic: 1,
    /** Root anchors hold the yoke from below only: raised arms may lift the shoulders of the
     * jacket (measured: front hem rise 1–3 cm → ~8 cm on reach_up_both S). */
    rootLiftFree: 1,
  },

  // --- Bake ---------------------------------------------------------------------------------
  /** Quiet relax on the frame-0 body before the motion starts (s of simulated time). Agent S
   * measured the shell reaching the kinetic threshold in 0.9 s (docs/STATUS.md). */
  relaxMaxSeconds: 1.0,
  /** Stop the relax early once at least this long and below the asset's kineticEpsilon. */
  relaxMinSeconds: 0.3,
  /** Rebuild the cloth-on-cloth layer pairs every this many motion frames (ClothSolver doc:
   * "call again once the cloth has moved far from the state the pairs were built in").
   * 0.33 s at 30 fps (was 6: the rebuild cost 7 ms per step amortised); engineering choice. */
  layerPairEveryFrames: 10,
  /** Penetration check (BakeChecks) on every this-many-th frame; validation only, speed. */
  penetrationEveryFrames: 3,
  /** Cloth root anchors bind only to skin whose upper-arm + forearm weight is below this
   * (engineering choice: the jacket hangs on the trunk and shoulder girdle, not the arm). */
  rootArmWeightMax: 0.2,
  /**
   * Armhole stop (cloth/armholeStop.ts, motion/armhole.ts): the underarm seam cannot slide toward
   * the shoulder past the armpit, so a raised upper arm carries the armhole and the coat. Source:
   * the user's own parka video (docs/STATUS-tryon-physics.md, "Hem lift"): arms overhead lift the
   * hem ~23 cm and the collar ~9 cm; without a stop the simulated hem rises ~7 cm, the yoke ~1 cm.
   * enabled: 0 = OFF. Measured on reach_up_both (user body, parka S): ON lifts the hem 17-21 cm,
   * but the peak edge strain rises (armpit 1.8-2.7 vs 1.39 off) and, with the default soft
   * contact, more cloth sinks into the armpit (share 1 % vs 0.1 %), so it fails the lead's gates.
   * Candidate settings below; turn on only with the gates re-measured.
   * bandM: the armhole's underarm part, seam points within 5 cm of its lowest point (engineering
   * choice: below the shoulder joint, where the axilla meets the seam).
   * armWeightMin: anchors ride on skin that is mostly upper arm (anatomical majority, as
   * armZoneWeightMin). stiffness 0.3: a compliant stop (a third of the violation per substep)
   * shares the lift with the fabric (hard: strain 2.7). direction 'anchor': move toward the
   * arm-carried rest point (outside the body), not along the axis.
   */
  armholeStop: {
    enabled: 0 as 0 | 1,
    bandM: 0.05,
    armWeightMin: 0.5,
    stiffness: 0.3,
    direction: 'anchor' as 'axis' | 'anchor',
    /**
     * 1 = long-range attachments from the stop points (Kim, Chentanez & Muller 2012, LRA): body
     * panels below the armhole and the sleeves stay within their rest geodesic distance of the
     * nearest stop point x the fabric's stretchMax, so the lift reaches the whole panel in one
     * pass instead of over-stretching the underarm.
     */
    lra: 1,
  },

  // --- Metrics -----------------------------------------------------------------------------
  /** Strain counted as "fabric at its limit": within this much of the edge's stretch limit
   * (asset config stretchMax / elasticStretchMax, both uncalibrated). Solver limit
   * enforcement is approximate, so 0.2 % of slack below the limit is still "at the limit". */
  strainLimitSlack: 0.002,
  /** Zone radii (m) for naming where fabric is at its limit, measured from body landmarks at
   * frame 0 (elbow, armpit, acromion). Engineering choice: roughly half a forearm width. */
  zoneRadiusM: 0.08,
  /** Exposed gaps below this (cm) are reported as covered (0). Numerical floor: the hem is
   * a 1–2 cm polyline sampled against a ring point, so smaller values are noise. */
  exposureFloorCm: 0.3,
  /** A wrist counts as uncovered once the cuff edge is above the wrist landmark by more
   * than this (cm). Same numerical floor as above. */
  wristFloorCm: 0.3,
  /** Exposed-skin highlight: a torso vertex is exposed when the hem lies above it along the
   * local torso "up" by more than this (m). Numerical floor (hem polyline sampling). */
  exposedVertexMarginM: 0.003,
  /** Hem points further than this (m) from the vertical line through a ring point are not
   * used for that ring point (the hem has left that side of the body). */
  hemLineMaxM: 0.12,
} as const;

export const WAISTBANDS = ['low', 'mid', 'high'] as const;
export type Waistband = (typeof WAISTBANDS)[number];
/** Motion contract: waistband default mid (approved by the user 2026-11-12). */
export const DEFAULT_WAISTBAND: Waistband = 'mid';

/** Contract motion ids (prompts/motion-contract.md), in UI order. */
export const MOTION_IDS = [
  'reach_up_both',
  'reach_up_one',
  'reach_forward',
  'sit',
  'bend_tie_shoes',
  'cross_arms',
] as const;
export type MotionId = (typeof MOTION_IDS)[number];

/** Kiosk background precompute of the motions (BakeQueue.ts). */
export const MOTION_CACHE = {
  /** Cap on the bytes of cached bakes (cloth positions + strain + exposure) across both jackets.
   * Measured 2026-11-12 (agent E2, docs/STATUS-kiosk.md "E2"): a bake is 14-20 MB (mean 16 MB;
   * 22 bakes = 351 MB), so all 24 (2 jackets x 2 sizes x 6 motions) are about 385 MB. 420 MB
   * lets the queue (which stops when one more largest bake would not fit) finish all 24, and a
   * longer session evict the least recently used bakes (a click bakes an evicted one again).
   * Chrome's working set was 1.4 GB with no bakes and 1.6 GB with 22 cached. */
  capBytes: 420e6,
} as const;
