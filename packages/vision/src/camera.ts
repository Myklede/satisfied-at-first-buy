import type { CameraErrorCode, CameraHandle, CameraInfo, CameraOptions } from './types';

/** Minimum stream height (px) accepted for measurement work; below this, report it. */
export const MIN_STREAM_HEIGHT = 480;

export class CameraError extends Error {
  readonly code: CameraErrorCode;
  constructor(code: CameraErrorCode, message: string) {
    super(message);
    this.name = 'CameraError';
    this.code = code;
  }
}

/** Lists video inputs. Labels are empty until permission has been granted once. */
export async function listCameras(): Promise<Array<{ deviceId: string; label: string }>> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  // Virtual cameras (DroidCam, OBS…) can deliver black frames when their source app is not
  // connected, so list physical cameras first; the default choice is then a real camera.
  const isVirtual = (label: string) => /droidcam|virtual|obs/i.test(label);
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Camera (press Start to allow)' }))
    .sort((a, b) => Number(isVirtual(a.label)) - Number(isVirtual(b.label)));
}

function mapError(error: unknown): CameraError {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return new CameraError('permission_denied', 'Camera permission was denied.');
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return new CameraError('no_camera', 'No matching camera was found.');
  if (name === 'NotReadableError' || name === 'AbortError')
    return new CameraError('device_busy', 'The camera is in use by another application.');
  return new CameraError('unknown', error instanceof Error ? error.message : String(error));
}

type VideoFrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/**
 * Opens a camera fully on-device. Frames stay in memory; nothing is written or sent.
 * `rotate` turns a landscape device (e.g. a phone via DroidCam) into a portrait source.
 */
export async function openCamera(options: CameraOptions = {}): Promise<CameraHandle> {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new CameraError('no_camera', 'getUserMedia is not available in this browser.');
  const rotate = options.rotate ?? 0;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
        width: { ideal: options.width ?? 1280 },
        height: { ideal: options.height ?? 720 },
        frameRate: { ideal: options.frameRate ?? 30 },
      },
    });
  } catch (error) {
    throw mapError(error);
  }

  const video = document.createElement('video') as VideoFrameCallbackVideo;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();

  const track = stream.getVideoTracks()[0];
  if (options.minFrameRate) {
    // Best effort: keep a frame-rate floor so auto-exposure cannot halve the fps in dim light.
    try {
      await track.applyConstraints({
        frameRate: { min: options.minFrameRate, ideal: options.frameRate ?? 30 },
      });
    } catch {
      // OverconstrainedError or unsupported: keep the stream as negotiated (see CameraOptions).
    }
  }
  const settings = track.getSettings();
  const streamWidth = video.videoWidth || settings.width || 0;
  const streamHeight = video.videoHeight || settings.height || 0;
  if (Math.min(streamWidth, streamHeight) < MIN_STREAM_HEIGHT) {
    stream.getTracks().forEach((t) => t.stop());
    throw new CameraError(
      'resolution_too_low',
      `Camera delivers ${streamWidth}×${streamHeight}; at least ${MIN_STREAM_HEIGHT}p is required.`,
    );
  }

  let canvas: HTMLCanvasElement | undefined;
  let context: CanvasRenderingContext2D | null = null;
  if (rotate !== 0) {
    canvas = document.createElement('canvas');
    canvas.width = streamHeight;
    canvas.height = streamWidth;
    context = canvas.getContext('2d', { alpha: false });
  }

  const listeners = new Set<(frameTime: number) => void>();
  const frameTimes: number[] = [];
  let closed = false;
  let handle = 0;

  const onVideoFrame = (now: number) => {
    if (closed) return;
    if (canvas && context) {
      context.save();
      context.translate(canvas.width / 2, canvas.height / 2);
      context.rotate((rotate * Math.PI) / 180);
      context.drawImage(video, -streamWidth / 2, -streamHeight / 2, streamWidth, streamHeight);
      context.restore();
    }
    frameTimes.push(now);
    while (frameTimes.length && now - frameTimes[0] > 1000) frameTimes.shift();
    for (const listener of listeners) listener(now);
    schedule();
  };
  const schedule = () => {
    if (video.requestVideoFrameCallback)
      handle = video.requestVideoFrameCallback((now) => onVideoFrame(now));
    else handle = requestAnimationFrame((now) => onVideoFrame(now));
  };
  schedule();

  const info = (): CameraInfo => ({
    deviceId: settings.deviceId ?? options.deviceId ?? '',
    label: track.label,
    width: canvas ? canvas.width : streamWidth,
    height: canvas ? canvas.height : streamHeight,
    fps: frameTimes.length,
    portrait: rotate !== 0,
  });

  return {
    video,
    source: canvas ?? video,
    onFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    info,
    close() {
      if (closed) return;
      closed = true;
      if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle);
      else cancelAnimationFrame(handle);
      listeners.clear();
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}
