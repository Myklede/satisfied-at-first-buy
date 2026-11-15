// Optional two-view webcam scan (front, then side) via @satisfy/vision.
// Frames stay in memory inside @satisfy/vision; only the numeric result leaves this screen.
// A camera or model error never blocks the flow: the judge continues without a scan.
import { useEffect, useRef, useState } from 'react';
import {
  CameraError,
  createBodyScanner,
  type BodyScannerHandle,
  type CameraHandle,
  type ScanGuidance,
  type ScanResult,
} from '@satisfy/vision';
import { CAMERA_BUSY_HELP } from '../engine/live/sources/cameraText';
import { openLiveCamera } from '../engine/live/sources/cameraSource';
import { CameraPicker } from './CameraPicker';
import { guidanceText, stageTitle } from './scanText';
import { formatPlusMinus, type Units } from './units';

/** Offer "Continue without scan" prominently after this long without a pass (prompt 04). */
export const SCAN_GIVE_UP_MS = 25_000;
/** Show the scan result for this long before continuing (prompt 04). */
export const SCAN_RESULT_MS = 2_000;
export const VISION_ASSET_BASE = '/vision/';

const NAMES: Record<string, string> = {
  shoulder_width_cm: 'Shoulders',
  chest_cm: 'Chest',
  waist_cm: 'Waist',
  hip_cm: 'Hip',
  arm_length_cm: 'Arm length',
};

export interface ScanLiveStats {
  model: string;
  inferenceHz: number;
  /** Raw calls in the window; the first 500 ms sample is not a one-second rate. */
  inferenceCalls: number;
  sampleWindowMs: number;
  framesProcessed: number;
  cameraFps: number;
  visibility: DocumentVisibilityState;
  focused: boolean;
  delegate: string;
  inferMs: number;
  analysisMs: number;
}

