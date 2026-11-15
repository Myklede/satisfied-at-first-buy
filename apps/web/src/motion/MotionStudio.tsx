// Fit in motion (P2): two sizes side by side on the user's measured body, baked cloth playback
// for the six contract motions, exposure / wrist / restriction numbers from the simulation.
// MotionStudio is a mountable component (props: body, fit, two sizes); MotionStudioRoute is
// the standalone `?motion` page that builds a body and garment fit first.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type FitRequest, type GarmentSpec } from '../api';
import { MotionClient, type MotionData } from '../engine/motion/MotionClient';
import { MotionScene, type View } from '../engine/motion/MotionScene';
import { MotionGarmentLayer } from '../engine/motion/MotionGarmentLayer';
import { summarySentence, RESTRICTION_ZONES } from '../engine/motion/metrics';
import type { BakedMotion } from '../engine/motion/bake';
import type { MotionFrames } from '../engine/motion/rig';
import { DEFAULT_WAISTBAND, MOTION_IDS, WAISTBANDS, type Waistband } from '../engine/motion/config';
import './motion.css';

export type MotionStudioProps = {
  bodyId: string;
  fitId: string;
  /** Two sizes to compare, left to right (e.g. ['S', 'M']). */
  sizes: string[];
  /** Recommended size (baked first). */
  recommended?: string | null;
  title?: string;
  onClose?: () => void;
  /**
   * A client the host already created for the same body, fit and sizes (the kiosk starts
   * baking the first motion in the background before the judge opens this view). The host
   * owns and disposes it.
   */
  client?: MotionClient;
};

/** Peak hold on the first pass through the motion's peak (s). */
const PEAK_HOLD_S = 1.5;
/** Fabric strain above which the bake is flagged as not physically converged (len/rest − 1). */
const UNCONVERGED_STRAIN = 0.25;
const LEVEL_INDEX: Record<Waistband, number> = { low: 0, mid: 1, high: 2 };
const LEVEL_LABEL: Record<Waistband, string> = {
  low: 'Low (hip line)',
  mid: 'Mid (default)',
  high: 'High (waist line)',
};

declare global {
  interface Window {
    __satisfyMotion?: {
      state: () => {
        ready: boolean;
        motion: string;
        baked: boolean;
        frame: number;
        error: string | null;
      };
      select: (motion: string) => void;
      seek: (frame: number | 'peak') => void;
      play: (playing: boolean) => void;
      view: (view: View) => void;
      tension: (on: boolean) => void;
      waistband: (level: Waistband) => void;
      results: () => unknown;
    };
  }
}

/**
 * Whether every size of a motion is baked, and while one is baking the real progress: the mean
 * over the sizes of done/total solver steps (a baked size counts 1, a size still settling or
 * waiting 0). `share` is null when nothing of this motion is running or finished yet.
 */
function motionState(client: MotionClient | null, sizes: string[], motionId: string) {
  if (!client) return { ready: false, share: null as number | null };
  let sum = 0,
    active = false,
    ready = true;
  for (const size of sizes) {
    if (client.cached(size, motionId)) {
      sum += 1;
      continue;
    }
    ready = false;
    const p = client.progressOf(size, motionId);
    if (p) {
      active = true;
      sum += p.phase === 'motion' && p.total > 0 ? p.done / p.total : 0;
    }
  }
  return { ready, share: ready || active ? sum / sizes.length : null };
}

