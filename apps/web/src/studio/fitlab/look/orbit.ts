// OR: drag-to-rotate in the Fit Lab. Left-drag / one-finger touch orbits the camera around the
// body (full turn horizontally, a band vertically, damped). The wheel stays the reveal's (R):
// no OrbitControls zoom, no pan. The reveal keeps the orbit direction and drives only target and
// distance, so the two coexist. ZB's garment grabs take the pointerdown in the capture phase on
// the canvas host and stop it, so a grab never reaches the OrbitControls on the canvas.
// Double-click (handled by the reveal: back to the Look) also turns the camera back to the front.
import { MOUSE, TOUCH, Vector3 } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const ORBIT = {
  /** Polar band (rad from +Y): never under the floor, never straight down on the head. */
  minPolar: (55 * Math.PI) / 180,
  maxPolar: (115 * Math.PI) / 180,
  /** CS: polar floor while the CT stage is on (the camera looks down on the cut). */
  ctMinPolar: (12 * Math.PI) / 180,
  dampingFactor: 0.08,
  rotateSpeed: 0.8,
  /** Turn-to-front easing rate (1/s). */
  frontRate: 9,
  /** Below this (rad) the turn-to-front snaps. */
  frontSnap: 0.002,
} as const;

/** Shortest signed step from azimuth `a` to `b` (rad), in (-PI, PI]. Pure; tested. */
export function shortestAngle(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Azimuth after one eased step toward `goal` (pure; tested). */
export function easeAzimuth(current: number, goal: number, dt: number, rate = ORBIT.frontRate) {
  const d = shortestAngle(current, goal);
  if (Math.abs(d) < ORBIT.frontSnap) return goal;
  return current + d * (1 - Math.exp(-rate * dt));
}

export interface FitLabOrbit {
  /** Animate the camera azimuth back to the front (+Z). */
  toFront(animate?: boolean): void;
  /** CS: relax the polar band (CT stage: the camera may look down on the cut) or restore it. */
  relax(on: boolean): void;
  dispose(): void;
}

/** Turns the Viewer's OrbitControls into a rotate-only orbit; double-click on `element` faces front. */
export function enableOrbit(controls: OrbitControls, element: HTMLElement): FitLabOrbit {
  controls.enabled = true;
  controls.enableRotate = true;
  controls.enableZoom = false;
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = ORBIT.dampingFactor;
  controls.rotateSpeed = ORBIT.rotateSpeed;
  controls.minAzimuthAngle = -Infinity;
  controls.maxAzimuthAngle = Infinity;
  controls.minPolarAngle = ORBIT.minPolar;
  controls.maxPolarAngle = ORBIT.maxPolar;
  controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: null, RIGHT: null };
  controls.touches = { ONE: TOUCH.ROTATE, TWO: null };
  controls.update();

  let raf = 0;
  let last = 0;
  const offset = new Vector3();
  // CS: the polar the view started with; the turn-to-front eases back to it too (double-click
  // after a drag up/down or the CT stage's tilt returns to the Look's straight view).
  const frontPolar = controls.getPolarAngle();
  const setAzimuth = (az: number, polar = controls.getPolarAngle()) => {
    offset.subVectors(controls.object.position, controls.target);
    const len = offset.length();
    offset.set(
      len * Math.sin(polar) * Math.sin(az),
      len * Math.cos(polar),
      len * Math.sin(polar) * Math.cos(az),
    );
    controls.object.position.copy(controls.target).add(offset);
    controls.update();
    // KioskMirrorView draws on change: the animated turn must redraw too.
    controls.dispatchEvent({ type: 'change' });
  };
  const tick = (now: number) => {
    raf = 0;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    const az = easeAzimuth(controls.getAzimuthalAngle(), 0, dt);
    const p0 = controls.getPolarAngle();
    const polar =
      Math.abs(p0 - frontPolar) < ORBIT.frontSnap
        ? frontPolar
        : p0 + (frontPolar - p0) * (1 - Math.exp(-ORBIT.frontRate * dt));
    setAzimuth(az, polar);
    if (az !== 0 || polar !== frontPolar) raf = requestAnimationFrame(tick);
    else last = 0;
  };
  const toFront = (animate = true) => {
    cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
    const reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animate || reduced) setAzimuth(0, frontPolar);
    else raf = requestAnimationFrame(tick);
  };
  // A new drag cancels a running turn-to-front.
  const onStart = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
  };
  const onDouble = () => toFront(true);
  controls.addEventListener('start', onStart);
  element.addEventListener('dblclick', onDouble);
  return {
    toFront,
    relax(on) {
      controls.minPolarAngle = on ? ORBIT.ctMinPolar : ORBIT.minPolar;
    },
    dispose() {
      cancelAnimationFrame(raf);
      controls.removeEventListener('start', onStart);
      element.removeEventListener('dblclick', onDouble);
    },
  };
}
