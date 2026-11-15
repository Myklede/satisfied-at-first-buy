import type { PoseLandmark, PoseSegmentationMask, PoseTrackerModel } from '@satisfy/vision';

/** Experimental graph mode. IMAGE removes temporal ROI/smoothing feedback, not model detail. */
export type PoseGraphMode = 'VIDEO' | 'IMAGE';
export type WorkerLandmark = PoseLandmark & { presence?: number };
export type PoseWorkerInit = {
  type: 'init';
  model: PoseTrackerModel;
  delegate: 'GPU' | 'CPU';
  mode: PoseGraphMode;
  segmentation: boolean;
  /** Isolation probes must fail instead of silently changing delegate. */
  allowCpuFallback: boolean;
};
export type PoseWorkerRequest =
  | PoseWorkerInit
  | {
      type: 'frame';
      id: number;
      bitmap: ImageBitmap;
      timestamp: number;
      /** poseSync=1: transfer the bitmap back with the result (the frame the AR then shows). */
      returnBitmap?: boolean;
    };
export type PoseWorkerReply =
  | {
      type: 'ready';
      delegate: 'GPU' | 'CPU';
      gpuFallbackReason?: string;
      /** UNMASKED_RENDERER_WEBGL of MediaPipe's context in the worker (diagnostics only). */
      renderer?: string;
    }
  | { type: 'error'; id?: number; message: string }
  | {
      type: 'result';
      id: number;
      width: number;
      height: number;
      image?: WorkerLandmark[];
      world?: WorkerLandmark[];
      mask?: PoseSegmentationMask;
      /** The inferred frame itself, when the request asked for it back (returnBitmap). */
      bitmap?: ImageBitmap;
      /** Worker-local duration including owned mask copy/readback; not a main-clock timestamp. */
      inferenceMs: number;
    };

/**
 * URL flags of the real-time pose experiments (F2, prompt 23). All OFF by default; defaults stay
 * unchanged until the native frozen/coverage/onset/performance gates pass on AC power.
 * - poseWorker=1: pose inference + mask readback in a module worker (main thread never blocks).
 * - poseMode=image: the stateless IMAGE graph (worker only).
 * - poseDelegate=cpu|gpu: the same full model on XNNPACK (CPU) or WebGL (GPU); no quality change.
 * - posePipe=1 (worker only): while the worker infers, the newest camera frame is captured and
 *   waits in ONE latest-wins slot, sent the moment the worker is free (older waiting frames are
 *   dropped, never queued), so the worker never idles between frames.
 * - poseSync=1 (worker only): the AR shows the exact camera frame each pose was inferred on (the
 *   worker hands the frame back), so the jacket and the body in the picture are never a frame
 *   apart; the video then advances with the poses instead of ahead of them.
 * - poseClock=1 (worker only): a finished pose is delivered (AR drawn) in the next display
 *   frame, right after that frame's camera callback has sent the next frame to the worker, so
 *   inference overlaps the main thread's AR work instead of waiting behind it.
 */
export function poseWorkerFlags(search: string) {
  const params = new URLSearchParams(search);
  const enabled = params.get('poseWorker') === '1';
  const mode: PoseGraphMode = params.get('poseMode') === 'image' ? 'IMAGE' : 'VIDEO';
  if (!enabled && mode === 'IMAGE')
    throw new Error('poseMode=image requires poseWorker=1 (the vision tracker is unchanged).');
  const d = params.get('poseDelegate');
  const delegate: 'GPU' | 'CPU' | undefined = d === 'cpu' ? 'CPU' : d === 'gpu' ? 'GPU' : undefined;
  const pipeline = enabled && params.get('posePipe') === '1';
  const sync = enabled && params.get('poseSync') === '1';
  const clock = enabled && params.get('poseClock') === '1';
  return { enabled, mode, delegate, pipeline, sync, clock };
}
