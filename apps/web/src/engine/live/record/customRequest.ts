// The body service request for a recorded move: POST /motion/{body_id}/custom/frames.bin
// (services/body/body_service/motion/custom.py, FORMAT.md). Hand-written like MotionClient's
// motion schemas: the response is a binary SATB container, the request is two fields.
import { POSE_LIMITS } from '@satisfy/vision';
import type { AnatomicalPose } from '../../motion/rig.ts';
import { RECORD } from './config.ts';
import { RECORDED_DOFS, type RecordedPose } from './recordedPoses.ts';

/** The service's request: `t` in SECONDS from the first pose; partial poses (left out = neutral). */
export type CustomMotionRequest = { fps: number; poses: { t: number; pose: AnatomicalPose }[] };

const ID = /^[a-f0-9]{64}$/;

/**
 * Converts a recorded move (`t` in ms, LiveFrame clock) to the service's request. Checks what the
 * service checks, so a bad recording fails here with a readable message: at least 2 poses,
 * strictly increasing times, at most RECORD.maxDurationMs, known DOFs inside the anatomical
 * limits, finite numbers. pelvis_drop_m is dropped (the rig solves it). `fps` is the measured
 * median sample rate, within the service's range.
 */
export function customMotionRequest(poses: readonly RecordedPose[]): CustomMotionRequest {
  if (poses.length < 2) throw new Error('A recorded move needs at least two poses.');
  const t0 = poses[0].t;
  const out: CustomMotionRequest['poses'] = [];
  const intervals: number[] = [];
  for (let i = 0; i < poses.length; i++) {
    const { t, pose } = poses[i];
    if (!Number.isFinite(t)) throw new Error('Pose times must be finite.');
    if (i > 0) {
      const dt = t - poses[i - 1].t;
      if (!(dt > 0)) throw new Error('Pose times must be strictly increasing.');
      intervals.push(dt);
    }
    const clean: AnatomicalPose = {};
    for (const [dof, value] of Object.entries(pose)) {
      if (dof === 'pelvis_drop_m') continue;
      if (!RECORDED_DOFS.includes(dof)) throw new Error(`Unknown pose DOF ${dof}.`);
      const [low, high] = POSE_LIMITS[dof as keyof typeof POSE_LIMITS];
      if (!Number.isFinite(value) || value < low || value > high)
        throw new Error(`${dof} is outside the anatomical limits.`);
      clean[dof] = value;
    }
    // Seconds; the first pose is exactly 0 (the service requires it).
    out.push({ t: i === 0 ? 0 : (t - t0) / 1000, pose: clean });
  }
  const durationMs = poses[poses.length - 1].t - t0;
  if (durationMs > RECORD.maxDurationMs)
    throw new Error(`A recorded move can be at most ${RECORD.maxDurationMs / 1000} s.`);
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)];
  const [lo, hi] = RECORD.fpsRange;
  // The declared rate bounds the sample count (ceil(8 s · fps) + 1); never below the mean rate.
  const mean = ((poses.length - 1) * 1000) / Math.max(durationMs, 1e-9);
  const fps = Math.min(hi, Math.max(lo, 1000 / median, mean));
  return { fps, poses: out };
}

/** POSTs the request and returns the motion-frames container. Never cached (body data). */
export async function fetchCustomFrames(
  bodyId: string,
  request: CustomMotionRequest,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (!ID.test(bodyId)) throw new Error('Invalid body ID');
  const response = await fetch(`/api/motion/${bodyId}/custom/frames.bin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    cache: 'no-store',
    signal,
  });
  if (response.status === 404) throw new Error('Body expired from memory. Build your body again.');
  if (response.status === 422) {
    const body = (await response.json().catch(() => null)) as {
      detail?: { msg?: string }[];
    } | null;
    throw new Error(`The recorded move was rejected: ${body?.detail?.[0]?.msg ?? 'invalid data'}`);
  }
  if (!response.ok) throw new Error(`Motion data unavailable (${response.status})`);
  return response.arrayBuffer();
}
