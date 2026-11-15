import { useEffect, useRef, useState } from 'react';
import { openCamera, type CameraHandle, type CameraInfo } from '@satisfy/vision';
import { buildSchema, jacketSchema } from './manifest';
import { recordRoutine, type CaptureResult } from './record';
import { CAMERA_OPTIONS, ROUTINE_MS, routineAt } from './routine';
import './capture.css';

declare const __CAPTURE_BUILD__: unknown;
const parsedBuild = buildSchema.safeParse(
  typeof __CAPTURE_BUILD__ === 'undefined' ? null : __CAPTURE_BUILD__,
);
const build = parsedBuild.success ? parsedBuild.data : null;

export default function CaptureLab() {
  const preview = useRef<HTMLDivElement>(null);
  const camera = useRef<CameraHandle | undefined>(undefined);
  const recording = useRef<AbortController | undefined>(undefined);
  const alive = useRef(false),
    generation = useRef(0);
  const downloads = useRef(new Set<() => void>());
  const [phase, setPhase] = useState<
    'off' | 'opening' | 'preview' | 'recording' | 'ready' | 'error'
  >('off');
  const [jacket, setJacket] = useState('');
  const [info, setInfo] = useState<CameraInfo>();
  const [progress, setProgress] = useState(routineAt(0));
  const [result, setResult] = useState<CaptureResult>();
  const [error, setError] = useState('');

  function closeCamera(owned = camera.current) {
    if (!owned) return;
    owned.close();
    owned.video.remove();
    if (camera.current === owned) camera.current = undefined;
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
      recording.current?.abort();
      closeCamera();
      for (const release of downloads.current) release();
    };
  }, []);

  async function startCamera() {
    const token = ++generation.current;
    setPhase('opening');
    setError('');
    setResult(undefined);
    try {
      const opened = await openCamera(CAMERA_OPTIONS);
      if (!alive.current || token !== generation.current) {
        opened.close();
        return;
      }
      camera.current = opened;
      opened.video.className = 'capture-video';
      preview.current?.append(opened.video);
      setInfo(opened.info());
      setPhase('preview');
    } catch (cause) {
      if (alive.current && token === generation.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setPhase('error');
      }
    }
  }
  function cancel() {
    generation.current++;
    recording.current?.abort();
    recording.current = undefined;
    closeCamera();
    setPhase('off');
    setResult(undefined);
    setError('');
  }
  function save(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob),
      link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    let timer = 0;
    const release = () => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      downloads.current.delete(release);
    };
    downloads.current.add(release);
    timer = window.setTimeout(release, 10000);
  }
  function saveManifest(value: CaptureResult) {
    save(
      new Blob([JSON.stringify(value.manifest, null, 2)], { type: 'application/json' }),
      `${value.base}.json`,
    );
  }
  async function startRoutine() {
    const owned = camera.current;
    if (!owned || !build) return;
    const token = ++generation.current,
      controller = new AbortController();
    recording.current = controller;
    setError('');
    setResult(undefined);
    setProgress(routineAt(0));
    setPhase('recording');
    try {
      const value = await recordRoutine(owned, {
        jacket,
        build,
        signal: controller.signal,
        onProgress: (next) => {
          if (alive.current && token === generation.current) setProgress(next);
        },
      });
      if (alive.current && token === generation.current) {
        setResult(value);
        setPhase('ready');
        save(value.video, `${value.base}.webm`);
        saveManifest(value);
      }
    } catch (cause) {
      if (alive.current && token === generation.current) {
        if (controller.signal.aborted) setPhase('off');
        else {
          setError(cause instanceof Error ? cause.message : String(cause));
          setPhase('error');
        }
      }
    } finally {
      closeCamera(owned);
      if (recording.current === controller) recording.current = undefined;
    }
  }
  const on = phase === 'preview' || phase === 'recording';
  const busy = phase === 'recording' || phase === 'opening';
  return (
    <main className="capture-lab" data-screen="ar-capture" data-phase={phase}>
      <header className="capture-header">
        <div>
          <div className="capture-eyebrow">RAW CAMERA / LOCAL ONLY</div>
          <h1>AR test capture</h1>
          <p>A labelled move routine for comparing future builds.</p>
        </div>
        <div className="capture-status" role="status">
          <b className={on ? 'on' : ''}>
            {on ? 'Camera on' : phase === 'opening' ? 'Starting camera' : 'Camera off'}
          </b>
          {build && (
            <small>
              Build {build.commit.slice(0, 10)}
              {build.dirty ? ' · working tree changed' : ''}
            </small>
          )}
        </div>
      </header>
      {!build && (
        <aside className="capture-build" role="status">
          Recording needs a stamped build. From the repo root run:
          <code>
            node node_modules/vite/bin/vite.js apps/web --config
            apps/web/src/labs/capture/vite.capture.config.mjs
          </code>
          Then open http://127.0.0.1:5781/?arcapture.
        </aside>
      )}
      <div className="capture-grid">
        <section className="capture-frame" aria-label="Raw camera preview">
          <div ref={preview} className="capture-video-host" />
          {!on && (
            <div className="capture-placeholder">
              {phase === 'ready'
                ? 'Recording complete. Camera stopped.'
                : 'Start the camera. Keep your head and hips in view.'}
            </div>
          )}
          {on && (
            <span className="capture-preview-note">
              Mirrored preview · the saved video is raw and unmirrored
            </span>
          )}
        </section>
        <aside className="capture-cue" aria-live="polite">
          <span className="capture-eyebrow">
            {phase === 'recording' ? `STEP ${progress.step} / 10` : 'ABOUT 75 SECONDS'}
          </span>
          <h2>
            {phase === 'recording'
              ? progress.cue
              : phase === 'ready'
                ? 'Your raw recording is ready'
                : 'Frame your head and hips, then follow each cue'}
          </h2>
          {phase === 'recording' && (
            <strong className="capture-countdown">{Math.ceil(progress.remainingMs / 1000)}</strong>
          )}
          <div
            className="capture-progress"
            role="progressbar"
            aria-label="Routine progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(
              (phase === 'ready' ? 1 : phase === 'recording' ? progress.progress : 0) * 100,
            )}
          >
            <i
              style={{
                width: `${(phase === 'ready' ? 1 : phase === 'recording' ? progress.progress : 0) * 100}%`,
              }}
            />
          </div>
          <p>
            Video contains only the camera image. The cue labels and timestamps go into a separate
            JSON file.
          </p>
          {info && (
            <small>
              {info.label} · {info.width} × {info.height}
            </small>
          )}
          {result && (
            <p className="capture-metrics">
              Measured {result.manifest.camera.fps.toFixed(1)} fps ·{' '}
              {(result.manifest.durationMs / 1000).toFixed(1)} s ·{' '}
              {(result.video.size / 1_000_000).toFixed(1)} MB
              <br />
              Encoding target 7 Mbit/s. Actual file{' '}
              {(result.manifest.encoding.actualBitsPerSecond / 1_000_000).toFixed(2)} Mbit/s.
            </p>
          )}
        </aside>
      </div>
      {error && (
        <p className="capture-error" role="alert">
          {error}
        </p>
      )}
      <div className="capture-controls">
        <label>
          Jacket worn
          <input
            aria-label="Jacket worn"
            placeholder="e.g. parka, t-shirt"
            maxLength={100}
            value={jacket}
            disabled={busy}
            onChange={(event) => setJacket(event.target.value)}
          />
        </label>
        {!on && phase !== 'opening' && (
          <button onClick={() => void startCamera()}>Start camera</button>
        )}
        {on && phase !== 'recording' && <button onClick={cancel}>Stop camera</button>}
        <button
          className="primary"
          disabled={phase !== 'preview' || !build || !jacketSchema.safeParse(jacket).success}
          onClick={() => void startRoutine()}
        >
          Record routine · {Math.ceil(ROUTINE_MS / 1000)} s
        </button>
        {busy && <button onClick={cancel}>Cancel</button>}
        {result && (
          <>
            <button onClick={() => save(result.video, `${result.base}.webm`)}>
              Download raw video
            </button>
            <button onClick={() => saveManifest(result)}>Download manifest</button>
          </>
        )}
      </div>
      <footer className="capture-privacy">
        Saved only to this computer&apos;s Downloads folder; move it to{' '}
        <code>data/reference-photos/live-diag/</code>; never uploaded.
        <br />
        Two files download when the routine finishes. Cue labels describe instructions, not verified
        poses.
      </footer>
    </main>
  );
}
