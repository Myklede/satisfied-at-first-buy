// Pose landmark recordings for real-data regression tests. Pure (no DOM).
//
// A recording holds ONLY numbers: per-frame timestamps, frame size and MediaPipe's 33 image +
// world landmarks [x, y, z, visibility], plus the neutral calibration in effect. No pixels. The
// lab (lab/pose.html) saves one only when the user clicks "Record pose"; put files in
// packages/vision/test-data/pose/ (gitignored: body geometry is personal data) and
// `npx vitest run` replays them through the same PosePipeline the live tracker uses.

import {
  POSE_LANDMARK_COUNT,
  type NeutralCalibration,
  type PoseLandmark,
  type PoseLandmarksInput,
  type Vec3,
} from './anatomicalPose';
import { PosePipeline, type PosePipelineOptions, type PoseTrackerFrame } from './posePipeline';

export const POSE_RECORDING_FORMAT = 'satisfy-pose-recording';
export const POSE_RECORDING_VERSION = 1;
/** Decimal places kept: 1e-5 m world / 1e-5 of the frame (≈ 0.01 px at 720p). Lossless here. */
export const POSE_RECORDING_DECIMALS = 5;

/** Motion performed in a recording (motion-contract.md preset ids, plus neutral and mixed). */
export const POSE_MOTION_TAGS = [
  'neutral',
  'reach_up_both',
  'reach_up_one',
  'reach_forward',
  'sit',
  'bend_tie_shoes',
  'cross_arms',
  'mixed',
] as const;
export type PoseMotionTag = (typeof POSE_MOTION_TAGS)[number];

export type Quad = [number, number, number, number];

export interface RecordedPoseFrame {
  /** Camera frame time, performance.now() ms. */
  t: number;
  width: number;
  height: number;
  /** Absent when no person was detected in this frame. */
  world?: Quad[];
  image?: Quad[];
}

export interface PoseRecordingMeta {
  motion?: PoseMotionTag;
  note?: string;
  invalid?: boolean;
  invalidReason?: string;
}

export interface PoseRecording {
  format: typeof POSE_RECORDING_FORMAT;
  version: typeof POSE_RECORDING_VERSION;
  createdAt: string;
  source: {
    camera: string;
    width: number;
    height: number;
    fps: number;
    delegate: string;
    model: string;
  };
  /** Neutral calibration active when recording started (null = uncalibrated). */
  calibration: NeutralCalibration | null;
  meta: PoseRecordingMeta;
  frames: RecordedPoseFrame[];
}

const toLandmark = (q: Quad): PoseLandmark => ({ x: q[0], y: q[1], z: q[2], visibility: q[3] });
export const landmarkToQuad = (p: PoseLandmark): Quad => [p.x, p.y, p.z, p.visibility ?? 0];

/** Converts a recorded frame to estimator input (used live and in replay). */
export function recordedFrameToInput(frame: RecordedPoseFrame): PoseLandmarksInput | undefined {
  if (!frame.world) return undefined;
  return { world: frame.world.map(toLandmark), image: frame.image?.map(toLandmark) };
}

const round = (v: number) => Number(v.toFixed(POSE_RECORDING_DECIMALS));

export function serializePoseRecording(rec: PoseRecording): string {
  const frames = rec.frames.map((f) => ({
    ...f,
    t: Number(f.t.toFixed(3)),
    world: f.world?.map((q) => q.map(round)),
    image: f.image?.map((q) => q.map(round)),
  }));
  return JSON.stringify({ ...rec, frames });
}

function fail(msg: string): never {
  throw new Error(`Invalid pose recording: ${msg}`);
}
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseQuads(v: unknown, what: string): Quad[] {
  if (!Array.isArray(v) || v.length !== POSE_LANDMARK_COUNT)
    fail(`${what} must be ${POSE_LANDMARK_COUNT} [x,y,z,visibility] quads.`);
  return v.map((q) => {
    if (!Array.isArray(q) || q.length !== 4 || !q.every(isNum)) fail(`${what}: bad quad.`);
    return [q[0], q[1], q[2], q[3]] as Quad;
  });
}

