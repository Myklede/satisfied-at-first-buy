// Jacket sandbox (/?sandbox): the kiosk's own 3D view of a jacket on a body, next to the real
// product's reference photos, with an eyedropper and a CIEDE2000 colour check. A look-dev tool:
// it renders through the same Viewer, materials, tone mapping and lights as the kiosk.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type GarmentSpec } from '../api';
import { containPoint, deltaE2000Rgb, rgbToLab, toHex, averageSrgb, type Rgb } from './colour';
import { DEBUG_OFF, SandboxEngine, type DebugFlags } from './SandboxEngine';
import {
  BODY_PRESETS,
  CLOSE_VIEWS,
  LIGHTING_LABELS,
  ORBIT_VIEWS,
  VIEW_LABELS,
  folderForStyle,
  screenshotName,
  validBody,
  type LightingId,
  type ViewId,
} from './presets';
import './sandbox.css';

interface RefFile {
  id: number;
  name: string;
  kind: 'image' | 'video';
  bytes: number;
}
interface RefFolder {
  name: string;
  files: RefFile[];
}
type Pick = 'photo' | '3d';
interface Sample {
  rgb: Rgb;
  /** Marker position inside its host element (CSS px). */
  at: { x: number; y: number };
}
declare global {
  interface Window {
    __satisfySandbox?: {
      ready: boolean;
      error: string | null;
      state: () => Record<string, unknown>;
      apply: (config: ApplyConfig) => Promise<void>;
      engine: SandboxEngine;
    };
  }
}
export interface ApplyConfig {
  style?: string;
  size?: string;
  body?: { sex: 'female' | 'male'; height_cm: number; weight_kg: number };
  view?: ViewId;
  lighting?: LightingId;
  debug?: Partial<DebugFlags>;
}

const SAMPLE_SIZES = [
  { label: '1 px', radius: 0 },
  { label: '5 x 5 px', radius: 2 },
  { label: '11 x 11 px', radius: 5 },
  { label: '21 x 21 px', radius: 10 },
];
const DEFAULT_BODY = BODY_PRESETS.find((b) => b.id === 'male-172-65')!;
const hex = (rgb: Rgb) => toHex(rgb).toUpperCase();
const mb = (bytes: number) => (bytes / 1048576).toFixed(1);

function deltaVerdict(de: number) {
  if (de < 1) return 'not visible';
  if (de < 2) return 'barely visible side by side';
  if (de < 5) return 'visible side by side';
  if (de < 10) return 'clearly different at a glance';
  return 'a different colour';
}

