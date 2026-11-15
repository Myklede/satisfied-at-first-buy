import { useEffect, useRef, useState } from 'react';
import type { GarmentFitResponse, GarmentSpec } from '../../api';
import type { LiveSource, LiveTryOnState } from '../../engine/live/contract';
import { createScreenSession, type ScreenEngine } from './session';
import {
  BASIS,
  cm,
  EMPTY_STATE,
  mockEnabled,
  personPresent,
  physicsPlayback,
  CLOSE_RANGE_PHASE,
  PHASE,
} from './presentation';
import { switchLiveSelection } from './selection';
import { BODY_BASIS, type BodyBasis } from './bodyBasis';
import { ArCoach, closeRangeEnabled, type CoachAdvice } from './coach';
import {
  ARFULL_VIEW_KEY,
  arFullEnabled,
  initialView,
  toggledView,
  toggleLabel,
  VIEW_MODES,
  viewBasis,
  type ViewMode,
} from './viewMode';
import { sortSizes } from '../fitSummary';
import './tryon.css';
import { recEnabled } from './liveRecorder';
import { LiveRecButton } from './LiveRecButton';
import { CameraPicker } from '../CameraPicker';
import { CameraFpsMonitor, MORE_LIGHT_HINT, trackFrameCount } from './cameraFps';

