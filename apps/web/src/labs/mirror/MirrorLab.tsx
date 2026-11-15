// Dev lab for the live mirror (/?mirrorlab). Owner: Claude agent V1 (prompt 14). Not a judge route.
// Body form → /body/fit → body_id; product + size; source = webcam or a local video file (never
// uploaded) or a reference video served from loopback (data/reference-photos, gitignored).
// Left: the source image with the 2D landmarks. Right: the mirror avatar. Both images are flipped
// like a mirror when "mirror" is on (display only: the posed avatar is the true pose).
import { useEffect, useRef, useState } from 'react';
import { api, type FitRequest, type FitResponse, type GarmentSpec } from '../../api';
import type { LiveTryOnOptions, LiveTryOnState, ZoneReadout } from '../../engine/live/contract';
import {
  createLiveTryOn,
  garmentFitLoader,
  type LiveStats,
  type LiveTryOnEngine,
  type StaticFit,
} from '../../engine/live/LiveTryOnEngine';
import { ArCompositor } from '../../engine/live/ar/ArCompositor';
import { createMoveBaker } from '../../engine/live/record/RecordMoveBaker';
import { createCameraSource } from '../../engine/live/sources/cameraSource';
import { MirrorCompare, pickJacket } from './MirrorCompare';
import { ScanPanel, type ScanSource } from './ScanPanel';
import { fitBody } from '../../kiosk/kioskApi';
import type { ScanResult } from '@satisfy/vision';

/** ScanResult → FitRequest.scan_measurements (same mapping as the kiosk, KioskApp.startFitting). */
function scanMeasurements(scan: ScanResult) {
  return {
    ...Object.fromEntries(
      Object.entries(scan.measurements).map(([name, m]) => [
        name,
        { value_cm: m.value_cm, sigma_cm: m.sigma_cm, method: m.method.slice(0, 400) },
      ]),
    ),
    calibration: /^[A-Za-z0-9_.:-]{1,64}$/.test(scan.calibration)
      ? scan.calibration
      : 'uncalibrated',
  };
}
import { recordDiagnostics } from './diagnostics';
import { createVideoFileSource } from '../../engine/live/sources/videoFileSource';

type SourceChoice = 'camera' | 'file' | 'reference';
type RefVideo = { folder: string; name: string };

const CONNECTIONS: [number, number][] = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [24, 26],
  [26, 28],
  [0, 11],
  [0, 12],
];

/** Move timestamps of the phone videos (docs/look/video-index.md, ±1 s). */
const JUMPS: Record<string, [string, number][]> = {
  'video-parka.mp4': [
    ['neutral', 2],
    ['reach up both', 47],
    ['reach up one', 53],
    ['cross arms', 66],
    ['sit', 70],
    ['reach forward (side)', 178],
  ],
};

/** Scoped resets: the app's global form styles (dark full-width selects) do not suit the lab. */
const LAB_CSS = `
.mlab { color: #111; }
.mlab select, .mlab input:not([type]), .mlab input[type='file'] {
  width: auto; color: #111; background: #fff; border: 1px solid #888; border-radius: 6px;
  padding: 4px 8px; font-size: 18px; min-height: 0; height: auto;
}
.mlab button { color: #111; background: #fff; border: 1px solid #888; }
.mlab button:disabled { opacity: 0.45; }
.mlab label { color: #111; font-size: 18px; }
.mlab th { color: #333; }
`;

const big = { fontSize: 22, padding: '10px 18px', borderRadius: 10, cursor: 'pointer' } as const;
const STATUS_COLOUR: Record<string, string> = {
  tight: '#c62828',
  fit: '#2e7d32',
  relaxed: '#1565c0',
  too_big: '#6a1b9a',
  unknown: '#777',
};

