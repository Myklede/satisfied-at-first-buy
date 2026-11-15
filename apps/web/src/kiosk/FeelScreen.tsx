// "Feel the fabric" (prompts/05 Part D): the judge steps close, closes a hand on the jacket on
// screen and pulls. Camera frames stay in memory inside @satisfy/vision; nothing is stored.
// A camera or model failure shows a friendly message; the rest of the kiosk keeps working.
import { useEffect, useRef, useState } from 'react';
import {
  CameraError,
  createHandTracker,
  openCamera,
  type CameraHandle,
  type HandFrame,
  type PinchEvent,
  type TunableHandTracker,
} from '@satisfy/vision';
import { HAND_PULL, HAND_TENSION } from '../engine/hand/config';
import type {
  HandPullController,
  HandPullUiState,
  StandardPull,
} from '../engine/hand/HandPullController';
import { FollowLog, formatFollow, type SizeFollow } from '../engine/hand/tension';
import type { InteractController, InteractUiState } from '../engine/interact/InteractController';
import { interactHint, interactStatus, NOT_MEASURED } from '../engine/interact/interactText';
import { VISION_ASSET_BASE } from './ScanScreen';
import type { GarmentView } from './garmentView';
import { cameraMessage, FEEL_TEXT, feelHint } from './feelText';
import type { CameraRelay } from './cameraRelay';
import { sortSizes } from './fitSummary';

/**
 * Measured follow per size for the current fit (this judge's body + jacket), across visits to
 * this screen. Page memory only; a different fit (next judge) replaces it (FollowLog).
 */
const followLog = new FollowLog();

/** What the standard pull does, from its constants (no numbers typed twice). */
const STANDARD_TITLE = `Standard pull: grabs the chest and pulls ${Math.round(
  HAND_TENSION.standardPullM * 100,
)} cm straight out for ${(HAND_TENSION.standardFrames / HAND_PULL.liveHz).toFixed(1)} s`;

/** Comparison card: left side under the title, clear of the jacket (centred) and camera (right). */
const COMPARE_STYLE = {
  position: 'absolute',
  left: 32,
  top: 104,
  width: 330,
  padding: '14px 18px',
  borderRadius: 12,
  background: 'rgba(17, 24, 28, 0.84)',
  color: '#fff',
} as const;

export interface HandPullDebug {
  controller: HandPullController;
  tracker?: TunableHandTracker;
  camera?: CameraHandle;
  /** Feed events exactly like the live tracker (replay harness). */
  sink: { onPinch(event: PinchEvent): void; onFrame(frame: HandFrame): void };
  /** Dev/test: replays a hand recording (JSON) into `sink` in real time. */
  replay(
    json: unknown,
    options?: import('../engine/hand/replay').ReplayOptions,
  ): Promise<import('../engine/hand/replay').ReplaySummary>;
  /**
   * Dev/test: suspend the 20 s no-hand exit while a harness replays recordings (the bench's fake
   * camera never shows a hand). Released, the timer restarts from now.
   */
  holdOpen(on: boolean): void;
  /** Dev/test: is the garment under this viewport point (NDC), within `tolerancePx`? */
  probe(x: number, y: number, tolerancePx?: number): boolean;
  /** The "Measure" button's action: standard pull on the size on screen, logged per size. */
  measure(): Promise<StandardPull>;
  /** Measured follow per size shown in the comparison panel (metres). */
  compare(): SizeFollow[];
}

declare global {
  interface Window {
    /** Numbers-only diagnostics for the hand pull (bench/e2e); no frames, no body data. */
    __handpull?: HandPullDebug;
    /** Numbers-only diagnostics for the zip and hood (agent Z e2e). */
    __interact?: InteractController;
  }
}

/** Zip/hood panel: bottom left, above the footer, clear of the jacket (centred). */
const ZIP_STYLE = {
  position: 'absolute',
  left: 32,
  bottom: 104,
  width: 330,
  padding: '12px 18px',
  borderRadius: 12,
  background: 'rgba(17, 24, 28, 0.84)',
  color: '#fff',
} as const;

/** The kiosk's page-long hand tracker and the camera relay it was created on (KioskApp). */
export interface SharedHandTracker {
  tracker: TunableHandTracker;
  relay: CameraRelay;
}

