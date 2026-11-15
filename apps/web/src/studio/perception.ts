// Studio perception (agent ZB): pose + hands from @satisfy/vision on the ONE shared camera.
//
// Pose: the live try-on's pose worker (engine/live/sources/workerPoseTracker: MediaPipe in a
// module worker, so the main thread stays free for Decart's stream and the Fit Lab render), with
// the main-thread createPoseTracker as fallback. Hands: createHandTracker (main thread) +
// PinchTracker, optionally rate-capped. Both read SharedCamera.video through a small CameraHandle
// adapter; the camera itself stays owned by the shell (DC): stop() never stops its tracks.
//
// Output landmarks follow the contract: normalised 0..1, origin top-left, NOT mirrored.
// Privacy: frames stay in memory (vision's network guard is installed by the trackers).
import {
  createHandTracker,
  createPoseTracker,
  neutralPose,
  synthesizeLandmarks,
  type CameraHandle,
  type HandTrackerDetailedStats,
  type PoseTracker,
  type PoseTrackerStats,
  type RecordedPoseFrame,
  type TrackedHandFrame,
  type TunableHandTracker,
} from '@satisfy/vision';
import type { Landmark2D, Perception, SharedCamera } from './contract';
import { HANDS_MAX_HZ } from './interact/config';

export type PoseFrameOut = Parameters<Parameters<Perception['onPose']>[0]>[0];
export type HandsFrameOut = Parameters<Parameters<Perception['onHands']>[0]>[0];

export interface StudioPerceptionOptions {
  /** Served prefix of /models and /mediapipe/wasm (the kiosk's VISION_ASSET_BASE). */
  assetBase?: string;
  /** Pose model; 'full' is what the live try-on runs. */
  poseModel?: 'lite' | 'full';
  /** Pose in a module worker (default true); falls back to the main thread if it fails. */
  poseWorker?: boolean;
  /** Run the hand tracker (default true). */
  hands?: boolean;
  /** Hand inference rate cap (Hz); 0 = every camera frame. */
  handsMaxHz?: number;
}

/** NDC (-1..1, +y up, unmirrored) -> contract image coordinates (0..1, top-left). */
export function ndcToImage(p: { x: number; y: number }): Landmark2D {
  return { x: (p.x + 1) / 2, y: (1 - p.y) / 2 };
}

/** A tracker frame (createHandTracker with mirrored:false) -> the contract's hands frame. */
export function handsFrameFromTracked(frame: TrackedHandFrame): HandsFrameOut {
  return {
    timeMs: frame.frameTime,
    hands: frame.hands.map((h) => ({
      handedness: h.hand === 'left' ? 'Left' : 'Right',
      points: h.landmarks.map(ndcToImage),
      pinching: h.pinching,
      pinchPoint: ndcToImage(h.pinchNdc),
    })),
  };
}

/** A raw pose frame -> the contract's pose frame, or null when no person was detected. */
export function poseFrameFromRaw(frame: RecordedPoseFrame): PoseFrameOut | null {
  if (!frame.image?.length) return null;
  return {
    timeMs: frame.t,
    image: frame.image.map(([x, y, , visibility]) => ({ x, y, visibility })),
    world: frame.world?.map(([x, y, z]) => ({ x, y, z })),
  };
}

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

/**
 * CameraHandle over a video the shell owns. `maxHz` > 0 drops frames to at most that rate.
 * close() only stops the frame loop (the stream belongs to SharedCamera's owner).
 */
