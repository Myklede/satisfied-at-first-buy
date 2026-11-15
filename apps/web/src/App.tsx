import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  api,
  type Capabilities,
  type FitRequest,
  type FitResponse,
  type KnownMeasurements,
} from './api';
import { Viewer } from './engine/Viewer';
import type { Preset } from './engine/CameraRig';
import { FitStudio } from './FitStudio';
import { consumeHandoff, knownChoices } from './handoff';

const inboundHandoff =
  typeof window === 'undefined' ? {} : consumeHandoff(window.location, window.history);

const knownFields = [
  ['chest_cm', 'Chest', 45, 200],
  ['waist_cm', 'Waist', 40, 200],
  ['hip_cm', 'Hip', 50, 200],
  ['shoulder_width_cm', 'Shoulder width', 20, 65],
  ['shoulder_arc_cm', 'Shoulder back arc', 20, 100],
  ['arm_length_cm', 'Arm length', 30, 100],
  ['back_length_cm', 'Back length', 25, 80],
  ['upper_arm_cm', 'Upper arm', 12, 70],
  ['neck_base_cm', 'Neck base', 20, 65],
  ['wrist_cm', 'Wrist', 10, 35],
] as const;
const names: Record<string, string> = {
  stature: 'Stature',
  chest: 'Chest',
  waist: 'Waist',
  hip: 'Hip',
  shoulder_width: 'Shoulder width',
  shoulder_arc: 'Shoulder · back arc',
  arm_length: 'Arm length',
  back_length: 'Back length',
  upper_arm: 'Upper arm',
  wrist: 'Wrist',
  neck_base: 'Neck base',
};
const initial: FitRequest = {
  height_cm: 172,
  weight_kg: 65,
  sex: 'male',
  shape_reference: 'neutral',
  known_measurements: {},
  density_kg_m3: 1010, // UI placeholder; replaced by service capabilities before the first fit.
};

