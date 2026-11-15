// SharedCamera (contract.ts): ONE getUserMedia for the whole Studio. Decart gets a clone of the
// track (its disconnect stops what it was given), our trackers read `video`. Frames stay in memory.
import type { SharedCamera } from './contract';

export const CAMERA_WIDTH = 1280;
export const CAMERA_HEIGHT = 720;
export const CAMERA_FPS = 30;
/** Default device: the iPhone-as-webcam app (the demo camera). */
export const PREFERRED_LABEL = /camo/i;

export interface SharedCameraHandle extends SharedCamera {
  label: string;
  /** A new stream with a cloned video track, for a consumer that will stop its tracks. */
  cloneStream(): MediaStream;
  close(): void;
}

async function open(deviceId: string | null): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      width: { ideal: CAMERA_WIDTH },
      height: { ideal: CAMERA_HEIGHT },
      frameRate: { ideal: CAMERA_FPS, max: CAMERA_FPS },
    },
  });
}

export async function listCameras(): Promise<{ deviceId: string; label: string }[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `camera ${i + 1}` }));
}

/** Opens the requested camera, else the Camo camera, else the default one. */
export async function openSharedCamera(
  deviceId: string | null = null,
): Promise<SharedCameraHandle> {
  let stream = await open(deviceId);
  if (!deviceId) {
    // Labels are only visible after permission, so look for Camo once the first stream is open.
    const current = stream.getVideoTracks()[0]?.label ?? '';
    if (!PREFERRED_LABEL.test(current)) {
      const camo = (await listCameras()).find((c) => PREFERRED_LABEL.test(c.label));
      if (camo) {
        stream.getTracks().forEach((t) => t.stop());
        stream = await open(camo.deviceId);
      }
    }
  }
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('camera gave no video track');
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.srcObject = stream;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error('camera video failed to load'));
  });
  await video.play();
  const settings = track.getSettings();
  return {
    stream,
    video,
    width: settings.width ?? video.videoWidth,
    height: settings.height ?? video.videoHeight,
    label: track.label,
    cloneStream: () => new MediaStream([track.clone()]),
    close: () => {
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}
