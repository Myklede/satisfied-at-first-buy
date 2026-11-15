// "Record a move" (agent V3) constants. Every value that changes a number shown to the user has
// a source or is marked as an engineering choice. Times in ms (LiveFrame.t) unless named _s.

// The confidence threshold is the live preview's own (livePose.MIN_DOF_CONFIDENCE, used by
// recordedPoses.ts), so the physics replay moves exactly the DOFs the user saw moving live.
export const RECORD = {
  /**
   * A DOF is used for the bake only when it is estimated in at least this share of the tracked
   * frames of the recording. Otherwise it is held at the body's neutral value for the whole move:
   * swapping between the measured and the neutral value frame by frame would make the limb jump,
   * which the cloth would feel as a jerk. Engineering choice.
   */
  keepShare: 0.8,
  /**
   * Longest stretch (ms) without a usable sample that the server's smoothstep interpolation may
   * bridge (6 frames at 30 fps). A DOF with a longer low-confidence run is held at neutral; a
   * longer stretch with no usable sample at all fails the recording. Engineering choice.
   */
  maxGapMs: 200,
  /**
   * Fastest plausible joint motion between two tracked samples, deg/s: the arm (angle between
   * humerus directions, so plane flips near gimbal lock do not count), elbows and trunk. The
   * vision package documents fast arm raises at 200-400 deg/s (POSE_FILTER_PARAMS); this is 2.5x
   * the fastest of those. A faster jump is the tracker losing a limb, measured on the user's video:
   * the left arm read 128 -> 23 deg in 0.1 s while the arm stayed overhead (up to 1819 deg/s).
   * Engineering choice.
   */
  maxJointSpeedDegS: 1000,
  /** Longest recording the body service accepts (motion/config.py CUSTOM_MAX_DURATION_S). */
  maxDurationMs: 8000,
  /** Nominal input rate range of the service (motion/config.py CUSTOM_FPS_RANGE). */
  fpsRange: [1, 60] as const,
  /**
   * A zone counts as restricted when its share of edges at the stretch limit rises by more than
   * this over the neutral frame: the same 2 % that metrics.summarySentence uses for "fabric at
   * its limit across the …".
   */
  restrictedShareRise: 0.02,
} as const;
