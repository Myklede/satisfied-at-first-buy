// Active durations come from prompt16a. Preparation gaps make the 58s move list a 74.5s routine.
export const COUNTDOWN_MS = 3000;
export const TRANSITION_MS = 1500;
export const CAMERA_OPTIONS = {
  width: 1280,
  height: 720,
  frameRate: 30,
  minFrameRate: 24,
} as const;
// Prompt16a asks >=5 Mbit/s; the existing mirror diagnostics also targets 7 Mbit/s.
export const VIDEO_BITS_PER_SECOND = 7_000_000;
export const MOVES = [
  { name: 'facing_relaxed', cue: 'Face the camera, arms relaxed', seconds: 5 },
  { name: 'arms_hanging', cue: 'Let your arms hang close to your body', seconds: 5 },
  { name: 'raise_both_arms', cue: 'Slowly raise both arms overhead, hold, then lower', seconds: 6 },
  { name: 'cross_arms', cue: 'Cross your arms. Give yourself a hug', seconds: 5 },
  { name: 'hands_on_hips', cue: 'Place your hands on your hips', seconds: 4 },
  { name: 'walk_in_place', cue: 'Walk in place, swinging your arms', seconds: 6 },
  {
    name: 'turn_45_left_right',
    cue: 'Turn 45° to your left, hold, return. Then right, hold, return',
    seconds: 10,
  },
  {
    name: 'show_back',
    cue: 'Turn around. Hold your back to the camera for 3 seconds, then return',
    seconds: 8,
  },
  { name: 'step_closer_back', cue: 'Step closer, then step back', seconds: 6 },
  { name: 'touch_chin', cue: 'Touch your chin to mark the collar height', seconds: 3 },
] as const;

export interface CaptureStep {
  name: string;
  startMs: number;
  endMs: number;
}
let cursor = COUNTDOWN_MS;
export const STEPS: readonly CaptureStep[] = MOVES.map((move, index) => {
  if (index) cursor += TRANSITION_MS;
  const startMs = cursor;
  cursor += move.seconds * 1000;
  return { name: move.name, startMs, endMs: cursor };
});
export const ROUTINE_MS = cursor;
// CX-DAY needs an isolated back hold. Keep ten movements, splitting only its eight-second cue.
export const SEGMENTS: readonly (CaptureStep & { cue: string })[] = STEPS.flatMap((step, index) =>
  step.name === 'show_back'
    ? [
        {
          name: 'show_back_turn_out',
          startMs: step.startMs,
          endMs: step.startMs + 2500,
          cue: 'Turn around to show your back',
        },
        {
          name: 'back_hold',
          startMs: step.startMs + 2500,
          endMs: step.startMs + 5500,
          cue: 'Hold your back to the camera for 3 seconds',
        },
        {
          name: 'show_back_turn_in',
          startMs: step.startMs + 5500,
          endMs: step.endMs,
          cue: 'Turn back to face the camera',
        },
      ]
    : [{ ...step, cue: MOVES[index].cue }],
);

export function routineAt(elapsedMs: number) {
  if (elapsedMs >= ROUTINE_MS)
    return {
      kind: 'done' as const,
      cue: 'Routine complete',
      remainingMs: 0,
      step: MOVES.length,
      progress: 1,
    };
  const index = STEPS.findIndex((step) => elapsedMs < step.endMs);
  const step = STEPS[index];
  if (elapsedMs < step.startMs)
    return {
      kind: index === 0 ? ('countdown' as const) : ('transition' as const),
      cue: `Get ready: ${MOVES[index].cue}`,
      remainingMs: step.startMs - Math.max(0, elapsedMs),
      step: index + 1,
      progress: Math.max(0, elapsedMs / ROUTINE_MS),
    };
  const segmentIndex = SEGMENTS.findIndex(
    (segment) => elapsedMs >= segment.startMs && elapsedMs < segment.endMs,
  );
  const segment = SEGMENTS[segmentIndex];
  return {
    kind: 'move' as const,
    cue: segment.cue,
    remainingMs: segment.endMs - elapsedMs,
    step: index + 1,
    segmentIndex,
    name: segment.name,
    progress: elapsedMs / ROUTINE_MS,
  };
}

export function captureBase(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `capture-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
