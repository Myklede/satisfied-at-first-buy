// R (prompt 33): the mouse wheel (or a trackpad pinch) on the Fit Lab panel drives one value,
// reveal 0..1: 0 = full-body framing and the product look, 1 = the closer framing, see-through.
// The camera keeps the user's orbit direction; only its target and distance follow the reveal.
// Double-click returns to the Look. prefers-reduced-motion: no easing, the camera jumps.
// CS (CT stage): the wheel keeps going past reveal 1 into ctPhase 0..1 (one eased value 0..2:
// reveal = min(1, v), ctPhase = max(0, v - 1)). v2 (user's spec): as ctPhase rises the camera
// turns smoothly to the viewer's right (CT_STAGE.azimuth) with a slight elevation (CT_STAGE.polar)
// and aims between the body and the CT layer stack beside it; wheel-up lowers ctPhase first
// (the turn reverses exactly), then the reveal. Double-click resets both (back to the Look).
import { Vector3 } from 'three';
import type { ScrollReveal, ScrollRevealOptions } from './types';

/** Wheel feel (look conventions). */
export const SCROLL_REVEAL = {
  /** Reveal per wheel pixel: a 100 px mouse notch = 0.14, about 7 notches from Look to see-through. */
  perPixel: 0.0014,
  /** Trackpad pinch (Chrome sends ctrl+wheel with small deltas): gain over a plain wheel. */
  pinchGain: 4,
  /** Easing rate toward the wheel's goal (1/s): ~95 % in 0.25 s. */
  rate: 12,
  /** Below this the eased value snaps to the goal. */
  snap: 0.002,
} as const;

/** Reveal change for one wheel event (pure; tested). Wheel forward / pinch out = closer. */
export function wheelStep(e: Pick<WheelEvent, 'deltaY' | 'deltaMode' | 'ctrlKey'>): number {
  const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1; // lines / pages -> px
  const px = Math.max(-400, Math.min(400, e.deltaY * scale));
  return -px * SCROLL_REVEAL.perPixel * (e.ctrlKey ? SCROLL_REVEAL.pinchGain : 1);
}

/** Notched wheel (user, 06:25): exactly 3 mouse notches from the Look to the see-through, a
 *  detent there (a fast spin cannot skip the X-ray), then 3 more notches into the CT stage.
 *  Trackpads (small deltas) accumulate pixels into notches. */
export const WHEEL_NOTCH = {
  perStage: 3,
  /** |deltaY| (px) at or above this is one mouse notch, whatever its size. */
  mousePx: 40,
  /** Accumulated small deltas (trackpad / pinch) per notch. */
  trackpadPx: 120,
  /** A free-spinning wheel fires many events: at most one notch per this many ms. */
  minGapMs: 90,
  /** After arriving at the see-through, further notches the same way wait this long. */
  detentMs: 450,
} as const;

/** Next goal for one notch (pure; tested): snaps to the 1/perStage grid, never crosses the
 *  see-through (1) in one notch, clamped to [0, max]. */
export function notchedGoal(goal: number, dir: 1 | -1, max: number): number {
  const n = WHEEL_NOTCH.perStage;
  let next = Math.round((goal + dir / n) * n) / n;
  if ((goal < 1 && next > 1) || (goal > 1 && next < 1)) next = 1;
  return Math.min(max, Math.max(0, next));
}

/** CT stage camera (CS). */
export const CT_STAGE = {
  /** Polar angle (rad from +Y) at ctPhase 1: 70 deg = 20 deg above horizontal. */
  polar: (70 * Math.PI) / 180,
  /** Turn to the viewer's right at ctPhase 1 (rad, added to the azimuth at entry). */
  azimuth: (60 * Math.PI) / 180,
  /** Camera distance at ctPhase 1 relative to the close framing's (body + stack in view). */
  distanceScale: 1.45,
} as const;

/** Split the wheel's 0..2 value into reveal and ctPhase (pure; tested). */
export function splitStage(v: number): { reveal: number; ct: number } {
  const u = Math.min(2, Math.max(0, Number.isFinite(v) ? v : 0));
  return { reveal: Math.min(1, u), ct: Math.max(0, u - 1) };
}

/** Smoothstep easing of the CT phase for the camera path. */
export function easeCt(p: number) {
  const u = Math.min(1, Math.max(0, p));
  return u * u * (3 - 2 * u);
}

/**
 * Polar after the CT phase moves from p0 to p1 (pure; tested): moves the current polar toward
 * the CT polar (phase rising) or back toward `base` (phase falling) in proportion to the eased
 * phase still to go, so a drag made inside the CT stage is kept and the ends are exact.
 */
export function ctPolarStep(
  cur: number,
  base: number,
  p0: number,
  p1: number,
  ct = CT_STAGE.polar,
) {
  const a = easeCt(p0),
    b = easeCt(p1);
  if (b === a) return cur;
  if (b > a) return b >= 1 ? ct : cur + (ct - cur) * ((b - a) / (1 - a));
  return b <= 0 ? base : cur + (base - cur) * ((a - b) / a);
}

/** Shortest signed turn from azimuth a to b (rad), in (-PI, PI]. */
function shortestTurn(a: number, b: number) {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

export type Framing = ReturnType<ScrollRevealOptions['framing']>;

/** Camera target and distance at reveal t: centre lerped, distance interpolated in log space. */
export function framingAt(t: number, f: Framing, out = new Vector3()) {
  const u = Math.min(1, Math.max(0, t));
  out.lerpVectors(f.fullBodyCenter, f.closeCenter, u);
  const a = Math.max(1e-3, f.fullBodyDistance),
    b = Math.max(1e-3, f.closeDistance);
  return { center: out, distance: Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * u) };
}

