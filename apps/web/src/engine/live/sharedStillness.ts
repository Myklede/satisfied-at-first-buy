// One decision per source frame for the pose, AR solve/glue and finishing layers.
// Thresholds and noise calibration remain in ar/config.ts (V2's measured pixel detector).
// Consumers must release immediately when `still` is false; they add no release hysteresis.
import type { LiveFrame } from './contract';
import { STILLNESS } from './ar/config';
import { StillnessLock, type StillnessState } from './ar/stillness';

export interface SharedStillState extends Readonly<StillnessState> {
  readonly still: boolean;
  readonly sinceMs: number | null;
  readonly releasedAtMs: number | null;
  readonly noisePx: number;
  readonly noiseRmsPx: readonly number[];
}

const frames = new WeakMap<LiveFrame, SharedStillState>();

/** The engine publishes before any pose/AR/finisher work on this exact source frame. */
export function sharedStillState(frame: LiveFrame): SharedStillState | null {
  return frames.get(frame) ?? null;
}

export class SharedStillDetector {
  private readonly motion = new StillnessLock(STILLNESS);
  private sinceMs: number | null = null;
  private releasedAtMs: number | null = null;
  private lastTime: number | null = null;
  private lastEnabled = true;
  private lastFrame: LiveFrame | null = null;
  private lastState: SharedStillState | null = null;

  reset() {
    this.motion.reset();
    this.sinceMs = this.releasedAtMs = this.lastTime = null;
    this.lastState = null;
    this.lastFrame = null;
  }

  /** Source milliseconds, not wall time; duplicate frames cannot advance engagement. */
  update(frame: LiveFrame, enabled = true): SharedStillState {
    if (this.lastFrame === frame && this.lastEnabled === enabled && this.lastState) {
      frames.set(frame, this.lastState);
      return this.lastState;
    }
    const wasStill = this.lastState?.still ?? false;
    if (this.lastTime !== null && frame.t < this.lastTime) this.reset();
    const points = enabled && frame.pose ? frame.landmarks2d : null;
    const span =
      points?.[11] && points[12]
        ? Math.hypot(points[11].x - points[12].x, points[11].y - points[12].y)
        : 0;
    if (!points) this.motion.reset();
    const motion = this.motion.update(frame.t, points, span);
    const still = enabled && !!frame.pose && motion.engaged;
    if (still && !wasStill) this.sinceMs = frame.t;
    if (!still) {
      this.sinceMs = null;
      if (wasStill) this.releasedAtMs = frame.t;
    }
    const noise = this.motion.noiseRmsPx();
    const state: SharedStillState = Object.freeze({
      ...motion,
      // The old AR release ease must never keep a consumer held after the common release.
      engaged: still,
      hold: still ? 1 : 0,
      still,
      sinceMs: this.sinceMs,
      releasedAtMs: this.releasedAtMs,
      noisePx: Math.sqrt(noise.reduce((sum, value) => sum + value * value, 0) / noise.length),
      noiseRmsPx: Object.freeze(noise),
    });
    this.lastFrame = frame;
    this.lastTime = frame.t;
    this.lastEnabled = enabled;
    this.lastState = state;
    frames.set(frame, state);
    return state;
  }
}