export function App() {
  const [stage, setStage] = useState<'body' | 'fit'>('body');
  const container = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const [request, setRequest] = useState<FitRequest>(initial);
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [result, setResult] = useState<FitResponse>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Connecting to body engine…');
  const [error, setError] = useState('');
  const [rangeNote, setRangeNote] = useState('');
  const [fps, setFps] = useState<number>();
  const [wireframe, setWireframe] = useState(false);
  const [landmarks, setLandmarks] = useState(false);
  const [tapes, setTapes] = useState(true);
  const [preset, setPreset] = useState<Preset>('front');

  async function build(inputs: FitRequest) {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true);
    setError('');
    setStatus('Finding your shape…');
    try {
      const body = await api.fit(inputs, controller.signal);
      const points = await api.landmarks(body.body_id, controller.signal);
      await viewer.current?.setBody(body, points, controller.signal);
      if (controller.signal.aborted) return;
      setResult(body);
      setRangeNote('Computing conditional shape sensitivity…');
      void api
        .uncertainty(body.body_id, controller.signal)
        .then((data) => {
          if (controller.signal.aborted) return;
          setResult((current) =>
            current?.body_id === body.body_id
              ? {
                  ...current,
                  measurements: Object.fromEntries(
                    Object.entries(current.measurements).map(([name, value]) => [
                      name,
                      { ...value, uncertainty: data.bands[name] },
                    ]),
                  ),
                }
              : current,
          );
          setRangeNote(
            data.accepted_samples >= 3
              ? `± shows conditional 10–90% shape sensitivity (${data.accepted_samples} accepted shapes), not population confidence.`
              : 'Too few shapes satisfy all targets; uncertainty is unavailable.',
          );
        })
        .catch(() => {
          if (!controller.signal.aborted) setRangeNote('Uncertainty unavailable.');
        });
      setPreset('front');
      setStatus(body.converged ? 'Body ready' : 'Review target residuals');
      return body;
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : 'Could not build body.');
        setStatus('Build failed');
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    try {
      viewer.current = new Viewer(container.current!, setFps);
    } catch {
      setError('WebGL could not start. Enable browser hardware acceleration and reload.');
      setStatus('3D unavailable');
      return;
    }
    let retry: ReturnType<typeof setTimeout>;
    let attempts = 0;
    async function connect() {
      try {
        const data = await api.capabilities(controller.signal);
        if (controller.signal.aborted) return;
        setCapabilities(data);
        if (inboundHandoff.error) {
          setError(inboundHandoff.error);
          setStatus('Body hand-off refused');
          return;
        }
        const transfer = inboundHandoff.value;
        if (transfer) {
          const [items, presets] = await Promise.all([
            api.products(controller.signal),
            api.garmentOptions(controller.signal),
          ]);
          const product = items.find((item) => item.product_id === transfer.productId);
          if (!product || !(transfer.size in product.sizes)) {
            setError('Body hand-off ignored: that catalogue product or size is unavailable.');
            setStatus('Review hand-off');
            return;
          }
          if (!knownChoices(transfer, presets)) {
            setError(
              'Body hand-off ignored: its under-layer or fit preference is not a studio preset.',
            );
            setStatus('Review hand-off');
            return;
          }
        }
        const inputs: FitRequest = {
          ...initial,
          density_kg_m3: data.default_density_kg_m3,
          ...(transfer
            ? {
                sex: transfer.body.sex,
                height_cm: transfer.body.height_cm,
                weight_kg: transfer.body.weight_kg,
                known_measurements:
                  transfer.body.chest_cm === undefined ? {} : { chest_cm: transfer.body.chest_cm },
              }
            : {}),
        };
        setRequest(inputs);
        const built = await build(inputs);
        if (built && transfer && !controller.signal.aborted) setStage('fit');
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (++attempts < 90) {
          retry = setTimeout(connect, 1500);
          return;
        }
        setStatus('Engine unavailable');
        setError(cause instanceof Error ? cause.message : 'Start npm run dev and reload.');
      }
    }
    void connect();
    return () => {
      clearTimeout(retry);
      controller.abort();
      activeRequest.current?.abort();
      viewer.current?.dispose();
      viewer.current = null;
    };
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    void build(request);
  }
  function known(name: keyof KnownMeasurements, value: string) {
    const measurements = { ...request.known_measurements };
    if (value === '') delete measurements[name];
    else measurements[name] = Number(value);
    setRequest({ ...request, known_measurements: measurements });
  }
  function view(value: Preset) {
    setPreset(value);
    viewer.current?.rig.preset(value);
  }

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Satisfy home">
          <span className="brand-mark">s</span>satisfy
          <span className="brand-caption">AT THE FIRST BUY</span>
        </a>
        <span className="studio-name">
          <span className="step-number">{stage === 'body' ? '01' : '02'}</span>{' '}
          {stage === 'body' ? 'Body' : 'Fit'} studio
        </span>
        <span className="local-badge">
          <i /> LOCAL & PRIVATE
        </span>
      </header>
      <nav className="stage-switch" aria-label="Studio">
        <button aria-pressed={stage === 'body'} onClick={() => setStage('body')}>
          01 Your body
        </button>
        <button
          disabled={!result || busy}
          aria-pressed={stage === 'fit'}
          onClick={() => setStage('fit')}
        >
          02 Try a jacket →
        </button>
      </nav>
      <main className="workspace" hidden={stage !== 'body'}>
        <aside className="input-panel">
          <div className="eyebrow">YOUR STARTING POINT</div>
          <h1>
            A better fit
            <br />
            starts with you.
          </h1>
          <p className="intro">
            Build a measured body, then bring your next purchase into perspective.
          </p>
          <form onSubmit={submit}>
            <div className="form-row">
              <label>
                Height{' '}
                <span className="input-wrap">
                  <input
                    required
                    type="number"
                    min="120"
                    max="220"
                    step="0.1"
                    value={request.height_cm}
                    onChange={(e) => setRequest({ ...request, height_cm: Number(e.target.value) })}
                  />
                  <span>cm</span>
                </span>
              </label>
              <label>
                Weight{' '}
                <span className="input-wrap">
                  <input
                    required
                    type="number"
                    min="30"
                    max="200"
                    step="0.1"
                    value={request.weight_kg}
                    onChange={(e) => setRequest({ ...request, weight_kg: Number(e.target.value) })}
                  />
                  <span>kg</span>
                </span>
              </label>
            </div>
            <fieldset className="sex-field">
              <legend>Body model</legend>
              <div className="segmented">
                {(['female', 'male'] as const).map((sex) => (
                  <button
                    key={sex}
                    type="button"
                    aria-pressed={request.sex === sex}
                    className={request.sex === sex ? 'selected' : ''}
                    onClick={() => setRequest({ ...request, sex })}
                  >
                    {sex === 'female' ? 'Female' : 'Male'}
                  </button>
                ))}
              </div>
            </fieldset>
            <details>
              <summary>
                Known measurements <span>OPTIONAL</span>
              </summary>
              <p className="field-help">
                A tape measure makes your model more personal. Enter centimetres.
              </p>
              <div className="known-grid">
                {knownFields.map(([name, label, min, max]) => (
                  <label key={name}>
                    {label}
                    <input
                      type="number"
                      min={min}
                      max={max}
                      step="0.1"
                      placeholder="—"
                      value={request.known_measurements?.[name] ?? ''}
                      onChange={(e) => known(name, e.target.value)}
                    />
                  </label>
                ))}
              </div>
            </details>
            {capabilities?.shape_reference_supported && (
              <details>
                <summary>
                  Shape reference <span>OPTIONAL</span>
                </summary>
                <p className="field-help">
                  Anny shape presets. Neutral uses an equal mix; a preset is not an identity or
                  accuracy guarantee.
                </p>
                <label className="sr-only" htmlFor="shape">
                  Shape reference
                </label>
                <select
                  id="shape"
                  value={request.shape_reference ?? 'neutral'}
                  onChange={(e) =>
                    setRequest({
                      ...request,
                      shape_reference: e.target.value as FitRequest['shape_reference'],
                    })
                  }
                >
                  {capabilities.shape_references.map((value) => (
                    <option key={value} value={value}>
                      {value === 'neutral'
                        ? 'Neutral · balanced mix'
                        : value[0].toUpperCase() + value.slice(1)}
                    </option>
                  ))}
                </select>
              </details>
            )}
            <button className="build-button" disabled={busy || !capabilities} type="submit">
              {busy ? (
                <>
                  <span className="spinner" /> Building your body
                </>
              ) : (
                <>
                  Build my body <span>↗</span>
                </>
              )}
            </button>
            <p className="privacy-note">
              <span>⌁</span> Your measurements stay on this device.
            </p>
          </form>
          <div className="model-note">
            <span className="eyebrow">A MODEL, WITH MEASUREMENTS</span>
            <p>Height and weight define a starting shape. Add tape measurements to refine it.</p>
            <a href="#measurement-results">
              Explore your measurements <span>→</span>
            </a>
          </div>
        </aside>
        <section className="viewport" aria-label="Interactive 3D body viewer">
          <div className="viewport-heading">
            <div>
              <span className="eyebrow">BODY / A-POSE</span>
              <h2>Your dimensions, in 3D.</h2>
            </div>
            <span className="live-tag">{fps === undefined ? '—' : fps} FPS</span>
          </div>
          <div className="canvas-container" ref={container} />
          {!result && (
            <div className="scene-placeholder">
              <span className="spinner" />
              {status}
            </div>
          )}
          <div className="scene-meta">
            <span className="status-dot" />
            {status}
            {result && <span className="fit-timing">{(result.fit_ms / 1000).toFixed(2)}s fit</span>}
          </div>
          <div className="view-controls" aria-label="Camera presets">
            {(['front', 'back', 'shoulder', 'side'] as const).map((name, i) => (
              <button
                key={name}
                className={preset === name ? 'active' : ''}
                onClick={() => view(name)}
              >
                <kbd>{i + 1}</kbd>
                {name}
              </button>
            ))}
          </div>
          <div className="scene-toggles">
            <label>
              <input
                type="checkbox"
                checked={wireframe}
                onChange={(e) => {
                  setWireframe(e.target.checked);
                  viewer.current?.body.wireframe(e.target.checked);
                }}
              />
              Wireframe
            </label>
            <label>
              <input
                type="checkbox"
                checked={landmarks}
                onChange={(e) => {
                  setLandmarks(e.target.checked);
                  if (viewer.current) viewer.current.landmarks.visible = e.target.checked;
                }}
              />
              Landmarks
            </label>
            <label>
              <input
                type="checkbox"
                checked={tapes}
                onChange={(e) => {
                  setTapes(e.target.checked);
                  if (viewer.current) viewer.current.tapes.visible = e.target.checked;
                }}
              />
              Tape lines
            </label>
          </div>
          <span className="orbit-hint">
            DRAG TO ORBIT <span>·</span> SCROLL TO ZOOM
          </span>
        </section>
        <aside className="results-panel" id="measurement-results">
          <div className="eyebrow">THE NUMBERS BEHIND THE SHAPE</div>
          <h2>Your measurements</h2>
          <p className="results-intro">
            Computed from the 3D surface.
            <br />
            All lengths in centimetres.
          </p>
          <div className="results-head">
            <span>MEASUREMENT</span>
            <span>BODY</span>
            <span>Δ TARGET</span>
          </div>
          {Object.entries(names).map(([name, label]) => {
            const measurement = result?.measurements[name];
            const residual = result?.residuals[name];
            const tolerance = name === 'stature' ? 0.5 : 1.5;
            return (
              <div className="measurement-row" key={name} title={measurement?.method}>
                <span>
                  {label}
                  {measurement && <small>{measurement.method}</small>}
                </span>
                <strong>
                  {measurement?.value_cm.toFixed(1) ?? '—'}
                  {measurement?.uncertainty && (
                    <small
                      title={`${measurement.uncertainty.lower_cm.toFixed(1)}–${measurement.uncertainty.upper_cm.toFixed(1)} cm`}
                    >
                      ±
                      {Math.max(
                        Math.abs(measurement.value_cm - measurement.uncertainty.lower_cm),
                        Math.abs(measurement.uncertainty.upper_cm - measurement.value_cm),
                      ).toFixed(1)}
                    </small>
                  )}
                </strong>
                <span
                  className={
                    residual === undefined
                      ? 'muted'
                      : Math.abs(residual) < tolerance
                        ? 'residual-good'
                        : 'residual-bad'
                  }
                >
                  {residual === undefined
                    ? '—'
                    : `${residual >= 0 ? '+' : ''}${residual.toFixed(1)}`}
                  <small>
                    {result?.targets[name] !== undefined
                      ? `of ${result.targets[name].toFixed(1)}`
                      : 'no target'}
                  </small>
                </span>
              </div>
            );
          })}
          <p className="field-help" aria-live="polite">
            {rangeNote}
          </p>
          <div className="mass-card">
            <span>Geometric mass estimate</span>
            <strong>
              {result?.mass_kg.toFixed(1) ?? '—'} <small>kg</small>
            </strong>
            <span>
              {result
                ? `Target ${result.targets.mass_kg.toFixed(1)} · Δ ${result.residuals.mass_kg.toFixed(3)} kg`
                : 'Volume × assumed body density'}
            </span>
          </div>
          <div className={`accuracy-note ${result?.converged === false ? 'needs-review' : ''}`}>
            <i />
            {result
              ? result.converged
                ? 'Provided targets are within fitting tolerances.'
                : 'Some provided targets need review.'
              : 'Your residuals will appear after fitting.'}
            <p>Predicted girths still need comparison with a real tape measure.</p>
          </div>
        </aside>
      </main>
      {stage === 'fit' && result && (
        <FitStudio key={result.body_id} body={result} handoff={inboundHandoff.value} />
      )}
      <footer>
        <span>SATISFY AT THE FIRST BUY</span>
        <span>Measured shape. More informed choices.</span>
        <span>BODY ENGINE / ANNY</span>
      </footer>
      {error && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <button onClick={() => setError('')} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}
    </div>
  );
}
