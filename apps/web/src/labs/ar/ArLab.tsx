// Dev lab for the AR overlay (/?arlab). Owner: Claude agent V2 (prompt 14). Not a judge route.
// Body form (or ?body=<id>) → product + size → source (reference video on loopback, a local file
// never uploaded, or the webcam) → V1's LiveTryOn engine with this lab's ArCompositor injected.
// Overlays (toggles): MediaPipe landmarks, the posed skeleton reprojected by the solved camera,
// hand occluders. A scrubber holds any frame of a video (the source re-emits a paused frame).
// URL: ?arlab&jacket=parka|puffer&size=S&h=175&w=62&sex=male&ref=<folder|name>&t=3&auto
import { useEffect, useRef, useState } from 'react';
import { api, type FitRequest, type FitResponse, type GarmentSpec } from '../../api';
import type { LiveTryOn, LiveTryOnState } from '../../engine/live/contract';
import { ArCompositor } from '../../engine/live/ar/ArCompositor';
import { ALIGNMENT_JOINTS, LANDMARK_OF_JOINT } from '../../engine/live/ar/config';
import {
  createLiveTryOn,
  garmentFitLoader,
  type LiveTryOnEngine,
  type StaticFit,
} from '../../engine/live/LiveTryOnEngine';
import { createCameraSource } from '../../engine/live/sources/cameraSource';
import { createVideoFileSource } from '../../engine/live/sources/videoFileSource';
import { installArLabHooks } from './labHooks';
import { MOVES } from './moves';

type SourceChoice = 'reference' | 'file' | 'camera';
type RefVideo = { folder: string; name: string };
type Fit = StaticFit & { fit_id: string; recommended_size: string | null };

const BONES: [string, string][] = [
  ['lShoulder', 'rShoulder'],
  ['lShoulder', 'lElbow'],
  ['lElbow', 'lWrist'],
  ['rShoulder', 'rElbow'],
  ['rElbow', 'rWrist'],
  ['lShoulder', 'lHip'],
  ['rShoulder', 'rHip'],
  ['lHip', 'rHip'],
  ['lHip', 'lKnee'],
  ['rHip', 'rKnee'],
];

const LAB_CSS = `
.arlab { color: #111; }
.arlab select, .arlab input:not([type]), .arlab input[type='number'], .arlab input[type='file'] {
  width: auto; color: #111; background: #fff; border: 1px solid #888; border-radius: 6px;
  padding: 3px 6px; font-size: 15px; min-height: 0; height: auto;
}
.arlab button { color: #111; background: #fff; border: 1px solid #888; border-radius: 6px; padding: 4px 10px; font-size: 15px; cursor: pointer; }
.arlab button:disabled { opacity: 0.45; }
.arlab label { color: #111; font-size: 15px; }
.arlab td, .arlab th { padding: 1px 6px; text-align: right; }
`;

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