export function ScanScreen({
  heightCm,
  sex,
  units,
  onDone,
  onStats,
}: {
  heightCm: number;
  sex: 'female' | 'male';
  units: Units;
  onDone: (result: ScanResult | null) => void;
  onStats: (stats: ScanLiveStats | null) => void;
}) {
  const preview = useRef<HTMLDivElement>(null);
  const [guidance, setGuidance] = useState<ScanGuidance>();
  const [phase, setPhase] = useState<'starting' | 'scanning' | 'result' | 'failed'>('starting');
  const [failure, setFailure] = useState('');
  // Retry camera: re-runs the effect, i.e. calls getUserMedia again without a page reload.
  const [attempt, setAttempt] = useState(0);
  const [canRetry, setCanRetry] = useState(false);
  const [result, setResult] = useState<ScanResult>();
  const [slow, setSlow] = useState(false);
  const finished = useRef(false);
  const finish = (value: ScanResult | null) => {
    if (finished.current) return;
    finished.current = true;
    onDone(value);
  };

  useEffect(() => {
    const controller = new AbortController();
    let camera: CameraHandle | undefined;
    let scanner: BodyScannerHandle | undefined;
    let statsTimer = 0;
    let resultTimer = 0;
    const giveUp = window.setTimeout(() => setSlow(true), SCAN_GIVE_UP_MS);
    (async () => {
      try {
        // The kiosk's camera choice (picker / ?cam= / ?camCrop=left), at the scan's 720p.
        camera = await openLiveCamera({
          width: 1280,
          height: 720,
          frameRate: 30,
          minFrameRate: undefined,
        });
        if (controller.signal.aborted) {
          camera.close();
          return;
        }
        // The frame the scanner sees: the video, or its canvas (?camCrop=left: one stereo eye).
        const view =
          typeof HTMLCanvasElement !== 'undefined' && camera.source instanceof HTMLCanvasElement
            ? camera.source
            : camera.video;
        view.className = 'k-video';
        preview.current?.append(view);
        scanner = await createBodyScanner(camera, {
          height_cm: heightCm,
          sex,
          assetBase: VISION_ASSET_BASE,
        });
        if (controller.signal.aborted) {
          scanner.close();
          return;
        }
        scanner.onGuidance(setGuidance);
        const scanStarted = performance.now();
        statsTimer = window.setInterval(() => {
          const s = scanner?.stats();
          const sampleWindowMs = Math.min(1000, performance.now() - scanStarted);
          if (s)
            onStats({
              model: s.model,
              inferenceHz: (s.inferenceHz * 1000) / sampleWindowMs,
              inferenceCalls: s.inferenceHz,
              sampleWindowMs,
              framesProcessed: s.framesProcessed,
              cameraFps: camera?.info().fps ?? 0,
              visibility: document.visibilityState,
              focused: document.hasFocus(),
              delegate: s.delegate,
              inferMs: s.inferMs,
              analysisMs: s.analysisMs,
            });
        }, 500);
        setPhase('scanning');
        const value = await scanner.run(controller.signal);
        if (controller.signal.aborted) return;
        setResult(value);
        setPhase('result');
        resultTimer = window.setTimeout(() => finish(value), SCAN_RESULT_MS);
      } catch (error) {
        if (controller.signal.aborted) return;
        setFailure(
          error instanceof CameraError
            ? error.code === 'permission_denied'
              ? 'The camera is not allowed in this window.'
              : error.code === 'device_busy'
                ? CAMERA_BUSY_HELP
                : error.code === 'no_camera'
                  ? 'No camera was found.'
                  : 'The camera could not start.'
            : 'The body scanner could not start.',
        );
        setCanRetry(error instanceof CameraError);
        setPhase('failed');
      }
    })();
    return () => {
      controller.abort();
      window.clearTimeout(giveUp);
      window.clearInterval(statsTimer);
      window.clearTimeout(resultTimer);
      onStats(null);
      scanner?.close();
      camera?.close();
      camera?.video.remove();
      if (camera?.source && camera.source !== camera.video) camera.source.remove();
    };
    // Runs once per mount (and per Retry camera): the inputs are fixed for this screen.
  }, [attempt]);

  return (
    <section className="k-panel k-scan" data-screen="scan">
      <div className="k-scan-preview" ref={preview}>
        {phase === 'starting' && <p className="k-scan-wait">Starting the camera…</p>}
      </div>
      <div className="k-scan-side">
        <div className="k-eyebrow">Body scan · optional</div>
        {phase === 'failed' ? (
          <>
            <h2>No scan this time</h2>
            <p className="k-lead">{failure} We will fit your body from height and weight.</p>
            {canRetry && (
              <button
                className="k-secondary"
                onClick={() => {
                  setFailure('');
                  setCanRetry(false);
                  setPhase('starting');
                  setAttempt((n) => n + 1);
                }}
              >
                Retry camera
              </button>
            )}
            <button className="k-primary" onClick={() => finish(null)}>
              Continue →
            </button>
          </>
        ) : phase === 'result' && result ? (
          <>
            <h2>Scan complete</h2>
            <ul className="k-scan-result">
              {Object.entries(result.measurements).map(([name, m]) => (
                <li key={name}>
                  <span>{NAMES[name] ?? name}</span>
                  <b>{formatPlusMinus(m.value_cm, m.sigma_cm, units)}</b>
                </li>
              ))}
            </ul>
            {result.calibration === 'uncalibrated' && (
              <p className="k-note">Camera not yet calibrated: wide uncertainty.</p>
            )}
          </>
        ) : (
          <>
            <h2>{stageTitle(guidance)}</h2>
            {/* User test 18:05: the skip path was not found; the try-on needs head to hips only. */}
            <p className="k-lead">
              Optional: this scan measures your whole body, head to feet. The try-on only needs head
              to hips, so you can skip it right away.
            </p>
            <button className="k-primary" onClick={() => finish(null)}>
              Skip scan · try it on now →
            </button>
            <p className="k-note">Please take your jacket off first.</p>
            <p className="k-guidance" aria-live="polite">
              {guidance ? guidanceText(guidance) : 'Step back until your whole body is visible'}
            </p>
            <div className="k-progress" aria-label="Capture progress">
              <i style={{ width: `${Math.round((guidance?.progress ?? 0) * 100)}%` }} />
            </div>
            <p className="k-note">Stand 1.5–2.5 m (5–8 ft) from the screen.</p>
            {slow && (
              <p className="k-note">
                Taking a while? Skip scan: your size comes from your height and weight.
              </p>
            )}
          </>
        )}
        <CameraPicker
          onChange={() => {
            setFailure('');
            setCanRetry(false);
            setPhase('starting');
            setAttempt((n) => n + 1);
          }}
        />
      </div>
    </section>
  );
}
