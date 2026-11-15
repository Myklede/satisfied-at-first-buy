// LiveSource over the Studio's shared Perception (contract.ts): the pose landmarks ZB's tracker
// already computes on the shared video go through @satisfy/vision's PosePipeline (anatomical
// angles, One Euro filter, neutral calibration), exactly as engine/live/sources/trackedSource.ts
// does with its own tracker. No second pose tracker is started; no video frame is read here.
import {
  PosePipeline,
  type CalibrationProgress,
  type NeutralCalibration,
  type PoseLandmark,
  type PoseTrackerFrame,
  type PoseTrackerStats,
} from '@satisfy/vision';
import type { AnatomicalPose } from '../../engine/motion/rig';
import type { LiveFrame } from '../../engine/live/contract';
import type { CalibratableSource } from '../../engine/live/sources/trackedSource';
import type { Landmark2D, Perception } from '../contract';

export type PoseFrame = Parameters<Parameters<Perception['onPose']>[0]>[0];

/** Source frame size for the LiveFrame's pixel landmarks (the Studio's SharedCamera size). */
export interface FrameSize {
  width: number;
  height: number;
}

const toLandmark = (
  p: Landmark2D | { x: number; y: number; z: number; visibility?: number },
): PoseLandmark => ({
  x: p.x,
  y: p.y,
  z: 'z' in p ? p.z : 0,
  visibility: p.visibility ?? 1,
});

/** Pure: one Perception pose frame + the pipeline's output → the engine's LiveFrame. */
export function toLiveFrame(
  frame: PoseFrame,
  tracked: PoseTrackerFrame,
  size: FrameSize,
  t0: number,
  cameraVertical: boolean,
): LiveFrame {
  const ok = tracked.personDetected && frame.image.length === 33 && !!frame.world;
  return {
    t: frame.timeMs - t0,
    width: size.width,
    height: size.height,
    landmarks2d: ok
      ? frame.image.map((p) => ({
          x: p.x * size.width,
          y: p.y * size.height,
          visibility: p.visibility ?? 1,
        }))
      : null,
    world: ok
      ? frame.world!.map((p, i) => ({
          x: p.x,
          y: p.y,
          z: p.z,
          visibility: frame.image[i]?.visibility ?? 1,
        }))
      : null,
    pose:
      ok && (tracked.calibrated || cameraVertical)
        ? { ...(tracked.pose as unknown as AnatomicalPose) }
        : null,
    confidence: ok ? { ...(tracked.confidence as unknown as Record<string, number>) } : {},
    mask: null,
  };
}

export class PerceptionSource implements CalibratableSource {
  readonly kind = 'camera' as const;
  readonly video = null;
  private pipeline: PosePipeline;
  private listeners = new Set<(frame: LiveFrame) => void>();
  private off?: () => void;
  private t0: number | null = null;
  private progress: CalibrationProgress | null = null;
  private cameraVertical = false;
  private paused = false;
  private times: number[] = [];

  constructor(
    private perception: Pick<Perception, 'onPose'>,
    private size: () => FrameSize,
    calibration: NeutralCalibration | null = null,
  ) {
    this.pipeline = new PosePipeline({ calibration });
  }

  start(): Promise<void> {
    if (!this.off) this.off = this.perception.onPose((frame) => this.onPose(frame));
    return Promise.resolve();
  }

  stop() {
    this.off?.();
    this.off = undefined;
  }

  /** While paused no frame reaches the engine: the avatar holds its last pose. */
  setPaused(on: boolean) {
    this.paused = on;
  }

  onFrame(callback: (frame: LiveFrame) => void) {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  private onPose(frame: PoseFrame) {
    if (this.paused) return;
    const now = performance.now();
    this.times.push(now);
    while (this.times.length && now - this.times[0] > 1000) this.times.shift();
    const input =
      frame.world && frame.world.length === 33 && frame.image.length === 33
        ? { world: frame.world.map(toLandmark), image: frame.image.map(toLandmark) }
        : undefined;
    const tracked = this.pipeline.update(frame.timeMs, input);
    this.progress = tracked.calibrating ?? null;
    this.t0 ??= frame.timeMs;
    const live = toLiveFrame(frame, tracked, this.size(), this.t0, this.cameraVertical);
    for (const listener of this.listeners) {
      try {
        listener(live);
      } catch (error) {
        console.error('[fitlab] frame listener threw', error);
      }
    }
  }

  calibrate(signal?: AbortSignal): Promise<NeutralCalibration> {
    this.cameraVertical = false;
    return new Promise<NeutralCalibration>((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('Calibration aborted', 'AbortError'));
      this.pipeline.startCalibration();
      const off = this.pipeline.onCalibrated((c) => {
        off();
        signal?.removeEventListener('abort', onAbort);
        resolve(c);
      });
      const onAbort = () => {
        off();
        this.pipeline.cancelCalibration();
        reject(new DOMException('Calibration aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  get calibrated() {
    return this.pipeline.calibration != null;
  }

  get calibrationProgress() {
    return this.progress;
  }

  /** Neutral stand could not finish: angles against the camera's up axis (engine says so). */
  useCameraVertical() {
    this.pipeline.setCalibration(null);
    this.cameraVertical = true;
  }

  get usingCameraVertical() {
    return this.cameraVertical;
  }

  /** Perception owns the tracker; only the delivered rate is known here. */
  stats(): PoseTrackerStats | null {
    return null;
  }

  /** Pose frames received over the last second. */
  get rateHz() {
    return this.times.length;
  }
}
