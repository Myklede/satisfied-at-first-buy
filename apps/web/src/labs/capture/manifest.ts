import { z } from 'zod';
import { SEGMENTS, ROUTINE_MS, VIDEO_BITS_PER_SECOND, type CaptureStep } from './routine';

const finite = z.number().finite();
export const jacketSchema = z.string().trim().min(1).max(100);
export const buildSchema = z.strictObject({
  commit: z.string().regex(/^[a-f0-9]{7,64}$/),
  dirty: z.boolean(),
});
export const captureManifestSchema = z
  .strictObject({
    schema: z.literal('satisfy-capture'),
    version: z.literal(1),
    createdAt: z.string().datetime(),
    videoFilename: z.string().regex(/^capture-\d{8}-\d{6}\.webm$/),
    build: buildSchema,
    jacket: jacketSchema,
    camera: z.strictObject({
      label: z.string(),
      width: finite.int().positive(),
      height: finite.int().positive(),
      fps: finite.nonnegative(),
    }),
    durationMs: finite.min(ROUTINE_MS),
    cameraMediaStartMs: finite.nonnegative(),
    timestampSource: z.literal('requestVideoFrameCallback'),
    note: z.literal(
      'Steps label operator cues, not automatically verified poses. Raw unmirrored camera; no overlay.',
    ),
    steps: z
      .array(
        z.strictObject({
          name: z.string(),
          startMs: finite.nonnegative(),
          endMs: finite.positive(),
        }),
      )
      .length(SEGMENTS.length),
    frames: z
      .array(z.strictObject({ tMs: finite.nonnegative(), mediaTimeMs: finite.nonnegative() }))
      .min(2)
      .max(30000),
    encoding: z.strictObject({
      mimeType: z.string().startsWith('video/webm'),
      requestedBitsPerSecond: finite.min(5_000_000),
      recorderBitsPerSecond: finite.min(5_000_000),
      actualBitsPerSecond: finite.positive(),
    }),
  })
  .superRefine((value, ctx) => {
    value.steps.forEach((step, index) => {
      const expected = SEGMENTS[index];
      if (
        step.name !== expected.name ||
        step.endMs <= step.startMs ||
        step.endMs > value.durationMs ||
        (index > 0 && step.startMs < value.steps[index - 1].endMs)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['steps', index],
          message: 'Step does not match the recorded routine timeline',
        });
    });
    value.frames.forEach((frame, index) => {
      if (
        frame.tMs > value.durationMs ||
        (index > 0 &&
          (frame.tMs <= value.frames[index - 1].tMs ||
            frame.mediaTimeMs < value.frames[index - 1].mediaTimeMs))
      )
        ctx.addIssue({
          code: 'custom',
          path: ['frames', index],
          message: 'Frame times must increase within the recorded video',
        });
    });
  });
export type CaptureManifest = z.infer<typeof captureManifestSchema>;
export type CaptureBuild = z.infer<typeof buildSchema>;
export type CaptureFrame = CaptureManifest['frames'][number];

export function makeManifest(input: {
  createdAt: Date;
  videoFilename: string;
  build: CaptureBuild;
  jacket: string;
  camera: { label: string; width: number; height: number };
  durationMs: number;
  cameraMediaStartMs: number;
  frames: CaptureFrame[];
  steps: CaptureStep[];
  mimeType: string;
  recorderBitsPerSecond: number;
  bytes: number;
}): CaptureManifest {
  const first = input.frames[0],
    last = input.frames.at(-1);
  const fps =
    first && last && last.tMs > first.tMs
      ? ((input.frames.length - 1) * 1000) / (last.tMs - first.tMs)
      : 0;
  return captureManifestSchema.parse({
    schema: 'satisfy-capture',
    version: 1,
    createdAt: input.createdAt.toISOString(),
    videoFilename: input.videoFilename,
    build: input.build,
    jacket: input.jacket,
    camera: { ...input.camera, fps },
    durationMs: input.durationMs,
    cameraMediaStartMs: input.cameraMediaStartMs,
    timestampSource: 'requestVideoFrameCallback',
    note: 'Steps label operator cues, not automatically verified poses. Raw unmirrored camera; no overlay.',
    steps: input.steps,
    frames: input.frames,
    encoding: {
      mimeType: input.mimeType,
      requestedBitsPerSecond: VIDEO_BITS_PER_SECOND,
      recorderBitsPerSecond: input.recorderBitsPerSecond,
      actualBitsPerSecond: (input.bytes * 8000) / input.durationMs,
    },
  });
}
