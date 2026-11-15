// Live webcam source: openCamera (packages/vision) + the shared pose tracker path.
import { listCameras, openCamera, type CameraHandle, type CameraOptions } from '@satisfy/vision';
import { TrackedSource, type TrackedSourceOptions } from './trackedSource.ts';
import {
  POSE_INPUT_MAX_SIDE,
  cameraChoice,
  findCamera,
  type CameraChoice,
} from './cameraChoice.ts';

/**
 * Default capture: 960×540 at 30 fps. The pose model resizes every frame to 256 px anyway, and
 * the user's live diagnostics at 1280×720 ran at only 18–21 fps on the Integrated Camera (the
 * AR texture upload and recording copies scale with the frame). 540 p keeps the AR sharp enough.
 */
export const LIVE_CAMERA: CameraOptions = {
  width: 960,
  height: 540,
  frameRate: 30,
  // Best-effort floor (openCamera applyConstraints, ignored if refused): in dim light the
  // Integrated Camera's auto-exposure fell from 30 to 17 fps within 20 s (user diagnostics 15:18).
  minFrameRate: 24,
};

/**
 * ?camHd=1 (F2, user U1 19:00): the camera's best mode. `ideal` constraints: a 1280×720 camera
 * (the Integrated Camera's maximum) opens at 1280×720, a 1080p one (iPhone via a virtual-camera
 * app) at 1920×1080. The pose worker infers on a <= 960 px copy (cameraChoice.POSE_INPUT_MAX_SIDE).
 */
export const HD_CAMERA: CameraOptions = {
  width: 1920,
  height: 1080,
  frameRate: 30,
  minFrameRate: 24,
};

const currentSearch = () => (typeof location === 'undefined' ? '' : location.search);
const sessionStore = () => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
};

/**
 * The deviceId of the preferred camera (label substring), or undefined for the default one.
 * Labels are empty until the origin has camera permission: then one short default open grants
 * it (released at once) and the list is read again.
 */
async function preferredDeviceId(label: string | null): Promise<string | undefined> {
  if (!label) return undefined;
  let devices = await listCameras();
  if (devices.every((d) => !d.label)) {
    const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    probe.getTracks().forEach((t) => t.stop());
    devices = await listCameras();
  }
  const id = findCamera(
    devices.map((d) => ({ ...d, kind: 'videoinput' as const })),
    label,
  );
  if (!id) console.warn(`[live] no camera matches "${label}"; the default camera is used`);
  return id ?? undefined;
}

/** Opens the live camera with the kiosk's choice (device, best mode, stereo crop). */
export function openLiveCamera(
  camera: CameraOptions = {},
  choice: CameraChoice = cameraChoice(currentSearch(), sessionStore()),
): Promise<CameraHandle> {
  const open = (deviceId?: string) =>
    openCamera({
      ...LIVE_CAMERA,
      ...(choice.hd ? HD_CAMERA : {}),
      ...camera,
      ...(deviceId ? { deviceId } : {}),
    });
  // No preference: openCamera's own promise, unchanged timing for the default camera.
  const opened =
    camera.deviceId || !choice.label
      ? open(camera.deviceId)
      : preferredDeviceId(choice.label).then(open);
  return choice.crop === 'left' ? opened.then(leftEye) : opened;
}

/**
 * ?camCrop=left: the left half of a side-by-side stereo frame (ZED 2 over UVC delivers both eyes
 * in one image). A canvas holds the left eye, redrawn on each camera frame before the listeners
 * run; it is the inference source and, hung on the video as `poseSyncDisplay` (ArCompositor
 * frameShown), what the AR draws. It answers the few video fields a VideoTexture reads.
 */
export function leftEye(handle: CameraHandle): CameraHandle {
  const video = handle.video;
  const canvas = document.createElement('canvas');
  const size = () => {
    const w = Math.max(1, Math.floor(handle.info().width / 2)),
      h = Math.max(1, handle.info().height);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  };
  size();
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('camCrop: no 2D canvas context');
  let painted = false;
  Object.defineProperties(canvas, {
    readyState: { get: () => (painted ? 4 : 0) },
    videoWidth: { get: () => canvas.width },
    videoHeight: { get: () => canvas.height },
  });
  Object.defineProperty(video, 'poseSyncDisplay', { value: canvas, configurable: true });
  const listeners = new Set<(t: number) => void>();
  const off = handle.onFrame((t) => {
    size();
    ctx.drawImage(
      handle.source,
      0,
      0,
      canvas.width,
      canvas.height,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    painted = true;
    for (const l of listeners) l(t);
  });
  return {
    video,
    source: canvas,
    onFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    info: () => ({ ...handle.info(), width: canvas.width, height: canvas.height }),
    close() {
      off();
      listeners.clear();
      delete (video as { poseSyncDisplay?: unknown }).poseSyncDisplay;
      handle.close();
    },
  };
}

export function createCameraSource(
  camera: CameraOptions = {},
  options: TrackedSourceOptions = {},
): TrackedSource {
  const choice = cameraChoice(currentSearch(), sessionStore());
  return new TrackedSource('camera', () => openLiveCamera(camera, choice), {
    ...(choice.hd ? { poseInputMaxSide: POSE_INPUT_MAX_SIDE } : {}),
    ...options,
  });
}
