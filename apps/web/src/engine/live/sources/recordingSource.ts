// Pose-recording replay: a numbers-only recording (packages/vision poseRecording) replayed in
// real time through the same PosePipeline, as LiveFrames. No video (`video` = null).
import { replayPoseRecording, type PoseRecording } from '@satisfy/vision';
import type { AnatomicalPose } from '../../motion/rig.ts';
import type { LiveFrame, LiveSource } from '../contract.ts';

/** Pure: the LiveFrames of a recording (time from the first frame, ms). */
export function recordingFrames(recording: PoseRecording): LiveFrame[] {
  const replayed = replayPoseRecording(recording);
  const t0 = recording.frames[0]?.t ?? 0;
  return recording.frames.map((raw, i) => {
    const f = replayed[i];
    const tracked = f.personDetected && raw.image && raw.world;
    return {
      t: raw.t - t0,
      width: raw.width,
      height: raw.height,
      landmarks2d: tracked
        ? raw.image!.map((q) => ({ x: q[0] * raw.width, y: q[1] * raw.height, visibility: q[3] }))
        : null,
      world: tracked
        ? raw.world!.map((q) => ({ x: q[0], y: q[1], z: q[2], visibility: q[3] }))
        : null,
      pose: tracked && f.calibrated ? { ...(f.pose as unknown as AnatomicalPose) } : null,
      confidence: tracked ? { ...(f.confidence as unknown as Record<string, number>) } : {},
      mask: null,
    };
  });
}

export class RecordingSource implements LiveSource {
  readonly kind = 'recording' as const;
  readonly video = null;
  private frames: LiveFrame[];
  private listeners = new Set<(frame: LiveFrame) => void>();
  private raf = 0;
  private started = 0;
  private index = 0;

  constructor(
    recording: PoseRecording,
    private loop = true,
  ) {
    this.frames = recordingFrames(recording);
    if (!this.frames.length) throw new Error('The pose recording has no frames.');
  }

  start() {
    this.stop();
    this.started = performance.now();
    this.index = 0;
    const duration = this.frames[this.frames.length - 1].t;
    const tick = (now: number) => {
      this.raf = requestAnimationFrame(tick);
      let t = now - this.started;
      if (t > duration) {
        if (!this.loop) return this.stop();
        this.started = now;
        this.index = 0;
        t = 0;
      }
      let emitted: LiveFrame | undefined;
      while (this.index < this.frames.length && this.frames[this.index].t <= t)
        emitted = this.frames[this.index++];
      if (emitted) for (const l of this.listeners) l(emitted);
    };
    this.raf = requestAnimationFrame(tick);
    return Promise.resolve();
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  onFrame(callback: (frame: LiveFrame) => void) {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }
}