export function videoCameraHandle(camera: SharedCamera, maxHz = 0): CameraHandle {
  const video = camera.video as VideoWithFrameCallback;
  const listeners = new Set<(t: number) => void>();
  let running = false,
    handle = 0,
    last = -Infinity,
    lastMediaTime = -1,
    frames: number[] = [];
  const minGap = maxHz > 0 ? 1000 / maxHz - 2 : 0;
  const dispatch = (t: number) => {
    frames.push(t);
    while (frames.length && t - frames[0] > 1000) frames.shift();
    if (t - last < minGap) return;
    last = t;
    for (const l of listeners) l(t);
  };
  const loop = () => {
    if (!running) return;
    if (video.requestVideoFrameCallback)
      handle = video.requestVideoFrameCallback(() => {
        dispatch(performance.now());
        loop();
      });
    else
      handle = requestAnimationFrame(() => {
        // No rVFC: one frame per new video time.
        if (video.currentTime !== lastMediaTime) {
          lastMediaTime = video.currentTime;
          dispatch(performance.now());
        }
        loop();
      });
  };
  const stop = () => {
    running = false;
    if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle);
    else cancelAnimationFrame(handle);
  };
  return {
    video,
    source: video,
    onFrame(listener) {
      listeners.add(listener);
      if (!running) {
        running = true;
        loop();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) stop();
      };
    },
    info: () => ({
      deviceId: camera.stream.getVideoTracks()[0]?.getSettings().deviceId ?? '',
      label: camera.stream.getVideoTracks()[0]?.label ?? '',
      width: video.videoWidth || camera.width,
      height: video.videoHeight || camera.height,
      fps: frames.length,
      portrait: false,
    }),
    close() {
      listeners.clear();
      stop();
      frames = [];
    },
  };
}

export class StudioPerception implements Perception {
  private poseListeners = new Set<(f: PoseFrameOut) => void>();
  private handListeners = new Set<(f: HandsFrameOut) => void>();
  private pose?: PoseTracker;
  private hands?: TunableHandTracker;
  private handles: CameraHandle[] = [];
  private unsub: (() => void)[] = [];
  private generation = 0;
  private poseFallback?: string;
  private handsError?: string;
  private lastPose?: PoseFrameOut;
  private lastHands?: HandsFrameOut;

  constructor(private readonly options: StudioPerceptionOptions = {}) {}

  async start(camera: SharedCamera): Promise<void> {
    this.stop();
    const generation = ++this.generation;
    const assetBase = this.options.assetBase ?? '/vision/';
    const poseHandle = videoCameraHandle(camera);
    this.handles.push(poseHandle);
    const poseOptions = { model: this.options.poseModel ?? 'full', assetBase } as const;
    const startPose = async (): Promise<PoseTracker> => {
      if (this.options.poseWorker === false) return createPoseTracker(poseHandle, poseOptions);
      try {
        const { createWorkerPoseTracker } = await import(
          '../engine/live/sources/workerPoseTracker'
        );
        return await createWorkerPoseTracker(poseHandle, {
          ...poseOptions,
          onFailure: (reason) => {
            // The worker died mid-session: carry on with the main-thread tracker.
            this.poseFallback = reason;
            if (generation !== this.generation) return;
            void createPoseTracker(poseHandle, poseOptions).then((t) => {
              if (generation !== this.generation) return t.close();
              this.attachPose(t);
            });
          },
        });
      } catch (error) {
        this.poseFallback = error instanceof Error ? error.message : String(error);
        console.warn('[studio/perception] pose worker unavailable, main thread used:', error);
        return createPoseTracker(poseHandle, poseOptions);
      }
    };
    const startHands = async (): Promise<TunableHandTracker | undefined> => {
      if (this.options.hands === false) return undefined;
      const handsHandle = videoCameraHandle(camera, this.options.handsMaxHz ?? HANDS_MAX_HZ);
      this.handles.push(handsHandle);
      return createHandTracker(handsHandle, {
        mirrored: false,
        maxHands: 2,
        modelAssetPath: `${assetBase}models/hand_landmarker.task`,
        wasmBasePath: `${assetBase}mediapipe/wasm`,
      });
    };
    // A hand tracker failure must not take the pose (and the Fit Lab) down with it.
    const [pose, hands] = await Promise.all([
      startPose(),
      startHands().catch((error: unknown) => {
        this.handsError = error instanceof Error ? error.message : String(error);
        console.warn('[studio/perception] hand tracker unavailable:', error);
        return undefined;
      }),
    ]);
    if (generation !== this.generation) {
      pose.close();
      hands?.close();
      return;
    }
    this.attachPose(pose);
    if (hands) {
      this.hands = hands;
      this.unsub.push(
        hands.onFrame((frame) => {
          const out = handsFrameFromTracked(frame);
          this.lastHands = out;
          for (const l of this.handListeners) l(out);
        }),
      );
      hands.start();
    }
  }

