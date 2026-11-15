import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  api,
  type FitResponse,
  type GarmentFitRequest,
  type GarmentFitResponse,
  type GarmentSpec,
  type GarmentOptions,
  type SizeFit,
} from './api';
import { Viewer } from './engine/Viewer';
import { knownProduct, type GarmentMode } from './engine/garmentMath';
import { knownChoices, type StudioHandoff } from './handoff';

export function FitStudio({ body, handoff }: { body: FitResponse; handoff?: StudioHandoff }) {
  const handoffApplied = useRef(false);
  const canvas = useRef<HTMLDivElement>(null);
  const compareCanvas = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const secondViewer = useRef<Viewer | null>(null);
  const [products, setProducts] = useState<GarmentSpec[]>([]);
  const [options, setOptions] = useState<GarmentOptions>();
  const [productId, setProductId] = useState('');
  const [fit, setFit] = useState<GarmentFitResponse>();
  const [size, setSize] = useState('S');
  const [mode, setMode] = useState<GarmentMode>('normal');
  const [under, setUnder] = useState('t-shirt');
  const [preference, setPreference] = useState<GarmentFitRequest['preference']>('regular');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [url, setUrl] = useState('');
  const [compare, setCompare] = useState(false);
  const [compareProduct, setCompareProduct] = useState('');
  const [compareSize, setCompareSize] = useState('S');
  const [compareFit, setCompareFit] = useState<GarmentFitResponse>();
  const [fps, setFps] = useState<number>();
  const [compareFps, setCompareFps] = useState<number>();
  const [quality, setQuality] = useState<'High' | 'Medium'>('High');
  const [simulated, setSimulated] = useState<SizeFit>();
  const [simulationInfo, setSimulationInfo] = useState('');
  const product = products.find((item) => item.product_id === productId);
  const current = simulated?.size === size ? simulated : fit?.sizes[size];
  const report = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : 'Could not load this fit.');

  useEffect(() => {
    const controller = new AbortController();
    let instance: Viewer;
    try {
      instance = new Viewer(canvas.current!, setFps);
      viewer.current = instance;
      instance.tapes.visible = false;
      instance.onShoulderView = () => setMode('xray');
      instance.onSettled = (metrics, seconds) => {
        setSimulated(metrics);
        setSimulationInfo(
          `Drape preview · ${seconds.toFixed(2)} s compute · physical validation pending`,
        );
      };
      void api
        .landmarks(body.body_id, controller.signal)
        .then((points) => instance.setBody(body, points, controller.signal))
        .then(() => {
          if (!controller.signal.aborted) setReady(true);
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) report(cause);
        });
      void Promise.all([api.products(controller.signal), api.garmentOptions(controller.signal)])
        .then(([items, presets]) => {
          if (controller.signal.aborted) return;
          setProducts(items);
          setOptions(presets);
          if (handoff) {
            // Same layer and preference as the Fit Agent's pick; set in this batch, so the first
            // /garment/fit already uses them. App refused unknown values before building the body.
            const chosen = knownChoices(handoff, presets);
            if (!chosen) {
              setError('The handed-off layer or fit preference is not a studio preset.');
              return;
            }
            setUnder(chosen.under);
            setPreference(chosen.preference);
          }
          // ?product=<id>: opened from the Fit Agent extension's "See 3D / X-ray" button.
          const wanted = handoff?.productId ?? new URLSearchParams(location.search).get('product');
          const first = items.find((item) => item.product_id === wanted) ?? items[0];
          setProductId(first?.product_id ?? '');
          setCompareProduct(first?.product_id ?? '');
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) report(cause);
        });
    } catch (cause) {
      report(cause);
    }
    return () => {
      controller.abort();
      instance?.dispose();
      viewer.current = null;
    };
    // The component is keyed by body_id. Conditional bands do not change its mesh.
  }, []);

  useEffect(() => {
    if (!ready || !productId || !options) return;
    const controller = new AbortController();
    setBusy(true);
    setError('');
    setFit(undefined);
    setSimulated(undefined);
    viewer.current?.garment.reset();
    viewer.current?.fitAnnotations.dispose();
    void api
      .garmentFit(
        {
          body_id: body.body_id,
          product_id: productId,
          layer_cm: options.layer_presets_cm[under],
          preference,
        },
        controller.signal,
      )
      .then((value) => {
        if (controller.signal.aborted) return;
        setFit(value);
        if (handoff && !handoffApplied.current && productId === handoff.productId) {
          if (!(handoff.size in value.sizes)) {
            setError('The handed-off size is unavailable; choose a measured size.');
            setFit(undefined);
            return;
          }
          setSize(handoff.size);
          handoffApplied.current = true;
        } else
          setSize((previous) =>
            previous in value.sizes
              ? previous
              : (products.find((item) => item.product_id === productId)?.owned_size ??
                Object.keys(value.sizes)[0]),
          );
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) report(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [body, ready, productId, options, under, preference, products]);

  useEffect(() => {
    if (!fit || !size) return;
    const controller = new AbortController();
    setSimulated(undefined);
    setSimulationInfo('Draping fabric…');
    void viewer.current
      ?.setGarment(fit, size, controller.signal)
      .then(() =>
        viewer.current?.garment.preload(
          fit.fit_id,
          Object.keys(fit.sizes),
          size,
          controller.signal,
        ),
      )
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) report(cause);
      });
    return () => controller.abort();
  }, [fit, size]);
  useEffect(() => {
    viewer.current?.setMode(mode, fit);
    secondViewer.current?.setMode(mode, compareFit);
  }, [mode, fit, compareFit]);
  useEffect(() => {
    viewer.current?.setQuality(quality);
    secondViewer.current?.setQuality(quality);
  }, [quality, compare]);

  useEffect(() => {
    if (!compare || !ready || !options || !compareProduct) return;
    const controller = new AbortController();
    let instance: Viewer;
    setCompareFit(undefined);
    setCompareFps(undefined);
    try {
      instance = new Viewer(compareCanvas.current!, setCompareFps);
      secondViewer.current = instance;
      instance.syncWith = viewer.current ?? undefined;
      instance.controls.enabled = false;
      instance.tapes.visible = false;
      instance.onShoulderView = () => setMode('xray');
      void (async () => {
        const points = await api.landmarks(body.body_id, controller.signal);
        await instance.setBody(body, points, controller.signal);
        const data = await api.garmentFit(
          {
            body_id: body.body_id,
            product_id: compareProduct,
            layer_cm: options.layer_presets_cm[under],
            preference,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setCompareFit(data);
      })().catch((cause: unknown) => {
        if (!controller.signal.aborted) report(cause);
      });
    } catch (cause) {
      report(cause);
    }
    return () => {
      controller.abort();
      instance?.dispose();
      secondViewer.current = null;
    };
  }, [compare, ready, body, options, compareProduct, under, preference]);
  useEffect(() => {
    if (!compareFit || !compareSize) return;
    const controller = new AbortController();
    void secondViewer.current
      ?.setGarment(compareFit, compareSize, controller.signal)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) report(cause);
      });
    return () => controller.abort();
  }, [compareFit, compareSize]);

  function match(event: FormEvent) {
    event.preventDefault();
    const found = knownProduct(url, products);
    if (found) {
      setProductId(found.product_id);
      setError('');
    } else
      setError(
        'This URL is not in the local catalogue. Adding new shops comes in a later milestone.',
      );
  }
  function shoulderView() {
    setMode('xray');
    viewer.current?.rig.preset('shoulders');
  }

  return (
    <main className="fit-studio">
      <aside className="fit-picker">
        <div className="eyebrow">02 / FIT STUDIO</div>
        <h1>
          See where
          <br />
          the fit falls.
        </h1>
        <label>
          Choose a jacket
          <select value={productId} onChange={(event) => setProductId(event.target.value)}>
            {products.map((item) => (
              <option key={item.product_id} value={item.product_id}>
                {item.style} · {item.colourway}
              </option>
            ))}
          </select>
        </label>
        <form onSubmit={match} className="url-form">
          <label>
            Or match a product URL
            <input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://…"
            />
          </label>
          <button type="submit">Find locally →</button>
        </form>
        <p className="field-help">
          {product?.title}
          <br />
          {product?.fabric.composition}
        </p>
        <label>
          Worn underneath
          <select value={under} onChange={(event) => setUnder(event.target.value)}>
            {Object.entries(options?.layer_presets_cm ?? {}).map(([name, value]) => (
              <option key={name} value={name}>
                {name} · {value} cm
              </option>
            ))}
          </select>
        </label>
        <label>
          How you like it
          <select
            value={preference}
            onChange={(event) =>
              setPreference(event.target.value as GarmentFitRequest['preference'])
            }
          >
            {options?.preferences.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <div className="product-note">
          <strong>
            {product?.fit_intent} design · {product?.construction.replaceAll('_', ' ')}
          </strong>
          <p>
            Insulation {product?.loft_cm?.toFixed(2)} ± {product?.loft_uncertainty_cm.toFixed(2)}{' '}
            cm. Inner room accounts for loft and your under-layer.
          </p>
        </div>
        <label className="compare-toggle">
          <input
            type="checkbox"
            checked={compare}
            onChange={(event) => setCompare(event.target.checked)}
          />{' '}
          Compare with synced cameras
        </label>
        {compare && (
          <>
            <label>
              Right-hand jacket
              <select
                value={compareProduct}
                onChange={(event) => {
                  setCompareProduct(event.target.value);
                  setCompareSize('S');
                }}
              >
                {products.map((item) => (
                  <option key={item.product_id} value={item.product_id}>
                    {item.style}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Right-hand size
              <select value={compareSize} onChange={(event) => setCompareSize(event.target.value)}>
                {Object.keys(compareFit?.sizes ?? product?.sizes ?? {}).map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
          </>
        )}
      </aside>
      <section className="fit-scene">
        <div className="fit-toolbar">
          <label>
            Quality{' '}
            <select
              aria-label="Rendering quality"
              value={quality}
              onChange={(event) => setQuality(event.target.value as 'High' | 'Medium')}
            >
              <option>High</option>
              <option>Medium</option>
            </select>
          </label>
          <div className="mode-tabs" aria-label="View mode">
            {(['normal', 'xray', 'heatmap', 'tension'] as const).map((value) => (
              <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>
                {value === 'xray' ? 'X-ray' : value}
              </button>
            ))}
          </div>
          <span className="live-tag">
            {fps ?? '—'} FPS{compare && ` / ${compareFps ?? '—'}`}
          </span>
        </div>
        <div className="size-tabs" aria-label="Size">
          {Object.entries(fit?.sizes ?? {}).map(([name, value]) => (
            <button key={name} aria-pressed={size === name} onClick={() => setSize(name)}>
              {name}
              <small>{value.estimated ? '3D · estimated' : '3D · tape'}</small>
            </button>
          ))}
        </div>
        <div className={`fit-canvases ${compare ? 'comparing' : ''}`}>
          <div className="fit-canvas" ref={canvas} />
          {compare && <div className="fit-canvas" ref={compareCanvas} />}
        </div>
        <div className="fit-camera-controls">
          {(['front', 'back', 'shoulder', 'side'] as const).map((value, index) => (
            <button key={value} onClick={() => viewer.current?.rig.preset(value)}>
              <kbd>{index + 1}</kbd> {value}
            </button>
          ))}
          <button onClick={shoulderView}>
            <kbd>5</kbd> Both shoulders · X-ray
          </button>
        </div>
        <div className="fit-overlay" aria-live="polite">
          {busy
            ? 'Computing fit and collision clearance…'
            : !current
              ? 'Choose a product to start.'
              : !current.geometry_available
                ? `${size}: 3D unavailable — missing ${current.missing_fields.join(', ')}. Chart-derived girths remain available below.`
                : `${product?.style} · ${size} · ${simulationInfo}`}
          {compareFit && !compareFit.sizes[compareSize]?.geometry_available && (
            <p>Right {compareSize}: no complete garment dimensions; no 3D claim.</p>
          )}
        </div>
        {mode === 'heatmap' && (
          <div className="heatmap-legend">
            <span>≤ {fit?.heatmap_tight_cm ?? '…'} cm tight</span>
            <i />
            <span>≥ {fit?.heatmap_loose_cm ?? '…'} cm loose</span>
            <small>
              Interpolated inner gap = simulated outer gap − current compressed insulation −
              under-layer. Grey: elastic gather / cuff adjuster; compression there is intentional.
            </small>
          </div>
        )}
        {mode === 'xray' && (
          <p className="xray-note">White dots: acromion / wrist · coloured dots: seam / cuff</p>
        )}
        {mode === 'tension' && (
          <p className="xray-note">
            Maximum incident-edge tensile strain: blue 0% → red 3%+. Raw strain is not clipped in
            the solver.
          </p>
        )}
      </section>
      <aside className="fit-results">
        <div className="eyebrow">FIT, WITH REASONS</div>
        <h2>
          {fit?.recommended_size ? `Best available: ${fit.recommended_size}` : 'Finding your fit'}
        </h2>
        <p className="field-help">{fit?.explanation}</p>
        <h3>
          Selected size {size}{' '}
          {current?.estimated && <span className="estimated-badge">estimated</span>}
        </h3>
        <p className="field-help">
          {current &&
            `${current.coverage * 100}% zone coverage · score ${current.score?.toFixed(1) ?? 'unknown'}`}
        </p>
        {Object.entries(current?.zones ?? {}).map(([zone, metric]) => (
          <div className={`fit-zone status-${metric.status}`} key={zone}>
            <div>
              <strong>{zone}</strong>
              <span>
                {metric.status.replaceAll('_', ' ')}
                {metric.estimated && ' · estimated'}
              </span>
            </div>
            <b>
              {metric.value_cm == null
                ? 'unknown'
                : `${metric.value_cm >= 0 ? '+' : ''}${metric.value_cm.toFixed(1)} cm`}
            </b>
            <p>{metric.explanation}</p>
            {metric.lower_cm != null &&
              metric.upper_cm != null &&
              metric.upper_cm - metric.lower_cm > 0.05 && (
                <small>
                  Range {metric.lower_cm.toFixed(1)}…{metric.upper_cm.toFixed(1)} cm
                  {metric.estimated ? ' · estimated' : ''}
                </small>
              )}
          </div>
        ))}
        <p className="field-help">{fit?.note}</p>
        <p className="field-help">
          {Object.values(body.measurements).some(
            (value) =>
              value.uncertainty && value.uncertainty.upper_cm - value.uncertainty.lower_cm > 4,
          )
            ? 'Your body sensitivity bands are wide. Tape measurements improve the estimate.'
            : 'Body bands show shape sensitivity, not population confidence.'}
        </p>
        <details>
          <summary>Sources & limitations</summary>
          <p className="field-help">{product?.notes}</p>
          {current?.warnings.map((warning) => (
            <p className="field-help" key={warning}>
              {warning}
            </p>
          ))}
          <p className="field-help">
            Owned S dimensions are taped. Other sizes use Anny chart-midpoint grades with
            uncalibrated uncertainty bands. Fabric stiffness and cuff opening need worn validation.
          </p>
        </details>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </aside>
    </main>
  );
}
