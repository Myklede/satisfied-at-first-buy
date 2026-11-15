// Measures the time from a set() call to a visible change in the Decart output video.
// Reads a 64x36 copy of each output frame in memory (never stored), see change-detect.ts.
import { ChangeDetector, meanAbsLumaDiff } from './change-detect';

const W = 64;
const H = 36;
const TIMEOUT_MS = 10_000;
const NOISE_WINDOW = 30;

export interface SwapResult {
  label: string;
  /** set() promise resolved after this many ms (null if it had not when the change was seen). */
  ackMs: number | null;
  /** First visibly changed frame, ms after set() was called; null = none within 10 s. */
  visibleMs: number | null;
  threshold: number;
}

type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
};

export class SwapProbe {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D | null;
  private running = false;
  private last: Uint8ClampedArray | null = null;
  private readonly noise: number[] = [];
  private pending: {
    t0: number;
    label: string;
    baseline: Uint8ClampedArray;
    detector: ChangeDetector;
    ackMs: number | null;
    resolve: (r: SwapResult) => void;
  } | null = null;

  constructor(private readonly video: HTMLVideoElement) {
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = null;
    this.noise.length = 0;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.last = null;
    this.finish(null);
  }

  /** Call right before set(); returns null when no output frame has arrived yet. */
  begin(label: string): { ack: () => void; result: Promise<SwapResult> } | null {
    if (!this.last) return null;
    this.finish(null);
    const t0 = performance.now();
    const baseline = this.last;
    const detector = new ChangeDetector(this.noise);
    const result = new Promise<SwapResult>((resolve) => {
      this.pending = { t0, label, baseline, detector, ackMs: null, resolve };
    });
    return {
      ack: () => {
        if (this.pending && this.pending.t0 === t0)
          this.pending.ackMs = Math.round(performance.now() - t0);
      },
      result,
    };
  }

  private finish(visibleAt: number | null): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.resolve({
      label: p.label,
      ackMs: p.ackMs,
      visibleMs: visibleAt === null ? null : Math.round(visibleAt - p.t0),
      threshold: p.detector.threshold,
    });
  }

  private schedule(): void {
    const v = this.video as VideoWithRvfc;
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => this.onFrame());
    else requestAnimationFrame(() => this.onFrame());
  }

  private onFrame(): void {
    if (!this.running) return;
    const now = performance.now();
    if (this.ctx && this.video.readyState >= 2) {
      this.ctx.drawImage(this.video, 0, 0, W, H);
      const frame = this.ctx.getImageData(0, 0, W, H).data;
      if (this.last && !this.pending) {
        this.noise.push(meanAbsLumaDiff(frame, this.last));
        if (this.noise.length > NOISE_WINDOW) this.noise.shift();
      }
      const p = this.pending;
      if (p) {
        const at = p.detector.feed(now, meanAbsLumaDiff(frame, p.baseline));
        if (at !== null) this.finish(at);
        else if (now - p.t0 > TIMEOUT_MS) this.finish(null);
      }
      this.last = frame;
    }
    this.schedule();
  }
}

/** A reference image as a JPEG/PNG/WebP blob, longest side <= 1024 (as Decart's sample repo). */
export async function loadReference(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`reference ${url}: HTTP ${res.status}`);
  const src = await res.blob();
  const bmp = await createImageBitmap(src);
  const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  if (scale === 1 && /^image\/(jpeg|png|webp)$/.test(src.type)) {
    bmp.close();
    return src;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', 0.9),
  );
}