export function MotionStudio({
  bodyId,
  fitId,
  sizes,
  recommended,
  title,
  onClose,
  client: shared,
}: MotionStudioProps) {
  const host = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<MotionData>();
  const [error, setError] = useState<string | null>(null);
  const [motion, setMotion] = useState<string>(MOTION_IDS[0]);
  const [waistband, setWaistband] = useState<Waistband>(DEFAULT_WAISTBAND);
  const [bakes, setBakes] = useState<Record<string, BakedMotion>>({});
  const [frames, setFrames] = useState<MotionFrames>();
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [tension, setTension] = useState(false);
  const [view, setView] = useState<View>('front');
  const [, redraw] = useState(0);
  const client = useRef<MotionClient | null>(null);
  const scene = useRef<MotionScene | null>(null);
  const play = useRef({ playing: true, t: 0, last: 0, held: false, holdUntil: 0 });
  const current = useMemo(
    () => sizes.map((s) => bakes[`${s}:${motion}`]).filter(Boolean) as BakedMotion[],
    [bakes, sizes, motion],
  );
  const ready = current.length === sizes.length && !!frames && frames.motion.id === motion;
  const peakFrame = useMemo(() => {
    if (!ready) return 0;
    // The frame where the worse size shows its largest hem rise (mid waistband ring maximum).
    let best = -Infinity,
      at = 0;
    for (const bake of current)
      bake.metrics.forEach((m, f) => {
        for (const v of m.hemAboveCm[waistband])
          if (Number.isFinite(v) && v > best) [best, at] = [v, f];
      });
    return at;
  }, [ready, current, waistband]);

  // Load the body's motion data and the two garment sizes once.
  useEffect(() => {
    const c = shared ?? new MotionClient(bodyId, fitId, sizes);
    client.current = c;
    // Real bake progress and "ready" state of every motion button come from the client.
    const unsubscribe = c.subscribe(() => redraw((n) => n + 1));
    c.load()
      .then((d) => {
        if (client.current !== c) return;
        setData(d);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      unsubscribe();
      if (c !== shared) c.dispose();
      if (client.current === c) client.current = null;
    };
  }, [bodyId, fitId, sizes, shared]);

  // Scene with one station per size.
  useEffect(() => {
    if (!data || !host.current) return;
    const s = new MotionScene(host.current, data.rig, sizes.length);
    scene.current = s;
    return () => {
      s.dispose();
      if (scene.current === s) scene.current = null;
    };
  }, [data, sizes.length]);

  // Bake the selected motion (both sizes, recommended first), then everything else.
  useEffect(() => {
    const c = client.current;
    if (!data || !c) return;
    let cancelled = false;
    setFrames(undefined);
    c.frames(motion)
      .then((f) => !cancelled && setFrames(f))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    const order = [...sizes].sort((a, b) => (a === recommended ? -1 : b === recommended ? 1 : 0));
    for (const size of order)
      c.bake(size, motion)
        .then((bake) => !cancelled && setBakes((old) => ({ ...old, [`${size}:${motion}`]: bake })))
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    c.prefetch(MOTION_IDS.filter((m) => m !== motion));
    play.current = { ...play.current, t: 0, held: false, holdUntil: 0 };
    setFrame(0);
    return () => {
      cancelled = true;
    };
  }, [data, motion, sizes, recommended]);

  // Put the baked garments into the scene when the motion's bakes are ready.
  useEffect(() => {
    const s = scene.current;
    if (!s || !data) return;
    sizes.forEach((size, i) => {
      const bake = bakes[`${size}:${motion}`];
      const asset = data.assets[size];
      s.setGarment(
        i,
        bake
          ? new MotionGarmentLayer(
              asset.triangles,
              bake.particles,
              asset.colour,
              asset.config.stretchMax,
            )
          : undefined,
      );
    });
  }, [data, bakes, motion, sizes]);

  // Playback clock: 1× real time, auto-hold at the peak once per pass, loop.
  useEffect(() => {
    play.current.playing = playing;
  }, [playing]);
  useEffect(() => {
    const s = scene.current;
    if (!s || !ready || !frames) return;
    const duration = (frames.count - 1) / frames.fps;
    s.onFrame = (time) => {
      const p = play.current,
        dt = p.last ? Math.min(0.1, (time - p.last) / 1000) : 0;
      p.last = time;
      if (!p.playing || time < p.holdUntil) return;
      const peakT = peakFrame / frames.fps;
      const next = p.t + dt;
      if (!p.held && p.t <= peakT && next >= peakT) {
        p.held = true;
        p.t = peakT;
        p.holdUntil = time + PEAK_HOLD_S * 1000;
      } else if (next > duration) {
        p.t = 0;
        p.held = false;
      } else p.t = next;
      setFrame(p.t * frames.fps);
    };
    return () => {
      s.onFrame = undefined;
    };
  }, [ready, frames, peakFrame]);

  // Draw the current frame: body pose, cloth, exposed skin, tension map.
  useEffect(() => {
    const s = scene.current;
    if (!s || !ready || !frames) return;
    const level = LEVEL_INDEX[waistband];
    const f = Math.round(frame);
    current.forEach((bake, i) => {
      const station = s.stations[i];
      station.body.pose(frames, frame / frames.fps);
      station.garment?.setTension(tension);
      station.garment?.show(bake, frame);
      const E = bake.exposureVertices.length,
        exposed: number[] = [];
      for (let k = 0; k < E; k++)
        if (bake.exposed[f * E + k] && bake.exposureLevel[k] >= level)
          exposed.push(bake.exposureVertices[k]);
      station.body.highlight(exposed);
    });
  }, [ready, frames, frame, current, tension, waistband]);

  // Automation hooks for local evidence capture (Playwright).
  useEffect(() => {
    window.__satisfyMotion = {
      state: () => ({ ready, motion, baked: ready, frame, error }),
      select: (m) => setMotion(m),
      seek: (target) => {
        setPlaying(false);
        const f = target === 'peak' ? peakFrame : target;
        play.current.t = frames ? f / frames.fps : 0;
        setFrame(f);
      },
      play: (on) => setPlaying(on),
      view: (v) => {
        scene.current?.setView(v);
        setView(v);
      },
      tension: (on) => setTension(on),
      waistband: (l) => setWaistband(l),
      results: () =>
        current.map((b) => ({
          size: b.size,
          motion: b.motionId,
          summary: b.summary,
          timings: b.timings,
          checks: b.checks,
        })),
    };
  });

  const presets = data?.presets ?? [];
  const label = (id: string) => presets.find((p) => p.id === id)?.label ?? id;
  const sentence = ready
    ? summarySentence(
        label(motion),
        waistband,
        current.map((b) => b.summary),
      )
    : '';
  const duration = frames ? (frames.count - 1) / frames.fps : 0;

  return (
    <div className="motion-studio">
      <header className="motion-top">
        <div className="motion-title">
          <h1>Fit in motion</h1>
          <p>{title ?? 'Your measured body, the same jacket in two sizes.'}</p>
        </div>
        {onClose && (
          <button className="motion-close" onClick={onClose}>
            Close
          </button>
        )}
      </header>
      <nav className="motion-actions" aria-label="Motions">
        {MOTION_IDS.map((id) => {
          const state = motionState(client.current, sizes, id);
          return (
            <button
              key={id}
              className={`${id === motion ? 'active' : ''}${state.ready ? ' motion-ready' : ''}`}
              onClick={() => setMotion(id)}
              disabled={!data}
              data-ready={state.ready}
            >
              {label(id)}
              {state.ready && <small className="motion-tag">ready</small>}
              {!state.ready && state.share !== null && (
                <span
                  className="motion-bar"
                  role="progressbar"
                  aria-label={`${label(id)} simulation`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(state.share * 100)}
                >
                  <span style={{ width: `${Math.round(state.share * 100)}%` }} />
                </span>
              )}
            </button>
          );
        })}
      </nav>
      <main className="motion-main">
        <section className="motion-stage">
          <div className="motion-canvas" ref={host} />
          {/* Seen from the back, the left station appears on the right. */}
          <div className={`motion-labels${view === 'back' ? ' reversed' : ''}`}>
            {sizes.map((s) => (
              <span key={s}>
                Size {s}
                {s === recommended ? ' (recommended)' : ''}
              </span>
            ))}
          </div>
          {!ready && (
            <div className="motion-wait">
              {error ??
                (!data
                  ? 'Loading your body and the two sizes…'
                  : sizes
                      .map((s) => {
                        const p = client.current?.progressOf(s, motion);
                        if (bakes[`${s}:${motion}`] || client.current?.cached(s, motion))
                          return `${s}: ready`;
                        if (!p) return `${s}: queued`;
                        const share = p.phase === 'relax' ? 0 : p.done / p.total;
                        return `${s}: ${p.phase === 'relax' ? 'settling' : 'simulating'} ${Math.round(share * 100)}%`;
                      })
                      .join('   ·   '))}
            </div>
          )}
          <div className="motion-controls">
            <button onClick={() => setPlaying((p) => !p)} disabled={!ready}>
              {playing ? 'Pause' : 'Play'}
            </button>
            <input
              type="range"
              min={0}
              max={frames ? frames.count - 1 : 0}
              step={0.01}
              value={frame}
              disabled={!ready}
              aria-label="Motion time"
              onChange={(e) => {
                setPlaying(false);
                const f = Number(e.target.value);
                play.current.t = frames ? f / frames.fps : 0;
                setFrame(f);
              }}
            />
            <span className="motion-time">
              {frames ? `${(frame / frames.fps).toFixed(1)} / ${duration.toFixed(1)} s` : ''}
            </span>
            <button
              onClick={() => {
                setPlaying(false);
                play.current.t = frames ? peakFrame / frames.fps : 0;
                setFrame(peakFrame);
              }}
              disabled={!ready}
            >
              Peak
            </button>
          </div>
          <div className="motion-toggles">
            {(['front', 'side', 'back'] as View[]).map((v) => (
              <button
                key={v}
                className={v === view ? 'active' : ''}
                onClick={() => {
                  scene.current?.setView(v);
                  setView(v);
                }}
              >
                {v[0].toUpperCase() + v.slice(1)}
              </button>
            ))}
            <label>
              <input
                type="checkbox"
                checked={tension}
                onChange={(e) => setTension(e.target.checked)}
              />
              Tension map
            </label>
          </div>
        </section>
        <aside className="motion-results">
          <div className="motion-waistband">
            <span>Trouser waistband</span>
            {WAISTBANDS.map((l) => (
              <button
                key={l}
                className={l === waistband ? 'active' : ''}
                onClick={() => setWaistband(l)}
              >
                {LEVEL_LABEL[l]}
              </button>
            ))}
          </div>
          {ready ? (
            <Results bakes={current} waistband={waistband} sentence={sentence} />
          ) : (
            <p className="motion-note">Results appear when both sizes have been simulated.</p>
          )}
        </aside>
      </main>
    </div>
  );
}

const fmt = (cm: number) => (cm > 0 ? `${cm.toFixed(1)} cm` : 'covered');

function Results({
  bakes,
  waistband,
  sentence,
}: {
  bakes: BakedMotion[];
  waistband: Waistband;
  sentence: string;
}) {
  const rows: [string, (b: BakedMotion) => string][] = [
    ['Belly (front)', (b) => fmt(b.summary.exposure[waistband].front)],
    ['Lower back', (b) => fmt(b.summary.exposure[waistband].back)],
    [
      'Sides',
      (b) => fmt(Math.max(b.summary.exposure[waistband].left, b.summary.exposure[waistband].right)),
    ],
    ['Most exposed point', (b) => fmt(b.summary.exposure[waistband].any)],
    ['Standing (before moving)', (b) => fmt(b.summary.neutralExposure[waistband].any)],
    ['Left wrist shows', (b) => fmt(b.summary.wrist.L.exposed)],
    ['Right wrist shows', (b) => fmt(b.summary.wrist.R.exposed)],
    [
      'Sleeve rides up',
      (b) => `${Math.max(b.summary.wrist.L.rideUp, b.summary.wrist.R.rideUp).toFixed(1)} cm`,
    ],
  ];
  return (
    <div>
      <p className="motion-sentence">{sentence}</p>
      <table className="motion-table">
        <thead>
          <tr>
            <th />
            {bakes.map((b) => (
              <th key={b.size}>{b.size}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, value]) => (
            <tr key={name}>
              <td>{name}</td>
              {bakes.map((b) => (
                <td key={b.size}>{value(b)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Fabric at its stretch limit</h2>
      <table className="motion-table small">
        <thead>
          <tr>
            <th>Zone</th>
            {bakes.map((b) => (
              <th key={b.size}>{b.size}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {RESTRICTION_ZONES.map((zone, z) => (
            <tr key={zone}>
              <td>{zone}</td>
              {bakes.map((b) => {
                const r = b.summary.restriction[z];
                return (
                  <td key={b.size}>
                    {Math.round(r.peakShare * 100)}%{' '}
                    <span className="muted">(standing {Math.round(r.neutralShare * 100)}%)</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="motion-note">
        Share of the zone's fabric edges at the stretch limit at the worst moment. Fabric stretch
        and friction values are uncalibrated.
        {bakes.some((b) => b.checks.maxStrain > UNCONVERGED_STRAIN) &&
          ` The cloth solver did not hold the fabric everywhere (peak strain ${bakes
            .map((b) => `${b.size} ${Math.round(b.checks.maxStrain * 100)}%`)
            .join(', ')}, far above what fabric can stretch), so treat the numbers as indicative.`}
      </p>
      <p className="motion-note">
        Simulated on this computer:{' '}
        {bakes.map((b) => `${b.size} ${(b.timings.totalMs / 1000).toFixed(0)} s`).join(', ')} for{' '}
        {bakes[0].frameCount} frames.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Standalone route (?motion): build a body and a garment fit, then compare two sizes.

const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', 'XXL', '3XL'];
const order = (a: string, b: string) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b);

export function MotionStudioRoute() {
  // Public reference body by default (172 cm / 65 kg male, the realism reference).
  const [request, setRequest] = useState<FitRequest>({
    height_cm: 172,
    weight_kg: 65,
    sex: 'male',
    shape_reference: 'neutral',
    known_measurements: {},
    density_kg_m3: 1010, // replaced by the service default before the fit
  });
  const [products, setProducts] = useState<GarmentSpec[]>([]);
  const [style, setStyle] = useState('DQ4920-206');
  const [session, setSession] = useState<MotionStudioProps>();
  const [status, setStatus] = useState('');
  useEffect(() => {
    api
      .products()
      .then(setProducts)
      .catch((e: unknown) => setStatus(String(e)));
  }, []);
  async function start() {
    try {
      setStatus('Building your body…');
      const capabilities = await api.capabilities();
      const body = await api.fit({ ...request, density_kg_m3: capabilities.default_density_kg_m3 });
      const product = products.find((p) => p.style === style);
      if (!product) throw new Error('Choose a jacket');
      setStatus('Fitting the jacket…');
      const fit = await api.garmentFit({
        body_id: body.body_id,
        product_id: product.product_id,
        layer_cm: 0.3,
        preference: 'regular',
      });
      const available = Object.keys(fit.sizes)
        .filter((s) => fit.sizes[s].geometry_available)
        .sort(order);
      const rec = fit.recommended_size ?? available[Math.floor(available.length / 2)];
      const i = available.indexOf(rec);
      // Compare the recommended size with the next smaller one (the shorter garment is the
      // one that can expose skin), or the next larger when it is already the smallest.
      const pair = i > 0 ? [available[i - 1], rec] : [rec, available[i + 1]];
      setStatus('');
      setSession({
        bodyId: body.body_id,
        fitId: fit.fit_id,
        sizes: pair.filter(Boolean),
        recommended: rec,
        title: `${product.title} · ${request.height_cm} cm / ${request.weight_kg} kg`,
      });
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }
  const auto = useRef(false);
  useEffect(() => {
    if (!auto.current && products.length && new URLSearchParams(location.search).has('auto')) {
      auto.current = true;
      void start();
    }
  });
  if (session) return <MotionStudio {...session} onClose={() => setSession(undefined)} />;
  return (
    <div className="motion-setup">
      <h1>Fit in motion</h1>
      <p>Build a body, pick a jacket, then watch two sizes move with you.</p>
      <label>
        Height (cm)
        <input
          type="number"
          min={120}
          max={220}
          value={request.height_cm}
          onChange={(e) => setRequest({ ...request, height_cm: Number(e.target.value) })}
        />
      </label>
      <label>
        Weight (kg)
        <input
          type="number"
          min={30}
          max={200}
          value={request.weight_kg}
          onChange={(e) => setRequest({ ...request, weight_kg: Number(e.target.value) })}
        />
      </label>
      <label>
        Sex
        <select
          value={request.sex}
          onChange={(e) => setRequest({ ...request, sex: e.target.value as FitRequest['sex'] })}
        >
          <option value="male">Male</option>
          <option value="female">Female</option>
        </select>
      </label>
      <label>
        Jacket
        <select value={style} onChange={(e) => setStyle(e.target.value)}>
          {products.map((p) => (
            <option key={p.product_id} value={p.style}>
              {p.title}
            </option>
          ))}
        </select>
      </label>
      <button onClick={() => void start()} disabled={!products.length}>
        Start
      </button>
      {status && <p className="motion-note">{status}</p>}
    </div>
  );
}