/** Overlays in SOURCE pixels on a canvas inside the compositor's (display-flipped) stage. */
function drawOverlay(
  canvas: HTMLCanvasElement,
  engine: LiveTryOnEngine,
  ar: ArCompositor,
  show: { landmarks: boolean; skeleton: boolean; hands: boolean },
) {
  const frame = engine.lastFrame;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (!frame) return ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width;
    canvas.height = frame.height;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const lw = Math.max(2, frame.width / 360);
  ctx.lineWidth = lw;
  const lms = frame.landmarks2d;
  if (show.landmarks && lms) {
    for (const [a, b] of BONES) {
      const p = lms[LANDMARK_OF_JOINT[a as keyof typeof LANDMARK_OF_JOINT]!],
        q = lms[LANDMARK_OF_JOINT[b as keyof typeof LANDMARK_OF_JOINT]!];
      if (Math.min(p.visibility, q.visibility) < 0.5) continue;
      ctx.strokeStyle = 'rgba(80,220,255,0.9)';
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
    }
    for (let i = 11; i <= 28; i++) {
      ctx.fillStyle = lms[i].visibility >= 0.5 ? 'rgba(80,220,255,1)' : 'rgba(255,140,80,0.7)';
      ctx.beginPath();
      ctx.arc(lms[i].x, lms[i].y, lw * 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const scene = engine.posedScene;
  if (show.skeleton && scene) {
    const joints = ar.jointsOf(scene);
    const pts = ar.projectPoints(joints as Record<string, [number, number, number]>);
    ctx.strokeStyle = 'rgba(255,60,200,0.95)';
    for (const [a, b] of BONES) {
      if (!pts[a] || !pts[b]) continue;
      ctx.beginPath();
      ctx.moveTo(pts[a][0], pts[a][1]);
      ctx.lineTo(pts[b][0], pts[b][1]);
      ctx.stroke();
    }
    // Error vectors: projected joint → landmark (what the alignment score measures).
    if (lms)
      for (const name of ALIGNMENT_JOINTS) {
        const p = pts[name],
          l = lms[LANDMARK_OF_JOINT[name]!];
        if (!p || !l || l.visibility < 0.5) continue;
        ctx.strokeStyle = 'rgba(255,230,0,0.95)';
        ctx.beginPath();
        ctx.moveTo(p[0], p[1]);
        ctx.lineTo(l.x, l.y);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,60,200,1)';
        ctx.beginPath();
        ctx.arc(p[0], p[1], lw * 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
  }
  if (show.hands)
    for (const h of ar.lastHands) {
      ctx.strokeStyle = 'rgba(120,255,120,0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const dx = h.b[0] - h.a[0],
        dy = h.b[1] - h.a[1];
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * h.radius,
        ny = (dx / len) * h.radius;
      ctx.moveTo(h.a[0] + nx, h.a[1] + ny);
      ctx.lineTo(h.b[0] + nx, h.b[1] + ny);
      ctx.arc(h.b[0], h.b[1], h.radius, Math.atan2(ny, nx), Math.atan2(-ny, -nx));
      ctx.lineTo(h.a[0] - nx, h.a[1] - ny);
      ctx.arc(h.a[0], h.a[1], h.radius, Math.atan2(-ny, -nx), Math.atan2(ny, nx));
      ctx.stroke();
      ctx.lineWidth = lw;
    }
}

/** Display-only mirror: through the engine when it supports it, else the compositor's stage. */
function applyMirror(engine: LiveTryOnEngine, ar: ArCompositor, on: boolean) {
  const live = engine as LiveTryOn;
  if (live.setMirrorDisplay) live.setMirrorDisplay(on);
  else ar.setMirrorDisplay(on);
}

const fmt = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(digits);

export function ArLab() {
  const params = new URLSearchParams(location.search);
  const [sex, setSex] = useState<'male' | 'female'>(
    params.get('sex') === 'female' ? 'female' : 'male',
  );
  const [height, setHeight] = useState(params.get('h') ?? '');
  const [weight, setWeight] = useState(params.get('w') ?? '');
  const [bodyId, setBodyId] = useState(params.get('body') ?? '');
  const [products, setProducts] = useState<GarmentSpec[]>([]);
  const [productId, setProductId] = useState('');
  const [fit, setFit] = useState<Fit | null>(null);
  const [size, setSize] = useState(params.get('size') ?? '');
  const [choice, setChoice] = useState<SourceChoice>(
    (params.get('source') as SourceChoice | null) ?? 'reference',
  );
  const [file, setFile] = useState<File | null>(null);
  const [refs, setRefs] = useState<RefVideo[]>([]);
  const [ref, setRef] = useState(params.get('ref') ?? '');
  const [startAt, setStartAt] = useState(params.get('t') ?? '3');
  const [state, setState] = useState<LiveTryOnState | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [show, setShow] = useState({ landmarks: true, skeleton: true, hands: false });
  const [mirrorDisplay, setMirrorDisplay] = useState(params.get('mirror') !== '0');
  const [videoTime, setVideoTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(false);
  const [, setTick] = useState(0);
  const engineRef = useRef<LiveTryOnEngine | null>(null);
  const arRef = useRef<ArCompositor | null>(null);
  const arContainer = useRef<HTMLDivElement>(null);
  const mirrorContainer = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLCanvasElement | null>(null);
  const showRef = useRef(show);
  showRef.current = show;
  const fitLoader = useRef<
    (o: { productId: string; bodyId: string }, s: AbortSignal) => Promise<StaticFit | null>
  >(() => Promise.resolve(null));
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
        const preferred = jacket
          ? list.find((p) => `${p.title} ${p.style}`.toLowerCase().includes(jacket))
          : undefined;
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

  // Engine + AR compositor live as long as the lab.
  useEffect(() => {
    // Mirroring is display-only. The engine flips its views when it can (LiveTryOn
    // .setMirrorDisplay); otherwise the compositor flips its own stage. Never both.
    const ar = new ArCompositor({ mirrorDisplay: false });
    // V4's finisher is off by default (cost); ?finish=1 opts in for A/B runs.
    ar.useFinisher = params.get('finish') === '1';
    // A/B: ?shoulder=0..1 sets the shoulder-landmark blend (joint → acromion) from the start.
    const blend = Number(params.get('shoulder'));
    if (params.has('shoulder') && blend >= 0 && blend <= 1) ar.shoulderMarkBlend = blend;
    // A/B: ?headflex=0 / 1 turns the forward-head correction of the eye anchors off / on.
    if (params.has('headflex')) ar.headFlexionOn = params.get('headflex') !== '0';
    // A/B: ?still=0 turns the stillness lock off.
    if (params.get('still') === '0') ar.stillnessOn = false;
    const headOffset = Number(params.get('headoffset'));
    if (params.has('headoffset') && Number.isFinite(headOffset))
      ar.headFlexionOffsetDeg = headOffset;
    const engine = createLiveTryOn({
      arRenderer: ar,
      loadFit: (o, signal) => fitLoader.current(o, signal),
    });
    engineRef.current = engine;
    arRef.current = ar;
    if (arContainer.current) engine.attachArView(arContainer.current);
    // &nomirror: AR only (the evaluation's browser: less RAM and GPU than a second 3D view).
    if (mirrorContainer.current && !params.has('nomirror'))
      engine.attachMirrorView(mirrorContainer.current);
    applyMirror(engine, ar, mirrorDisplay);
    const off = engine.onState(setState);
    let raf = 0,
      last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const stage = ar.stage;
      if (stage && overlay.current?.parentElement !== stage) {
        const canvas = document.createElement('canvas');
        canvas.style.cssText =
          'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none';
        stage.append(canvas);
        overlay.current = canvas;
      }
      if (overlay.current) drawOverlay(overlay.current, engine, ar, showRef.current);
      const video = engine.currentSource?.video;
      if (now - last > 200) {
        last = now;
        if (video) {
          setVideoTime(video.currentTime);
          setDuration(video.duration || 0);
          setPaused(video.paused);
        }
        setTick((t) => t + 1);
      }
    };
    raf = requestAnimationFrame(tick);
    const hooks = installArLabHooks(engine, ar);
    return () => {
      hooks();
      cancelAnimationFrame(raf);
      off();
      engine.dispose();
      engineRef.current = null;
      arRef.current = null;
    };
    // The compositor is built once; the mirror toggle calls applyMirror.
  }, []);

  async function ensureBody(): Promise<string | null> {
    if (/^[a-f0-9]{64}$/.test(bodyId)) return bodyId;
    const h = Number(height),
      w = Number(weight);
    if (!(h >= 120 && h <= 220) || !(w >= 30 && w <= 200)) {
      setError('Enter height (120–220 cm) and weight (30–200 kg), or a body id.');
      return null;
    }
    setBusy('Building the body…');
    try {
      const fitted: FitResponse = await api.fit({
        sex,
        height_cm: h,
        weight_kg: w,
        shape_reference: 'neutral',
        density_kg_m3: settings.current.density,
        known_measurements: {},
      });
      setBodyId(fitted.body_id);
      return fitted.body_id;
    } finally {
      setBusy('');
    }
  }

  async function loadFit(body: string, product: string): Promise<{ fit: Fit; size: string }> {
    setBusy('Fitting the jacket…');
    try {
      const response = (await api.garmentFit({
        body_id: body,
        product_id: product,
        layer_cm: settings.current.layer,
        preference: 'regular',
      })) as unknown as Fit;
      setFit(response);
      const sizes = Object.keys(response.sizes);
      const chosen = size && sizes.includes(size) ? size : (response.recommended_size ?? sizes[0]);
      setSize(chosen);
      return { fit: response, size: chosen };
    } finally {
      setBusy('');
    }
  }

  async function start() {
    const engine = engineRef.current;
    if (!engine) return;
    setError('');
    try {
      const body = await ensureBody();
      if (!body || !productId) return;
      const { fit: f, size: s } =
        fit && fit.fit_id && (fit as { body_id?: string }).body_id === body
          ? { fit, size }
          : await loadFit(body, productId);
      let source;
      if (choice === 'camera') source = createCameraSource();
      else if (choice === 'file') {
        if (!file) return setError('Choose a video file first.');
        source = createVideoFileSource(file, { startAt: Number(startAt) || 0 });
      } else {
        const [folder, name] = ref.split('|');
        if (!folder || !name) return setError('No reference video found.');
        const url = `/sandbox/ref?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`;
        source = createVideoFileSource(url, { startAt: Number(startAt) || 0 });
      }
      const loader = garmentFitLoader({ layer_cm: settings.current.layer, preference: 'regular' });
      fitLoader.current = async (o, signal) =>
        o.productId === productId && o.bodyId === body
          ? f
          : loader({ ...o, fitId: f.fit_id, size: s }, signal);
      setRunning(true);
      arRef.current?.tracker.reset();
      await engine.start(source, { bodyId: body, fitId: f.fit_id, productId, size: s });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function stop() {
    engineRef.current?.stop();
    setRunning(false);
  }

  async function changeProduct(next: string) {
    setProductId(next);
    if (!/^[a-f0-9]{64}$/.test(bodyId)) return;
    try {
      const r = await loadFit(bodyId, next);
      if (running) await engineRef.current?.setProduct(next, r.fit.fit_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function changeSize(next: string) {
    setSize(next);
    if (running) await engineRef.current?.setSize(next);
  }

  const video = () => engineRef.current?.currentSource?.video ?? null;
  function seek(t: number) {
    const v = video();
    if (!v) return;
    arRef.current?.tracker.resetSmoothing();
    v.currentTime = Math.max(0, Math.min(t, (v.duration || t) - 0.05));
  }
  function togglePlay() {
    const v = video();
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }

  const ar = arRef.current;
  const solution = ar?.tracker.last;
  const report = solution?.alignment;
  const focal = ar?.tracker.focalEstimate;
  const refName = ref.split('|')[1]?.split('/').pop() ?? '';
  const moves = choice === 'reference' ? (MOVES[refName] ?? []) : [];
  const sizes = fit ? Object.keys(fit.sizes) : [];

  return (
    <main
      className="arlab"
      style={{
        fontFamily: 'system-ui',
        padding: 10,
        display: 'grid',
        gap: 8,
        gridTemplateRows: 'auto auto 1fr',
        height: '100vh',
        boxSizing: 'border-box',
        background: '#fafaf8',
      }}
    >
      <style>{LAB_CSS}</style>
      <section style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 18 }}>AR lab (V2)</strong>
        <select value={sex} onChange={(e) => setSex(e.target.value as 'male' | 'female')}>
          <option value="male">male</option>
          <option value="female">female</option>
        </select>
        <label>
          cm{' '}
          <input
            type="number"
            style={{ width: 70 }}
            value={height}
            onChange={(e) => setHeight(e.target.value)}
          />
        </label>
        <label>
          kg{' '}
          <input
            type="number"
            style={{ width: 60 }}
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
          />
        </label>
        <label>
          or body{' '}
          <input
            style={{ width: 120 }}
            value={bodyId}
            placeholder="body_id"
            onChange={(e) => setBodyId(e.target.value.trim())}
          />
        </label>
        <select value={productId} onChange={(e) => void changeProduct(e.target.value)}>
          {products.map((p) => (
            <option key={p.product_id} value={p.product_id}>
              {p.style} {p.title}
            </option>
          ))}
        </select>
        <select
          value={size}
          onChange={(e) => void changeSize(e.target.value)}
          disabled={!sizes.length}
        >
          {(sizes.length ? sizes : [size || '–']).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={choice} onChange={(e) => setChoice(e.target.value as SourceChoice)}>
          <option value="reference">reference video</option>
          <option value="file">local file</option>
          <option value="camera">camera</option>
        </select>
        {choice === 'reference' && (
          <select value={ref} onChange={(e) => setRef(e.target.value)}>
            {refs.map((r) => (
              <option key={`${r.folder}|${r.name}`} value={`${r.folder}|${r.name}`}>
                {r.folder.split('-').slice(-1)[0]} / {r.name.split('/').pop()}
              </option>
            ))}
          </select>
        )}
        {choice === 'file' && (
          <input
            type="file"
            accept="video/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        )}
        {choice !== 'camera' && (
          <label>
            from s{' '}
            <input
              type="number"
              style={{ width: 55 }}
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
            />
          </label>
        )}
        <button onClick={() => void start()} disabled={!!busy}>
          {running ? 'Restart' : 'Start'}
        </button>
        <button onClick={stop} disabled={!running}>
          Stop
        </button>
        <span>{busy}</span>
        {error && <span style={{ color: '#c62828' }}>{error}</span>}
      </section>
      <section
        style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 14 }}
      >
        {(['landmarks', 'skeleton', 'hands'] as const).map((k) => (
          <label key={k}>
            <input
              type="checkbox"
              checked={show[k]}
              onChange={(e) => setShow({ ...show, [k]: e.target.checked })}
            />{' '}
            {k === 'skeleton'
              ? 'solved skeleton + error'
              : k === 'hands'
                ? 'hand occluders'
                : 'landmarks'}
          </label>
        ))}
        <label>
          <input
            type="checkbox"
            checked={mirrorDisplay}
            onChange={(e) => {
              setMirrorDisplay(e.target.checked);
              if (engineRef.current && ar) applyMirror(engineRef.current, ar, e.target.checked);
            }}
          />{' '}
          mirror display
        </label>
        <button onClick={togglePlay} disabled={!running || choice === 'camera'}>
          {paused ? 'Play' : 'Pause'}
        </button>
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.04}
          value={videoTime}
          disabled={!running || choice === 'camera'}
          style={{ width: 260 }}
          onChange={(e) => seek(Number(e.target.value))}
        />
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {videoTime.toFixed(2)} / {duration.toFixed(1)} s
        </span>
        {moves.map(([label, t]) => (
          <button key={label} onClick={() => seek(t)} disabled={!running}>
            {label}
          </button>
        ))}
      </section>
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0,3fr) minmax(0,1.4fr) 300px',
          gap: 8,
          minHeight: 0,
        }}
      >
        <div
          ref={arContainer}
          style={{ minHeight: 0, background: '#000', borderRadius: 8, overflow: 'hidden' }}
        />
        <div
          ref={mirrorContainer}
          style={{ minHeight: 0, background: '#ecebe8', borderRadius: 8, overflow: 'hidden' }}
        />
        <aside style={{ fontSize: 13, overflow: 'auto', fontVariantNumeric: 'tabular-nums' }}>
          <div>
            <b>phase</b> {state?.phase ?? 'idle'} · {state?.message}
          </div>
          <div>
            <b>AR</b> {ar?.status} · {fmt(ar?.stats.fps, 0)} fps · render {fmt(ar?.stats.renderMs)}{' '}
            ms (solve {fmt(ar?.stats.solveMs, 2)} ms)
          </div>
          <div style={{ marginTop: 6, fontSize: 15 }}>
            <b>alignment</b> {report ? fmt(report.score, 2) : '–'}
            {report?.approximate ? <span style={{ color: '#b26a00' }}> · approximate</span> : null}
          </div>
          <div>
            RMS {fmt(report?.rmsPx)} px = {fmt(report ? report.rmsFraction * 100 : null)} % of
            shoulder width ({fmt(report?.shoulderWidthPx, 0)} px), {report?.points ?? 0} joints
          </div>
          <table style={{ marginTop: 4 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>joint</th>
                <th>err px</th>
                <th>dx</th>
                <th>dy</th>
              </tr>
            </thead>
            <tbody>
              {ALIGNMENT_JOINTS.map((name) => {
                const j = report?.perJoint[name];
                return (
                  <tr key={name}>
                    <td style={{ textAlign: 'left' }}>{name}</td>
                    <td>{fmt(j?.errorPx)}</td>
                    <td>{fmt(j?.dx)}</td>
                    <td>{fmt(j?.dy)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ marginTop: 6 }}>
            <b>camera</b> f {fmt(focal?.f, 0)} px · {focal?.source} · diag FOV{' '}
            {fmt(focal?.diagonalFovDeg)}° · horiz {fmt(focal?.horizontalFovDeg)}°
            {focal && Number.isFinite(focal.logSigma) ? ` · ±${fmt(focal.logSigma * 100)} %` : ''} ·{' '}
            {focal?.keyframes ?? 0} keyframes
          </div>
          <div>
            keyframe RMS {fmt(focal?.rmsPx)} px (at prior f: {fmt(focal?.priorRmsPx)} px) · tilt
            pitch {fmt(ar?.tracker.cameraTiltDeg.pitch)}° roll {fmt(ar?.tracker.cameraTiltDeg.roll)}
            °
          </div>
          <div>
            body at {fmt(solution?.pose.t[2], 2)} m · yaw{' '}
            {fmt(solution ? (solution.pose.yaw * 180) / Math.PI : null, 0)}° · raw RMS{' '}
            {fmt(solution?.rawRmsPx)} px
          </div>
          <p style={{ color: '#666' }}>
            Cyan: MediaPipe landmarks. Magenta: posed joints reprojected by the solved camera.
            Yellow: the error that alignment measures. Mirror display flips only the picture.
          </p>
        </aside>
      </section>
    </main>
  );
}