export function FeelScreen({
  view,
  hands,
  onExit,
  onActivity,
  jackets,
  jacket = 0,
  onJacket,
}: {
  view: GarmentView;
  /** Built during the kiosk warm-up; without it this screen builds its own tracker. */
  hands?: SharedHandTracker;
  onExit: () => void;
  onActivity: () => void;
  /** Both jackets (labels and whether each can be felt); the switch shows when given. */
  jackets?: Array<{ label: string; ready: boolean }>;
  /** Index of the jacket on screen. */
  jacket?: number;
  onJacket?: (index: number) => void;
}) {
  const preview = useRef<HTMLDivElement>(null);
  const [ui, setUi] = useState<HandPullUiState>();
  const [ready, setReady] = useState(false);
  const [cameraState, setCameraState] = useState<'starting' | 'on' | 'failed'>('starting');
  const [failure, setFailure] = useState('');
  const [solverFailure, setSolverFailure] = useState('');
  const exit = useRef(onExit);
  exit.current = onExit;
  const activity = useRef(onActivity);
  activity.current = onActivity;
  const [current, setCurrent] = useState<{ fit: string; size: string }>();
  const [compare, setCompare] = useState<SizeFollow[]>([]);
  const [measuring, setMeasuring] = useState(false);
  const [measureError, setMeasureError] = useState('');
  const measure = useRef<() => Promise<StandardPull>>(undefined);
  const [zip, setZip] = useState<InteractUiState>();
  const interact = useRef<InteractController>(undefined);

  useEffect(() => {
    let disposed = false;
    let camera: CameraHandle | undefined;
    let tracker: TunableHandTracker | undefined;
    let lastHand = performance.now();
    let held = false;
    let controller: HandPullController;
    try {
      controller = view.startHandPull();
    } catch (error) {
      setSolverFailure(error instanceof Error ? error.message : String(error));
      return;
    }
    controller.onUi = setUi;
    controller.onError = (message) => setSolverFailure(message);
    interact.current = controller.interact;
    if (controller.interact) {
      controller.interact.onUi = setZip;
      controller.interact.onActivity = () => {
        lastHand = performance.now();
        activity.current();
      };
      window.__interact = controller.interact;
    }
    const identity = controller.identity();
    setCurrent(identity);
    const refresh = () => setCompare(followLog.entries(identity?.fit, sortSizes));
    refresh();
    controller.onGrabEnd = (pull) => {
      followLog.recordHand(pull.fit, pull.size, pull.followMaxM, pull.taut);
      refresh();
    };
    const runMeasure = async () => {
      lastHand = performance.now();
      activity.current();
      setMeasuring(true);
      setMeasureError('');
      try {
        const result = await controller.measureStandardPull();
        followLog.recordStandard(result.fit, result.size, result.followMaxM, result.taut);
        if (!disposed) refresh();
        return result;
      } catch (error) {
        if (!disposed) setMeasureError(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        lastHand = performance.now();
        if (!disposed) setMeasuring(false);
      }
    };
    measure.current = runMeasure;
    const sink = {
      onPinch: (event: PinchEvent) => {
        lastHand = performance.now();
        activity.current();
        controller.handlePinch(event);
      },
      onFrame: (frame: HandFrame) => {
        if (frame.hands.length) {
          lastHand = performance.now();
          activity.current();
        }
        controller.handleFrame(frame);
      },
    };
    window.__handpull = {
      controller,
      sink,
      replay: async (json, options) =>
        (await import('../engine/hand/replay')).playRecording(json, sink, options),
      probe: (x, y, tolerancePx) => !!controller.pick({ x, y }, tolerancePx),
      measure: runMeasure,
      compare: () => followLog.entries(identity?.fit, sortSizes),
      holdOpen: (on) => {
        held = on;
        lastHand = performance.now();
      },
    };
    controller
      .start()
      .then(() => {
        if (!disposed) {
          setReady(true);
          lastHand = performance.now();
        }
      })
      .catch((error: unknown) => {
        if (!disposed) setSolverFailure(error instanceof Error ? error.message : String(error));
      });
    // With the kiosk's shared tracker (built during its warm-up) this screen only opens the
    // camera and attaches it; on exit the tracker is stopped, not closed. Without one (warm-up
    // failed) a tracker is built here, as before.
    let release = () => {
      tracker?.close();
      camera?.close();
    };
    (async () => {
      try {
        // Diagnostics (agent S): User Timing measures for the camera and hand-tracker start.
        const opened = performance.now();
        camera = await openCamera({ width: 1280, height: 720, frameRate: 30 });
        performance.measure('feel:camera', { start: opened });
        if (disposed) return camera.close();
        camera.video.className = 'k-feel-video';
        preview.current?.append(camera.video);
        const trackerStarted = performance.now();
        if (hands) {
          const shared = hands.tracker,
            own = camera;
          hands.relay.attach(own);
          tracker = shared;
          const offPinch = shared.onPinch(sink.onPinch),
            offFrame = shared.onFrame(sink.onFrame);
          release = () => {
            shared.stop(); // releases a held grab through the sink, as close() did
            offPinch();
            offFrame();
            hands.relay.detach();
            own.close();
          };
        } else {
          tracker = await createHandTracker(camera, {
            modelAssetPath: `${VISION_ASSET_BASE}models/hand_landmarker.task`,
            wasmBasePath: `${VISION_ASSET_BASE}mediapipe/wasm`,
          });
          if (disposed) {
            tracker.close();
            return camera.close();
          }
          tracker.onPinch(sink.onPinch);
          tracker.onFrame(sink.onFrame);
        }
        performance.measure('feel:hand-tracker', { start: trackerStarted });
        tracker.start();
        if (window.__handpull) Object.assign(window.__handpull, { tracker, camera });
        setCameraState('on');
      } catch (error) {
        if (disposed) return;
        release();
        setFailure(cameraMessage(error instanceof CameraError ? error.code : 'unknown'));
        setCameraState('failed');
        view.allowOrbit(true);
      }
    })();
    // prompts/05 Part D: leave after 20 s with no hand (camera and tracker stop on unmount).
    const idle = window.setInterval(() => {
      if (!held && performance.now() - lastHand > HAND_PULL.noHandExitMs) exit.current();
    }, 500);
    return () => {
      disposed = true;
      measure.current = undefined;
      window.clearInterval(idle);
      release();
      view.endHandPull();
      if (window.__handpull?.controller === controller) delete window.__handpull;
      if (window.__interact === controller.interact) delete window.__interact;
      interact.current = undefined;
    };
  }, [view, hands]);

  const hint = feelHint(ui?.cursor);
  // While the jacket is opened (zip or hood) the shown cloth is not the measured shell.
  const open = !!zip?.open;
  return (
    <section className="k-feel" data-screen="feel">
      {/* Title over the 3D view: clicks pass through to the jacket (the hood stands behind the head,
          up here); only the jacket switch takes them. */}
      <div className="k-feel-top" style={{ pointerEvents: 'none' }}>
        <h2>{FEEL_TEXT.stepCloser}</h2>
        {jackets && onJacket && jackets.length > 1 && (
          <div
            role="group"
            aria-label="Jacket"
            style={{
              display: 'flex',
              gap: 8,
              marginTop: 6,
              pointerEvents: 'auto',
              width: 'fit-content',
            }}
          >
            {jackets.map((j, i) => (
              <button
                key={i}
                className={i === jacket ? 'k-primary' : 'k-secondary'}
                style={{ fontSize: 15, padding: '6px 12px' }}
                aria-pressed={i === jacket}
                disabled={!j.ready}
                onClick={() => i !== jacket && onJacket(i)}
              >
                {j.label}
              </button>
            ))}
          </div>
        )}
        {!ready && !solverFailure && <p className="k-note">{FEEL_TEXT.preparing}</p>}
      </div>
      {/* Information only: clicks pass through to the jacket (the zip pull can sit behind it). */}
      <div
        className={`k-feel-hint ${ui?.cursor ?? 'open'}`}
        aria-live="polite"
        style={{ pointerEvents: 'none' }}
      >
        <span className="k-hand-icon" aria-hidden="true" />
        <span>{hint}</span>
      </div>
      <aside
        className="k-feel-compare"
        style={{ ...COMPARE_STYLE, top: jackets && jackets.length > 1 ? 150 : COMPARE_STYLE.top }}
        aria-label="Measured pull per size"
      >
        <h3 style={{ margin: '0 0 4px', fontSize: 21 }}>How far the fabric follows</h3>
        <p style={{ margin: '0 0 10px', fontSize: 14, opacity: 0.75, whiteSpace: 'normal' }}>
          Measured by the cloth simulation on your body. It stops when the jacket is taut.
        </p>
        {open && (
          <p role="status" style={{ margin: '0 0 10px', fontSize: 16, color: '#ffd27a' }}>
            Jacket {NOT_MEASURED}: close the zip{zip?.hasHood ? ' and zip the hood on' : ''} to
            measure again.
          </p>
        )}
        {compare.length === 0 && (
          <p style={{ margin: '0 0 10px', fontSize: 16 }}>
            Pull the jacket to measure size {current?.size ?? ''}.
          </p>
        )}
        {compare.map((e) => (
          <div key={e.size} style={{ marginBottom: 8 }} data-size={e.size}>
            <b style={{ fontSize: 20 }}>
              {e.size}
              {e.size === current?.size ? ' (on screen)' : ''}
            </b>
            {e.handMaxM !== undefined && (
              <div style={{ fontSize: 16 }}>
                Your pull: <b>{formatFollow(e.handMaxM)}</b>
                {e.handTaut ? ' · taut' : ''}
              </div>
            )}
            {e.standardM !== undefined && (
              <div style={{ fontSize: 16 }}>
                Standard pull: <b>{formatFollow(e.standardM)}</b>
                {e.standardTaut ? ' · taut' : ' · still following'}
              </div>
            )}
          </div>
        ))}
        <button
          className="k-secondary"
          style={{ fontSize: 16, padding: '8px 14px', marginTop: 4 }}
          disabled={!ready || measuring || !!solverFailure || open || !!zip?.dragging}
          onClick={() => void measure.current?.().catch(() => undefined)}
          title={STANDARD_TITLE}
        >
          {measuring ? 'Measuring…' : `Measure size ${current?.size ?? ''} (standard pull)`}
        </button>
        <p style={{ margin: '6px 0 0', fontSize: 13, opacity: 0.7, whiteSpace: 'normal' }}>
          {STANDARD_TITLE}. Change size on the result screen to compare.
        </p>
        {measureError && (
          <p role="alert" style={{ margin: '6px 0 0', fontSize: 14, color: '#ff8a7a' }}>
            {measureError}
          </p>
        )}
      </aside>
      {interact.current && (
        <aside className="k-feel-zip" style={ZIP_STYLE} aria-label="Zip and hood">
          <div data-zip-status style={{ fontSize: 18, fontWeight: 700 }} aria-live="polite">
            {interactStatus(zip)}
          </div>
          <p style={{ margin: '4px 0 8px', fontSize: 14, opacity: 0.8, whiteSpace: 'normal' }}>
            {interactHint(zip)}
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {zip?.hasHood && (
              <button
                className="k-secondary"
                style={{ fontSize: 15, padding: '6px 12px' }}
                onClick={() => {
                  const c = interact.current;
                  if (!c) return;
                  c.viewHood(!c.inHoodView);
                  setZip(c.state());
                }}
              >
                {zip.hoodView ? 'Front view' : 'Hood view'}
              </button>
            )}
            {!!zip && zip.zipOpen > 0 && !zip.dragging && (
              <button
                className="k-secondary"
                style={{ fontSize: 15, padding: '6px 12px' }}
                onClick={() => interact.current?.setZipOpen(0)}
              >
                Close the zip
              </button>
            )}
          </div>
        </aside>
      )}
      <div className="k-feel-preview" ref={preview} hidden={cameraState !== 'on'} />
      {cameraState === 'failed' && (
        <div className="k-feel-error" role="alert">
          <p>{failure}</p>
        </div>
      )}
      {solverFailure && (
        <div className="k-feel-error" role="alert">
          <p>The fabric simulation stopped: {solverFailure}</p>
        </div>
      )}
      <nav className="k-actions k-footer">
        <button className="k-primary" onClick={() => exit.current()}>
          ← Done
        </button>
      </nav>
    </section>
  );
}