function parseCalibration(v: unknown): NeutralCalibration | null {
  if (v === null || v === undefined) return null;
  if (!isObj(v)) fail('calibration must be an object or null.');
  const up = v.up;
  if (!Array.isArray(up) || up.length !== 3 || !up.every(isNum)) fail('calibration.up: 3 numbers.');
  const h = v.standingHipHeightM;
  if (h !== null && !(isNum(h) && h > 0.3 && h < 1.5))
    fail('calibration.standingHipHeightM must be null or 0.3..1.5 m.');
  return {
    up: [up[0], up[1], up[2]] as Vec3,
    standingHipHeightM: h as number | null,
    frames: isNum(v.frames) ? v.frames : 0,
  };
}

/** Validates untrusted JSON (e.g. a file in test-data/pose/) into a PoseRecording. */
export function parsePoseRecording(json: unknown): PoseRecording {
  if (!isObj(json)) fail('not an object.');
  if (json.format !== POSE_RECORDING_FORMAT) fail(`format must be "${POSE_RECORDING_FORMAT}".`);
  if (json.version !== POSE_RECORDING_VERSION) fail(`unsupported version ${String(json.version)}.`);
  if (!Array.isArray(json.frames)) fail('frames must be an array.');
  const metaIn = isObj(json.meta) ? json.meta : {};
  const meta: PoseRecordingMeta = {};
  if (metaIn.motion !== undefined) {
    if (!(POSE_MOTION_TAGS as readonly unknown[]).includes(metaIn.motion))
      fail(`meta.motion must be one of ${POSE_MOTION_TAGS.join(', ')}.`);
    meta.motion = metaIn.motion as PoseMotionTag;
  }
  if (typeof metaIn.note === 'string') meta.note = metaIn.note;
  if (metaIn.invalid !== undefined) {
    if (typeof metaIn.invalid !== 'boolean') fail('meta.invalid must be boolean.');
    meta.invalid = metaIn.invalid;
  }
  if (typeof metaIn.invalidReason === 'string') meta.invalidReason = metaIn.invalidReason;
  const src = isObj(json.source) ? json.source : {};
  let lastT = -Infinity;
  const frames = json.frames.map((f, i): RecordedPoseFrame => {
    if (!isObj(f)) fail(`frame ${i} is not an object.`);
    if (!isNum(f.t) || f.t < lastT) fail(`frame ${i}: t must be finite and non-decreasing.`);
    lastT = f.t;
    if (!isNum(f.width) || !isNum(f.height) || f.width <= 0 || f.height <= 0)
      fail(`frame ${i}: bad size.`);
    const out: RecordedPoseFrame = { t: f.t, width: f.width, height: f.height };
    if (f.world !== undefined) out.world = parseQuads(f.world, `frame ${i} world`);
    if (f.image !== undefined) out.image = parseQuads(f.image, `frame ${i} image`);
    return out;
  });
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const num = (v: unknown) => (isNum(v) ? v : 0);
  return {
    format: POSE_RECORDING_FORMAT,
    version: POSE_RECORDING_VERSION,
    createdAt: str(json.createdAt),
    source: {
      camera: str(src.camera),
      width: num(src.width),
      height: num(src.height),
      fps: num(src.fps),
      delegate: str(src.delegate),
      model: str(src.model),
    },
    calibration: parseCalibration(json.calibration),
    meta,
    frames,
  };
}

/** Feeds a recording through a fresh PosePipeline (with the recorded calibration). */
export function replayPoseRecording(
  rec: PoseRecording,
  options: PosePipelineOptions = {},
): PoseTrackerFrame[] {
  const pipeline = new PosePipeline({ calibration: rec.calibration, ...options });
  return rec.frames.map((f) => pipeline.update(f.t, recordedFrameToInput(f)));
}
