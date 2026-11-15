// "Record diagnostics" for the mirror lab: both views side by side (AR composite left, mirror
// right, flipped like the screen when mirrored) as one WebM, plus a per-frame JSON log, both
// downloaded to the browser's Downloads folder. Local only: nothing is uploaded or committed.
// The user consented to local recordings of themself (prompt 14, 2026-11-13).
import type { DiagnosticEntry, LiveTryOnEngine } from '../../engine/live/LiveTryOnEngine';

/** Recording bitrate: enough to read the collar and sleeve edges in the footage. */
const VIDEO_BITS_PER_SECOND = 7_000_000;
const FPS = 30;
const HEIGHT = 720;

const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A <video> playing a canvas's own stream (works for WebGL canvases without preserveDrawingBuffer). */
function streamVideo(canvas: HTMLCanvasElement) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = canvas.captureStream(FPS);
  void video.play().catch(() => undefined);
  return video;
}

export type DiagnosticsResult = { base: string; frames: number; bytes: number };

declare const __SATISFY_BUILD__: string | undefined;
/** The git commit the server was started on (defined by the stable server), else 'dev'. */
const BUILD = typeof __SATISFY_BUILD__ === 'string' ? __SATISFY_BUILD__ : 'dev';

function glueState(ar: unknown, frames: { ar: unknown }[]) {
  const enabled = (ar as { glue?: unknown } | undefined)?.glue;
  const states = frames
    .map((f) => (f.ar as { glue?: unknown } | null)?.glue)
    .filter((g) => g != null);
  return {
    enabled: typeof enabled === 'boolean' ? enabled : null,
    framesWithGlueState: states.length,
    last: states.length ? states[states.length - 1] : null,
  };
}

export async function recordDiagnostics(options: {
  engine: LiveTryOnEngine;
  /** The injected AR renderer (V2's ArCompositor), to log whether its glue warp is on. */
  arRenderer?: unknown;
  /** Free-form context for the log (body source, scan measurements, product, size). */
  meta?: Record<string, unknown>;
  arContainer: HTMLElement | null;
  seconds: number;
  onTick: (remainingS: number) => void;
}): Promise<DiagnosticsResult> {
  const { engine, seconds } = options;
  const arCanvas = options.arContainer?.querySelector('canvas') ?? null;
  const mirrorCanvas = engine.mirrorCanvas;
  const sources = [arCanvas, mirrorCanvas].filter((c): c is HTMLCanvasElement => !!c);
  if (!sources.length) throw new Error('Nothing to record: start the camera first.');
  const videos = sources.map(streamVideo);
  const widths = sources.map((c) => Math.round((c.width / Math.max(1, c.height)) * HEIGHT));
  const out = document.createElement('canvas');
  out.width = widths.reduce((a, b) => a + b, 0);
  out.height = HEIGHT;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas for the recording.');
  const mirrored = engine.mirrorDisplay;
  // Mean luma (0..255) of the source video twice a second: dim light is what drags the camera's
  // frame rate down (auto-exposure), so the log shows how dark the tracker's input was.
  const sourceVideo = engine.currentSource?.video ?? null;
  const lumaCanvas = document.createElement('canvas');
  lumaCanvas.width = 32;
  lumaCanvas.height = 18;
  const lumaCtx = lumaCanvas.getContext('2d', { willReadFrequently: true });
  const luma: { wallMs: number; mean: number }[] = [];
  let lastLuma = 0;
  const started = performance.now();
  let raf = 0;
  const draw = () => {
    raf = requestAnimationFrame(draw);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, out.width, out.height);
    let x = 0;
    videos.forEach((v, i) => {
      const w = widths[i];
      if (v.readyState >= 2) {
        ctx.save();
        if (mirrored) {
          // The screen shows both views flipped (CSS), so the recording does too.
          ctx.translate(x + w, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(v, 0, 0, w, HEIGHT);
        } else ctx.drawImage(v, x, 0, w, HEIGHT);
        ctx.restore();
      }
      x += w;
    });
    const now = performance.now();
    if (lumaCtx && sourceVideo && sourceVideo.readyState >= 2 && now - lastLuma > 500) {
      lastLuma = now;
      lumaCtx.drawImage(sourceVideo, 0, 0, 32, 18);
      const px = lumaCtx.getImageData(0, 0, 32, 18).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4)
        sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      luma.push({ wallMs: now - started, mean: sum / (px.length / 4) });
    }
    ctx.fillStyle = '#e53935';
    ctx.font = '600 22px system-ui';
    ctx.fillText(`REC ${(performance.now() / 1000).toFixed(2)} s`, 12, 28);
  };
  draw();
  const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) =>
    MediaRecorder.isTypeSupported(t),
  );
  const recorder = new MediaRecorder(out.captureStream(FPS), {
    mimeType: type,
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const frames: (DiagnosticEntry & { wallMs: number })[] = [];
  const source = engine.currentSource as { cameraInfo?: () => unknown } | undefined;
  // Negotiated size and measured fps of the device (getSettings / delivered frames).
  const cameraInfo = { atStart: source?.cameraInfo?.() ?? null, atEnd: null as unknown };
  const off = engine.onDiagnostics((entry) =>
    frames.push({ ...entry, wallMs: performance.now() - started }),
  );
  const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
  recorder.start(1000);
  try {
    for (let left = seconds; left > 0; left--) {
      options.onTick(left);
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    off();
    recorder.stop();
    await stopped;
    cancelAnimationFrame(raf);
    for (const v of videos) {
      (v.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
      v.srcObject = null;
    }
  }
  cameraInfo.atEnd = source?.cameraInfo?.() ?? null;
  const base = `diag-${stamp()}`;
  const video = new Blob(chunks, { type: type ?? 'video/webm' });
  const log = {
    format: 'satisfy-live-diagnostics',
    version: 1,
    createdAt: new Date().toISOString(),
    note: 'Local only. Video: AR composite (left) and mirror (right), as shown on screen.',
    seconds,
    composite: { width: out.width, height: out.height, views: widths, mirrored },
    build: BUILD,
    meta: options.meta ?? null,
    // The AR's image-space glue warp: whether the compositor had it on, and its last debug state.
    glue: glueState(options.arRenderer, frames),
    luma,
    stats: engine.stats(),
    camera: cameraInfo,
    state: engine.currentState,
    frames,
  };
  download(video, `${base}.webm`);
  download(new Blob([JSON.stringify(log)], { type: 'application/json' }), `${base}.json`);
  return { base, frames: frames.length, bytes: video.size };
}
