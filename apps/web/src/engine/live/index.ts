// Public entry of the live try-on engine (V1). The kiosk screen (CX-TRY) and the labs import from
// here; the contract types live in ./contract.ts (lead).
export type * from './contract.ts';
export {
  createLiveTryOn,
  garmentFitLoader,
  LiveTryOnEngine,
  type DiagnosticEntry,
  type LiveStats,
  type LiveTryOnDeps,
  type PoseAdjuster,
  type StaticFit,
} from './LiveTryOnEngine.ts';
export { LiveAvatar } from './LiveAvatar.ts';
export { createCameraSource, LIVE_CAMERA } from './sources/cameraSource.ts';
export { createVideoFileSource, videoHandle } from './sources/videoFileSource.ts';
export { RecordingSource, recordingFrames } from './sources/recordingSource.ts';
export { isCalibratable, TrackedSource, VISION_ASSET_BASE } from './sources/trackedSource.ts';
