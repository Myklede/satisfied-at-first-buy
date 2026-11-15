import type { BakedMove, MoveBaker } from '../../engine/live/contract';
/** Selects recorded frames only. Never changes baked geometry or fit/physics numbers. */
export class PlaybackClock {
  paused = false;
  frame = 0;
  private offset = 0;
  private target: number | null = null;
  private count = 1;
  reset() {
    this.paused = false;
    this.frame = 0;
    this.offset = 0;
    this.target = null;
  }
  setPaused(paused: boolean) {
    if (this.paused && !paused) this.target = this.frame;
    this.paused = paused;
  }
  seek(fraction: number) {
    this.target = Math.round(Math.min(1, Math.max(0, fraction)) * (this.count - 1));
  }
  resolve(incoming: number, count: number) {
    this.count = Math.max(1, count);
    if (this.target !== null) {
      this.frame = this.target;
      this.offset = (this.frame - incoming + this.count) % this.count;
      this.target = null;
    } else if (!this.paused) this.frame = (incoming + this.offset) % this.count;
    return this.frame;
  }
}
export function controlledBaker(baker: MoveBaker, clock: PlaybackClock): MoveBaker {
  return {
    async bake(...args) {
      const baked = await baker.bake(...args);
      const range = (baked as BakedMove & { recorded?: { start: number; end: number } }).recorded;
      const start = range?.start ?? 0;
      const end = range?.end ?? baked.frameCount - 1;
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end < start ||
        end >= baked.frameCount
      )
        throw Error('Invalid recorded playback window');
      const span = end - start + 1;
      clock.reset();
      clock.resolve(0, span);
      let selected = start;
      const controlled: BakedMove & { recorded?: { start: number; end: number } } = {
        recorded: range,
        fps: baked.fps,
        frameCount: baked.frameCount,
        applyFrame(index, scene) {
          selected = start + clock.resolve(index - start, span);
          baked.applyFrame(selected, scene);
        },
        readouts() {
          return baked.readouts(selected);
        },
        dispose() {
          baked.dispose();
        },
      };
      return controlled;
    },
  };
}
