// Delivered camera frame rate on the try-on, and the "more light" hint (F2, lead 18:25).
// The Integrated Camera's auto-exposure halves its frame rate in dim light (probe 18:2x: 30 fps
// at 1/64 s exposure, 15 fps once it chooses 1/16 s) while track.getSettings() keeps reporting
// the requested 30, so the delivered rate is counted from frames: MediaStreamTrack.stats
// (totalFrames) where Chrome exposes it, else the source's presented-frame count per second.
// The AR follows the camera 1:1, so below 24 fps the only fix on site is more light.

/** Below this delivered rate (fps) the hint shows (the D9 bar: AR >= 24 fps). */
export const LOW_CAMERA_FPS = 24;
/** Above this it clears (hysteresis, so the hint does not flicker around 24). */
export const OK_CAMERA_FPS = 26;
/** How long a rate must hold before the hint shows or clears (ms). */
export const CAMERA_FPS_HOLD_MS = 2000;
export const MORE_LIGHT_HINT = 'More light on you = smoother try-on';

type TrackStats = { totalFrames?: number; deliveredFrames?: number; discardedFrames?: number };

/** Frames the camera has produced so far, when the browser exposes track.stats (else null). */
export function trackFrameCount(track: MediaStreamTrack | undefined): number | null {
  const stats = (track as (MediaStreamTrack & { stats?: TrackStats }) | undefined)?.stats;
  if (!stats) return null;
  if (typeof stats.totalFrames === 'number') return stats.totalFrames;
  if (typeof stats.deliveredFrames === 'number')
    return stats.deliveredFrames + (stats.discardedFrames ?? 0);
  return null;
}

export class CameraFpsMonitor {
  private last?: { at: number; frames: number };
  private since?: { low: boolean; at: number };
  /** Latest delivered rate (fps), null until measured. */
  fps: number | null = null;
  /** True while the hint should show. */
  low = false;

  /**
   * One reading: `frames` = cumulative frame counter (track.stats) or null, `fallbackFps` =
   * the source's own per-second count when no counter exists.
   */
  sample(now: number, frames: number | null, fallbackFps: number | null): void {
    let fps: number | null = null;
    if (frames !== null) {
      if (this.last && now > this.last.at && frames >= this.last.frames)
        fps = ((frames - this.last.frames) * 1000) / (now - this.last.at);
      this.last = { at: now, frames };
    } else fps = fallbackFps;
    if (fps === null || !Number.isFinite(fps)) return;
    this.fps = fps;
    const below = fps < LOW_CAMERA_FPS,
      above = fps >= OK_CAMERA_FPS;
    const want = this.low ? !above : below;
    if (want === this.low) {
      this.since = undefined;
      return;
    }
    if (!this.since || this.since.low !== want) this.since = { low: want, at: now };
    else if (now - this.since.at >= CAMERA_FPS_HOLD_MS) {
      this.low = want;
      this.since = undefined;
    }
  }

  reset() {
    this.last = undefined;
    this.since = undefined;
    this.fps = null;
    this.low = false;
  }
}
