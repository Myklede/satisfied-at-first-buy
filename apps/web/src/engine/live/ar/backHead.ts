// The real head over the jacket in back views (agent F3, prompt 23; behind ?f3head=1). Pure.
//
// From behind (F1's ?f1turn=1 draws the jacket's back), the posed body's head is behind the
// jacket's hood, so the hood was drawn over the whole back of the head; the real parka's hood
// lies down on the upper back with the head above it (venue-mac-ao ≈ 108–113 s). Here the
// head's region in the picture (a capsule round the head, from the ears, else from the
// shoulders) is given back to the video where the person mask says person: the hood then shows
// only below the nape. Proportions are heuristics from head geometry: the ears sit at mid-head
// height, the head's half-width ≈ 0.62 × ear-to-ear, ≈ 0.32 × the shoulder-landmark span; the
// head centre ≈ 0.62 span above the shoulder line.
import type { ImageLandmark } from '../contract';
import type { HandCapsule } from './ArCompositor';

/** Back view: from this drawn yaw (deg) on, or when the tracker labels the back. */
export const BACK_HEAD_YAW_DEG = 110;
export const HEAD_OF_EARS = 0.62;
export const HEAD_OF_SPAN = 0.32;
export const HEAD_ABOVE_SHOULDERS_OF_SPAN = 0.62;
/** The capsule runs from 0.45 R above to 0.35 R below the head centre, radius 1.1 R. */
const UP = 0.45,
  DOWN = 0.35,
  GROW = 1.1;

export function backHeadCapsule(
  l: readonly ImageLandmark[] | null,
  backView: boolean,
  yawDeg: number,
): Omit<HandCapsule, 'depth'> | null {
  if (!l || !(backView || Math.abs(yawDeg) >= BACK_HEAD_YAW_DEG)) return null;
  const ls = l[11],
    rs = l[12],
    le = l[7],
    re = l[8];
  let cx: number, cy: number, r: number;
  if (le && re && Math.min(le.visibility, re.visibility) >= 0.3 && Math.abs(le.x - re.x) > 2) {
    cx = (le.x + re.x) / 2;
    cy = (le.y + re.y) / 2;
    r = HEAD_OF_EARS * Math.hypot(le.x - re.x, le.y - re.y);
  } else if (ls && rs && Math.min(ls.visibility, rs.visibility) >= 0.5) {
    const span = Math.hypot(ls.x - rs.x, ls.y - rs.y);
    if (span < 2) return null;
    cx = (ls.x + rs.x) / 2;
    cy = (ls.y + rs.y) / 2 - HEAD_ABOVE_SHOULDERS_OF_SPAN * span;
    r = HEAD_OF_SPAN * span;
  } else return null;
  return { a: [cx, cy - UP * r], b: [cx, cy + DOWN * r], radius: GROW * r };
}
