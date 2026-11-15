// Move timestamps of the user's phone videos (docs/look/video-index.md, read by eye, ±1 s).
// Buttons in the lab, and the evaluation's sample times (several per move where the index
// gives a range). Times are in seconds of the video.

/** One jump button per move. */
export const MOVES: Record<string, [string, number][]> = {
  'video-parka.mp4': [
    ['neutral', 4],
    ['turn ¾', 33],
    ['side', 34.5],
    ['back', 36.5],
    ['reach up both', 48.5],
    ['reach up one', 54],
    ['cross arms', 67],
    ['sit', 74],
    ['bend', 82],
    ['reach fwd (side)', 180],
  ],
  'video-puffer.mp4': [
    ['neutral', 16],
    ['turn ¾', 23.5],
    ['side', 25.5],
    ['back', 29],
    ['reach up both', 48],
    ['reach up one', 54],
    ['cross arms', 68],
    ['sit', 76],
    ['bend', 83],
    ['reach fwd (side)', 184],
  ],
};

export type EvalMove =
  | 'neutral'
  | 'turn'
  | 'reach_up_both'
  | 'reach_up_one'
  | 'cross_arms'
  | 'sit'
  | 'bend'
  | 'reach_forward';

/** Evaluation samples per video: the move and the times inside its range in the index. */
export const EVAL_SAMPLES: Record<string, { calibrateAt: number; moves: [EvalMove, number[]][] }> =
  {
    'video-parka.mp4': {
      calibrateAt: 4,
      moves: [
        ['neutral', [3, 5, 6, 12.5, 26, 31]],
        ['turn', [33, 34.5, 36.5, 40, 42]],
        ['reach_up_both', [47.5, 48.5, 49.5, 63]],
        ['reach_up_one', [53.5, 54.5, 57.5]],
        ['cross_arms', [66.5, 67.5]],
        ['sit', [72, 74, 76]],
        ['bend', [81, 83]],
        ['reach_forward', [108, 109, 180, 182]],
      ],
    },
    'video-puffer.mp4': {
      calibrateAt: 16,
      moves: [
        ['neutral', [14, 16, 18, 20, 38, 41]],
        ['turn', [23.5, 25.5, 29, 33, 35.5]],
        ['reach_up_both', [47, 48, 49, 208]],
        ['reach_up_one', [53, 55, 61, 63]],
        ['cross_arms', [66, 68, 70]],
        ['sit', [74, 76, 78]],
        ['bend', [82, 84]],
        ['reach_forward', [109, 112, 183, 185]],
      ],
    },
  };
