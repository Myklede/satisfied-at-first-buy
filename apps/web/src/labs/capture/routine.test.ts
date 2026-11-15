import { expect, it } from 'vitest';
import { captureBase, MOVES, ROUTINE_MS, routineAt, STEPS, SEGMENTS } from './routine';
import { captureManifestSchema, makeManifest } from './manifest';

it('retains all ten prescribed active durations and a 74.5s countdown/transition routine', () => {
  expect(MOVES.map((move) => move.seconds)).toEqual([5, 5, 6, 5, 4, 6, 10, 8, 6, 3]);
  expect(ROUTINE_MS).toBe(74500);
  expect(routineAt(0)).toMatchObject({ kind: 'countdown', remainingMs: 3000 });
  STEPS.forEach((step, index) => {
    expect(routineAt(step.startMs)).toMatchObject({
      kind: 'move',
      step: index + 1,
    });
    expect(step.endMs - step.startMs).toBe(MOVES[index].seconds * 1000);
    if (index) expect(step.startMs - STEPS[index - 1].endMs).toBe(1500);
  });
  expect(routineAt(8000)).toMatchObject({ kind: 'transition', step: 2, remainingMs: 1500 });
  expect(routineAt(74500)).toMatchObject({ kind: 'done', progress: 1 });
  expect(captureBase(new Date(2026, 10, 13, 19, 5, 9))).toBe('capture-20261113-190509');
});

const manifest = () =>
  makeManifest({
    createdAt: new Date('2026-11-13T19:00:00Z'),
    videoFilename: 'capture-20261113-190000.webm',
    build: { commit: 'a'.repeat(40), dirty: false },
    jacket: 'Synthetic fake-camera test',
    camera: { label: 'fake camera', width: 1280, height: 720 },
    durationMs: 74500,
    cameraMediaStartMs: 1000,
    frames: [
      { tMs: 10, mediaTimeMs: 1010 },
      { tMs: 50, mediaTimeMs: 1050 },
    ],
    steps: SEGMENTS.map(({ name, startMs, endMs }) => ({ name, startMs, endMs })),
    mimeType: 'video/webm;codecs=vp9',
    recorderBitsPerSecond: 7_000_000,
    bytes: 1_000_000,
  });

it('isolates the three-second back hold from both turn transitions', () => {
  const back = SEGMENTS.find((step) => step.name === 'back_hold')!;
  expect(back.endMs - back.startMs).toBe(3000);
  expect(routineAt(back.startMs - 1)).toMatchObject({ name: 'show_back_turn_out', step: 8 });
  expect(routineAt(back.startMs)).toMatchObject({ name: 'back_hold', step: 8 });
  expect(routineAt(back.endMs)).toMatchObject({ name: 'show_back_turn_in', step: 8 });
  expect(SEGMENTS).toHaveLength(12);
});
it('validates the export and computes delivered fps/actual bitrate, separate from requested bitrate', () => {
  const value = manifest();
  expect(value.camera.fps).toBe(25);
  expect(value.encoding.actualBitsPerSecond).toBeCloseTo(107382.55, 2);
  expect(value.encoding.actualBitsPerSecond).not.toBe(value.encoding.requestedBitsPerSecond);
  expect(captureManifestSchema.safeParse({ ...value, uploaded: true }).success).toBe(false);
});
it('rejects altered cue labels, missing jacket/build identity and non-monotonic timestamps', () => {
  const value = manifest();
  expect(captureManifestSchema.safeParse({ ...value, jacket: '' }).success).toBe(false);
  expect(
    captureManifestSchema.safeParse({ ...value, build: { commit: 'unknown', dirty: true } })
      .success,
  ).toBe(false);
  expect(
    captureManifestSchema.safeParse({
      ...value,
      steps: value.steps.map((step, index) =>
        index === 0 ? { ...step, name: 'inferred_pose' } : step,
      ),
    }).success,
  ).toBe(false);
  expect(
    captureManifestSchema.safeParse({ ...value, frames: [...value.frames].reverse() }).success,
  ).toBe(false);
});
it('preserves measured cue dispatch times rather than replacing them with the planned offsets', () => {
  const value = manifest();
  const shifted = {
    ...value,
    durationMs: value.durationMs + 17,
    steps: value.steps.map((step) => ({
      ...step,
      startMs: step.startMs + 17,
      endMs: step.endMs + 17,
    })),
  };
  expect(captureManifestSchema.parse(shifted).steps[0].startMs).toBe(3017);
});