async function referenceVideos(): Promise<RefVideo[]> {
  try {
    const response = await fetch('/sandbox/refs', { cache: 'no-store' });
    if (!response.ok) return [];
    const data = (await response.json()) as {
      folders: { name: string; files: { name: string; kind: string }[] }[];
    };
    return data.folders.flatMap((f) =>
      f.files.filter((x) => x.kind === 'video').map((x) => ({ folder: f.name, name: x.name })),
    );
  } catch {
    return [];
  }
}

function drawSource(canvas: HTMLCanvasElement, engine: LiveTryOnEngine) {
  const video = engine.currentSource?.video;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (!video || !video.videoWidth) {
    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  const w = video.videoWidth,
    h = video.videoHeight;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const flip = engine.mirrorDisplay;
  ctx.save();
  if (flip) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1); // like a mirror, same as the engine's mirror view
  }
  ctx.drawImage(video, 0, 0, w, h);
  ctx.restore();
  const lms = engine.lastFrame?.landmarks2d;
  if (!lms) return;
  const X = (x: number) => (flip ? w - x : x);
  ctx.lineWidth = Math.max(3, w / 220);
  for (const [a, b] of CONNECTIONS) {
    const ok = Math.min(lms[a].visibility, lms[b].visibility) > 0.5;
    ctx.strokeStyle = ok ? 'rgba(80,220,255,0.95)' : 'rgba(255,120,80,0.6)';
    ctx.beginPath();
    ctx.moveTo(X(lms[a].x), lms[a].y);
    ctx.lineTo(X(lms[b].x), lms[b].y);
    ctx.stroke();
  }
  for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24]) {
    ctx.fillStyle = lms[i].visibility > 0.5 ? '#fff' : '#f84';
    ctx.beginPath();
    ctx.arc(X(lms[i].x), lms[i].y, ctx.lineWidth * 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function ZoneTable({ zones }: { zones: ZoneReadout[] }) {
  const names = [...new Set(zones.map((z) => z.zone))];
  if (!names.length) return null;
  const cell = (z: ZoneReadout | undefined) =>
    z ? (
      <span style={{ color: STATUS_COLOUR[z.status] }}>
        {z.valueCm === null ? '–' : `${z.valueCm >= 0 ? '+' : ''}${z.valueCm.toFixed(1)} cm`}{' '}
        {z.status}
      </span>
    ) : (
      '–'
    );
  return (
    <table style={{ fontSize: 18, borderCollapse: 'collapse', width: '100%' }}>
      <thead>
        <tr style={{ textAlign: 'left' }}>
          <th>zone</th>
          <th>static fit</th>
          <th>preview (skinned, not physics)</th>
          <th>physics</th>
        </tr>
      </thead>
      <tbody>
        {names.map((n) => (
          <tr key={n}>
            <td>{n}</td>
            <td>{cell(zones.find((z) => z.zone === n && z.basis === 'static-fit'))}</td>
            <td>{cell(zones.find((z) => z.zone === n && z.basis === 'preview'))}</td>
            <td>{cell(zones.find((z) => z.zone === n && z.basis === 'physics'))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** /?mirrorlab, or /?mirrorlab&compare for the kiosk-vs-live look check. */
export function MirrorLab() {
  return new URLSearchParams(location.search).has('compare') ? (
    <MirrorCompare />
  ) : (
    <LiveMirrorLab />
  );
}

function LiveMirrorLab() {
  const params = new URLSearchParams(location.search);
  const [sex, setSex] = useState<'male' | 'female'>(
    params.get('sex') === 'female' ? 'female' : 'male',
  );
  const [height, setHeight] = useState(params.get('h') ?? '');
  const [weight, setWeight] = useState(params.get('w') ?? '');
  const [body, setBody] = useState<FitResponse | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [products, setProducts] = useState<GarmentSpec[]>([]);
  const [productId, setProductId] = useState('');
  const [fit, setFit] = useState<
    (StaticFit & { fit_id: string; recommended_size: string | null }) | null
  >(null);
  const [size, setSize] = useState('');
  const fitRef = useRef<StaticFit | null>(null);
  useEffect(() => {
    fitRef.current = fit;
  }, [fit]);
  const [choice, setChoice] = useState<SourceChoice>(
    (params.get('source') as SourceChoice | null) ?? 'camera',
  );
  const [file, setFile] = useState<File | null>(null);
  const [refs, setRefs] = useState<RefVideo[]>([]);
  const [ref, setRef] = useState(params.get('ref') ?? '');
  const [startAt, setStartAt] = useState(params.get('t') ?? '2');
  const [state, setState] = useState<LiveTryOnState | null>(null);
  const [stats, setStats] = useState<LiveStats | null>(null);
  const [running, setRunning] = useState(false);
  // "Record a move" (physics bake) stays hidden until its playback is verified (lead, 14:05).
  const recordEnabled = params.get('record') === '1';
  const arEnabled = params.get('ar') !== '0';
  const [mirrored, setMirrored] = useState(params.get('mirror') !== '0');
  const engineRef = useRef<LiveTryOnEngine | null>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const arRef = useRef<HTMLDivElement>(null);
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const scanRef = useRef<ScanResult | null>(null);

  function scanSource(): ScanSource {
    if (choice === 'reference') {
      const [folder, name] = ref.split('|');
      return {
        kind: 'video',
        url: `/sandbox/ref?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`,
        startAt: Number(startAt) || 0,
      };
    }
    return { kind: 'camera' };
  }

  async function finishScan(result: ScanResult | null) {
    setScanning(false);
    scanRef.current = result;
    setScan(result);
    // A new body: the next Start (or this rebuild) uses it.
    setBody(null);
    setFit(null);
    if (result) await buildBody();
  }
  const [diag, setDiag] = useState<{
    kind: 'idle' | 'countdown' | 'rec' | 'saving' | 'saved' | 'error';
    text: string;
  }>({ kind: 'idle', text: '' });

  /** 3-2-1, then 20 s of both views + per-frame log, downloaded to Downloads (local only). */
  async function recordDiag() {
    const engine = engineRef.current;
    if (!engine) return;
    try {
      for (const n of [3, 2, 1]) {
        setDiag({ kind: 'countdown', text: `Recording in ${n}…` });
        await new Promise((r) => setTimeout(r, 1000));
      }
      const result = await recordDiagnostics({
        engine,
        arRenderer: engine.arRenderer,
        meta: {
          body: body
            ? {
                bodyId: body.body_id,
                source: scan ? 'scan' : 'height/weight',
                heightCm: Number(height),
                weightKg: Number(weight),
                sex,
                measurements: Object.fromEntries(
                  Object.entries(body.measurements).map(([k, m]) => [k, m.value_cm]),
                ),
              }
            : null,
          scan: scan ? { measurements: scan.measurements, calibration: scan.calibration } : null,
          product: products.find((p) => p.product_id === productId)?.title ?? productId,
          size,
        },
        arContainer: arRef.current,
        seconds: 20,
        onTick: (left) => setDiag({ kind: 'rec', text: `● REC ${left} s` }),
      });
      setDiag({
        kind: 'saved',
        text: `Saved to Downloads: ${result.base}.webm + .json (${result.frames} frames)`,
      });
      setTimeout(() => setDiag({ kind: 'idle', text: '' }), 12000);
    } catch (error) {
      setDiag({
        kind: 'error',
        text: `Recording failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  const fitLoader = useRef<(o: LiveTryOnOptions, signal: AbortSignal) => Promise<StaticFit | null>>(
    () => Promise.resolve(null),
  );
  const settings = useRef({ density: 1010 as FitRequest['density_kg_m3'], layer: 0 });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [capabilities, options, list, videos] = await Promise.all([
          api.capabilities(),
          api.garmentOptions(),
          api.products(),
          referenceVideos(),
        ]);
        if (cancelled) return;
        settings.current.density =
          capabilities.default_density_kg_m3 as FitRequest['density_kg_m3'];
        settings.current.layer = options.layer_presets_cm['t-shirt'] ?? 0;
        setProducts(list);
        const jacket = params.get('jacket')?.toLowerCase();
        const preferred = jacket ? pickJacket(list, jacket) : undefined;
        setProductId((p) => p || preferred?.product_id || list[0]?.product_id || '');
        setRefs(videos);
        setRef((r) => r || (videos[0] ? `${videos[0].folder}|${videos[0].name}` : ''));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * V2's compositor. V4's finishing pass is OFF by default in this lab (lead, 15:55: it cost
   * ~110 ms/frame on the main thread here) until V4 reports it under ~4 ms; ?finish=1 opts in.
   */
  function makeCompositor() {
    const compositor = new ArCompositor({ mirrorDisplay: false });
    compositor.useFinisher = params.get('finish') === '1';
    return compositor;
  }

  // The engine and its mirror view live as long as the lab.
  useEffect(() => {
    const engine = createLiveTryOn({
      // V2's AR on the left (the real split screen); ?ar=0 shows the plain camera + landmarks.
      ...(arEnabled ? { arRenderer: makeCompositor() } : {}),
      mirrorDisplay: params.get('mirror') !== '0',
      stabilize: params.get('stab') !== '0',
      armsDown: params.get('armsdown') !== '0',
      fitMedian: params.get('median') !== '0',
      // The old behaviour (stab=0) also drove the legs; legs=1 drives them with the stabilizer.
      driveLegs: params.get('legs') === '1' || params.get('stab') === '0',
      loadFit: (o, signal) => fitLoader.current(o, signal),
      // V3: "Record a move" bakes true cloth physics on this body (static zones for the readouts).
      ...(recordEnabled
        ? {
            moveBaker: createMoveBaker({
              staticZones: (o) => fitRef.current?.sizes[o.size]?.zones,
            }),
          }
        : {}),
    });
    engineRef.current = engine;
    if (mirrorRef.current) engine.attachMirrorView(mirrorRef.current);
    if (arEnabled && arRef.current) engine.attachArView(arRef.current);
    const off = engine.onState(setState);
    let raf = 0;
    let lastStats = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!arEnabled && canvasRef.current) drawSource(canvasRef.current, engine);
      if (now - lastStats > 500) {
        lastStats = now;
        setStats(engine.stats());
      }
    };
    raf = requestAnimationFrame(tick);
    (window as unknown as { __mirrorlab?: unknown }).__mirrorlab = {
      engine,
      stats: () => engine.stats(),
      state: () => engine.currentState,
    };
    return () => {
      cancelAnimationFrame(raf);
      off();
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  async function buildBody() {
    setError('');
    const h = Number(height),
      w = Number(weight);
    if (!(h >= 120 && h <= 220) || !(w >= 30 && w <= 200)) {
      setError('Enter your height (120–220 cm) and weight (30–200 kg) first.');
      return null;
    }
    setBusy('Building your body…');
    try {
      // With a scan, its measurements refine the body (the kiosk's request, kioskApi.fitBody).
      const scanned = scanRef.current;
      const { body: fitted } = await fitBody({
        sex,
        height_cm: h,
        weight_kg: w,
        shape_reference: 'neutral',
        density_kg_m3: settings.current.density,
        known_measurements: {},
        ...(scanned ? { scan_measurements: scanMeasurements(scanned) } : {}),
      });
      setBody(fitted);
      const response = await loadFit(fitted.body_id, productId);
      return response ? { body: fitted, ...response } : null;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy('');
    }
  }

  async function loadFit(bodyId: string, product: string) {
    if (!product) return;
    setBusy('Fitting the jacket…');
    try {
      const response = await api.garmentFit({
        body_id: bodyId,
        product_id: product,
        layer_cm: settings.current.layer,
        preference: 'regular',
      });
      setFit(
        response as unknown as StaticFit & { fit_id: string; recommended_size: string | null },
      );
      const sizes = Object.keys(response.sizes);
      const wanted = params.get('size');
      const chosen =
        size && sizes.includes(size)
          ? size
          : wanted && sizes.includes(wanted)
            ? wanted
            : (response.recommended_size ?? sizes[0]);
      setSize(chosen);
      return {
        fit: response as unknown as StaticFit & { fit_id: string; recommended_size: string | null },
        size: chosen,
      };
    } finally {
      setBusy('');
    }
  }

  async function start() {
    const engine = engineRef.current;
    if (!engine) return;
    setError('');
    // One click: build the body and fit the jacket first if needed.
    let currentBody = body,
      currentFit = fit,
      currentSize = size;
    if (!currentBody || !currentFit) {
      const built = await buildBody();
      if (!built) return;
      currentBody = built.body;
      currentFit = built.fit;
      currentSize = built.size;
    }
    const startBody = currentBody,
      startFit = currentFit;
    let source;
    // ?seg=1: also read the person segmentation mask (the AR's occlusion input), to measure its cost.
    const tracked = { segmentation: params.get('seg') === '1' };
    if (choice === 'camera') source = createCameraSource({}, tracked);
    else if (choice === 'file') {
      if (!file) return setError('Choose a video file first.');
      source = createVideoFileSource(file, { ...tracked, startAt: Number(startAt) || 0 });
    } else {
      const [folder, name] = ref.split('|');
      if (!folder || !name) return setError('No reference video found.');
      const url = `/sandbox/ref?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`;
      source = createVideoFileSource(url, { ...tracked, startAt: Number(startAt) || 0 });
    }
    setRunning(true);
    const loadFitFn = garmentFitLoader({ layer_cm: settings.current.layer, preference: 'regular' });
    // Reuse the fit already fetched for the first load (same body + product).
    fitLoader.current = async (o, s) =>
      o.productId === productId && o.bodyId === startBody.body_id ? startFit : loadFitFn(o, s);
    await engine.start(source, {
      bodyId: startBody.body_id,
      fitId: startFit.fit_id,
      productId,
      size: currentSize,
    });
  }

  function stop() {
    engineRef.current?.stop();
    setRunning(false);
  }

  async function changeProduct(next: string) {
    setProductId(next);
    if (!body) return;
    const response = await loadFit(body.body_id, next).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    });
    if (response && running) await engineRef.current?.setProduct(next, response.fit.fit_id);
  }

  async function changeSize(next: string) {
    setSize(next);
    if (running) await engineRef.current?.setSize(next);
  }

  function jump(t: number) {
    const video = engineRef.current?.currentSource?.video;
    if (video) video.currentTime = t;
  }

  const phase = state?.phase ?? 'idle';
  // An engine error (camera busy or denied, body expired) brings the Start button back.
  useEffect(() => {
    if (phase === 'error') setRunning(false);
  }, [phase]);
  const quality = state?.trackingQuality ?? 0;
  const refName = ref.split('|')[1]?.split('/').pop() ?? '';
  const jumps = choice === 'reference' ? (JUMPS[refName] ?? []) : [];
  const phaseColour =
    phase === 'tracking'
      ? '#2e7d32'
      : phase === 'calibrating'
        ? '#ef6c00'
        : phase === 'lost' || phase === 'error'
          ? '#c62828'
          : '#333';

  return (
    <main
      className="mlab"
      style={{
        fontFamily: 'system-ui',
        padding: 12,
        display: 'grid',
        gap: 10,
        // Fixed rows: the control rows never wrap and the status row has a fixed height, so the
        // views' row never changes size when text changes (the AR "zoom" report, 14:30).
        gridTemplateRows: '62px 62px minmax(0, 1fr) 200px',
        height: '100vh',
        boxSizing: 'border-box',
        background: '#fafaf8',
      }}
    >
      <style>{LAB_CSS}</style>
      <section
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          flexWrap: 'nowrap',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          fontSize: 18,
        }}
      >
        <strong style={{ fontSize: 22 }}>Mirror lab · Try it on you</strong>
        <select
          value={sex}
          onChange={(e) => setSex(e.target.value as 'male' | 'female')}
          style={{ fontSize: 18 }}
        >
          <option value="male">male</option>
          <option value="female">female</option>
        </select>
        <label>
          height cm{' '}
          <input
            value={height}
            onChange={(e) => setHeight(e.target.value)}
            size={4}
            style={{ fontSize: 18 }}
          />
        </label>
        <label>
          weight kg{' '}
          <input
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            size={4}
            style={{ fontSize: 18 }}
          />
        </label>
        <button
          onClick={() => {
            setError('');
            if (!(Number(height) >= 120 && Number(height) <= 220))
              return setError('Enter your height first: the scan uses it for scale.');
            setScanning(true);
          }}
          disabled={!!busy || running || scanning}
          style={{ ...big, background: '#0d47a1', color: '#fff' }}
        >
          {scan ? 'Scan again' : 'Scan my body'}
        </button>
        <button onClick={() => void buildBody()} disabled={!!busy || running} style={big}>
          {body ? 'Rebuild body' : 'Build my body'}
        </button>
        <select
          value={productId}
          onChange={(e) => void changeProduct(e.target.value)}
          style={{ fontSize: 18 }}
        >
          {products.map((p) => (
            <option key={p.product_id} value={p.product_id}>
              {p.title}
            </option>
          ))}
        </select>
        <select
          value={size}
          onChange={(e) => void changeSize(e.target.value)}
          style={{ fontSize: 18 }}
          disabled={!fit}
        >
          {Object.keys(fit?.sizes ?? {}).map((s) => (
            <option key={s} value={s}>
              {s}
              {s === fit?.recommended_size ? ' (recommended)' : ''}
            </option>
          ))}
        </select>
        {busy && <span>{busy}</span>}
      </section>
      <section
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          flexWrap: 'nowrap',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          fontSize: 18,
        }}
      >
        <label>
          <input type="radio" checked={choice === 'camera'} onChange={() => setChoice('camera')} />{' '}
          camera
        </label>
        <label>
          <input type="radio" checked={choice === 'file'} onChange={() => setChoice('file')} />{' '}
          video file
        </label>
        {choice === 'file' && (
          <input
            type="file"
            accept="video/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        )}
        <label>
          <input
            type="radio"
            checked={choice === 'reference'}
            onChange={() => setChoice('reference')}
          />{' '}
          reference video (local)
        </label>
        {choice === 'reference' && (
          <select value={ref} onChange={(e) => setRef(e.target.value)} style={{ fontSize: 16 }}>
            {refs.map((r) => (
              <option key={`${r.folder}|${r.name}`} value={`${r.folder}|${r.name}`}>
                {r.folder.split('-').slice(-2).join(' ')} · {r.name}
              </option>
            ))}
          </select>
        )}
        {choice !== 'camera' && (
          <label>
            start at s{' '}
            <input
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
              size={3}
              style={{ fontSize: 18 }}
            />
          </label>
        )}
        {!running ? (
          <button
            onClick={() => void start()}
            disabled={!!busy}
            style={{
              ...big,
              fontSize: 28,
              fontWeight: 700,
              padding: '12px 28px',
              background: '#1b5e20',
              color: '#fff',
            }}
          >
            {choice === 'camera' ? 'Start camera' : 'Start video'}
          </button>
        ) : (
          <button onClick={stop} style={big}>
            Stop
          </button>
        )}
        {running && (
          <>
            <button onClick={() => void engineRef.current?.calibrate()} style={big}>
              Recalibrate
            </button>
            <button
              onClick={() => void recordDiag()}
              disabled={diag.kind === 'countdown' || diag.kind === 'rec' || diag.kind === 'saving'}
              style={{ ...big, background: '#b71c1c', color: '#fff' }}
            >
              Record diagnostics (20 s)
            </button>
            {recordEnabled && (
              <button
                onClick={() => void engineRef.current?.recordMove(5)}
                style={big}
                disabled={phase !== 'tracking'}
              >
                Record a move (5 s)
              </button>
            )}
            {recordEnabled &&
              (phase === 'playback' ? (
                <button onClick={() => engineRef.current?.backToLive()} style={big}>
                  Back to live
                </button>
              ) : (
                <button onClick={() => engineRef.current?.replayLast()} style={big}>
                  Replay last
                </button>
              ))}
          </>
        )}
        <label>
          <input
            type="checkbox"
            checked={mirrored}
            onChange={(e) => {
              setMirrored(e.target.checked);
              engineRef.current?.setMirrorDisplay(e.target.checked);
            }}
          />{' '}
          mirror image
        </label>
        {running &&
          jumps.map(([label, t]) => (
            <button key={label} onClick={() => jump(t)} style={{ fontSize: 15 }}>
              {label} ({t}s)
            </button>
          ))}
      </section>
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
          gridTemplateRows: 'minmax(0, 1fr)',
          gap: 12,
          minHeight: 0,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {scanning && (
          <ScanPanel
            heightCm={Number(height)}
            sex={sex}
            source={scanSource()}
            onDone={(result) => void finishScan(result)}
          />
        )}
        <div
          style={{
            position: 'relative',
            background: '#222',
            borderRadius: 12,
            overflow: 'hidden',
            minHeight: 0,
          }}
        >
          {arEnabled ? (
            <div ref={arRef} style={{ position: 'absolute', inset: 0 }} />
          ) : (
            <canvas
              ref={canvasRef}
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
            />
          )}
          <span
            style={{
              position: 'absolute',
              left: 12,
              top: 8,
              color: '#fff',
              fontSize: 18,
              zIndex: 3,
              textShadow: '0 1px 3px #000',
            }}
          >
            {arEnabled ? 'you, with the jacket (AR)' : choice === 'camera' ? 'camera' : 'video'}
            {mirrored ? ' · mirrored' : ''}
          </span>
        </div>
        <div
          style={{
            position: 'relative',
            borderRadius: 12,
            overflow: 'hidden',
            minHeight: 0,
            background: '#ecebe8',
          }}
        >
          <div ref={mirrorRef} style={{ position: 'absolute', inset: 0 }} />
          <span
            style={{
              position: 'absolute',
              left: 12,
              top: 8,
              fontSize: 18,
              background: '#fff8',
              padding: '2px 8px',
              borderRadius: 6,
            }}
          >
            {phase === 'playback' && state?.zones.some((z) => z.basis === 'physics')
              ? 'mirror · jacket = PHYSICS replay (true cloth simulation)'
              : phase === 'baking'
                ? 'mirror · simulating the jacket on your move…'
                : 'mirror · jacket = skinned PREVIEW (no cloth physics)'}
          </span>
          {phase === 'calibrating' && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'grid',
                placeItems: 'center',
                background: '#0006',
                color: '#fff',
                fontSize: 34,
                fontWeight: 700,
                textAlign: 'center',
                padding: 24,
              }}
            >
              <div>
                Stand straight, arms relaxed
                <br />
                hold still for 1 second
                <div style={{ fontSize: 22, marginTop: 12 }}>{state?.message}</div>
                <div
                  style={{
                    marginTop: 16,
                    height: 14,
                    width: 320,
                    background: '#fff4',
                    borderRadius: 7,
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${Math.round((state?.progress ?? 0) * 100)}%`,
                      background: '#ffb300',
                      borderRadius: 7,
                    }}
                  />
                </div>
              </div>
            </div>
          )}
          {diag.kind !== 'idle' && (
            <div
              style={{
                position: 'absolute',
                right: 12,
                top: 8,
                zIndex: 5,
                padding: '6px 14px',
                borderRadius: 8,
                font: '700 24px system-ui',
                color: '#fff',
                background:
                  diag.kind === 'error' ? '#c62828' : diag.kind === 'saved' ? '#2e7d32' : '#b71c1c',
              }}
            >
              {diag.text}
            </div>
          )}
          {phase === 'tracking' &&
            /^(Turn back toward|Step back a little|Tracking is weak)/.test(
              state?.message ?? '',
            ) && (
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: 20,
                  textAlign: 'center',
                  fontSize: 26,
                  fontWeight: 700,
                  color: '#e65100',
                  textShadow: '0 1px 2px #fff',
                }}
              >
                {state?.message}
              </div>
            )}
          {phase === 'lost' && (
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 24,
                textAlign: 'center',
                fontSize: 28,
                fontWeight: 700,
                color: '#c62828',
              }}
            >
              {state?.message}
            </div>
          )}
        </div>
      </section>
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr)',
          gap: 16,
          fontSize: 18,
          height: 200,
          overflow: 'hidden',
        }}
      >
        <div>
          <div style={{ fontSize: 26, fontWeight: 700, color: phaseColour }}>
            {phase.toUpperCase()} ·{' '}
            {state?.message ||
              busy ||
              (height && weight
                ? 'Ready: press Start camera'
                : 'Enter your height and weight, then press Start camera')}
          </div>
          {error && <div style={{ color: '#c62828', fontSize: 20 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
            tracking
            <div style={{ width: 200, height: 12, background: '#ddd', borderRadius: 6 }}>
              <div
                style={{
                  width: `${Math.round(quality * 100)}%`,
                  height: '100%',
                  borderRadius: 6,
                  background: quality > 0.6 ? '#2e7d32' : quality > 0.3 ? '#ef6c00' : '#c62828',
                }}
              />
            </div>
            {(quality * 100).toFixed(0)}%
          </div>
          {stats && (
            <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 15, marginTop: 6 }}>
              source {stats.sourceFps} fps · mirror {stats.renderFps} fps · tracker{' '}
              {stats.trackerMs?.toFixed(0) ?? '–'} ms (inference{' '}
              {stats.inferenceMs?.toFixed(0) ?? '–'}) · rig+skin {stats.poseMs.toFixed(1)} ms · to
              screen {stats.displayMs.toFixed(0)} ms · total {stats.totalMs?.toFixed(0) ?? '–'} ms ·
              DOFs {stats.estimated.length}/15 · clamps {stats.clamps} · {stats.tracker ?? ''} ·
              wrist step{' '}
              {stats.wristStepMm
                ? `${stats.wristStepMm.mean.toFixed(1)}/${stats.wristStepMm.p90.toFixed(1)} mm`
                : '–'}
              {/* V6: the live jacket deformers (?dyn=0 / ?dyn=1); fit numbers never use them. */}
              {stats.deform.map((d) => (
                <div key={d.name}>
                  {d.name} {d.active ? 'on' : 'off'} · {d.lastApplyMs.toFixed(2)} ms · {d.note}
                  {d.name === 'dynamics' && stats.rootYawDeg !== null
                    ? ` · heading ${stats.rootYawDeg.toFixed(0)}°`
                    : ''}
                </div>
              ))}
            </div>
          )}
          {body && (
            <div style={{ fontSize: 14, color: '#666' }}>
              body {body.body_id.slice(0, 8)} ({scan ? 'scanned' : 'height/weight'}) · fit{' '}
              {fit?.fit_id.slice(0, 8) ?? '–'} · size {size}
            </div>
          )}
        </div>
        <ZoneTable zones={state?.zones ?? []} />
      </section>
    </main>
  );
}
