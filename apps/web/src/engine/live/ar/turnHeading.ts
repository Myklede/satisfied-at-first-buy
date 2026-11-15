// Full-turn heading for the AR overlay (agent F1, prompt 23a; defect atlas D1/D2: the jacket faded
// to a ghost at the side view and was hidden on the back). Pure, no DOM.
//
// Venue trace (venue-khong-ao, F1 probe 2026-11-14, ?f1turn off): MediaPipe's world-landmark yaw
// (ArTracker.yawFromWorld) is continuous through a whole turn: 9 → −60 → 0 → +67 → 88 → 117 → 142
// → 163 → −177 → −170 → −143 → −117 → −86 → −61°, and its left/right labels stay consistent past
// the side view (the 2D shoulder order flips to −1 and the nose sits 0.06–0.18 m behind the
// shoulders on the back). The 2D solve under-reads a turned body (−45…−51° at world −60°, image
// shoulder span 0.36 of frontal ⇒ ≈ 69°) and lands 15–25° off the back (−151…−157° vs −170°).
// Near facing the opposite holds: the world yaw is biased (+5…+9° on a facing person) and noisy,
// while the solve with its frontal pin and deadband is still (the user's "rotating back and forth"
// complaint). So:
//   |world| ≤ blendFromDeg: the front-hemisphere solve yaw (unchanged behaviour);
//   |world| ≥ blendToDeg, or the back hemisphere: the world yaw;
//   in between: a smoothstep blend of the two (no step at the hand-over).
// The front solve is first kept within agreeDeg of the world yaw (arms up / crossed: the solve
// read 15–37° while the world yaw and the video showed facing).
// A one-frame world jump beyond maxJumpDeg (a MediaPipe label flip) is held for up to persistMs
// unless the 2D back-view detector agrees with the new hemisphere.
import { wrapAngle } from './cameraModel';

export interface TurnParams {
  blendFromDeg: number;
  blendToDeg: number;
  maxJumpDeg: number;
  persistMs: number;
  /** The front yaw is kept within this of the world yaw (deg): a mis-posed solve cannot turn it. */
  agreeDeg: number;
}

const DEG = Math.PI / 180;

export class TurnHeading {
  private last?: number;
  private lastT?: number;
  private jumpSince?: number;
  /** Lab readout of the last frame: inputs and the blend weight. */
  debug: { front: number; world: number | null; weight: number; held: boolean } | null = null;

  /**
   * ?f1yawfast (agent F1b, RESULT 3): a jump beyond maxJumpDeg that stays in the same hemisphere is
   * held for persistMs whatever the back-view detector says. The detector tells front from back,
   * not left from right: live5 look job 3b81cd 44.50 s, MediaPipe's world yaw mirrored on the back
   * (+112 -> -115 deg, both back views) was accepted and drew the jacket mirrored for one frame,
   * then the yaw filter smeared it into a straight-back frame (173 deg) on a body in profile.
   */
  flipGuard = false;

  constructor(readonly params: TurnParams) {}

  reset() {
    this.last = this.lastT = this.jumpSince = undefined;
    this.debug = null;
  }

  /** The previous heading (rad), if any. */
  get previous(): number | undefined {
    return this.last;
  }

  /**
   * One frame. `front` = the front-hemisphere yaw the tracker would draw (rad, |front| ≤ π/2);
   * `world` = MediaPipe's world-landmark yaw (rad, full circle) or null; `backView` = the 2D
   * back-view detector. Returns the heading to draw (rad, (−π, π]).
   */
  update(t: number, front: number, world: number | null, backView: boolean): number {
    const P = this.params;
    if (this.lastT !== undefined && (t < this.lastT || t - this.lastT > 1000)) this.reset();
    this.lastT = t;
    let w = world === null ? null : wrapAngle(world);
    let held = false;
    if (w !== null && this.last !== undefined) {
      if (Math.abs(wrapAngle(w - this.last)) > P.maxJumpDeg * DEG) {
        const toBack = Math.abs(w) > Math.PI / 2;
        const agrees = backView === toBack;
        // A jump that lands in the other hemisphere is a MediaPipe left/right flip unless the 2D
        // back-view detector agrees: never accepted by persistence alone (the jacket's back on a
        // person who faces the camera is the worst error). A real turn passes the side view in
        // steps below maxJumpDeg and never needs this.
        const otherHemisphere = toBack !== Math.abs(this.last) > Math.PI / 2;
        this.jumpSince ??= t;
        const recent = t - this.jumpSince < P.persistMs;
        const hold = otherHemisphere ? !agrees : (this.flipGuard || !agrees) && recent;
        if (hold) {
          w = this.last;
          held = true;
        } else this.jumpSince = undefined;
      } else this.jumpSince = undefined;
    }
    let h: number;
    let weight = 0;
    if (w === null) {
      // No world landmarks: the front yaw, mirrored onto the back while the detector says so.
      h = backView ? wrapAngle((front >= 0 ? Math.PI : -Math.PI) - front) : front;
      weight = backView ? 1 : 0;
    } else if (backView || Math.abs(w) >= Math.PI / 2) {
      h = w;
      weight = 1;
    } else {
      // A solve that disagrees with a facing world yaw (raised or crossed arms the rig has not
      // matched) is pulled to within agreeDeg of it before the blend.
      const a = P.agreeDeg * DEG;
      const f = w + Math.max(-a, Math.min(a, wrapAngle(front - w)));
      const x = Math.min(
        1,
        Math.max(0, (Math.abs(w) / DEG - P.blendFromDeg) / (P.blendToDeg - P.blendFromDeg)),
      );
      weight = x * x * (3 - 2 * x);
      h = wrapAngle(f + weight * wrapAngle(w - f));
    }
    this.last = h;
    this.debug = { front, world: w, weight, held };
    return h;
  }
}
