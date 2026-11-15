// Selfie multiclass segmentation OFF the main thread (agent V4). A module worker running the
// lead's @satisfy/vision createSelfieSegmenter (MediaPipe ImageSegmenter, selfie_multiclass)
// on small ImageBitmaps sent by the finisher. The CPU (XNNPACK) inference took ≈ 100+ ms per
// frame on the main thread (V1's measurement, 2026-11-13); here it never blocks rendering.
//
// Privacy: the bitmap is processed in memory and closed; only the category mask (numbers) goes
// back. The wrapper installs the network guard in this worker too.
import { createSelfieSegmenter, type SelfieSegmenter } from '@satisfy/vision';
import { MASK_MAX_WIDTH } from './config';
import { packClasses } from './masks';

export type SegmentRequest =
  | { type: 'init'; assetBase: string; delegate: 'GPU' | 'CPU' }
  | { type: 'frame'; id: number; t: number; bitmap: ImageBitmap; postedAbs: number }
  | { type: 'close' };

export type SegmentReply =
  | { type: 'ready'; delegate: 'GPU' | 'CPU' }
  | { type: 'error'; message: string }
  | { type: 'skip'; id: number }
  | {
      type: 'mask';
      id: number;
      width: number;
      height: number;
      data: Uint8Array;
      /**
       * The mask packed into filterable RGBA channels here (masks.ts packClasses): off the main
       * thread, which received ≈ 25 masks/s from the GPU delegate (≈ 1 ms/frame to pack there).
       */
      packed: Uint8Array;
      packedWidth: number;
      packedHeight: number;
      /** Inference time inside the worker (ms). */
      ms: number;
      /**
       * Latency breakdown (F4): absolute times (performance.timeOrigin + now, ms, comparable
       * across the worker and the page) when the frame arrived here, inference and packing ended,
       * and the reply was posted.
       */
      recvAbs: number;
      inferAbs: number;
      packAbs: number;
    };

const scope = self as unknown as {
  postMessage(message: SegmentReply, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<SegmentRequest>) => void) | null;
  close(): void;
};

// MediaPipe loads its wasm loader with importScripts, and in a module worker (where that throws a
// TypeError) with `self.import(url)` when present, else `import(url)`. Vite's dev server appends
// `?import` to a root-relative dynamic import and refuses that for files in /public ("Failed to
// fetch dynamically imported module …vision_wasm_module_internal.js?import", first eval run).
// An absolute URL is left alone, so the loader gets one.
(self as unknown as { import?: (url: string) => Promise<unknown> }).import = (url: string) =>
  import(/* @vite-ignore */ new URL(url, self.location.href).href);

let segmenter: SelfieSegmenter | null = null;
const abs = () => performance.timeOrigin + performance.now();
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

scope.onmessage = (event) => {
  const m = event.data;
  if (m.type === 'init') {
    createSelfieSegmenter({ assetBase: m.assetBase, delegate: m.delegate })
      .then((s) => {
        segmenter = s;
        scope.postMessage({ type: 'ready', delegate: s.delegate });
      })
      .catch((e: unknown) => scope.postMessage({ type: 'error', message: message(e) }));
    return;
  }
  if (m.type === 'close') {
    segmenter?.close();
    segmenter = null;
    scope.close();
    return;
  }
  const { id, t, bitmap } = m;
  const recvAbs = abs();
  if (!segmenter) {
    bitmap.close();
    scope.postMessage({ type: 'skip', id });
    return;
  }
  try {
    // segmentForVideo accepts any ImageSource (an ImageBitmap here); the wrapper's type is
    // narrower than what MediaPipe takes.
    const mask = segmenter.segment(bitmap as unknown as HTMLCanvasElement, t);
    const ms = segmenter.inferenceMs;
    const inferAbs = abs();
    if (!mask) scope.postMessage({ type: 'skip', id });
    else {
      const p = packClasses(mask, MASK_MAX_WIDTH);
      const packAbs = abs();
      scope.postMessage(
        {
          type: 'mask',
          id,
          width: mask.width,
          height: mask.height,
          data: mask.data,
          packed: p.data,
          packedWidth: p.width,
          packedHeight: p.height,
          ms,
          recvAbs,
          inferAbs,
          packAbs,
        },
        [mask.data.buffer, p.data.buffer],
      );
    }
  } catch (e) {
    scope.postMessage({ type: 'error', message: message(e) });
  } finally {
    bitmap.close();
  }
};