  private attachPose(tracker: PoseTracker) {
    this.pose?.close();
    this.pose = tracker;
    this.unsub.push(
      tracker.onRawFrame((raw) => {
        const out = poseFrameFromRaw(raw);
        if (!out) return;
        this.lastPose = out;
        for (const l of this.poseListeners) l(out);
      }),
    );
    tracker.start();
  }

  stop(): void {
    this.generation++;
    for (const u of this.unsub) u();
    this.unsub = [];
    this.pose?.close();
    this.hands?.close();
    this.pose = undefined;
    this.hands = undefined;
    for (const h of this.handles) h.close();
    this.handles = [];
  }

  onPose(fn: (frame: PoseFrameOut) => void): () => void {
    this.poseListeners.add(fn);
    return () => this.poseListeners.delete(fn);
  }

  onHands(fn: (frame: HandsFrameOut) => void): () => void {
    this.handListeners.add(fn);
    return () => this.handListeners.delete(fn);
  }

  /** Latest frames (overlay, diagnostics). */
  latest() {
    return { pose: this.lastPose, hands: this.lastHands };
  }

  /** Numbers only: tracker rates and latencies (camera frame callback -> result). */
  stats(): {
    pose?: PoseTrackerStats;
    hands?: HandTrackerDetailedStats;
    poseFallback?: string;
    handsError?: string;
  } {
    return {
      pose: this.pose?.stats(),
      hands: this.hands?.stats(),
      poseFallback: this.poseFallback,
      handsError: this.handsError,
    };
  }
}

/**
 * Feeds recorded/synthetic frames through the same listeners as the live trackers (replay tests,
 * the camera-free demo). Implements Perception; start() does nothing.
 */
export class ReplayPerception implements Perception {
  private poseListeners = new Set<(f: PoseFrameOut) => void>();
  private handListeners = new Set<(f: HandsFrameOut) => void>();
  async start(): Promise<void> {}
  stop(): void {}
  onPose(fn: (frame: PoseFrameOut) => void) {
    this.poseListeners.add(fn);
    return () => this.poseListeners.delete(fn);
  }
  onHands(fn: (frame: HandsFrameOut) => void) {
    this.handListeners.add(fn);
    return () => this.handListeners.delete(fn);
  }
  pushPose(frame: PoseFrameOut) {
    for (const l of this.poseListeners) l(frame);
  }
  pushHands(frame: HandsFrameOut) {
    for (const l of this.handListeners) l(frame);
  }
}

/**
 * The shell's factory (DC's main.ts loads it when present). `?zbReplay=1` (verification only):
 * a ReplayPerception on window.__zbReplay instead of the trackers, so a browser check can push
 * scripted pose/hand frames (numbers only) without a real camera.
 */
export function createPerception(options: StudioPerceptionOptions = {}): Perception {
  if (
    typeof location !== 'undefined' &&
    new URLSearchParams(location.search).get('zbReplay') === '1'
  ) {
    const replay = new ReplayPerception();
    const w = window as unknown as {
      __zbReplay?: ReplayPerception;
      __zbPose?: PoseFrameOut['image'];
    };
    w.__zbReplay = replay;
    // A full standing person (vision's own synthetic landmarks, as FL's dev page) at 30 Hz, so the
    // Fit Lab sees a valid body; the browser check reads __zbPose to place the scripted hands.
    const input = synthesizeLandmarks(neutralPose());
    const image = (input.image ?? input.world).map((q) => ({
      x: q.x,
      y: q.y,
      visibility: q.visibility ?? 1,
    }));
    const world = input.world.map((q) => ({ x: q.x, y: q.y, z: q.z }));
    w.__zbPose = image;
    setInterval(() => replay.pushPose({ timeMs: performance.now(), image, world }), 33);
    return replay;
  }
  // Lab knobs (no effect unless set): ?zbHandsHz=20 caps hand inference, ?zbPoseWorker=0 runs the
  // pose on the main thread, ?zbHands=0 turns the hand tracker off.
  const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const hz = Number(params.get('zbHandsHz'));
  return new StudioPerception({
    ...options,
    ...(Number.isFinite(hz) && hz > 0 ? { handsMaxHz: hz } : {}),
    ...(params.get('zbPoseWorker') === '0' ? { poseWorker: false } : {}),
    ...(params.get('zbHands') === '0' ? { hands: false } : {}),
  });
}