export function SandboxStudio() {
  const host = useRef<HTMLDivElement>(null);
  const engineRef = useRef<SandboxEngine>(null);
  const mediaRef = useRef<HTMLImageElement | HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState('Starting the 3D view…');
  const [ready, setReady] = useState(false);
  const [products, setProducts] = useState<GarmentSpec[]>([]);
  const [style, setStyle] = useState('');
  const [sizes, setSizes] = useState<string[]>([]);
  const [size, setSize] = useState('');
  const [bodyId, setBodyId] = useState(DEFAULT_BODY.id);
  const [sex, setSex] = useState<'female' | 'male'>(DEFAULT_BODY.sex);
  const [height, setHeight] = useState(String(DEFAULT_BODY.height_cm));
  const [weight, setWeight] = useState(String(DEFAULT_BODY.weight_kg));
  const [view, setView] = useState<ViewId>('front');
  const [lighting, setLighting] = useState<LightingId>('kiosk');
  const [sameAsKiosk, setSameAsKiosk] = useState(true);
  const [debug, setDebug] = useState<DebugFlags>({ ...DEBUG_OFF });
  const [folders, setFolders] = useState<RefFolder[]>([]);
  const [refsError, setRefsError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [showPanel, setShowPanel] = useState(true);
  const [overlay, setOverlay] = useState(false);
  const [opacity, setOpacity] = useState(0.5);
  const [scale, setScale] = useState(1);
  const [shift, setShift] = useState({ x: 0, y: 0 });
  const [pick, setPick] = useState<Pick | null>(null);
  const [radius, setRadius] = useState(2);
  const [photoSample, setPhotoSample] = useState<Sample | null>(null);
  const [renderSample, setRenderSample] = useState<Sample | null>(null);

  const folder = useMemo(() => {
    const name = folderForStyle(
      style,
      folders.map((f) => f.name),
    );
    return folders.find((f) => f.name === name);
  }, [style, folders]);
  const files = folder?.files ?? [];
  const file = files[selected] as RefFile | undefined;
  const fileUrl = (f: RefFile) =>
    `/sandbox/ref?folder=${encodeURIComponent(folder!.name)}&i=${f.id}`;
  const effectiveLighting: LightingId = sameAsKiosk ? 'kiosk' : lighting;

  /** Runs one engine job with a busy label; a failure is shown, never swallowed. */
  const run = useCallback(async (label: string, job: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await job();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy('');
    }
  }, []);

  const syncSizes = useCallback((engine: SandboxEngine) => {
    setSizes(engine.sizes());
    setSize(engine.size);
  }, []);

  const loadRefs = useCallback(async () => {
    try {
      const response = await fetch('/sandbox/refs', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setFolders(((await response.json()) as { folders: RefFolder[] }).folders);
      setRefsError(null);
    } catch (cause) {
      setRefsError(
        `Reference photos unavailable (${cause instanceof Error ? cause.message : String(cause)}). Use npm run sandbox or the Vite dev server.`,
      );
    }
  }, []);

  // ------------------------------------------------------------ start up
  useEffect(() => {
    const engine = new SandboxEngine(host.current!);
    engineRef.current = engine;
    let alive = true;
    void (async () => {
      try {
        const list = await api.products();
        if (!alive) return;
        setProducts(list);
        const first = list[0];
        setStyle(first.style);
        // First jacket's intended wearer: a women's parka starts on a female body.
        const body = /women/i.test(first.title)
          ? BODY_PRESETS.find((b) => b.id === 'female-168-62')!
          : DEFAULT_BODY;
        setBodyId(body.id);
        setSex(body.sex);
        setHeight(String(body.height_cm));
        setWeight(String(body.weight_kg));
        await engine.loadBody(body);
        await engine.loadJacket(first);
        if (!alive) return;
        syncSizes(engine);
        engine.goTo('front');
        setReady(true);
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (alive) setBusy('');
      }
    })();
    void loadRefs();
    return () => {
      alive = false;
      delete window.__satisfySandbox;
      engine.dispose();
      engineRef.current = null;
    };
  }, [loadRefs, syncSizes]);

  useEffect(() => engineRef.current?.setLighting(effectiveLighting), [effectiveLighting, ready]);
  useEffect(() => engineRef.current?.setDebug(debug), [debug, ready]);

  // ------------------------------------------------------------ actions
  const applyBody = useCallback(
    (input: { sex: 'female' | 'male'; height_cm: number; weight_kg: number }) =>
      run('Building the body…', async () => {
        const engine = engineRef.current!;
        await engine.loadBody(input);
        if (engine.product) await engine.loadJacket(engine.product, engine.size);
        syncSizes(engine);
        engine.goTo(view);
        setPhotoSample(null);
        setRenderSample(null);
      }),
    [run, syncSizes, view],
  );

  const chooseBody = (id: string) => {
    setBodyId(id);
    const preset = BODY_PRESETS.find((b) => b.id === id);
    if (!preset) return;
    setSex(preset.sex);
    setHeight(String(preset.height_cm));
    setWeight(String(preset.weight_kg));
    void applyBody(preset);
  };
  const customProblem = validBody(Number(height), Number(weight));
  const applyCustom = () => {
    if (customProblem) return;
    setBodyId('custom');
    void applyBody({ sex, height_cm: Number(height), weight_kg: Number(weight) });
  };

  const chooseJacket = (next: string) => {
    const target = products.find((p) => p.style === next);
    if (!target) return;
    setStyle(next);
    setSelected(0);
    setPhotoSample(null);
    void run('Fitting the jacket…', async () => {
      const engine = engineRef.current!;
      await engine.loadJacket(target, engine.size);
      syncSizes(engine);
      engine.goTo(view);
    });
  };
  const chooseSize = (next: string) => {
    setSize(next);
    void run(`Dressing size ${next}…`, async () => {
      const engine = engineRef.current!;
      await engine.setSize(next);
      engine.goTo(view);
    });
  };
  const chooseView = (next: ViewId) => {
    setView(next);
    try {
      engineRef.current!.goTo(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // Scripted access for the screenshot script and the other agent's look-dev loops.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !ready) return;
    window.__satisfySandbox = {
      ready: true,
      error,
      engine,
      state: () => ({
        style: engine.product?.style,
        size: engine.size,
        view,
        lighting: engine.lighting,
        debug: engine.debug,
        body: engine.body?.body_id,
        busy,
        seams: engine.seamStats,
      }),
      apply: async (config) => {
        if (config.body) {
          await engine.loadBody(config.body);
          setBodyId('custom');
          setSex(config.body.sex);
          setHeight(String(config.body.height_cm));
          setWeight(String(config.body.weight_kg));
          if (engine.product) await engine.loadJacket(engine.product, config.size ?? engine.size);
        }
        const wanted = config.style && products.find((p) => p.style === config.style);
        if (wanted) {
          await engine.loadJacket(wanted, config.size ?? engine.size);
          setStyle(wanted.style);
          setSelected(0);
        } else if (config.size && config.size !== engine.size) await engine.setSize(config.size);
        setSizes(engine.sizes());
        setSize(engine.size);
        if (config.lighting) {
          setSameAsKiosk(config.lighting === 'kiosk');
          setLighting(config.lighting);
          engine.setLighting(config.lighting);
        }
        if (config.debug) {
          setDebug((d) => ({ ...d, ...config.debug }));
          engine.setDebug(config.debug);
        }
        if (config.view) {
          setView(config.view);
          engine.goTo(config.view);
        } else engine.goTo(view);
        for (let i = 0; i < 20; i++) await new Promise((r) => requestAnimationFrame(r));
      },
    };
  }, [ready, error, busy, view, products]);

  // ------------------------------------------------------------ colour check
  const media = () => mediaRef.current;
  const naturalSize = (el: HTMLImageElement | HTMLVideoElement) =>
    el instanceof HTMLVideoElement
      ? { width: el.videoWidth, height: el.videoHeight }
      : { width: el.naturalWidth, height: el.naturalHeight };

  const onPhotoClick = (event: React.MouseEvent) => {
    const el = media();
    if (!el || pick !== 'photo') return;
    const box = el.getBoundingClientRect(),
      natural = naturalSize(el),
      point = containPoint(box, natural, event.clientX, event.clientY);
    if (!point) return setError('Click on the photo itself, not the empty margin.');
    const scalePx = Math.min(box.width / natural.width, box.height / natural.height);
    const r = Math.max(0, Math.round(radius / scalePx));
    const x0 = Math.max(0, point.x - r),
      y0 = Math.max(0, point.y - r),
      w = Math.min(natural.width, point.x + r + 1) - x0,
      h = Math.min(natural.height, point.y + r + 1) - y0;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    try {
      context.drawImage(el, x0, y0, w, h, 0, 0, w, h);
      const rgb = averageSrgb(context.getImageData(0, 0, w, h).data);
      const frame = el.parentElement!.getBoundingClientRect();
      setPhotoSample({ rgb, at: { x: event.clientX - frame.left, y: event.clientY - frame.top } });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const on3dClick = (event: React.MouseEvent) => {
    if (pick !== '3d') return;
    try {
      const rgb = engineRef.current!.sampleColour(event.clientX, event.clientY, radius);
      const frame = host.current!.getBoundingClientRect();
      setRenderSample({ rgb, at: { x: event.clientX - frame.left, y: event.clientY - frame.top } });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const delta =
    photoSample && renderSample ? deltaE2000Rgb(photoSample.rgb, renderSample.rgb) : null;

  // ------------------------------------------------------------ screenshots
  const download = (canvas: HTMLCanvasElement, sideBySide: boolean) => {
    const engine = engineRef.current!;
    canvas.toBlob((blob) => {
      if (!blob) return setError('Could not encode the screenshot');
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = screenshotName({
        style,
        size,
        sex,
        height_cm: Number(height),
        weight_kg: Number(weight),
        view,
        lighting: engine.lighting,
        sideBySide,
      });
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    }, 'image/png');
  };
  const shotRender = () => download(engineRef.current!.capture(), false);
  const shotSideBySide = () => {
    const el = media();
    if (!el) return;
    const frame = engineRef.current!.capture();
    const natural = naturalSize(el);
    if (!natural.width) return setError('The photo has not loaded yet');
    const photoWidth = Math.round((natural.width * frame.height) / natural.height);
    const out = document.createElement('canvas');
    out.width = frame.width + photoWidth;
    out.height = frame.height;
    const context = out.getContext('2d')!;
    context.drawImage(frame, 0, 0);
    context.drawImage(el, frame.width, 0, photoWidth, frame.height);
    download(out, true);
  };

  const flag = (key: keyof DebugFlags, label: string) => (
    <label key={key}>
      <input
        type="checkbox"
        checked={debug[key]}
        onChange={(e) => setDebug((d) => ({ ...d, [key]: e.target.checked }))}
      />
      {label}
    </label>
  );
  const swatch = (sample: Sample | null, label: string) => (
    <div className="sbx-swatch">
      <i style={{ background: sample ? hex(sample.rgb) : 'transparent' }} />
      <span>
        <b>{label}</b>
        {sample ? (
          <>
            <code>{hex(sample.rgb)}</code>
            <small>
              rgb({sample.rgb.join(', ')}) · L*{rgbToLab(sample.rgb)[0].toFixed(1)}
            </small>
          </>
        ) : (
          <small>not picked</small>
        )}
      </span>
    </div>
  );

  return (
    <div className="sbx">
      <aside className="sbx-side">
        <h1>Jacket sandbox</h1>
        <p className="sbx-note">
          Same Viewer, materials, tone mapping, exposure and lights as the kiosk. Orbit with the
          mouse, wheel to zoom.
        </p>

        <h2>Jacket</h2>
        <select value={style} onChange={(e) => chooseJacket(e.target.value)} disabled={!ready}>
          {products.map((p) => (
            <option key={p.style} value={p.style}>
              {p.style} · {p.colourway}
            </option>
          ))}
        </select>
        <div className="sbx-sizes" role="group" aria-label="Size">
          {sizes.map((s) => (
            <button
              key={s}
              aria-pressed={s === size}
              onClick={() => chooseSize(s)}
              disabled={!!busy}
            >
              {s}
            </button>
          ))}
        </div>

        <h2>Body</h2>
        <select value={bodyId} onChange={(e) => chooseBody(e.target.value)} disabled={!ready}>
          {BODY_PRESETS.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
        <div className="sbx-custom">
          <select value={sex} onChange={(e) => setSex(e.target.value as 'female' | 'male')}>
            <option value="female">female</option>
            <option value="male">male</option>
          </select>
          <label>
            cm
            <input value={height} inputMode="numeric" onChange={(e) => setHeight(e.target.value)} />
          </label>
          <label>
            kg
            <input value={weight} inputMode="numeric" onChange={(e) => setWeight(e.target.value)} />
          </label>
          <button onClick={applyCustom} disabled={!!customProblem || !!busy}>
            Apply
          </button>
        </div>
        {customProblem && <p className="sbx-warn">{customProblem}</p>}

        <h2>View</h2>
        <div className="sbx-views">
          {ORBIT_VIEWS.map((v) => (
            <button key={v} aria-pressed={v === view} onClick={() => chooseView(v)}>
              {VIEW_LABELS[v]}
            </button>
          ))}
        </div>
        <h3>Close-ups</h3>
        <div className="sbx-views">
          {CLOSE_VIEWS.map((v) => (
            <button
              key={v}
              aria-pressed={v === view}
              onClick={() => chooseView(v)}
              disabled={!ready || !!busy}
            >
              {VIEW_LABELS[v]}
            </button>
          ))}
        </div>

        <h2>Lighting</h2>
        <label className="sbx-check">
          <input
            type="checkbox"
            checked={sameAsKiosk}
            onChange={(e) => setSameAsKiosk(e.target.checked)}
          />
          Same as kiosk (nothing differs from the real demo)
        </label>
        <select
          value={lighting}
          disabled={sameAsKiosk}
          onChange={(e) => setLighting(e.target.value as LightingId)}
        >
          {(Object.keys(LIGHTING_LABELS) as LightingId[]).map((id) => (
            <option key={id} value={id}>
              {LIGHTING_LABELS[id]}
            </option>
          ))}
        </select>

        <h2>Debug</h2>
        <div className="sbx-flags">
          {flag('garment', 'Garment')}
          {flag('body', 'Body')}
          {flag('wireframe', 'Wireframe')}
          {flag('seams', 'Panel + baffle seam lines')}
          {flag('normals', 'Normals (view space)')}
        </div>
        {debug.seams && (
          <p className="sbx-note">
            Magenta = quilting stitch lines (isolines of the shader's chamber phase). Other colours
            = shell panel boundaries.
          </p>
        )}

        <h2>Screenshot</h2>
        <div className="sbx-row">
          <button onClick={shotRender} disabled={!ready}>
            PNG of 3D view
          </button>
          <button onClick={shotSideBySide} disabled={!ready || !file || file.kind !== 'image'}>
            PNG side by side
          </button>
        </div>
      </aside>

      <main className="sbx-main">
        <div className="sbx-stage">
          <div className="sbx-3d-wrap">
            <div className="sbx-3d" ref={host} />
            {overlay && file?.kind === 'image' && folder && (
              <img
                className="sbx-overlay"
                src={fileUrl(file)}
                alt=""
                style={{
                  opacity,
                  transform: `translate(${shift.x}%, ${shift.y}%) scale(${scale})`,
                }}
              />
            )}
            {pick === '3d' && <div className="sbx-pick" onClick={on3dClick} />}
            {renderSample && (
              <b className="sbx-dot" style={{ left: renderSample.at.x, top: renderSample.at.y }} />
            )}
            {(busy || error) && (
              <div className={`sbx-status${error ? ' bad' : ''}`}>{error ?? busy}</div>
            )}
          </div>

          {showPanel && (
            <section className="sbx-photo">
              <header>
                <b>Reference photos</b>
                <span>{folder ? folder.name : style ? `no folder for ${style}` : ''}</span>
                <button onClick={() => void loadRefs()}>Refresh</button>
              </header>
              {refsError && <p className="sbx-warn">{refsError}</p>}
              {!refsError && files.length === 0 && (
                <div className="sbx-empty">
                  <b>No reference photos yet.</b>
                  <p>
                    Drop .jpg, .png, .webp images or .mp4 / .mov clips into
                    <code>data/reference-photos/{folder?.name ?? '<folder>'}/</code>
                    (subfolders are fine; the folder is gitignored), then press Refresh.
                  </p>
                </div>
              )}
              {file && folder && (
                <div className="sbx-media" onClick={onPhotoClick} data-picking={pick === 'photo'}>
                  {file.kind === 'image' ? (
                    <img
                      key={fileUrl(file)}
                      ref={(el) => {
                        mediaRef.current = el;
                      }}
                      src={fileUrl(file)}
                      alt={file.name}
                    />
                  ) : (
                    <video
                      key={fileUrl(file)}
                      ref={(el) => {
                        mediaRef.current = el;
                      }}
                      src={fileUrl(file)}
                      controls
                      loop
                      muted
                    />
                  )}
                  {photoSample && (
                    <b
                      className="sbx-dot"
                      style={{ left: photoSample.at.x, top: photoSample.at.y }}
                    />
                  )}
                </div>
              )}
              {files.length > 0 && (
                <div className="sbx-strip">
                  {files.map((f, i) => (
                    <button
                      key={f.id}
                      aria-pressed={i === selected}
                      title={`${f.name} (${mb(f.bytes)} MB)`}
                      onClick={() => {
                        setSelected(i);
                        setPhotoSample(null);
                      }}
                    >
                      {f.kind === 'image' ? (
                        <img src={fileUrl(f)} alt="" loading="lazy" />
                      ) : (
                        <span>video</span>
                      )}
                      <small>{f.name}</small>
                    </button>
                  ))}
                </div>
              )}
              {file?.kind === 'image' && (
                <div className="sbx-overlay-controls">
                  <label className="sbx-check">
                    <input
                      type="checkbox"
                      checked={overlay}
                      onChange={(e) => setOverlay(e.target.checked)}
                    />
                    Overlay on the 3D view
                  </label>
                  <label>
                    opacity
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={opacity}
                      onChange={(e) => setOpacity(Number(e.target.value))}
                    />
                  </label>
                  <label>
                    scale
                    <input
                      type="range"
                      min="0.4"
                      max="2.5"
                      step="0.01"
                      value={scale}
                      onChange={(e) => setScale(Number(e.target.value))}
                    />
                  </label>
                  <label>
                    x
                    <input
                      type="range"
                      min="-60"
                      max="60"
                      step="0.5"
                      value={shift.x}
                      onChange={(e) => setShift((s) => ({ ...s, x: Number(e.target.value) }))}
                    />
                  </label>
                  <label>
                    y
                    <input
                      type="range"
                      min="-60"
                      max="60"
                      step="0.5"
                      value={shift.y}
                      onChange={(e) => setShift((s) => ({ ...s, y: Number(e.target.value) }))}
                    />
                  </label>
                </div>
              )}
            </section>
          )}
        </div>

        <footer className="sbx-colour">
          <div className="sbx-row">
            <button
              aria-pressed={pick === 'photo'}
              onClick={() => setPick(pick === 'photo' ? null : 'photo')}
              disabled={!file}
            >
              Pick on photo
            </button>
            <button
              aria-pressed={pick === '3d'}
              onClick={() => setPick(pick === '3d' ? null : '3d')}
              disabled={!ready}
            >
              Pick on 3D
            </button>
            <select
              value={radius}
              onChange={(e) => setRadius(Number(e.target.value))}
              title="Sample size"
            >
              {SAMPLE_SIZES.map((s) => (
                <option key={s.radius} value={s.radius}>
                  {s.label}
                </option>
              ))}
            </select>
            <button onClick={() => setShowPanel((v) => !v)}>
              {showPanel ? 'Hide' : 'Show'} photo panel
            </button>
          </div>
          {swatch(photoSample, 'Photo')}
          {swatch(renderSample, '3D render')}
          <div className="sbx-delta">
            {delta === null ? (
              <small>Pick one point on each to compare.</small>
            ) : (
              <>
                <b>ΔE2000 {delta.toFixed(1)}</b>
                <small>{deltaVerdict(delta)}</small>
              </>
            )}
          </div>
          <small className="sbx-fine">
            sRGB display values, averaged in linear light. Photo colour also depends on the
            photographer's light and camera, so read ΔE as a guide, not proof.
          </small>
        </footer>
      </main>
    </div>
  );
}
