// Opt-in experiment (?poseWorker=1); the default tracker remains in @satisfy/vision. Full model +
// native bitmap + full Float32 person mask. All inference/readback stays in this worker.
// Privacy: the worker-local network guard (first import: it installs itself on evaluation, before
// MediaPipe's module runs) keeps MediaPipe's usage logger off the network (AGENTS.md §3).
import { installWorkerNetworkGuard, workerUrlAllowed } from './workerNetworkGuard';
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { inferPose } from './poseInference';
import type { PoseWorkerInit, PoseWorkerReply, PoseWorkerRequest } from './poseWorkerProtocol';

installWorkerNetworkGuard(); // idempotent; explicit in case the import-time check ever misses

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PoseWorkerRequest>) => void) | null;
  postMessage(message: PoseWorkerReply, transfer?: Transferable[]): void;
};
// Same installed 1.2.2 module-loader workaround as the existing segment.worker.ts (a module worker
// has no importScripts); loopback / same-origin URLs only.
(self as unknown as { import?: (url: string) => Promise<unknown> }).import = (url) => {
  const href = new URL(url, self.location.href).href;
  if (!workerUrlAllowed(href, self.location.href))
    return Promise.reject(new TypeError('Blocked by privacy guard: non-local script'));
  return import(/* @vite-ignore */ href);
};

let detector: PoseLandmarker | undefined;
let config: PoseWorkerInit | undefined;
let lastTimestamp = 1;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Diagnostics: the adapter MediaPipe's WebGL2 context runs on (getContext returns its context). */
function rendererOf(canvas: OffscreenCanvas | undefined): string | undefined {
  try {
    const gl = canvas?.getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : undefined;
  } catch {
    return undefined;
  }
}

async function initialize(init: PoseWorkerInit) {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(self.location.hostname))
    throw new Error('Experimental pose worker requires a loopback server.');
  // Fixed local asset paths, never a remote model URL or a path supplied by a camera frame.
  const assetBase = new URL('/vision/', self.location.origin).href;
  const fileset = await FilesetResolver.forVisionTasks(`${assetBase}mediapipe/wasm`, true);
  let canvas: OffscreenCanvas | undefined;
  const create = async (delegate: 'GPU' | 'CPU') => {
    canvas = new OffscreenCanvas(1, 1);
    const task = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: `${assetBase}models/pose_landmarker_${init.model}.task`,
        delegate,
      },
      canvas,
      runningMode: init.mode,
      numPoses: 1,
      // Library defaults; same values as vision/poseTracker.ts, not tuned to a reference clip.
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: init.segmentation,
    });
    try {
      const warm = new OffscreenCanvas(64, 64);
      warm.getContext('2d')?.fillRect(0, 0, 64, 64);
      inferPose(task, warm, init.mode, 1, 0);
      return task;
    } catch (error) {
      task.close();
      throw error;
    }
  };
  let delegate = init.delegate;
  let gpuFallbackReason: string | undefined;
  try {
    detector = await create(delegate);
  } catch (error) {
    if (delegate !== 'GPU' || !init.allowCpuFallback) throw error;
    gpuFallbackReason = message(error);
    delegate = 'CPU';
    detector = await create(delegate);
  }
  config = init;
  scope.postMessage({ type: 'ready', delegate, gpuFallbackReason, renderer: rendererOf(canvas) });
}

scope.onmessage = ({ data }) => {
  if (data.type === 'init') {
    void initialize(data).catch((error: unknown) =>
      scope.postMessage({ type: 'error', message: message(error) }),
    );
    return;
  }
  const { bitmap, id } = data;
  let returned = false;
  try {
    if (!detector || !config) throw new Error('Pose worker is not initialized.');
    // Main camera clock is preserved across transfer; worker wall-clock origin is irrelevant.
    const timestamp = Math.max(data.timestamp, lastTimestamp + 1);
    lastTimestamp = timestamp;
    const result = inferPose(detector, bitmap, config.mode, timestamp, id);
    const transfer: Transferable[] = result.mask ? [result.mask.data.buffer] : [];
    if (data.returnBitmap) {
      result.bitmap = bitmap;
      transfer.push(bitmap);
    }
    scope.postMessage(result, transfer);
    returned = !!data.returnBitmap;
  } catch (error) {
    scope.postMessage({ type: 'error', id, message: message(error) });
  } finally {
    if (!returned) bitmap.close();
  }
};
