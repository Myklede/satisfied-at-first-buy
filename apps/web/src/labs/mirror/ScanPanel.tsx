// "Scan my body" for the mirror lab: the kiosk's two-view scan (front, then side) from
// @satisfy/vision createBodyScanner. Its measurements go to /body/fit as scan_measurements, so the
// mirror and the AR use a body with the person's own shoulder width, arm length and girths.
// Frames stay in memory inside @satisfy/vision; only the numbers leave this panel.
// The scanner needs the WHOLE body (head to heels) in the picture: see SETUP below.
import { useEffect, useRef, useState } from 'react';
import {
  CameraError,
  createBodyScanner,
  openCamera,
  type BodyScannerHandle,
  type CameraHandle,
  type ScanGuidance,
  type ScanResult,
} from '@satisfy/vision';
import { VISION_ASSET_BASE } from '../../engine/live/sources/trackedSource';
import { videoHandle } from '../../engine/live/sources/videoFileSource';
import { guidanceText, stageTitle } from '../../kiosk/scanText';

/** Framing the scanner checks (packages/vision scan.ts: nose and a heel visible, not cut). */
export const SETUP = [
  'Take the jacket off (T-shirt).',
  'Stand 2.5–3 m (8–10 ft) from the laptop.',
  'Your whole body must be in the picture, head to feet.',
  'Feet cut off? Tilt the screen back or put the laptop on a box.',
];

const NAMES: Record<string, string> = {
  shoulder_width_cm: 'Shoulders',
  chest_cm: 'Chest',
  waist_cm: 'Waist',
  hip_cm: 'Hip',
  arm_length_cm: 'Arm length',
};

export type ScanSource = { kind: 'camera' } | { kind: 'video'; url: string; startAt: number };

export function ScanPanel({
  heightCm,
  sex,
  source,
  onDone,
}: {
  heightCm: number;
  sex: 'female' | 'male';
  source: ScanSource;
  onDone: (result: ScanResult | null) => void;
}) {
  const preview = useRef<HTMLDivElement>(null);
  const [guidance, setGuidance] = useState<ScanGuidance>();
  const [phase, setPhase] = useState<'starting' | 'scanning' | 'result' | 'failed'>('starting');
  const [failure, setFailure] = useState('');
  const [result, setResult] = useState<ScanResult>();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let camera: CameraHandle | undefined;
    let scanner: BodyScannerHandle | undefined;
    let video: HTMLVideoElement | undefined;
    (async () => {
      try {
        if (source.kind === 'camera') {
          camera = await openCamera({ width: 1280, height: 720, frameRate: 30 });
          camera.video.style.transform = 'scaleX(-1)'; // a mirror while positioning
        } else {
          video = document.createElement('video');
          video.muted = true;
          video.playsInline = true;
          video.src = source.url;
          video.currentTime = source.startAt;
          await video.play();
          camera = videoHandle(video, 'reference video');
          videoRef.current = video;
        }
        if (controller.signal.aborted) return;
        Object.assign(camera.video.style, {
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          background: '#111',
        });
        preview.current?.append(camera.video);
        scanner = await createBodyScanner(camera, {
          height_cm: heightCm,
          sex,
          assetBase: VISION_ASSET_BASE,
          // The GPU delegate's mask readback fails on this laptop next to the other WebGL
          // contexts (glReadPixels "invalid format": every frame reads as no person); the CPU
          // delegate returns CPU masks. A scan is a few seconds, so its speed is fine.
          delegate: new URLSearchParams(location.search).get('scangpu') === '1' ? 'GPU' : 'CPU',
        });
        if (controller.signal.aborted) return;
        scanner.onGuidance(setGuidance);
        setPhase('scanning');
        const value = await scanner.run(controller.signal);
        if (controller.signal.aborted) return;
        setResult(value);
        setPhase('result');
      } catch (error) {
        if (controller.signal.aborted) return;
        setFailure(
          error instanceof CameraError
            ? `${error.code}: ${error.message}`
            : error instanceof Error
              ? error.message
              : String(error),
        );
        setPhase('failed');
      }
    })();
    return () => {
      controller.abort();
      scanner?.close();
      camera?.close();
      camera?.video.remove();
      if (video) {
        video.removeAttribute('src');
        video.load();
      }
    };
    // Runs once per mount: the inputs are fixed for the lifetime of this panel.
  }, []);

  const text = guidance ? guidanceText(guidance) : 'Starting the camera…';
  const big = { fontSize: 22, padding: '10px 18px', borderRadius: 10, cursor: 'pointer' } as const;
  return (
    <div
      data-panel="scan"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 10,
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr)',
        gap: 12,
        background: '#fafaf8',
      }}
    >
      <div ref={preview} style={{ background: '#111', borderRadius: 12, overflow: 'hidden' }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 8 }}>
        <div style={{ fontSize: 18, color: '#555' }}>Body scan · before trying on</div>
        {phase === 'failed' ? (
          <>
            <div style={{ fontSize: 30, fontWeight: 700 }}>No scan this time</div>
            <div style={{ fontSize: 20 }}>{failure}</div>
            <div style={{ fontSize: 20 }}>Your body will come from height and weight.</div>
            <button style={big} onClick={() => onDone(null)}>
              Continue without scan
            </button>
          </>
        ) : phase === 'result' && result ? (
          <>
            <div style={{ fontSize: 30, fontWeight: 700, color: '#2e7d32' }}>Scan complete</div>
            <table style={{ fontSize: 20 }}>
              <tbody>
                {Object.entries(result.measurements).map(([name, m]) => (
                  <tr key={name}>
                    <td>{NAMES[name] ?? name}</td>
                    <td style={{ textAlign: 'right' }}>
                      <b>{m.value_cm.toFixed(1)} cm</b> ± {m.sigma_cm.toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {result.calibration === 'uncalibrated' && (
              <div style={{ fontSize: 16, color: '#8d6e00' }}>
                Camera not calibrated: wide uncertainty.
              </div>
            )}
            {result.warnings.length > 0 && (
              <div style={{ fontSize: 16, color: '#8d6e00' }}>{result.warnings.join(' · ')}</div>
            )}
            <button
              style={{ ...big, background: '#1b5e20', color: '#fff', fontWeight: 700 }}
              onClick={() => onDone(result)}
            >
              Use this body
            </button>
            <button style={big} onClick={() => onDone(null)}>
              Discard scan
            </button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 30, fontWeight: 700 }}>{stageTitle(guidance)}</div>
            <div
              style={{ fontSize: 34, fontWeight: 700, color: guidance?.ok ? '#2e7d32' : '#e65100' }}
            >
              {text}
            </div>
            <div style={{ height: 16, background: '#ddd', borderRadius: 8 }}>
              <div
                style={{
                  height: '100%',
                  width: `${Math.round((guidance?.progress ?? 0) * 100)}%`,
                  background: '#2e7d32',
                  borderRadius: 8,
                }}
              />
            </div>
            <ul style={{ fontSize: 19, margin: 0, paddingLeft: 22, lineHeight: 1.5 }}>
              {SETUP.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {source.kind === 'video' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => videoRef.current?.pause()}>hold frame</button>
                <button onClick={() => void videoRef.current?.play()}>play</button>
              </div>
            )}
            <button style={big} onClick={() => onDone(null)}>
              Skip scan (use height and weight)
            </button>
          </>
        )}
      </div>
    </div>
  );
}
