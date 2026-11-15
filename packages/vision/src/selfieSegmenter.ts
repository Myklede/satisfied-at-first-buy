// Multiclass selfie segmentation (MediaPipe ImageSegmenter, selfie_multiclass_256x256).
// Each pixel gets a category: 0 background, 1 hair, 2 body-skin, 3 face-skin, 4 clothes, 5 others.
// Used by the live AR finisher (agent V4) to cover the person's real clothes and to composite
// only real skin (the hands) over the virtual jacket.
//
// Fully on-device: frames stay in memory, and nothing is written or sent (installNetworkGuard).
// The default delegate is CPU. On the demo laptop (ANGLE/D3D11) GPU mask readbacks failed for the
// pose landmarker (see scan.ts). GPU is opt-in; if its creation or its first readback fails, this
// switches to CPU once.
import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import { installNetworkGuard } from './networkGuard';

export const SELFIE_CLASSES = [
  'background',
  'hair',
  'body-skin',
  'face-skin',
  'clothes',
  'others',
] as const;

/** One category per pixel (row 0 = top), at the model's output size. */
/** Frame sources segmentForVideo accepts, including worker-side ImageBitmap / OffscreenCanvas. */
export type SegmenterSource = HTMLVideoElement | HTMLCanvasElement | ImageBitmap | OffscreenCanvas;

export type SelfieClassMask = { data: Uint8Array; width: number; height: number };

export interface SelfieSegmenter {
  /** Segments one frame. Timestamps are made strictly increasing. null if no mask came back. */
  segment(source: SegmenterSource, timestampMs: number): SelfieClassMask | null;
  /** Duration of the last segment() call, ms. */
  readonly inferenceMs: number;
  readonly delegate: 'GPU' | 'CPU';
  close(): void;
}

export interface CreateSelfieSegmenterOptions {
  /** URL prefix where /models and /mediapipe/wasm are served. Default '/'. */
  assetBase?: string;
  /** Default 'CPU' (see the header comment). */
  delegate?: 'GPU' | 'CPU';
}

async function createSegmenter(
  assetBase: string,
  delegate: 'GPU' | 'CPU',
): Promise<ImageSegmenter> {
  installNetworkGuard();
  // In a module Web Worker (no document) only the ES-module wasm loader sets ModuleFactory.
  const fileset = await FilesetResolver.forVisionTasks(
    `${assetBase}mediapipe/wasm`,
    typeof document === 'undefined',
  );
  return ImageSegmenter.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: `${assetBase}models/selfie_multiclass_256x256.tflite`,
      delegate,
    },
    runningMode: 'VIDEO',
    outputCategoryMask: true,
    outputConfidenceMasks: false,
  });
}

/** Copies the category mask out of a result (the result is closed by the caller). */
function readMask(result: ReturnType<ImageSegmenter['segmentForVideo']>): SelfieClassMask | null {
  const mask = result.categoryMask;
  if (!mask) return null;
  return { data: mask.getAsUint8Array().slice(), width: mask.width, height: mask.height };
}

export async function createSelfieSegmenter(
  options: CreateSelfieSegmenterOptions = {},
): Promise<SelfieSegmenter> {
  const assetBase = options.assetBase ?? '/';
  let delegate: 'GPU' | 'CPU' = options.delegate ?? 'CPU';
  let segmenter: ImageSegmenter;
  try {
    segmenter = await createSegmenter(assetBase, delegate);
  } catch (error) {
    if (delegate !== 'GPU') throw error;
    delegate = 'CPU';
    segmenter = await createSegmenter(assetBase, delegate);
  }
  let lastTs = -Infinity;
  let inferenceMs = 0;
  let verified = delegate === 'CPU';
  let closed = false;

  const run = (source: SegmenterSource, ts: number) => {
    const result = segmenter.segmentForVideo(source, ts);
    try {
      return readMask(result);
    } finally {
      result.close();
    }
  };

  return {
    get inferenceMs() {
      return inferenceMs;
    },
    get delegate() {
      return delegate;
    },
    segment(source, timestampMs) {
      if (closed) return null;
      const ts = timestampMs > lastTs ? timestampMs : lastTs + 1;
      lastTs = ts;
      const t0 = performance.now();
      try {
        const mask = run(source, ts);
        verified = true;
        return mask;
      } catch (error) {
        if (verified) throw error;
        // First GPU readback failed: switch to CPU once. The next call uses the new instance.
        segmenter.close();
        delegate = 'CPU';
        verified = true;
        void createSegmenter(assetBase, 'CPU').then((s) => {
          if (closed) s.close();
          else segmenter = s;
        });
        return null;
      } finally {
        inferenceMs = performance.now() - t0;
      }
    },
    close() {
      closed = true;
      segmenter.close();
    },
  };
}
