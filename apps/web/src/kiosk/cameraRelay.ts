// A camera handle the kiosk's long-lived hand tracker is created on (agent S). The tracker only
// uses the public CameraHandle interface: `source` for each frame and `onFrame` from start().
// Feel attaches the real camera while it is open and detaches it on exit, so the tracker (the
// MediaPipe landmarker, its GPU programs and its first inference) is built once, during the
// warm-up, instead of on every Feel open or jacket switch (a 0.3–4.9 s main-thread task).
import type { CameraHandle, CameraInfo } from '@satisfy/vision';

type FrameListener = (frameTime: number) => void;

const DETACHED: CameraInfo = {
  deviceId: 'detached',
  label: 'detached',
  width: 0,
  height: 0,
  fps: 0,
  portrait: false,
};

export class CameraRelay implements CameraHandle {
  private target?: CameraHandle;
  private readonly listeners = new Set<FrameListener>();
  private unsubscribe?: () => void;
  private fallback?: HTMLVideoElement;

  /** Frames of `camera` now reach the relay's listeners (the previous camera is detached). */
  attach(camera: CameraHandle) {
    this.detach();
    this.target = camera;
    this.unsubscribe = camera.onFrame((frameTime) => {
      for (const listener of this.listeners) listener(frameTime);
    });
  }

  /** Stops forwarding frames. The camera itself stays open: its owner closes it. */
  detach() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.target = undefined;
  }

  get attached() {
    return this.target !== undefined;
  }

  get video(): HTMLVideoElement {
    return this.target?.video ?? this.placeholder();
  }

  get source(): HTMLVideoElement | HTMLCanvasElement {
    // Detached: a 0×0 element, which the tracker skips (no frame size).
    return this.target?.source ?? this.placeholder();
  }

  onFrame(listener: FrameListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  info(): CameraInfo {
    return this.target?.info() ?? DETACHED;
  }

  /** The relay owns no camera: closing it only detaches. */
  close() {
    this.detach();
  }

  private placeholder() {
    // Created lazily (needs a DOM); never shown, no frames (videoWidth 0).
    this.fallback ??= document.createElement('video');
    return this.fallback;
  }
}
