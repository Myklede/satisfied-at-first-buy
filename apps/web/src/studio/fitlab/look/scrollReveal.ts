// R (prompt 33): the mouse wheel (or a trackpad pinch) on the Fit Lab panel drives one value,
// reveal 0..1: 0 = full-body framing and the product look, 1 = the closer framing, see-through.
// The camera keeps the user's orbit direction; only its target and distance follow the reveal.
// Double-click returns to the Look. prefers-reduced-motion: no easing, the camera jumps.
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

export function createScrollReveal(
  opts: ScrollRevealOptions & { controls?: RevealControls },
): ScrollReveal {
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

  const place = () => {
    const { center, distance } = framingAt(value, opts.framing(), centre);
    const from = controls ? controls.target : hasCenter ? lastCenter : center;
    dir.subVectors(camera.position, from);
    if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1);
    dir.normalize();
    camera.position.copy(center).addScaledVector(dir, distance);
    lastCenter.copy(center);
    hasCenter = true;
    if (controls) {
      controls.target.copy(center);
      controls.update();
    } else camera.lookAt(center);
    opts.onReveal(value);
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
    goal = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
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

  const onWheel = (e: WheelEvent) => {
    // The wheel belongs to the reveal while over the panel: no page scroll, no OrbitControls zoom.
    e.preventDefault();
    e.stopPropagation();
    go(goal + wheelStep(e), true);
  };
  const onDouble = () => go(0, true);

  element.addEventListener('wheel', onWheel, { passive: false, capture: true });
  element.addEventListener('dblclick', onDouble);
  place();

  return {
    value: () => value,
    set(t, animate = true) {
      go(t, animate);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      element.removeEventListener('wheel', onWheel, { capture: true });
      element.removeEventListener('dblclick', onDouble);
    },
  };
}
