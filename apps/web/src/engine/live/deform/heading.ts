// Whole-body heading for the dynamics (contract.ts LiveDeformContext.rootYawDeg): the live pose has
// no root yaw (the avatar always faces front; trunk twist is in the pose), so a body turn reaches
// the jacket only through this number. Read from MediaPipe's world landmarks (hip-centred metres,
// x toward image right = the person's left when facing the camera, y down, z away from the
// camera): the hip line (pelvis = root; the shoulder line would count the trunk twist twice),
// falling back to the shoulder line when the hips are not seen (head-to-hips framing).
// 0 = facing the camera, + = turning to the person's left. Side-on and back views are ambiguous in
// a single view: null.
import type { WorldLandmark } from '../contract.ts';
import { DYNAMICS } from './config.ts';

const L_SHOULDER = 11,
  R_SHOULDER = 12,
  L_HIP = 23,
  R_HIP = 24;

export function rootYawFromWorld(world: WorldLandmark[] | null): number | null {
  if (!world || world.length < 25) return null;
  const seen = (i: number) => world[i].visibility >= DYNAMICS.heading.minVisibility;
  const pair: [number, number] | null =
    seen(L_HIP) && seen(R_HIP)
      ? [L_HIP, R_HIP]
      : seen(L_SHOULDER) && seen(R_SHOULDER)
        ? [L_SHOULDER, R_SHOULDER]
        : null;
  if (!pair) return null;
  const l = world[pair[0]],
    r = world[pair[1]];
  const dx = l.x - r.x,
    dz = l.z - r.z;
  if (!(Math.hypot(dx, dz) > 0.05)) return null;
  const yaw = (Math.atan2(dz, dx) * 180) / Math.PI;
  return Math.abs(yaw) <= DYNAMICS.heading.maxAbsDeg ? yaw : null;
}

/**
 * A body turn of θ narrows the image shoulder span to |cos θ| of its frontal width. A heading
 * whose size disagrees with that by more than DYNAMICS.heading.spanToleranceDeg is ambiguous:
 * null (the deformer keeps its last heading). Measured on the 15:12 live session: V2's drawn yaw
 * read 37-48 deg while the span said ~10 deg and the user faced the camera; fed as is, the hem
 * swayed 1 cm on average with no turn (0.1 cm without the heading). A back view (|θ| near 180)
 * has a full span again, so it is checked against 180 - span angle. Raised arms also narrow the
 * span, so this only rejects, it never invents a turn.
 * @param spanRatio image shoulder span / the remembered frontal span (null = not measured)
 */
export function plausibleHeading(raw: number | null, spanRatio: number | null): number | null {
  if (raw === null || spanRatio === null || !Number.isFinite(spanRatio) || spanRatio <= 0)
    return raw;
  const turn = (Math.acos(Math.min(1, spanRatio)) * 180) / Math.PI;
  const size = Math.abs(wrapDeg(raw));
  const off = Math.min(Math.abs(size - turn), Math.abs(size - (180 - turn)));
  return off <= DYNAMICS.heading.spanToleranceDeg ? raw : null;
}

/** An angle difference wrapped to (−180, 180]: +180 and −180 are the same heading. */
export function wrapDeg(d: number) {
  const w = d - 360 * Math.floor((d + 180) / 360);
  return w === -180 ? 180 : w;
}

/**
 * Heading filter: an exponential smoother (τ) followed by a backlash (dead band): tracking noise
 * smaller than the band never moves the output (no jitter at rest), a real turn moves it with at
 * most the band of offset. One-frame flips larger than spikeDeg are ignored; after
 * spikeFrames of them in a row the filter restarts at the new value. Wrap-safe: it works on the
 * unwrapped heading (a step from +179 to −179 is 2°, never a spin) and returns it wrapped to
 * (−180, 180]. null = unknown.
 */
export class YawFilter {
  private smooth = NaN;
  private out = NaN;
  private lastT = NaN;
  private spikes = 0;

  update(tMs: number, input: number | null): number | null {
    const H = DYNAMICS.heading;
    if (input === null || !Number.isFinite(input)) {
      if (Number.isFinite(this.lastT) && tMs - this.lastT > H.holdMs) this.reset();
      return Number.isFinite(this.out) ? wrapDeg(this.out) : null;
    }
    if (!Number.isFinite(this.smooth)) {
      this.smooth = this.out = wrapDeg(input);
      this.lastT = tMs;
      return this.out;
    }
    // The input unwrapped next to the smoothed heading.
    const raw = this.smooth + wrapDeg(input - this.smooth);
    if (Math.abs(raw - this.smooth) > H.spikeDeg) {
      if (++this.spikes < H.spikeFrames) return wrapDeg(this.out);
      this.smooth = this.out = raw;
      this.spikes = 0;
      this.lastT = tMs;
      return wrapDeg(raw);
    }
    this.spikes = 0;
    const dt = Math.max(0, tMs - this.lastT) / 1000;
    this.lastT = tMs;
    this.smooth += (raw - this.smooth) * (1 - Math.exp(-dt / H.tauS));
    if (this.out < this.smooth - H.deadBandDeg) this.out = this.smooth - H.deadBandDeg;
    else if (this.out > this.smooth + H.deadBandDeg) this.out = this.smooth + H.deadBandDeg;
    return wrapDeg(this.out);
  }

  reset() {
    this.smooth = this.out = this.lastT = NaN;
    this.spikes = 0;
  }
}
