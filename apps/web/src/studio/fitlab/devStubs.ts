// Dev-only stand-ins for the Studio's bus and Perception (DC and ZB own the real ones), so the Fit
// Lab can be checked without a camera (apps/web/fitlab-dev.html). The pose is vision's synthetic
// body (packages/vision poseSynth), driven by a scripted anatomical pose: numbers only, no video.
import { neutralPose, synthesizeLandmarks, type AnatomicalPose } from '@satisfy/vision';
import type { GarmentState, Perception, StateSource, StudioBus } from '../contract';

export class StubBus implements StudioBus {
  private listeners = new Set<(n: GarmentState, p: GarmentState, s: StateSource) => void>();
  constructor(private state: GarmentState) {}
  get() {
    return this.state;
  }
  set(patch: Partial<GarmentState>, source: StateSource) {
    const prev = this.state;
    this.state = { ...prev, ...patch };
    for (const fn of this.listeners) fn(this.state, prev, source);
  }
  subscribe(fn: (n: GarmentState, p: GarmentState, s: StateSource) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

/** Scripted pose at time t (s): 2.5 s neutral stand (calibration), then a 12 s move loop. */
export function scriptedPose(t: number): AnatomicalPose | null {
  const pose = { ...neutralPose() };
  if (t < 2.5) return pose;
  const u = (t - 2.5) % 12;
  const ease = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));
  if (u < 3) {
    // Both arms up to the side and down again.
    const k = ease(u < 1.5 ? u / 1.5 : (3 - u) / 1.5);
    pose.shoulder_L_elevation = 10 + 120 * k;
    pose.shoulder_R_elevation = 10 + 120 * k;
    pose.shoulder_L_plane = 20;
    pose.shoulder_R_plane = 20;
  } else if (u < 6) {
    // Right arm forward, elbow bent (reaching).
    const k = ease(u < 4.5 ? (u - 3) / 1.5 : (6 - u) / 1.5);
    pose.shoulder_R_elevation = 10 + 80 * k;
    pose.shoulder_R_plane = 20 + 60 * k;
    pose.elbow_R_flexion = 70 * k;
  } else if (u < 9) {
    // Trunk twist and lean.
    const k = Math.sin(((u - 6) / 3) * 2 * Math.PI);
    pose.trunk_twist = 20 * k;
    pose.trunk_lateral = 8 * k;
  } else if (u < 10) {
    return null; // nobody tracked for 1 s: the avatar holds, then eases to the stand
  }
  return pose;
}

/** Perception stand-in emitting the scripted pose at `hz`. */
export class SyntheticPerception implements Perception {
  private pose = new Set<Parameters<Perception['onPose']>[0]>();
  private timer = 0;
  private started = 0;
  constructor(private hz = 30) {}
  start() {
    this.stop();
    this.started = performance.now();
    this.timer = window.setInterval(() => this.tick(), 1000 / this.hz);
    return Promise.resolve();
  }
  stop() {
    clearInterval(this.timer);
  }
  private tick() {
    const now = performance.now();
    const pose = scriptedPose((now - this.started) / 1000);
    if (!pose) return; // a real tracker emits nothing (or no person) when nobody is seen
    const input = synthesizeLandmarks(pose);
    const image = (input.image ?? input.world).map((p) => ({
      x: p.x,
      y: p.y,
      visibility: p.visibility ?? 1,
    }));
    const world = input.world.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    for (const fn of this.pose) fn({ timeMs: now, image, world });
  }
  onPose(fn: Parameters<Perception['onPose']>[0]) {
    this.pose.add(fn);
    return () => {
      this.pose.delete(fn);
    };
  }
  onHands() {
    return () => {};
  }
}