export interface TryOnJacket {
  product: GarmentSpec;
  fit: GarmentFitResponse;
  size: string;
}
interface Props {
  bodyId: string;
  bodyBasis: BodyBasis;
  signal: AbortSignal;
  jackets: TryOnJacket[];
  initialJacket: number;
  onExit(): void;
  onActivity(): void;
  onReset(): void;
}
export function TryOnScreen(props: Props) {
  const initial = useRef(props);
  const callbacks = useRef(props);
  callbacks.current = props;
  const ar = useRef<HTMLDivElement>(null),
    mirror = useRef<HTMLDivElement>(null);
  const session = useRef<{ engine: ScreenEngine; source: LiveSource } | undefined>(undefined);
  const alive = useRef(false);
  const [state, setState] = useState<LiveTryOnState>(EMPTY_STATE);
  const [jacket, setJacket] = useState(props.initialJacket);
  const [size, setSize] = useState(props.jackets[props.initialJacket].size);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  // Delivered camera fps (dim light halves it; the AR follows the camera 1:1): hint below 24.
  const [lowLight, setLowLight] = useState(false);
  const [paused, setPaused] = useState(false),
    [position, setPosition] = useState(0);
  const [controls, setControls] = useState(false);
  // ?arfull=1: open in full-screen AR, one toggle to Split and back, kept for the session.
  const arFull = arFullEnabled(location.search);
  const [view, setViewState] = useState<ViewMode>(() =>
    initialView(location.search, arFull ? storedView() : null),
  );
  const setView = (next: ViewMode) => {
    setViewState(next);
    if (arFull) storeView(next);
  };
  const mock = mockEnabled(location.search);
  const latest = useRef(state);
  latest.current = state;
  const [advice, setAdvice] = useState<CoachAdvice>({ prompt: null, fadeAr: false });
  useEffect(() => {
    const coach = new ArCoach(closeRangeEnabled(location.search));
    const update = () => setAdvice(coach.update(latest.current, performance.now()));
    update();
    const timer = window.setInterval(update, 100);
    return () => window.clearInterval(timer);
  }, [retry]);
  useEffect(() => {
    alive.current = true;
    let disposed = false;
    let owned: { engine: ScreenEngine; source: LiveSource } | undefined;
    let unsubscribe = () => {};
    let offPresence = () => {};
    let synthetic = false;
    setState(EMPTY_STATE);
    const fps = new CameraFpsMonitor();
    const tick = window.setInterval(() => {
      const source = owned?.source.video?.srcObject;
      const on =
        source instanceof MediaStream &&
        source.getVideoTracks().some((t) => t.readyState === 'live');
      setCameraOn(on);
      if (on) {
        const wasLow = fps.low;
        const info = (
          owned?.source as { cameraInfo?: () => { fps: number } | null } | undefined
        )?.cameraInfo?.();
        fps.sample(
          performance.now(),
          trackFrameCount(source.getVideoTracks()[0]),
          info?.fps ?? null,
        );
        if (fps.low !== wasLow)
          console.info(
            `[kiosk] camera delivers ${fps.fps?.toFixed(1)} fps: light hint ${fps.low ? 'on' : 'off'}`,
          );
        setLowLight(fps.low);
      } else fps.reset();
      if (synthetic && personPresent(latest.current)) callbacks.current.onActivity();
    }, 500);
    void (async () => {
      const current = await createScreenSession(
        location.search,
        initial.current.jackets.map((j) => j.fit),
      );
      owned = current;
      if (disposed) {
        current.engine.dispose();
        current.source.stop();
        return;
      }
      session.current = current;
      synthetic = current.mock;
      // Contract: landmarks2d=null means no person. This remains authoritative during a bake/replay.
      offPresence = current.source.onFrame((frame) => {
        if (!disposed && frame.landmarks2d !== null) callbacks.current.onActivity();
      });
      setControls(
        typeof current.engine.setPaused === 'function' && typeof current.engine.seek === 'function',
      );
      unsubscribe = current.engine.onState((s) => {
        if (!disposed) {
          latest.current = s;
          setState({ ...s });
        }
      });
      current.engine.attachArView(ar.current!);
      current.engine.attachMirrorView(mirror.current!);
      const chosen = initial.current.jackets[initial.current.initialJacket];
      await current.engine.start(current.source, {
        bodyId: initial.current.bodyId,
        productId: chosen.product.product_id,
        fitId: chosen.fit.fit_id,
        size: chosen.size,
      });
      if (disposed) {
        current.engine.dispose();
        current.source.stop();
      }
    })().catch((error: unknown) => {
      if (!disposed)
        setState({
          ...EMPTY_STATE,
          phase: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
    });
    const close = () => {
      disposed = true;
      alive.current = false;
      clearInterval(tick);
      unsubscribe();
      offPresence();
      owned?.engine.stop();
      owned?.source.stop();
      owned?.engine.dispose();
      session.current = undefined;
    };
    initial.current.signal.addEventListener('abort', close, { once: true });
    return () => {
      initial.current.signal.removeEventListener('abort', close);
      close();
    };
  }, [retry]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      if (alive.current)
        setState((s) => ({
          ...s,
          phase: 'error',
          message: error instanceof Error ? error.message : String(error),
        }));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const switchJacket = (index: number) =>
    void run(async () => {
      const chosen = props.jackets[index];
      const current = session.current;
      if (!current) throw Error('Live session is not ready');
      await switchLiveSelection(current.engine, {
        size: chosen.size,
        product: { productId: chosen.product.product_id, fitId: chosen.fit.fit_id },
      });
      if (alive.current && latest.current.phase !== 'error') {
        setJacket(index);
        setSize(chosen.size);
        setPaused(false);
        setPosition(0);
      }
    });
  const record = () =>
    void run(async () => {
      for (let n = 3; n > 0; n--) {
        if (!alive.current) return;
        setCountdown(n);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!alive.current) return;
      setCountdown(null);
      setPaused(false);
      setPosition(0);
      await session.current?.engine.recordMove(5);
    });
  const locked =
    busy || ['starting', 'calibrating', 'recording', 'baking', 'error'].includes(state.phase);
  const model =
    (closeRangeEnabled(location.search) ? CLOSE_RANGE_PHASE[state.phase] : undefined) ??
    PHASE[state.phase];
  const playback = state.phase === 'playback';
  const physics = physicsPlayback(state);
  const basisLabel = viewBasis(state);
  const canControlPlayback = controls && physics;
  const guide = ['starting', 'calibrating', 'lost'].includes(state.phase);
  return (
    <section
      className="k-live"
      data-screen="live-tryon"
      data-phase={state.phase}
      data-ar-faded={advice.fadeAr}
      data-layout={view}
      data-arfull={arFull}
      aria-label="Try it on you"
    >
      <header className="live-header">
        <div>
          <span className="k-eyebrow">YOUR BODY / YOUR MOVE</span>
          <h1>Try it on you</h1>
          <p className="live-body-basis" data-testid="live-body-basis">
            {BODY_BASIS[props.bodyBasis]}
          </p>
        </div>
        <div className="live-view-controls" role="group" aria-label="Try-on view">
          {arFull && (
            <button
              className="k-primary live-view-toggle"
              data-testid="live-view-toggle"
              aria-pressed={view !== 'ar-full'}
              onClick={() => {
                setView(toggledView(view));
                callbacks.current.onActivity();
              }}
            >
              {toggleLabel(view)}
            </button>
          )}
          {!arFull &&
            VIEW_MODES.map((mode) => (
              <button
                key={mode.value}
                aria-label={mode.accessible}
                title={mode.hint}
                aria-pressed={view === mode.value}
                onClick={() => {
                  setView(mode.value);
                  callbacks.current.onActivity();
                }}
              >
                {mode.label}
              </button>
            ))}
        </div>
        <div className="live-indicators">
          {mock && <b className="live-mock">MOCK DATA</b>}
          <span className="live-camera" role="status">
            <i className={cameraOn ? 'on' : ''} />
            {cameraOn
              ? 'Camera on'
              : state.phase === 'starting'
                ? 'Requesting camera'
                : 'Camera off'}
          </span>
          <button className="k-secondary" onClick={props.onExit}>
            Done
          </button>
        </div>
      </header>
      <div className="live-selectors">
        <label>
          Jacket
          <select
            aria-label="Live jacket"
            disabled={locked}
            value={jacket}
            onChange={(e) => switchJacket(Number(e.target.value))}
          >
            {props.jackets.map((j, i) => (
              <option key={j.product.product_id} value={i}>
                {j.product.style} · {j.product.colourway}
              </option>
            ))}
          </select>
        </label>
        <div className="live-sizes" role="group" aria-label="Live size">
          {sortSizes(Object.keys(props.jackets[jacket].fit.sizes)).map((s) => (
            <button
              key={s}
              aria-pressed={s === size}
              disabled={locked}
              onClick={() =>
                void run(async () => {
                  const current = session.current;
                  if (!current) throw Error('Live session is not ready');
                  await switchLiveSelection(current.engine, { size: s });
                  if (alive.current && latest.current.phase !== 'error') setSize(s);
                })
              }
            >
              {s}
            </button>
          ))}
        </div>
        <span className="live-basis">
          {basisLabel}
          {mock ? ' · synthetic fixture' : ''}
        </span>
      </div>
      {mock && (
        <div className="live-mock-tools">
          <label className="live-mock-scenario">
            Synthetic scenario
            <select
              aria-label="Mock phase"
              value={state.phase}
              onChange={(e) =>
                session.current?.engine.simulatePhase?.(e.target.value as typeof state.phase)
              }
            >
              {[
                'starting',
                'calibrating',
                'tracking',
                'lost',
                'recording',
                'baking',
                'playback',
                'error',
              ].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label className="live-mock-scenario">
            Synthetic cue
            <select
              aria-label="Mock guidance"
              value={
                ['', 'Face the camera', 'More light needed', 'Out of range'].includes(state.message)
                  ? state.message
                  : ''
              }
              onChange={(event) => session.current?.engine.simulateMessage?.(event.target.value)}
            >
              <option value="">No explicit cue</option>
              <option>Face the camera</option>
              <option>More light needed</option>
              <option>Out of range</option>
            </select>
          </label>
        </div>
      )}
      <div className="live-content">
        <div className="live-scenes">
          <figure className="live-ar-panel">
            <figcaption>
              On you <span>Camera + jacket · {basisLabel}</span>
            </figcaption>
            <div className="live-viewport live-ar-viewport" ref={ar} data-testid="live-ar" />
            {advice.prompt && (
              <p className="live-coach" role="status" data-testid="ar-coach">
                {advice.prompt}
              </p>
            )}
            {guide && (
              <div className="live-guide" aria-hidden="true">
                <svg viewBox="0 0 150 230">
                  <circle cx="75" cy="32" r="19" />
                  <path d="M55 61L32 77 13 152M95 61L118 77 137 152M55 61L48 154 102 154 95 61M52 154L46 224M98 154L104 224" />
                </svg>
              </div>
            )}
          </figure>
          <figure className="live-mirror-panel">
            <figcaption>
              {view === 'ar-full' ? 'Mirror' : 'Your fitted body'}
              <span>
                {view !== 'ar-full' && 'Moving with you · '}
                {basisLabel}
              </span>
            </figcaption>
            <div className="live-viewport" ref={mirror} data-testid="live-mirror" />
          </figure>
        </div>
        <aside className="live-readouts" aria-label="Fit readouts">
          <h2>Fit, with reasons</h2>
          <p className="live-fine">
            Fit = static measurements · Preview = skinned · Physics = simulated cloth
          </p>
          <div className="live-zone-list">
            {(['shoulder', 'chest', 'bicep', 'sleeve', 'hem', 'collar'] as const).map((zone) => {
              const z = state.zones.find((v) => v.zone === zone);
              return (
                <div className={`live-zone ${z?.status ?? 'unknown'}`} key={zone}>
                  <div>
                    <b>{zone === 'bicep' ? 'Upper arm' : zone}</b>
                    <span className="live-basis">{z ? BASIS[z.basis] : 'Fit'}</span>
                  </div>
                  <div className="live-zone-value">
                    <strong>{cm(z?.valueCm ?? null)}</strong>
                    <span>{z?.status.replace('_', ' ') ?? 'unknown'}</span>
                  </div>
                  <div
                    className="live-fit-bar"
                    role="img"
                    aria-label={`${zone}: ${z?.status ?? 'unknown'}`}
                  >
                    <i data-status={z?.status ?? 'unknown'} />
                  </div>
                </div>
              );
            })}
          </div>
          {physics && (
            <div className="live-physics" data-testid="physics-readouts">
              <h3>
                During your move <span className="live-basis">Physics</span>
              </h3>
              {state.exposureCm ? (
                <p>
                  Hem exposure · front {cm(state.exposureCm.front)} · back{' '}
                  {cm(state.exposureCm.back)} · sides {cm(state.exposureCm.sides)}
                </p>
              ) : (
                <p>Hem exposure not assessed.</p>
              )}
              {state.sleeveRideUpCm ? (
                <p>
                  Sleeve ride-up · left {cm(state.sleeveRideUpCm.left)} · right{' '}
                  {cm(state.sleeveRideUpCm.right)}
                </p>
              ) : (
                <p>Sleeve ride-up not assessed.</p>
              )}
            </div>
          )}
        </aside>
      </div>
      <div className="live-state" role="status" aria-live="polite">
        <div>
          <h2>
            {countdown !== null
              ? `Ready in ${countdown}`
              : playback && !physics
                ? 'Your move, preview only'
                : model.title}
          </h2>
          <p>
            {state.message ||
              (playback && !physics
                ? 'Skinned preview replay. Real cloth physics is not available for this move.'
                : model.detail)}
          </p>
        </div>
        {countdown !== null ? (
          <b className="live-countdown">{countdown}</b>
        ) : state.phase === 'recording' && state.progress !== null ? (
          <div
            className="live-ring"
            role="progressbar"
            aria-label="Recording progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(state.progress * 100)}
            style={{
              background: `conic-gradient(var(--live-accent) ${state.progress * 360}deg, #354947 0deg)`,
            }}
          >
            <span>{Math.round(state.progress * 100)}%</span>
          </div>
        ) : state.progress !== null ? (
          <progress max={1} value={state.progress} aria-label={`${state.phase} progress`} />
        ) : (
          <span className="live-quality" aria-label="Tracking quality">
            Tracking <meter min={0} max={1} value={state.trackingQuality} />
            {lowLight && <small className="live-light-hint"> · {MORE_LIGHT_HINT}</small>}
          </span>
        )}
      </div>
      <footer className="live-footer">
        <div className="live-actions">
          {state.phase === 'error' ? (
            <>
              <button
                className="k-primary"
                onClick={() => {
                  setJacket(initial.current.initialJacket);
                  setSize(initial.current.jackets[initial.current.initialJacket].size);
                  setRetry((n) => n + 1);
                }}
              >
                Retry camera
              </button>
              <button className="k-secondary" onClick={props.onReset}>
                Start over
              </button>
            </>
          ) : playback ? (
            <>
              <button
                className="k-secondary"
                disabled={!canControlPlayback}
                onClick={() => {
                  session.current?.engine.setPaused?.(!paused);
                  setPaused(!paused);
                }}
              >
                {paused ? 'Play' : 'Pause'}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={position}
                aria-label="Playback position"
                disabled={!canControlPlayback}
                onChange={(e) => {
                  const p = Number(e.target.value);
                  session.current?.engine.seek?.(p);
                  setPosition(p);
                }}
              />
              <button
                className="k-secondary"
                onClick={() => {
                  session.current?.engine.replayLast();
                  setPaused(false);
                  setPosition(0);
                }}
              >
                Replay
              </button>
              <button className="k-primary" onClick={() => session.current?.engine.backToLive()}>
                Back to live
              </button>
              {!canControlPlayback && (
                <small>Pause and scrub require a supported physics replay.</small>
              )}
            </>
          ) : (
            <button
              className="k-primary"
              disabled={locked || state.phase !== 'tracking'}
              onClick={record}
            >
              Record a move
            </button>
          )}
        </div>
        <p className="live-privacy">
          The camera stays on this laptop. Nothing is recorded or saved.
          <small>
            “Record a move” keeps five seconds of pose in memory only. Erased when you finish.
          </small>
        </p>
        <CameraPicker onChange={() => setRetry((n) => n + 1)} />
      </footer>
      {recEnabled(location.search) && (
        <LiveRecButton
          targets={() => ({
            video: session.current?.source.video ?? null,
            arContainer: ar.current,
            engine: session.current?.engine,
            product: {
              productId: props.jackets[jacket].product.product_id,
              fitId: props.jackets[jacket].fit.fit_id,
              size,
            },
          })}
        />
      )}
    </section>
  );
}

/** The session's stored try-on view (?arfull=1), or null (no storage, private mode). */
function storedView(): string | null {
  try {
    return sessionStorage.getItem(ARFULL_VIEW_KEY);
  } catch {
    return null;
  }
}
function storeView(view: ViewMode) {
  try {
    sessionStorage.setItem(ARFULL_VIEW_KEY, view);
  } catch {
    /* Storage unavailable: the choice lasts until the screen closes. */
  }
}
