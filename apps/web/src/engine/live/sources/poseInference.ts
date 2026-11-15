// The callback owns borrowed MediaPipe masks only during the call. Copy exactly once before
// transfer; never clone/re-upload a GPU mask on the UI thread. No threshold/resolution changes.
import type { PoseLandmarker, PoseLandmarkerResult } from '@mediapipe/tasks-vision';
import type { PoseGraphMode, PoseWorkerReply, WorkerLandmark } from './poseWorkerProtocol';

type Result = Extract<PoseWorkerReply, { type: 'result' }>;
type Detector = Pick<PoseLandmarker, 'detect' | 'detectForVideo'>;

export function inferPose(
  detector: Detector,
  bitmap: ImageBitmap | OffscreenCanvas,
  mode: PoseGraphMode,
  timestamp: number,
  id: number,
  now: () => number = () => performance.now(),
): Result {
  const begin = now();
  let result: Result | undefined;
  const copy = (items: WorkerLandmark[]) => items.map((p) => ({ ...p }));
  const receive = (value: PoseLandmarkerResult) => {
    const mask = value.segmentationMasks?.[0];
    result = {
      type: 'result',
      id,
      width: bitmap.width,
      height: bitmap.height,
      image: value.landmarks[0] ? copy(value.landmarks[0]) : undefined,
      world: value.worldLandmarks[0] ? copy(value.worldLandmarks[0]) : undefined,
      mask: mask
        ? {
            width: mask.width,
            height: mask.height,
            data: new Float32Array(mask.getAsFloat32Array()),
          }
        : undefined,
      inferenceMs: 0,
    };
    // Callback masks belong to MediaPipe: it releases them when this callback returns.
  };
  if (mode === 'IMAGE') detector.detect(bitmap, receive);
  else detector.detectForVideo(bitmap, timestamp, receive);
  if (!result) throw new Error('PoseLandmarker did not synchronously deliver a result.');
  result.inferenceMs = now() - begin;
  return result;
}
