// ?rec=1: a live REC button for analysis sessions. Records the RAW camera MediaStream (the one the
// tracker reads, never a canvas) and the AR canvas as the user sees it, then saves both WebM files
// and a JSON manifest through ordinary browser downloads. Nothing is uploaded or stored elsewhere;
// frames reach the disk only because the user pressed REC (AGENTS.md §3). Without the flag nothing
// here runs, and while not recording there is no captureStream, no timer and no listener.
import { VIDEO_BITS_PER_SECOND } from '../../labs/capture/routine';

/** Auto-stop (s): a session clip, kept short so the files stay small enough to share. */
export const REC_MAX_SECONDS = 90;
/** Task cap: ≤ 6 Mbit/s per stream. The capture lab's 7 Mbit/s constant, capped. */
export const REC_BITS_PER_SECOND = Math.min(VIDEO_BITS_PER_SECOND, 6_000_000);
/** AR canvas capture rate (fps). */
export const REC_AR_FPS = 30;
const MIME_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

export function recEnabled(search: string): boolean {
  return new URLSearchParams(search).get('rec') === '1';
}

const pad = (n: number) => String(n).padStart(2, '0');
/** `ar-live-YYYYMMDD-HHMMSS` in local time. */
export function recordingBase(at: Date): string {
  return (
    `ar-live-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-` +
    `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  );
}
export function recordingFiles(base: string) {
  return { raw: `${base}-raw.webm`, ar: `${base}-ar.webm`, manifest: `${base}.json` };
}
/** "00:12" for the STOP button. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

/** One per-second reading of the engine's own stats (read only; null = not exposed). */
export interface RecSample {
  /** Seconds since REC. */
  t: number;
  arFps: number | null;
  arRenderMs: number | null;
  arDisplayMs: number | null;
  arTotalMs: number | null;
  trackerMs: number | null;
  sourceFps: number | null;
  mirrorFps: number | null;
}
export interface GapStats {
  count: number;
  meanMs: number;
  p50Ms: number;
  p90Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Gaps above 100 ms (a visible stall). */
  over100: number;
}
/** Summary of intervals between AR renders (ms); null when fewer than one interval. */
export function gapStats(gaps: readonly number[]): GapStats | null {
  if (!gaps.length) return null;
  const sorted = [...gaps].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const round = (x: number) => Math.round(x * 10) / 10;
  return {
    count: sorted.length,
    meanMs: round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    p50Ms: round(at(0.5)),
    p90Ms: round(at(0.9)),
    p99Ms: round(at(0.99)),
    maxMs: round(sorted[sorted.length - 1]),
    over100: sorted.filter((g) => g > 100).length,
  };
}

export interface ManifestInput {
  base: string;
  startedAt: Date;
  stoppedAt: Date;
  stopReason: 'user' | 'auto-90s' | 'track-ended' | 'unmount' | 'error';
  product: { productId: string; fitId: string; size: string; name?: string } | null;
  search: string;
  canvas: { width: number; height: number; cssWidth: number; cssHeight: number } | null;
  devicePixelRatio: number;
  cameraSettings: { width?: number; height?: number; frameRate?: number; deviceId?: string } | null;
  userAgent: string;
  webglRenderer: string | null;
  mimeType: string;
  bitsPerSecond: { raw: number; ar: number };
  arSource: string;
  arMirroredOnScreen: boolean;
  samples: RecSample[];
  gaps: number[];
  errors: string[];
}
const mean = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
};
export function buildManifest(i: ManifestInput) {
  const files = recordingFiles(i.base);
  return {
    kind: 'satisfy-ar-live-recording',
    version: 1,
    files,
    startedAt: i.startedAt.toISOString(),
    stoppedAt: i.stoppedAt.toISOString(),
    durationS: Math.round((i.stoppedAt.getTime() - i.startedAt.getTime()) / 100) / 10,
    stopReason: i.stopReason,
    product: i.product,
    search: i.search,
    canvas: i.canvas,
    devicePixelRatio: i.devicePixelRatio,
    cameraSettings: i.cameraSettings,
    userAgent: i.userAgent,
    webglRenderer: i.webglRenderer,
    recorder: { mimeType: i.mimeType, bitsPerSecond: i.bitsPerSecond, arCaptureFps: REC_AR_FPS },
    notes: {
      raw: 'Camera MediaStream the tracker reads (video.srcObject of the live source), not a canvas.',
      ar: i.arSource,
      arMirroredOnScreen: i.arMirroredOnScreen
        ? 'The AR stage is flipped with CSS scaleX(-1) on screen; the recorded canvas is NOT flipped.'
        : 'The AR canvas is shown unflipped.',
      gaps:
        'Intervals between AR renders, detected by polling the compositor stats once per ' +
        'animation frame: quantised to the display refresh (~16.7 ms at 60 Hz).',
    },
    perSecond: i.samples,
    summary: {
      arFpsMean: mean(i.samples.map((s) => s.arFps)),
      arFpsMin: (() => {
        const v = i.samples.map((s) => s.arFps).filter((x): x is number => x !== null);
        return v.length ? Math.min(...v) : null;
      })(),
      arTotalMsMean: mean(i.samples.map((s) => s.arTotalMs)),
      arDisplayMsMean: mean(i.samples.map((s) => s.arDisplayMs)),
      frameGaps: gapStats(i.gaps),
    },
    errors: i.errors,
  };
}
export type RecManifest = ReturnType<typeof buildManifest>;

// ---------------------------------------------------------------- browser part (not unit-tested)

/** What the tryon screen hands over at REC time; read only. */
export interface RecTargets {
  /** The live source's video element (srcObject = the camera stream the tracker uses). */
  video: HTMLVideoElement | null;
  /** The AR container (the engine appends its WebGL canvas inside). */
  arContainer: HTMLElement | null;
  /** The engine, duck-typed for stats() and arRenderer.stats. */
  engine: unknown;
  product: ManifestInput['product'];
}

type StatsLike = {
  arDisplayMs?: number;
  arTotalMs?: number | null;
  trackerMs?: number | null;
  sourceFps?: number;
  renderFps?: number;
};
type ArStatsLike = { fps?: number; renderMs?: number };
function engineStats(engine: unknown): StatsLike | null {
  const e = engine as { stats?: () => StatsLike } | null;
  if (!e || typeof e.stats !== 'function') return null;
  try {
    return e.stats();
  } catch {
    return null;
  }
}
function arStats(engine: unknown): ArStatsLike | null {
  const r = (engine as { arRenderer?: { stats?: ArStatsLike } } | null)?.arRenderer;
  return r && typeof r.stats === 'object' && r.stats ? r.stats : null;
}
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

function webglRenderer(): string | null {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch {
    return null;
  }
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The top AR canvas inside the container (the last canvas in DOM order is drawn on top). */
function arCanvas(container: HTMLElement | null): HTMLCanvasElement | null {
  const all = container ? Array.from(container.querySelectorAll('canvas')) : [];
  return all.length ? all[all.length - 1] : null;
}

export interface LiveRecording {
  readonly base: string;
  readonly startedAt: number;
  stop(reason?: ManifestInput['stopReason']): Promise<void>;
}

/** Starts both recorders. Throws a readable Error when a stream cannot be recorded. */
export function startLiveRecording(
  targets: RecTargets,
  onEnded: (error: string | null) => void,
): LiveRecording {
  if (typeof MediaRecorder === 'undefined')
    throw Error('Recording is unavailable in this browser.');
  const camera = targets.video?.srcObject;
  if (
    !(camera instanceof MediaStream) ||
    !camera.getVideoTracks().some((t) => t.readyState === 'live')
  )
    throw Error('Camera is not live yet.');
  const canvas = arCanvas(targets.arContainer);
  if (!canvas) throw Error('AR view canvas not found.');
  const mimeType = MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
  if (!mimeType) throw Error('This browser cannot record WebM.');

  const startedAt = new Date();
  const base = recordingBase(startedAt);
  const files = recordingFiles(base);
  const arCount = targets.arContainer?.querySelectorAll('canvas').length ?? 0;
  const stage = canvas.parentElement;
  const mirrored = !!stage && /scaleX\(-1\)/.test(stage.style.transform);
  const cameraTrack = camera.getVideoTracks()[0];
  const settings = cameraTrack.getSettings();
  const errors: string[] = [];
  const samples: RecSample[] = [];
  const gaps: number[] = [];

  const arStream = canvas.captureStream(REC_AR_FPS);
  const rawRec = new MediaRecorder(camera, { mimeType, videoBitsPerSecond: REC_BITS_PER_SECOND });
  const arRec = new MediaRecorder(arStream, { mimeType, videoBitsPerSecond: REC_BITS_PER_SECOND });
  const rawChunks: Blob[] = [],
    arChunks: Blob[] = [];
  rawRec.ondataavailable = (e) => e.data.size && rawChunks.push(e.data);
  arRec.ondataavailable = (e) => e.data.size && arChunks.push(e.data);
  rawRec.onerror = () => errors.push('raw recorder error');
  arRec.onerror = () => errors.push('ar recorder error');

  // Per-second engine stats and AR frame gaps (the compositor reassigns `stats` on every render).
  const t0 = performance.now();
  const sampler = window.setInterval(() => {
    const s = engineStats(targets.engine),
      a = arStats(targets.engine);
    samples.push({
      t: Math.round((performance.now() - t0) / 100) / 10,
      arFps: num(a?.fps),
      arRenderMs: a?.renderMs === undefined ? null : Math.round(a.renderMs * 10) / 10,
      arDisplayMs: num(s?.arDisplayMs),
      arTotalMs: num(s?.arTotalMs),
      trackerMs: num(s?.trackerMs),
      sourceFps: num(s?.sourceFps),
      mirrorFps: num(s?.renderFps),
    });
  }, 1000);
  let lastStats: unknown = arStats(targets.engine),
    lastRender = -1,
    raf = 0;
  const poll = (now: number) => {
    const current = arStats(targets.engine);
    if (current && current !== lastStats) {
      if (lastRender >= 0) gaps.push(now - lastRender);
      lastRender = now;
      lastStats = current;
    }
    raf = requestAnimationFrame(poll);
  };
  raf = requestAnimationFrame(poll);

  let stopping: Promise<void> | null = null;
  const trackEnded = () => void recording.stop('track-ended');
  cameraTrack.addEventListener('ended', trackEnded);
  const autoStop = window.setTimeout(() => void recording.stop('auto-90s'), REC_MAX_SECONDS * 1000);

  const finished = (rec: MediaRecorder) =>
    new Promise<void>((resolve) => {
      if (rec.state === 'inactive') return resolve();
      rec.addEventListener('stop', () => resolve(), { once: true });
      rec.stop();
    });

  const recording: LiveRecording = {
    base,
    startedAt: startedAt.getTime(),
    stop(reason = 'user') {
      stopping ??= (async () => {
        clearInterval(sampler);
        clearTimeout(autoStop);
        cancelAnimationFrame(raf);
        cameraTrack.removeEventListener('ended', trackEnded);
        await Promise.all([finished(rawRec), finished(arRec)]);
        // The canvas capture track is ours; the camera tracks belong to the live source.
        arStream.getTracks().forEach((t) => t.stop());
        const stoppedAt = new Date();
        const rect = canvas.getBoundingClientRect();
        const manifest = buildManifest({
          base,
          startedAt,
          stoppedAt,
          stopReason: reason,
          product: targets.product,
          search: location.search,
          canvas: {
            width: canvas.width,
            height: canvas.height,
            cssWidth: Math.round(rect.width),
            cssHeight: Math.round(rect.height),
          },
          devicePixelRatio: window.devicePixelRatio,
          cameraSettings: {
            width: settings.width,
            height: settings.height,
            frameRate: settings.frameRate,
          },
          userAgent: navigator.userAgent,
          webglRenderer: webglRenderer(),
          mimeType,
          bitsPerSecond: { raw: rawRec.videoBitsPerSecond, ar: arRec.videoBitsPerSecond },
          arSource:
            `canvas.captureStream(${REC_AR_FPS}) of the top canvas in the AR view ` +
            `(${arCount} canvas element(s) found; the camera video is drawn inside this WebGL canvas).`,
          arMirroredOnScreen: mirrored,
          samples,
          gaps,
          errors,
        });
        download(new Blob(rawChunks, { type: mimeType }), files.raw);
        // Chrome may ask once to allow multiple downloads from this page.
        setTimeout(() => download(new Blob(arChunks, { type: mimeType }), files.ar), 400);
        setTimeout(
          () =>
            download(
              new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
              files.manifest,
            ),
          800,
        );
        onEnded(errors.length ? errors.join('; ') : null);
      })();
      return stopping;
    },
  };
  rawRec.start(1000);
  arRec.start(1000);
  return recording;
}