/** Orbit controls the camera follows (OrbitControls: Viewer.controls). Optional but recommended:
 *  without it the camera is aimed with lookAt, which OrbitControls.update would undo. */
export interface RevealControls {
  target: Vector3;
  update(): unknown;
}

/** CS: CT-stage options (all optional; without them the wheel stops at reveal 1 as before). */
export interface CtStageOptions {
  /** Enable the CT stage past reveal 1. */
  ctStage?: boolean;
  /** World point the CT camera aims at (slice centre at slice height), null = close framing. */
  ctAim?: () => { x: number; y: number; z: number } | null;
  /** Called with ctPhase BEFORE the camera is placed (relax the orbit's polar clamp here). */
  onCtPhase?: (phase: number) => void;
}

export function createScrollReveal(
  opts: ScrollRevealOptions & { controls?: RevealControls } & CtStageOptions,
): ScrollReveal & { ctPhase(): number } {
  const { element, camera, controls } = opts;
  let value = 0;
  let goal = 0;
  let raf = 0;
  let last = 0;
  let disposed = false;
  const lastCenter = new Vector3();
  let hasCenter = false;
  const centre = new Vector3();
  const dir = new Vector3();
  const reduced = () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const max = opts.ctStage ? 2 : 1;
  let lastCt = 0;
  let basePolar = Math.PI / 2;
  let baseAz = 0;
  const aim = new Vector3();

  const place = () => {
    const { reveal, ct } = splitStage(value);
    opts.onCtPhase?.(ct);
    const framed = framingAt(reveal, opts.framing(), centre);
    const center = framed.center;
    let distance = framed.distance;
    const from = controls ? controls.target : hasCenter ? lastCenter : center;
    dir.subVectors(camera.position, from);
    if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1);
    dir.normalize();
    if (ct > 0 || lastCt > 0) {
      const e = easeCt(ct);
      const at = opts.ctAim?.();
      if (at) center.lerp(aim.set(at.x, at.y, at.z), e);
      distance *= 1 + (CT_STAGE.distanceScale - 1) * e;
      // Tilt: keep the azimuth, move the polar (rad from +Y).
      const polar = Math.acos(Math.min(1, Math.max(-1, dir.y)));
      const azNow = Math.atan2(dir.x, dir.z);
      if (lastCt === 0) {
        basePolar = polar;
        baseAz = azNow;
      }
      // Azimuth unwrapped around the entry azimuth, so the turn never takes the long way.
      const azRel = baseAz + shortestTurn(baseAz, azNow);
      const next = ctPolarStep(polar, basePolar, lastCt, ct);
      const az = ctPolarStep(azRel, baseAz, lastCt, ct, baseAz + CT_STAGE.azimuth);
      dir.set(Math.sin(next) * Math.sin(az), Math.cos(next), Math.sin(next) * Math.cos(az));
    }
    lastCt = ct;
    camera.position.copy(center).addScaledVector(dir, distance);
    lastCenter.copy(center);
    hasCenter = true;
    if (controls) {
      controls.target.copy(center);
      controls.update();
    } else camera.lookAt(center);
    opts.onReveal(reveal);
  };

  const tick = (now: number) => {
    raf = 0;
    if (disposed) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    value += (goal - value) * (1 - Math.exp(-SCROLL_REVEAL.rate * dt));
    if (Math.abs(goal - value) < SCROLL_REVEAL.snap) value = goal;
    place();
    if (value !== goal) raf = requestAnimationFrame(tick);
    else last = 0;
  };

  const go = (t: number, animate: boolean) => {
    goal = Math.min(max, Math.max(0, Number.isFinite(t) ? t : 0));
    if (!animate || reduced()) {
      cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
      value = goal;
      place();
      return;
    }
    if (!raf) raf = requestAnimationFrame(tick);
  };

  let acc = 0;
  let lastNotch = -Infinity;
  let holdUntil = -Infinity;
  let holdDir = 0;
  const onWheel = (e: WheelEvent) => {
    // The wheel belongs to the reveal while over the panel: no page scroll, no OrbitControls zoom.
    e.preventDefault();
    e.stopPropagation();
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1; // lines / pages -> px
    const px = e.deltaY * scale * (e.ctrlKey ? SCROLL_REVEAL.pinchGain : 1);
    let dir: 1 | -1 | 0 = 0;
    if (Math.abs(px) >= WHEEL_NOTCH.mousePx) {
      acc = 0;
      dir = px < 0 ? 1 : -1;
    } else {
      acc += px;
      if (Math.abs(acc) >= WHEEL_NOTCH.trackpadPx) {
        dir = acc < 0 ? 1 : -1;
        acc = 0;
      }
    }
    if (!dir) return;
    const now = performance.now();
    if (now - lastNotch < WHEEL_NOTCH.minGapMs) return;
    if (goal === 1 && dir === holdDir && now < holdUntil) return;
    lastNotch = now;
    const next = notchedGoal(goal, dir, max);
    if (next === 1 && goal !== 1) {
      holdUntil = now + WHEEL_NOTCH.detentMs;
      holdDir = dir;
    }
    go(next, true);
  };
  const onDouble = () => go(0, true);

  element.addEventListener('wheel', onWheel, { passive: false, capture: true });
  element.addEventListener('dblclick', onDouble);
  place();

  return {
    value: () => splitStage(value).reveal,
    ctPhase: () => splitStage(value).ct,
    set(t, animate = true) {
      // The contract's reveal 0..1; set(1) from the CT stage goes back to the see-through.
      go(Math.min(1, t), animate);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      element.removeEventListener('wheel', onWheel, { capture: true });
      element.removeEventListener('dblclick', onDouble);
    },
  };
}
