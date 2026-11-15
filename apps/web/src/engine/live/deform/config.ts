// Live jacket dynamics (agent V6): every constant that changes what the deformer shows, with its
// source. "Judged" = an engineering choice made by V6 for the look, not a measured value; the
// physical values come from the cloth asset's own solver config (services/body/body_service/
// config.py CLOTH_CONFIG + SHELL_CLOTH_CONFIG, the same numbers "Record a move" bakes with) and
// fall back to the values below only when an asset lacks them.
// Units: metres, seconds, kilograms (AGENTS.md §5).

export const DYNAMICS = {
  /**
   * Default state of the 'dynamics' deformer in the live preview. Labs and the kiosk override it
   * with ?dyn=0 / ?dyn=1 (or LiveTryOnDeps.dynamics). The gates (lead, prompt 14 17:45): ≤ 2 ms
   * per frame, held deviation 0, penetration ≤ 5 mm, rest jitter < 1 mm, 5 min stable, readouts
   * unchanged; measured by deform/eval (dynamicsEval.test.ts in Node, browserEval.mjs in Chrome).
   */
  defaultOn: false,

  // --- Time stepping ------------------------------------------------------------------------
  /** Fixed substep rate, independent of the camera's 14–26 fps (judged: 120 Hz keeps ω·h ≤ 0.12
   * for the stiffest pendulum below, far inside the semi-implicit Euler stability bound of 2). */
  substepHz: 120,
  /** Simulated time per frame is clamped to this many substeps (100 ms): a slower frame plays
   * the dynamics in slow motion instead of taking an unstable step. Judged. */
  maxSubstepsPerFrame: 12,
  /** Constraint sweeps per substep (edges), λ reset per substep (Macklin et al. 2019, the
   * true solver's "small steps" path). Judged: the proxy net is inextensible after 2. */
  iterations: 2,
  /** No frame for this long: the motion is not continuous, restart from the target (judged:
   * ~5 dropped frames at 14 fps). */
  stallMs: 400,
  /**
   * At rest the jacket is exactly its target (lead, ~20:30: "when the person is still the jacket
   * must be absolutely still"). Once every proxy target has moved less than restTargetTolM per
   * frame for restAfterMs, the remaining sway decays with time constant restTauMs and snaps to
   * the target below restLockSnapM; from then on the solver does not run until the target moves.
   * Judged: the pose stillness lock (livePose.ts) makes the target bit-identical at rest; 0.01 mm
   * absorbs float noise from other stages.
   */
  restAfterMs: 100,
  restTauMs: 50,
  restLockSnapM: 1e-4,
  restTargetTolM: 1e-5,
  /** A node's target moving more than this in one frame is a pose jump (a screen-fit flip, a
   * re-calibration, a replay loop): that node restarts from its target. Judged: a fast arm swing at 14 fps
   * moves the cuff ~0.1 m per frame (diag recordings: wrist p90 41 mm/frame at 17–22 fps). */
  jumpM: 0.25,
  /** More than this share of the proxy nodes jumping at once restarts the whole jacket (a
   * re-calibration, a person re-entering); fewer restarts only those nodes (an arm flip). */
  jumpGlobalShare: 0.3,

  // --- Physical parameters (fallbacks; the asset's config wins) ------------------------------
  /** m/s², CLOTH_CONFIG.gravity. Enters as the pendulum restoring stiffness g/L (below). */
  gravity: 9.81,
  /** 1/s velocity decay, SHELL_CLOTH_CONFIG.dampingPerSecond (uncalibrated there too). Applied
   * to the cloth's velocity RELATIVE to its skinned target: a jacket carried at constant speed
   * by the body is not braked by it (air drag is negligible at body speeds). */
  dampingPerSecond: 3.0,
  /**
   * Smallest damping ratio of a particle's swing about its target, so the effective damping is
   * max(dampingPerSecond, 2·ζ·ω) with ω = √(g/L). Judged: the true solver also loses energy to
   * friction against the body (CLOTH_CONFIG.friction 0.35) and contact, which this proxy has not.
   * Measured on the synthetic 6 cm hem kick (dynamics.test.ts): 3 /s alone settled below 2 mm in
   * 2.5 s; ζ 0.5 / 0.6 / 0.7 / 0.9 / 1.2 → 1.7 / 1.6 / 1.3 / 1.3 / 1.9 s (1.2 is overdamped and
   * creeps). The brief asks for ~0.5–1 s; 0.8 leaves a small overshoot.
   */
  minDampingRatio: 0.8,
  /** m/s, CLOTH_CONFIG.velocityLimit: relative-velocity trust region. */
  velocityLimit: 2.0,
  /** kg per cloth particle, CLOTH_CONFIG.particleMass (a proxy node weighs its cell). */
  particleMass: 1e-4,
  /** m/N, CLOTH_CONFIG.stretchCompliance: the proxy edges are as inextensible as the fabric. */
  stretchCompliance: 1e-8,

  // --- Coarse proxy (budget: ≤ 2 ms per frame on the main thread) --------------------------
  /** Poisson-disk spacing of the simulated proxy nodes on the jacket (judged: secondary motion
   * is a smooth field; 3.5 cm keeps ~10 nodes from the chest line to a puffer's hem). */
  proxySpacingM: 0.035,
  /** Interpolation support radius, × spacing (Wendland C2 weights over the 2-ring). Judged:
   * 1.5 keeps ~6 nodes per particle (1.8 kept ~11 for the same look, at twice the cost). */
  interpRadiusFactor: 1.5,
  /** Most proxy weights kept per cloth particle. Judged (weights fall to 0 at the radius). */
  interpMaxWeights: 8,

  // --- Max-distance map (Unity Cloth / NVIDIA APEX "max distance" coefficients) ---------------
  // Held (max distance 0, exactly the skinned target): neck, collar (panel 6), yoke (panel 3),
  // every torso row at or above the chest tape row (paths.chest: shoulders, upper chest and
  // upper back), the upper arms and elbows. Free regions grow smoothly (smoothstep, C1) from 0.
  /** Torso hem max distance = this × (chest line → hem drop), clamped to [hemMinM, hemMaxM].
   * Judged from the brief (lower hem 3–6 cm): the long parka (≈0.6 m drop) gets 6 cm, a
   * hip-length puffer (≈0.37 m) ≈4.4 cm. */
  hemPerDrop: 0.12,
  hemMinM: 0.03,
  hemMaxM: 0.06,
  /** Cuff max distance at the cuff ring, falling to 0 this far up the sleeve (brief: 1–2 cm;
   * the ramp ends below the elbow, so the elbow stays held). Judged. */
  cuffMaxM: 0.015,
  cuffRangeM: 0.12,
  /** Hood (panel 7): 0 at its seam, rising over hoodRampM of geodesic distance. Judged. */
  hoodMaxM: 0.03,
  hoodRampM: 0.2,
  /** An OPEN front edge (boundary on the front panels above the hem) gets this much more, over a
   * band of this width. The two jackets' meshes are closed at the front (zipped), so this is 0
   * for them; it only acts on an asset with a free zip edge. Judged. */
  zipBonusM: 0.01,
  zipBandM: 0.03,
  /** The zip edge lies within this of the centre-front plane (x = 0). Construction convention. */
  zipCentreM: 0.05,
  /** Max distances below this are 0 (held exactly; numerical). */
  heldBelowM: 1e-5,
  /** Displacements below this are written as exactly the target (numerical: float round-off of
   * the solver at rest is ~1e-17 m; the rest-jitter gate is 1 mm). */
  restSnapM: 1e-7,
  /** Shortest pendulum length (restoring g/L): caps the stiffness near the hold line. Judged. */
  pendulumMinM: 0.05,

  // --- Collisions -----------------------------------------------------------------------------
  /** Body anchors per moving particle: the nearest body vertices at bind + spread ones covering
   * the region it can reach (its max distance + this). Judged. */
  anchorsNear: 4,
  anchorsSpread: 4,
  anchorReachM: 0.03,
  /** A candidate whose tangent plane has the target more than this behind it is on the far side
   * of a limb and is not used (judged: LBS can sink a target a few mm; a wrist is ~5 cm thick). */
  anchorFacingM: 0.01,
  /** A particle this close to its target skips the collision tests: it can be at most this much
   * deeper than its target (gate: 5 mm). Speed setting. */
  collideSkipM: 0.002,
  /** Farthest a point of the body surface lies from its nearest vertex (judged: half the longest
   * Anny edge on the hands and arms, ~1 cm). Used by the contact budget (collide.ts). */
  skinVertexSpacingM: 0.005,
  /** The arm capsules' boxes grow by this to decide which particles test the real arm/hand skin
   * (a spread hand and thumb reach past the hand capsule). Judged. */
  armBoxMarginM: 0.04,
  /** Hood particles never move toward the body (they lie on the jacket's back panel). */
  hoodInwardM: 0,
  /** Hand capsule beyond the wrist joint, along the forearm (judged: a relaxed hand ~10 cm long
   * to the fingertips (adult ~18-19 cm) and ~9 cm across the palm; a 3 cm x 9 cm one let the hem
   * into the palm and fingers, measured 9.9 mm on
   * the 15:12 session). Conservative: it only blocks motion, never pushes a target. */
  handLengthM: 0.19,
  handRadiusM: 0.045,

  // --- Body turns (contract rootYawDeg; heading.ts) -----------------------------------------
  /**
   * Whether the engine feeds the heading to the dynamics by default (?dynyaw=1 turns it on).
   * Off: replaying the three recorded live sessions (the user facing the camera, no turn), V2's
   * drawn yaw swung the parka hem 0.5-1.1 cm on average (p95 2-3.5 cm, peaks at the 6 cm max
   * distance) against 0.1-0.3 cm without it; the span check and a 10 deg dead band cut that only
   * to 0.3-0.7 cm. On once the heading is shown quiet when the person does not turn.
   */
  headingDefaultOn: false,
  /** A heading change larger than this in one frame is a jump (front/back flip): teleport. */
  yawJumpDeg: 45,
  heading: {
    /** Landmarks used for the heading need at least this visibility (judged). */
    minVisibility: 0.5,
    /** Beyond this the single-view heading is ambiguous (side-on): null (judged). */
    maxAbsDeg: 75,
    /** Smoothing time constant, s (judged: MediaPipe world z is noisy by a few cm). */
    tauS: 0.1,
    /** Backlash: heading noise below this never moves the jacket. Judged from the recorded
     * sessions (V2's drawn yaw wanders 0-15 deg frame to frame with no turn; was 3). */
    deadBandDeg: 10,
    /** A heading whose size disagrees with the shoulder-span turn by more than this is
     * ambiguous (heading.ts plausibleHeading). Judged. */
    spanToleranceDeg: 20,
    /** One-frame changes above this are flips, ignored unless they persist this many frames. */
    spikeDeg: 40,
    spikeFrames: 4,
    /** Unknown for longer than this: the filter forgets its state. */
    holdMs: 500,
  },
} as const;

/** The dynamics' physical parameters for one asset (asset config first, fallbacks above). */
export function physicalParameters(config: Record<string, number> | undefined) {
  const c = config ?? {};
  const pick = (key: string, fallback: number) =>
    Number.isFinite(c[key]) ? (c[key] as number) : fallback;
  return {
    gravity: Math.abs(pick('gravity', -DYNAMICS.gravity)),
    dampingPerSecond: pick('dampingPerSecond', DYNAMICS.dampingPerSecond),
    velocityLimit: pick('velocityLimit', DYNAMICS.velocityLimit),
    particleMass: pick('particleMass', DYNAMICS.particleMass),
    stretchCompliance: pick('stretchCompliance', DYNAMICS.stretchCompliance),
    collisionMargin: pick('collisionMargin', 0.002),
  };
}
