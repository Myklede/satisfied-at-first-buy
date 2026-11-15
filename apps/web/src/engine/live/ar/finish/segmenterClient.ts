// Main-thread side of the off-thread selfie segmenter (agent V4). Sends a small ImageBitmap of the
// person's upper-body box (createImageBitmap: asynchronous, no readback on this thread) to
// segment.worker.ts, at most one in flight; keeps the latest category mask with the box it covers
// and the landmark anchor at request time (the finisher shifts the mask by the person's motion
// since then: motion.ts). Main-thread cost: a createImageBitmap call and a postMessage per request.
import type { SelfieClassMask } from '@satisfy/vision';
import type { ByteMask } from './masks';
import type { LandmarkSnapshot } from './motion';
import type { SegmentReply, SegmentRequest } from './segment.worker';

/** Source-pixel box a mask covers. */
export type MaskRect = { x: number; y: number; w: number; h: number };

export type ClassMaskResult = {
  mask: SelfieClassMask;
  rect: MaskRect;
  /** The landmarks when the frame was sent (motion compensation), or null. */
  anchor: LandmarkSnapshot | null;
  /**
   * F4 (?f4mask=1 with the pose worker): the LiveFrame.t of the camera frame this mask was cut
   * from ('posecapture'), or null for a request made at draw time. The finisher pairs it with that
   * frame's landmarks when the frame is drawn.
   */
  tag: number | null;
  /** performance.now() when the frame was sent / when the mask arrived. */
  sentAt: number;
  arrivedAt: number;
  /** Inference inside the worker (ms). */
  workerMs: number;
  /** The mask packed in the worker (masks.ts packClasses at MASK_MAX_WIDTH). */
  packed: ByteMask;
  id: number;
  /**
   * F4 latency breakdown (ms): sent → bitmap ready, bitmap posted → worker received (queue),
   * inference, packing, reply posted → arrived here. The wait from arrival to the first frame that
   * uses it is the finisher's (FinishStats.classUseDelayMs).
   */
  timing: { bitmapMs: number; queueMs: number; inferMs: number; packMs: number; replyMs: number };
};

/**
 * F4 capture path: the result cut from the newest frame that is not newer than the drawn frame
 * `t` and was already drawn (its landmarks are in `drawn`), or null.
 */
export function pickCaptured<T extends { tag: number | null }>(
  recent: readonly T[],
  t: number,
  drawn: { has(t: number): boolean },
): T | null {
  let pick: T | null = null;
  for (const c of recent)
    if (c.tag !== null && c.tag <= t + 0.5 && drawn.has(c.tag) && (!pick || c.tag >= pick.tag!))
      pick = c;
  return pick;
}

/** The model's input size (selfie_multiclass_256x256): the long side of the bitmap. */
export const SEGMENT_INPUT = 256;

export class WorkerSegmenter {
  ready = false;
  delegate: 'GPU' | 'CPU' | null = null;
  error: string | null = null;
  latest: ClassMaskResult | null = null;
  /** The last few results, newest last (F4: pick the newest not newer than the drawn frame). */
  recent: ClassMaskResult[] = [];
  private worker?: Worker;
  private busy = false;
  private nextId = 0;
  private pending = new Map<
    number,
    Omit<ClassMaskResult, 'mask' | 'packed' | 'arrivedAt' | 'workerMs' | 'timing'> & {
      bitmapAbs?: number;
      postedAbs?: number;
    }
  >();

  constructor(assetBase: string, delegate: 'GPU' | 'CPU') {
    try {
      this.worker = new Worker(new URL('./segment.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return;
    }
    this.worker.onmessage = (event: MessageEvent<SegmentReply>) => this.onReply(event.data);
    this.worker.onerror = (event) => {
      this.error = event.message || 'segmenter worker failed to load';
      this.busy = false;
    };
    this.post({ type: 'init', assetBase, delegate });
  }

  private post(message: SegmentRequest, transfer: Transferable[] = []) {
    this.worker?.postMessage(message, transfer);
  }

  private onReply(m: SegmentReply) {
    if (m.type === 'ready') {
      this.ready = true;
      this.delegate = m.delegate;
      return;
    }
    if (m.type === 'error') {
      this.error = m.message;
      this.busy = false;
      return;
    }
    const sent = this.pending.get(m.id);
    this.pending.delete(m.id);
    this.busy = false;
    if (m.type === 'skip' || !sent) return;
    const arrivedAt = performance.now();
    const sentAbs = performance.timeOrigin + sent.sentAt;
    const { bitmapAbs = sentAbs, postedAbs = bitmapAbs, ...rest } = sent;
    this.latest = {
      ...rest,
      mask: { data: m.data, width: m.width, height: m.height },
      packed: { data: m.packed, width: m.packedWidth, height: m.packedHeight },
      arrivedAt,
      workerMs: m.ms,
      timing: {
        bitmapMs: bitmapAbs - sentAbs,
        queueMs: m.recvAbs - postedAbs,
        inferMs: m.inferAbs - m.recvAbs,
        packMs: m.packAbs - m.inferAbs,
        replyMs: performance.timeOrigin + arrivedAt - m.packAbs,
      },
    };
    this.recent.push(this.latest);
    if (this.recent.length > 4) this.recent.shift();
  }

  /**
   * Sends `rect` of the video for segmentation unless one is in flight. Returns true if sent.
   * `rect` is clamped to the frame.
   */
  request(
    video: HTMLVideoElement | HTMLCanvasElement,
    rect: MaskRect,
    frame: { width: number; height: number },
    anchor: LandmarkSnapshot | null,
    tag: number | null = null,
  ): boolean {
    if (!this.worker || !this.ready || this.busy || this.error) return false;
    const x = Math.max(0, Math.floor(rect.x)),
      y = Math.max(0, Math.floor(rect.y));
    const w = Math.min(frame.width - x, Math.ceil(rect.w)),
      h = Math.min(frame.height - y, Math.ceil(rect.h));
    if (w < 8 || h < 8) return false;
    // The video element's intrinsic size can differ from the frame's (both are source px here).
    const vw = video instanceof HTMLVideoElement ? video.videoWidth : video.width;
    const vh = video instanceof HTMLVideoElement ? video.videoHeight : video.height;
    if (!vw || !vh) return false;
    const kx = vw / frame.width,
      ky = vh / frame.height;
    const long = Math.max(w, h);
    const resizeWidth = Math.max(8, Math.round((SEGMENT_INPUT * w) / long));
    const resizeHeight = Math.max(8, Math.round((SEGMENT_INPUT * h) / long));
    const id = ++this.nextId;
    const sentAt = performance.now();
    this.busy = true;
    this.pending.set(id, { rect: { x, y, w, h }, anchor, sentAt, id, tag });
    createImageBitmap(video, x * kx, y * ky, w * kx, h * ky, {
      resizeWidth,
      resizeHeight,
      resizeQuality: 'low',
    })
      .then((bitmap) => {
        if (!this.worker) {
          bitmap.close();
          return;
        }
        const p = this.pending.get(id);
        const now = performance.timeOrigin + performance.now();
        if (p) p.bitmapAbs = p.postedAbs = now;
        this.post({ type: 'frame', id, t: sentAt, bitmap, postedAbs: now }, [bitmap]);
      })
      .catch((e: unknown) => {
        this.pending.delete(id);
        this.busy = false;
        this.error = e instanceof Error ? e.message : String(e);
      });
    return true;
  }

  dispose() {
    this.post({ type: 'close' });
    this.worker?.terminate();
    this.worker = undefined;
    this.pending.clear();
  }
}
