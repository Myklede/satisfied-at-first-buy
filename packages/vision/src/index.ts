// Public API of @satisfy/vision (owned by Claude; see AGENTS.md §1).
export type * from './types';
export { CameraError, MIN_STREAM_HEIGHT, listCameras, openCamera } from './camera';
export { OneEuroFilter, OneEuroVecFilter } from './oneEuro';
export type { OneEuroParams } from './oneEuro';
export { DEFAULT_PINCH_TUNING, PinchTracker } from './pinch';
export type { GrabEvent, PinchTuning, TrackedHand, TrackedHandFrame } from './pinch';
export { DEFAULT_GRAB_MODEL } from './grip';
export type { GrabModel, GripConfidence, GripType } from './grip';
export { DEFAULT_HAND_MODEL_PATH, DEFAULT_WASM_BASE_PATH, createHandTracker } from './hands';
export type {
  CreateHandTrackerOptions,
  HandTrackerDetailedStats,
  TunableHandTracker,
} from './hands';
export { createBodyScanner } from './scan';
export type {
  BodyScannerHandle,
  BodyScannerLabOptions,
  ScanResultDetailed,
  ScanStats,
  ScanFrameDebug,
  PoseModel,
  Delegate,
} from './scan';
export { UNCALIBRATED, parseCalibrationSet, applyCalibration } from './calibration';
export type { CalibrationSet, CalibrationEntry } from './calibration';
export {
  ANATOMICAL_DOFS,
  POSE_LIMITS,
  NeutralCalibrator,
  estimateAnatomicalPose,
  neutralPose,
  humerusDirectionLocal,
  forearmDirectionLocal,
  humerusRotate,
  armAnglesFromLocal,
} from './anatomicalPose';
export type {
  AnatomicalDof,
  AnatomicalPose,
  PoseConfidence,
  NeutralCalibration,
  PoseEstimate,
  PoseLandmarksInput,
  PoseLandmark,
  CalibrationProgress,
  CalibrationIssue,
} from './anatomicalPose';
export { PosePipeline, POSE_FILTER_PARAMS } from './posePipeline';
export type { PoseTrackerFrame, PosePipelineOptions } from './posePipeline';
export { createPoseTracker, DEFAULT_POSE_TRACKER_MODEL } from './poseTracker';
export type {
  PoseTracker,
  PoseTrackerOptions,
  PoseTrackerStats,
  PoseTrackerModel,
  PoseSegmentationMask,
} from './poseTracker';
export { poseSkeleton, synthesizeLandmarks, SKELETON_BONES, DEFAULT_SEGMENTS } from './poseSynth';
export type { Skeleton, SkeletonSegments, JointName } from './poseSynth';
export {
  parsePoseRecording,
  serializePoseRecording,
  replayPoseRecording,
  POSE_MOTION_TAGS,
} from './poseRecording';
export type { PoseRecording, RecordedPoseFrame, PoseMotionTag } from './poseRecording';
export {
  parseHandRecording,
  serializeHandRecording,
  frameToObservations,
  replayRecording,
} from './handRecording';
export type { HandRecording, RecordedHandFrame, RecordedHand } from './handRecording';
export { SELFIE_CLASSES, createSelfieSegmenter } from './selfieSegmenter';
export type {
  SelfieClassMask,
  SegmenterSource,
  SelfieSegmenter,
  CreateSelfieSegmenterOptions,
} from './selfieSegmenter';
