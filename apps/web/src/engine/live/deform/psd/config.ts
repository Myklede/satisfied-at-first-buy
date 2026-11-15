// Pose-space correctives (agent V7) constants. Every value that changes what the jacket looks like
// has a source or is marked as an engineering choice. Units: metres, seconds, degrees unless named.
//
// What this is: the live jacket is LBS-skinned (garmentSkin.ts). Its shape does not change the way
// real cloth does with pose (no hem lift with raised arms, no folds at the elbows, sleeves that
// splay when the arms hang). The correctives are learnt offline from TRUE cloth solves of this
// body and size (the motion bake's own solver and constants, motion/bake.ts) at a few dozen key
// poses, stored per particle in its LBS local frame, and interpolated over pose at run time
// (pose-space deformation: Lewis et al., SIGGRAPH 2000; weighted per region as in Kurihara &
// Miyata, SCA 2004). No offset is sculpted by hand.

export const PSD = {
  // --- Sampling the true solver (bakeSamples.ts) --------------------------------------------
  /**
   * The motion frames are fetched at the service's 30 fps and fed to the bake at this rate (every
   * 3rd frame; bake.ts then takes 6 solver steps of the asset's dt per frame and records one).
   * Same solver, same constants, same dt: only the bake's per-frame bookkeeping (snapshot, metrics,
   * penetration probe; measured 71 ms per recorded frame vs 48 ms per solver step on this laptop)
   * runs less often. Measured on the neutral body, parka S, both arms to 100 deg then 0.6 s hold:
   * the end state differs from the 30 fps bake by 0.1 cm mean, 2.1 cm max, the same size as the
   * 30-vs-15 fps difference (0.07 / 2.0 cm), i.e. the solver's own path noise. Speed setting.
   */
  bakeFps: 10,
  /**
   * Ramp speed between two key poses, deg/s of the largest angle change: the service's validated
   * lead-in speed (motion/config.py CUSTOM_LEAD_SPEED_DEG_S = 110, reach_up_both's mean ramp), so
   * no sample moves a limb faster than a preset does (no tunnelling, subdivision.ts).
   */
  rampDegPerS: 110,
  /** Shortest ramp, s (the service's CUSTOM_LEAD_S). */
  minRampS: 0.5,
  /**
   * Hold at each key pose before its particles are recorded, s. Measured: see docs/STATUS-psd.md
   * ("settle"). Engineering choice within the bake budget.
   */
  settleS: 0.4,
  /** Longest chain (s of motion); the service accepts at most 8 s (CUSTOM_MAX_DURATION_S). */
  maxChainS: 8,
  /**
   * Bake workers in the browser. One bake worker holds about 0.2 GB (rig, SDF, cloth asset, solver;
   * Node RSS measured 236 MB for the whole process). Two halve the wait on this 6-core laptop
   * (docs/STATUS-psd.md "bake time"). Engineering choice.
   */
  workers: 2,

  // --- Pose features (features.ts) --------------------------------------------------------
  /**
   * Weight of elbow flexion against the humerus direction in the arm feature space: full flexion
   * (150 deg) counts as far as this many units of chord on the unit sphere of humerus directions
   * (2 = opposite directions). Engineering choice (fitted by leave-one-out, rbf.ts).
   */
  elbowScale: 1.0,
  /**
   * Weight of the other arm's height (−cos of its elevation) in a side's arm feature: the other
   * arm going from the stand to overhead moves the feature by ~1.9 × this. Engineering choice.
   */
  otherArmScale: 0.6,
  /** Trunk feature scales (deg per unit): twist, flexion, lateral bend. Engineering choice. */
  trunkScaleDeg: { twist: 45, flexion: 60, lateral: 30 },

  // --- Regional masks (features.ts) -----------------------------------------------------
  /**
   * Half-width (m) of the band across the body's mid-sagittal plane where the left- and right-arm
   * correctives blend (smoothstep on the neutral particle X). Outside it a particle follows only
   * its own side's arm. Engineering choice: about half a chest width each side of the zip.
   */
  maskBandM: 0.1,

  // --- Interpolation (rbf.ts, model.ts) ---------------------------------------------------
  /**
   * Gaussian RBF width (feature units). Leave-one-out (Rippa 1999) is still run over this list,
   * but with near-exact interpolation it chose the narrowest width (0.35), whose bumps sag
   * between key poses: on parka S raise-mid 2.66 cm mean vs 0.89 at 0.6, raise-low 1.74 vs 1.11,
   * front-high-bent 1.50 vs 0.73. Against 1.3, 0.6 was better on 5 of 9 hold-outs; against 0.9, on 4
   * (worse on 4). Chosen on the hold-out poses (one global number; docs/STATUS-psd.md).
   */
  sigmaCandidates: [0.6],
  /**
   * Trunk RBF widths, chosen by leave-one-out (the trunk samples are few and far apart: twist ±25,
   * lean ±12 deg; a narrow width sags between them and the stand). Feature units.
   */
  trunkSigmaCandidates: [0.6, 0.9, 1.2, 1.6, 2.0],
  /**
   * Ridge regularisation (relative to the kernel's diagonal, 1). Effectively none: the model
   * reproduces each true solve at its own pose. Measured on parka S (docs/STATUS-psd.md):
   * leave-one-out preferred λ = 0.01-0.05, but that blend of samples smeared folds (visible hem
   * tears in the frames). Against λ = 1e-6 it had an equal or larger mean error on all 9
   * hold-outs, and up to 5× more particles > 5 mm inside the body (raise-mid 349 vs 66).
   */
  lambdaCandidates: [1e-6],
  /**
   * PCA components kept of the sample offset fields (compression and run-time cost). Chosen so
   * the training samples reconstruct within PSD.pcaToleranceM (mean) or all components are kept.
   */
  maxComponents: 16,
  /** Mean reconstruction error accepted when truncating the PCA basis, m. Engineering choice. */
  pcaToleranceM: 0.0005,

  // --- Run time (PoseCorrectives.ts) ----------------------------------------------------
  /**
   * Elevation fade (lead, 2026-11-13): each side's arm correctives apply at full weight up to
   * `full` deg of that arm's shoulder elevation and fade (smoothstep) to 0 at `zero`; the trunk
   * term is not faded. Why: with the arms raised, the true solve itself sinks cloth under the
   * armpit and shoulder skin (the shoulder-ridge collapse V3 is fixing, b1), which the AR occluder
   * shows as holes in the jacket (measured: parka raise-mid 1018 px true solve vs 71 px LBS;
   * docs/STATUS-psd.md). Below the fade the correctives beat LBS without opening holes. Widen it
   * once b1 lands and the same measure passes.
   */
  fade: { full: 70, zero: 100 } as { full: number; zero: number } | null,

  /**
   * Body guard (guard.ts): a correction never moves a particle below this height over its own
   * region's skin tangent plane (or deeper than the skinned jacket had it). The solver's own
   * collision margin (asset config collisionMargin = 2 mm).
   */
  guardMarginM: 0.002,
  /**
   * The guard tests a particle only while its corrected position stays within its neutral
   * distance to its guard vertex plus this: the tangent plane describes the skin only near that
   * vertex. Without it the
   * guard pushed sleeves that the solve slid down the arm out along a stale plane (crinkled
   * sleeves, a tear at the front waist; measured, docs/STATUS-psd.md "body guard").
   */
  guardRadiusM: 0.03,
  /**
   * The guard's skin search runs only for particles whose correction heads into the skin past
   * (neutral clearance − margin − this) along their own skin normal; the rest move outward or
   * along the body. Speed setting (measured: same holes and penetrations, docs/STATUS-psd.md).
   */
  guardSlackM: 0.03,
  /** Fade-in once the correctives are ready (ms), so the jacket never jumps. Engineering choice. */
  fadeInMs: 600,
  /**
   * Product styles the correctives are ON for by default (lead, 2026-11-13). A style is listed
   * only when it passes the default-ON gates on every hold-out (holes ≤ LBS + 100 px or ≤ 1.5×
   * LBS, > 5 mm inside ≤ LBS, shape error ≤ LBS, ≤ 2 ms per frame). FB7675-100 (parka): passes on
   * all 10 hold-outs, commit d7e05c5 (docs/STATUS-psd.md "Round 5"). DQ4920-206 (puffer): blocked
   * by hug-wide (182 hole px vs LBS 16: its thick sleeves push each other's cuffs back where the
   * forearms meet). `?psd=0` turns it off and `?psd=1` on for every product (labs).
   */
  // Prompt17b live gate: observed cam-parka PSD holes17px vs LBS0 at2s
  // fails the literal >1.5x gate. Keep opt-in pending a complete passing live check.
  defaultOnStyles: [] as readonly string[],
} as const;

/** Cache key version: bump whenever the sampling or the model changes. */
export const PSD_VERSION = 'psd-v1';
