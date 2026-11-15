// Which camera the try-on (and the body scan) opens, and how (F2, lead 19:00, user U1/U2).
// - ?cam=<label substring> or the kiosk's camera picker (sessionStorage) chooses the device,
//   e.g. an iPhone through a virtual-camera app, or a ZED 2 stereo camera.
// - ?camCrop=left uses the left half of a side-by-side stereo frame (ZED 2 over UVC).
// - ?camHd=1 asks for the camera's best mode (1920x1080, else what it has, e.g. 1280x720) at
//   30 fps, and the pose worker infers on a <= 960 px copy, so inference cost does not grow
//   while the AR draws the full-resolution frame. Default off.
// Only labels and ids are read (no pixels); nothing leaves the machine.

export const CAMERA_STORAGE_KEY = 'satisfy.camera.label';
/** Longest side of the pose worker's input under ?camHd=1 (the old 960x540 capture). */
export const POSE_INPUT_MAX_SIDE = 960;

export type CameraCrop = 'left' | null;
export interface CameraChoice {
  /** Case-insensitive substring of the wanted device label, or null for the default camera. */
  label: string | null;
  crop: CameraCrop;
  hd: boolean;
}

type Store = Pick<Storage, 'getItem'> | null | undefined;

export function cameraChoice(search: string, store?: Store): CameraChoice {
  const params = new URLSearchParams(search);
  const fromUrl = params.get('cam');
  let stored: string | null = null;
  try {
    stored = store?.getItem(CAMERA_STORAGE_KEY) ?? null;
  } catch {
    stored = null; // storage blocked: the URL still works
  }
  const label = (fromUrl ?? stored ?? '').trim();
  return {
    label: label || null,
    crop: params.get('camCrop') === 'left' ? 'left' : null,
    hd: params.get('camHd') === '1',
  };
}

/** The device whose label contains `label` (case-insensitive), else null. */
export function findCamera(
  devices: readonly Pick<MediaDeviceInfo, 'kind' | 'label' | 'deviceId'>[],
  label: string,
): string | null {
  const want = label.toLowerCase();
  const hit = devices.find((d) => d.kind === 'videoinput' && d.label.toLowerCase().includes(want));
  return hit?.deviceId ?? null;
}

/** Pose input size: the source scaled so its longest side is <= max (never upscaled). */
export function poseInputSize(width: number, height: number, max: number) {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scaled: scale < 1,
  };
}
