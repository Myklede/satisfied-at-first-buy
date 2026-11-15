// Zero-config judge kiosk (prompt 04). Route: /?kiosk
// Body data lives only in this page's memory. Reset forgets the body in the service and
// reloads the page, which drops every web-side cache (including engine module caches the
// kiosk cannot reach) — see docs/DECISIONS.md.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createBodyScanner,
  createHandTracker,
  type CameraHandle,
  type ScanResult,
} from '@satisfy/vision';
import {
  api,
  type FitRequest,
  type FitResponse,
  type GarmentFitRequest,
  type GarmentFitResponse,
  type GarmentSpec,
  type SizeFit,
  type Uncertainty,
} from '../api';
import { MOTION_CACHE, MOTION_IDS } from '../engine/motion/config';
import { BakeStore, MotionBakeQueue } from '../engine/motion/BakeQueue';
import { MotionClient } from '../engine/motion/MotionClient';
import { MotionStudio } from '../motion/MotionStudio';
import {
  contrastLine,
  contrastSize,
  collarLine,
  cutNote,
  geometrySizes,
  lengthFormat,
  reasonLine,
  sortSizes,
  storeLink,
} from './fitSummary';
import { GarmentView } from './garmentView';
import { isGarmentFinish, markShadersWarm } from './shaderWarm';
import { CameraRelay } from './cameraRelay';
import type { SharedHandTracker } from './FeelScreen';
import {
  fitBody,
  forgetBody,
  openStore,
  quitKiosk,
  serviceHealthy,
  serviceRestarts,
  ServiceUnavailable,
  type ScanFitReport,
} from './kioskApi';
import { BoardPanel, TryOnPanel } from './panels';
import { FeelScreen } from './FeelScreen';
import { ScanScreen, VISION_ASSET_BASE, type ScanLiveStats } from './ScanScreen';
import { advanceWatchdog, failureCause, INITIAL_WATCHDOG } from './watchdog';
import { IDLE_TICK_MS, idleTick, type IdleClock } from './idle';
import {
  cmToFtIn,
  formatLength,
  formatPlusMinus,
  kgToLb,
  parseYou,
  type Units,
  type YouInput,
} from './units';
import { TryOnScreen } from './tryon/TryOnScreen';
import { syncBackgroundMotion } from './backgroundMotion';
import { tryOnBody } from './tryon/bodyBasis';
import './kiosk.css';

type Screen =
  | 'warmup'
  | 'attract'
  | 'you'
  | 'scan'
  | 'fitting'
  | 'result'
  | 'tryon'
  | 'board'
  | 'feel'
  | 'live-tryon';

/** Inactivity before an automatic reset (prompt 04: 90 s). */
export const IDLE_RESET_MS = 90_000;
/** Delay on the result screen before the automatic X-ray shoulder camera move. */
const MONEY_SHOT_DELAY_MS = 2_500;
/** Attract body: the 172 cm / 65 kg male reference input (README), never a person. */
const REFERENCE = { height_cm: 172, weight_kg: 65, sex: 'male' as const };
/** Kiosk fit defaults (README: t-shirt under-layer, regular preference, neutral shape). */
const DEFAULT_LAYER = 't-shirt';
const settings: { density_kg_m3: FitRequest['density_kg_m3']; layer_cm: number } = {
  density_kg_m3: 1010, // replaced by the service's capabilities during warm-up
  layer_cm: NaN, // replaced by the service's garment options during warm-up
};
const personRequest = (p: {
  height_cm: number;
  weight_kg: number;
  sex: 'female' | 'male';
}): FitRequest => ({
  ...p,
  shape_reference: 'neutral',
  density_kg_m3: settings.density_kg_m3,
  known_measurements: {},
});
const garmentRequest = (body_id: string, product_id: string): GarmentFitRequest => ({
  body_id,
  product_id,
  layer_cm: settings.layer_cm,
  preference: 'regular',
});
const BODY_KEYS = ['shoulder_width', 'chest', 'waist', 'hip'] as const;
const BODY_LABELS: Record<string, string> = {
  shoulder_width: 'Shoulders',
  chest: 'Chest',
  waist: 'Waist',
  hip: 'Hip',
};

interface Jacket {
  product: GarmentSpec;
  fit?: GarmentFitResponse;
  size?: string;
  /** Body visible → recommended shell on screen. */
  visibleMs?: number;
  settledMs?: number;
  /** Metrics measured on the shown, settled shell per size (secondary numbers only). */
  shown?: Record<string, SizeFit>;
  error?: string;
  switching?: boolean;
  lastSwitchMs?: number;
}

interface Diagnostics {
  warmupMs?: number;
  warmupSteps: Record<string, number>;
  visionWarm?: string;
  gpu?: string;
  fitWallMs?: number;
  fitServerMs?: number;
  bodyVisibleMs?: number;
  /** Continue (fitting start) → result screen shown. */
  resultMs?: number;
  /** Body visible → each recommended jacket shell on screen. */
  visibleMs: number[];
  settleMs: number[];
  solverStepMs?: number | null;
  sizeSwitchMs: number[];
  sizeSwitchPhases: NonNullable<Awaited<ReturnType<GarmentView['dress']>>['timing']>[];
  recommendedDressPhases: NonNullable<Awaited<ReturnType<GarmentView['dress']>>['timing']>[];
  /** Page start → attract jacket settled (background, after warm-up). */
  attractDressedMs?: number;
  scan?: ScanLiveStats | null;
}

/** A still canvas posing as a camera: lets MediaPipe load and compile before any judge. */
function stillCamera(): CameraHandle {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  canvas.getContext('2d')?.fillRect(0, 0, 640, 480);
  const video = document.createElement('video');
  return {
    video,
    source: canvas,
    onFrame: () => () => undefined,
    info: () => ({
      deviceId: 'warm-up',
      label: 'warm-up',
      width: 640,
      height: 480,
      fps: 0,
      portrait: false,
    }),
    close: () => undefined,
  };
}

declare global {
  interface Window {
    __kiosk?: {
      screen: Screen;
      diagnostics: Diagnostics;
      jackets: Array<{ style: string; size?: string; settled: boolean; error?: string }>;
      stats: () => {
        heapBytes: number | null;
        views: Array<ReturnType<GarmentView['stats']>>;
        fps: number[];
        garmentVertices: number[];
      };
      /** Background motion bakes (numbers only). */
      motion: () => {
        enabled: boolean;
        pending: number;
        running: string | null;
        completed: number;
        failed: number;
        cachedBakes: number;
        cachedMb: number;
        capMb: number;
        evictions: number;
        /** Background bakes stopped for a hand pull. */
        preemptions: number;
        /** [jacket index, motion id, every size baked] for the pairs the kiosk has a client for. */
        ready: Array<[number, string, boolean]>;
      };
    };
  }
}

export function KioskApp() {
  const [screen, setScreen] = useState<Screen>('warmup');
  /** ms after page load at which every garment shader program was linked (operator cue). */
  const [shadersWarmMs, setShadersWarmMs] = useState<number | null>(null);
  /** The page-long hand tracker Feel attaches its camera to (built during the warm-up). */
  const sharedHands = useRef<SharedHandTracker | undefined>(undefined);
  const [progress, setProgress] = useState({ done: 0, total: 5, label: 'Starting…' });
  const [units, setUnits] = useState<Units>('imperial');
  const [form, setForm] = useState<YouInput>({
    units: 'imperial',
    heightCm: '',
    weightKg: '',
    heightFt: '',
    heightIn: '',
    weightLb: '',
  });
  // No default: the judge picks a body shape before Continue (prompt 06 F1).
  const [sex, setSex] = useState<'female' | 'male' | null>(null);
  const [formErrors, setFormErrors] = useState<{ height?: string; weight?: string }>({});
  const [person, setPerson] = useState<{
    height_cm: number;
    weight_kg: number;
    sex: 'female' | 'male';
  }>();
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [body, setBody] = useState<FitResponse>();
  const [scanReport, setScanReport] = useState<ScanFitReport | null>(null);
  const [bands, setBands] = useState<Uncertainty>();
  const [jackets, setJackets] = useState<Jacket[]>([]);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState('');
  const [sceneReady, setSceneReady] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [storeNote, setStoreNote] = useState<Record<string, string>>({});
  const [, forceTick] = useState(0);
  const diagnostics = useRef<Diagnostics>({
    warmupSteps: {},
    visibleMs: [],
    settleMs: [],
    sizeSwitchMs: [],
    sizeSwitchPhases: [],
    recommendedDressPhases: [],
  });
  // Fit in motion: one pre-warmed client per jacket (judge's body, recommended + contrast size).
  const motionClients = useRef(new Map<string, MotionClient>());
  const [motionFor, setMotionFor] = useState<number | null>(null);
  const motionForRef = useRef(motionFor);
  motionForRef.current = motionFor;
  // Feel the fabric on either jacket (agent Z: zip and hood on both); 0 = the left one.
  const [feelJacket, setFeelJacket] = useState(0);
  const [liveJacket, setLiveJacket] = useState(0);
  const unfollowed = useRef(false);
  const [motionReady, setMotionReady] = useState<Record<string, boolean>>({});
  // Background precompute of the other motions (engine/motion/BakeQueue.ts): one pair at a time,
  // memory-capped, paused during a hand pull, a size switch or a jacket build.
  const motionStore = useRef(new BakeStore(MOTION_CACHE.capBytes));
  const motionQueue = useRef<MotionBakeQueue | null>(null);
  const motionQueueOn = useRef(!new URLSearchParams(location.search).has('nomotionqueue'));
  const busy = useRef({ builds: 0, switches: 0 });
  const containers = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  const views = useRef<GarmentView[]>([]);
  const session = useRef(new AbortController());
  const bodyIds = useRef<string[]>([]);
  /**
   * The no-scan body and both garment fits, started when the judge presses Continue on the
   * You screen, so the service builds the jackets while the judge is on the scan screen. With
   * "Skip" the fitting reuses them; with a scan, the scan fit is anchored to this same body
   * (FitRequest.scan_measurements), so the work is never wasted. Forgotten on reset.
   */
  const prefit = useRef<{
    key: string;
    pending: Promise<{ result: Awaited<ReturnType<typeof fitBody>>; fits: GarmentFitResponse[] }>;
  } | null>(null);
  const remember = (...ids: string[]) => {
    bodyIds.current = [...new Set([...bodyIds.current, ...ids])];
  };
  const lastInput = useRef(performance.now());
  const screenRef = useRef<Screen>('warmup');
  screenRef.current = screen;
  const resetting = useRef(false);
  const watchdogState = useRef(INITIAL_WATCHDOG);

  /** Reconnect path: the service generation that held this judge's body is gone. */
  const enterReconnect = useCallback(() => {
    watchdogState.current = { ...watchdogState.current, lost: true };
    session.current.abort(); // no more requests against the forgotten service generation
    setReconnecting(true);
  }, []);
  /**
   * Whether a failed request was caused by losing the service rather than by the request
   * itself (e.g. a geometry error). Engine fetches report plain Errors, so the service is
   * asked directly: unhealthy or restarted → lost. Two health deadlines in a row count as a
   * request error, so a slow-but-alive service never costs the judge the session.
   */
  async function serviceLost(error: unknown): Promise<boolean> {
    if (error instanceof ServiceUnavailable) return true;
    for (let attempt = 0; attempt < 2; attempt++) {
      const [healthy, restarts] = await Promise.all([serviceHealthy(), serviceRestarts()]);
      const cause = failureCause(watchdogState.current, { healthy, restarts }, false);
      if (cause !== 'unknown') return cause === 'service';
    }
    return false;
  }

  const reset = useCallback(async () => {
    if (resetting.current) return;
    resetting.current = true;
    session.current.abort();
    // Cancel fit-in-motion downloads and the background bakes first: the body is forgotten next.
    motionQueue.current?.dispose();
    motionClients.current.forEach((client) => client.dispose());
    // Forget this judge's body (and its scan base) in the service, then reload: the reload
    // clears every web-side cache, camera handle and worker in one step.
    await Promise.all(bodyIds.current.map((id) => forgetBody(id)));
    location.reload();
  }, []);

  // ---------- warm-up ----------
  useEffect(() => {
    let cancelled = false;
    const started = performance.now();
    const step = (label: string, done: number) => {
      diagnostics.current.warmupSteps[label] = Math.round(performance.now() - started);
      if (!cancelled) setProgress({ done, total: 5, label });
    };
    (async () => {
      setProgress({ done: 0, total: 5, label: 'Starting the body engine…' });
      while (!(await serviceHealthy())) {
        if (cancelled) return;
        await new Promise((r) => setTimeout(r, 1000));
      }
      step('Body engine ready', 1);
      const visionWarm = (async () => {
        // Load and compile pose + hand models once (GPU delegate, CPU fallback) so the
        // scan screen starts instantly. A failure only disables the scan, never the kiosk.
        try {
          const camera = stillCamera();
          const scanner = await createBodyScanner(camera, {
            height_cm: REFERENCE.height_cm,
            sex: REFERENCE.sex,
            assetBase: VISION_ASSET_BASE,
          });
          const delegate = scanner.stats().delegate;
          scanner.close();
          // The hand tracker is kept for the page's life on a camera relay: Feel attaches its
          // camera instead of building a landmarker (its first inference used to be a 0.3–4.9 s
          // main-thread task on every Feel open and jacket switch). Closed by the reload.
          const relay = new CameraRelay();
          const hands = await createHandTracker(relay, {
            modelAssetPath: `${VISION_ASSET_BASE}models/hand_landmarker.task`,
            wasmBasePath: `${VISION_ASSET_BASE}mediapipe/wasm`,
          });
          if (cancelled) hands.close();
          else sharedHands.current = { tracker: hands, relay };
          diagnostics.current.visionWarm = `pose+hands loaded (${delegate})`;
        } catch (error) {
          diagnostics.current.visionWarm = `failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        step('Camera models loaded', 3);
      })();
      const [capabilities, options] = await Promise.all([api.capabilities(), api.garmentOptions()]);
      settings.density_kg_m3 = capabilities.default_density_kg_m3;
      const layer = options.layer_presets_cm[DEFAULT_LAYER];
      if (layer === undefined) throw new Error(`Missing under-layer preset ${DEFAULT_LAYER}`);
      settings.layer_cm = layer;
      const [products, reference] = await Promise.all([
        api.products(),
        fitBody(personRequest(REFERENCE)),
      ]);
      if (cancelled) return;
      step('Reference fit done', 2);
      views.current = containers.map(
        (ref) =>
          new GarmentView(ref.current!, () => {
            views.current.forEach((view) => {
              view.setMode('xray');
              view.showLabels(true);
            });
          }),
      );
      views.current[1].followCamera(views.current[0]);
      // No annotation chips on attract (review 03 M3); the money shot turns them on.
      views.current.forEach((view) => view.showLabels(false));
      await views.current[0].showBody(reference.body);
      // Shader programs compile in the background and are drawn only once linked, so a cold GPU
      // cache never freezes the page (docs/STATUS-kiosk.md, section S). Only the scene's small
      // programs are awaited here.
      await Promise.all(views.current.map((view) => view.sceneShaders()));
      diagnostics.current.gpu = views.current[0].gpuRenderer();
      step('Shaders compiled', 4);
      await visionWarm;
      if (cancelled) return;
      // The jackets' programs (~7 s each on a cold cache; the GPU process compiles about two at
      // a time, all submitted ones sharing it), after the camera models so their shaders do not
      // compete: first the product looks of both views (needed to dress), then the X-ray passes
      // (the money shot) view by view. View i always shows product i (attract, dressing, Feel).
      const finishes = products.map((product) => product.visual?.finish.value);
      void Promise.all(views.current.map((view, i) => view.prepareShaders(finishes[i]))).then(
        async () => {
          for (const [i, view] of views.current.entries())
            if (!cancelled) await view.prepareShaders(finishes[i], true);
          // Operator cue: only when every view's programs were really compiled ahead (a view
          // without a known finish compiles on its first show instead).
          if (!cancelled && views.current.every((_, i) => isGarmentFinish(finishes[i])))
            setShadersWarmMs(markShadersWarm(document.documentElement, performance.now()));
        },
      );
      setJackets(products.map((product) => ({ product })));
      diagnostics.current.warmupMs = Math.round(performance.now() - started);
      step('Ready', 5);
      views.current[0].turntable(true);
      setScreen('attract');
      // Attract jacket: settle the first product's owned size on the reference body.
      const first = products[0];
      if (first) {
        const fit = await api.garmentFit(garmentRequest(reference.body.body_id, first.product_id));
        if (!cancelled && screenRef.current === 'attract')
          await views.current[0]
            .dress(
              fit,
              first.owned_size ?? fit.recommended_size ?? Object.keys(fit.sizes)[0],
              session.current.signal,
            )
            .then(() => {
              diagnostics.current.attractDressedMs = Math.round(performance.now() - started);
            })
            .catch(() => undefined); // cancelled when a judge starts; the attract body stays
      }
    })().catch(() => {
      // Warm-up errors are retried by a reload; the watchdog shows "Reconnecting…".
      if (!cancelled) setTimeout(() => location.reload(), 3000);
    });
    return () => {
      cancelled = true;
      views.current.forEach((view) => view.dispose());
      views.current = [];
      sharedHands.current?.tracker.close();
      sharedHands.current = undefined;
    };
    // Warm-up runs exactly once per page load.
  }, []);

  // ---------- operator keys, attract start, inactivity ----------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      lastInput.current = performance.now();
      if (event.ctrlKey && event.shiftKey) {
        const key = event.key.toUpperCase();
        if (key === 'R') void reset();
        else if (key === 'D') setShowDiagnostics((value) => !value);
        else if (key === 'Q') void quitKiosk().then(() => window.close());
        else if (key === 'B') setScreen('board');
        if (['R', 'D', 'Q', 'B'].includes(key)) event.preventDefault();
        return;
      }
      if (screenRef.current === 'attract' && event.key === 'Escape') {
        // Operator exit, shown as "Esc to exit" on attract only (prompt 06 F2): Chrome --kiosk
        // has no window frame. A judge pressing Esc mid-session never quits the kiosk.
        event.preventDefault();
        void quitKiosk().then(() => window.close());
        return;
      }
      if (
        screenRef.current === 'attract' &&
        !['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)
      )
        begin();
    };
    const onPointer = () => {
      lastInput.current = performance.now();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('pointermove', onPointer);
    // Main-thread stalls are not inactivity, and a Try moves bake the judge is watching keeps
    // the session (idle.ts: a stalled check used to reset the kiosk before the judge's queued
    // click was delivered).
    let clock: Omit<IdleClock, 'lastInput'> = { lastTick: performance.now(), preparingSince: null };
    const idle = window.setInterval(() => {
      const current = screenRef.current;
      const preparing =
        motionForRef.current !== null &&
        [...motionClients.current.values()].some((client) => client.urgentPending > 0);
      const next = idleTick(
        { ...clock, lastInput: lastInput.current },
        performance.now(),
        preparing,
        IDLE_RESET_MS,
        document.visibilityState === 'visible',
      );
      lastInput.current = next.clock.lastInput;
      clock = { lastTick: next.clock.lastTick, preparingSince: next.clock.preparingSince };
      if (current !== 'warmup' && current !== 'attract' && next.reset) void reset();
    }, IDLE_TICK_MS);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('pointermove', onPointer);
      window.clearInterval(idle);
    };
  }, [reset]);

  // ---------- watchdog ----------
  useEffect(() => {
    let cancelled = false;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      const [healthy, restarts] = await Promise.all([serviceHealthy(), serviceRestarts()]);
      polling = false;
      if (cancelled) return;
      const next = advanceWatchdog(
        watchdogState.current,
        { healthy, restarts },
        screenRef.current === 'warmup',
      );
      watchdogState.current = next.state;
      if (next.action !== 'ok') enterReconnect();
      // The restarted service has no cached bodies: start a fresh session.
      if (next.action === 'reset') void reset();
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [reset, enterReconnect]);

  // Diagnostics overlay refresh.
  useEffect(() => {
    if (!showDiagnostics) return;
    const timer = window.setInterval(() => forceTick((n) => n + 1), 500);
    return () => window.clearInterval(timer);
  }, [showDiagnostics]);

  // Test/diagnostic hook (numbers only; no body data).
  useEffect(() => {
    window.__kiosk = {
      screen,
      diagnostics: diagnostics.current,
      jackets: jackets.map((j) => ({
        style: j.product.style,
        size: j.size,
        settled: j.settledMs !== undefined,
        error: j.error,
      })),
      stats: () => ({
        heapBytes:
          (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
            ?.usedJSHeapSize ?? null,
        views: views.current.map((view) => view.stats()),
        fps: views.current.map((view) => view.fps),
        garmentVertices: views.current.map((view) => view.garmentVertices()),
      }),
      motion: () => ({
        enabled: motionQueueOn.current,
        pending: motionQueue.current?.pending ?? 0,
        running: motionQueue.current?.running ?? null,
        completed: motionQueue.current?.completed ?? 0,
        failed: motionQueue.current?.failed ?? 0,
        cachedBakes: motionStore.current.count,
        cachedMb: +(motionStore.current.total / 1e6).toFixed(1),
        capMb: +(motionStore.current.capBytes / 1e6).toFixed(0),
        evictions: motionStore.current.evictions,
        preemptions: [...motionClients.current.values()].reduce((n, c) => n + c.preemptions, 0),
        ready: jackets.flatMap((j, i): Array<[number, string, boolean]> => {
          const client = j.fit && motionClients.current.get(j.fit.fit_id);
          return client
            ? MOTION_IDS.map((id) => [i, id, client.sizes.every((s) => !!client.cached(s, id))])
            : [];
        }),
      }),
    };
  }, [screen, jackets]);

  function begin() {
    views.current[0]?.turntable(false);
    views.current[0]?.clearGarment();
    views.current[0]?.preset('front');
    setScreen('you');
  }

  function submitYou() {
    if (!sex) return; // Continue stays disabled until a body shape is picked
    const parsed = parseYou({ ...form, units });
    if (!parsed.ok) {
      setFormErrors({ height: parsed.height, weight: parsed.weight });
      return;
    }
    setFormErrors({});
    setPerson({ height_cm: parsed.height_cm, weight_kg: parsed.weight_kg, sex });
    const request = personRequest({
      height_cm: parsed.height_cm,
      weight_kg: parsed.weight_kg,
      sex,
    });
    const signal = session.current.signal;
    const products = jackets.map((j) => j.product);
    const pending = fitBody(request, signal).then(async (result) => {
      remember(result.body.body_id);
      const fits = await Promise.all(
        products.map((product) =>
          api.garmentFit(garmentRequest(result.body.body_id, product.product_id), signal),
        ),
      );
      return { result, fits };
    });
    pending.catch(() => undefined); // startFitting falls back to its own requests
    prefit.current = { key: JSON.stringify(request), pending };
    setScreen('scan');
  }

  function switchUnits(next: Units) {
    // Carry entered values across so a judge never has to retype.
    const parsed = parseYou({ ...form, units });
    if (parsed.ok) {
      const { ft, inches } = cmToFtIn(parsed.height_cm);
      setForm({
        units: next,
        heightCm: String(Math.round(parsed.height_cm)),
        weightKg: String(Math.round(parsed.weight_kg)),
        heightFt: String(ft),
        heightIn: String(Math.round(inches)),
        weightLb: String(Math.round(kgToLb(parsed.weight_kg))),
      });
    }
    setUnits(next);
  }

  // ---------- fitting ----------
  async function startFitting(scanResult: ScanResult | null) {
    if (!person) return;
    setScan(scanResult);
    setScreen('fitting');
    setMessage('Building your body…');
    const signal = session.current.signal;
    const started = performance.now();
    const d = diagnostics.current;
    try {
      const scanMeasurements = scanResult
        ? {
            ...Object.fromEntries(
              Object.entries(scanResult.measurements).map(([name, m]) => [
                name,
                { value_cm: m.value_cm, sigma_cm: m.sigma_cm, method: m.method.slice(0, 400) },
              ]),
            ),
            calibration: /^[A-Za-z0-9_.:-]{1,64}$/.test(scanResult.calibration)
              ? scanResult.calibration
              : 'uncalibrated',
          }
        : undefined;
      const plain = personRequest(person);
      const early =
        !scanMeasurements && prefit.current?.key === JSON.stringify(plain)
          ? await prefit.current.pending.catch(() => null)
          : null;
      const { body: fitted, scan: report } =
        early?.result ??
        (await fitBody(
          { ...plain, ...(scanMeasurements ? { scan_measurements: scanMeasurements } : {}) },
          signal,
        ));
      remember(fitted.body_id, ...(report ? [report.base_body_id] : []));
      d.fitWallMs = Math.round(performance.now() - started);
      d.fitServerMs = Math.round(fitted.fit_ms);
      setBody(fitted);
      setScanReport(report);
      // Garment fits need only the body id: request them while the body mesh loads.
      const products = jackets.map((j) => j.product);
      const fitsPending = early
        ? Promise.resolve(early.fits)
        : Promise.all(
            products.map((product) =>
              api.garmentFit(garmentRequest(fitted.body_id, product.product_id), signal),
            ),
          );
      fitsPending.catch(() => undefined); // awaited below; avoid an unhandled rejection meanwhile
      await Promise.all(views.current.map((view) => view.showBody(fitted, signal)));
      if (signal.aborted) return;
      const bodyVisible = performance.now();
      d.bodyVisibleMs = Math.round(bodyVisible - started);
      setSceneReady(true);
      setMessage('Dressing both jackets…');
      void api
        .uncertainty(fitted.body_id, signal)
        .then(setBands)
        .catch(() => undefined);
      const fits = await fitsPending;
      if (signal.aborted) return;
      setJackets(
        products.map((product, i) => ({
          product,
          fit: fits[i],
          size: fits[i].recommended_size ?? undefined,
        })),
      );
      d.visibleMs = [];
      d.settleMs = [];
      d.recommendedDressPhases = [];
      const update = (i: number, change: (j: Jacket) => Jacket) =>
        setJackets((current) => current.map((j, k) => (k === i ? change(j) : j)));
      const dressed = fits.slice(0, views.current.length).map((fit, i) => {
        const size = fit.recommended_size ?? geometrySizes(fit)[0];
        let markVisible!: () => void;
        const visible = new Promise<void>((resolve) => (markVisible = resolve));
        const settled = (async () => {
          if (!size) return markVisible();
          try {
            const { solverMeanStepMs, shown, timing } = await views.current[i].dress(
              fit,
              size,
              signal,
              () => {
                const ms = Math.round(performance.now() - bodyVisible);
                d.visibleMs[i] = ms;
                update(i, (j) => ({ ...j, size, visibleMs: ms }));
                markVisible();
              },
            );
            const ms = Math.round(performance.now() - bodyVisible);
            d.settleMs[i] = ms;
            if (timing) d.recommendedDressPhases[i] = timing;
            d.solverStepMs = solverMeanStepMs;
            update(i, (j) => ({
              ...j,
              size,
              settledMs: ms,
              shown: shown ? { ...j.shown, [size]: shown } : j.shown,
            }));
          } catch (error) {
            // Losing the service is not this jacket's fault: reconnect instead of showing a
            // per-jacket error (and the result screen) behind "Reconnecting…".
            const lost = !signal.aborted && (await serviceLost(error));
            if (lost) enterReconnect();
            else if (!signal.aborted)
              update(i, (j) => ({ ...j, error: 'The 3D drape is unavailable for this jacket.' }));
          } finally {
            markVisible();
          }
          if (signal.aborted) return;
          // The other sizes precompute in the background (engine cache) once this one settled.
          const sizes = sortSizes(geometrySizes(fit));
          busy.current.builds++;
          void views.current[i]
            ?.precompute(fit, sizes, size, signal)
            .catch(() => undefined)
            .finally(() => {
              busy.current.builds--;
              motionQueue.current?.kick();
            });
        })();
        return { visible, settled };
      });
      // The result shows as soon as BOTH recommended shells are on screen (review 03 H5); the
      // cloth keeps settling and the other sizes keep loading behind a small indicator.
      await Promise.all(dressed.map((x) => x.visible));
      if (signal.aborted) return;
      d.resultMs = Math.round(performance.now() - started);
      views.current[0]?.enterResult();
      setMessage('');
      setScreen('result');
      await Promise.all(dressed.map((x) => x.settled));
      if (signal.aborted) return;
      // Fit in motion: bake the first motion for the first jacket in the background.
      prewarmMotion(fitted.body_id, fits);
    } catch (error) {
      if (signal.aborted) return;
      const lost = await serviceLost(error);
      if (signal.aborted) return;
      if (lost) enterReconnect();
      else setFailure(error instanceof Error ? error.message : 'Something went wrong.');
    }
  }

  // 3D labels use the same units and text as the cards (one number per quantity).
  useEffect(() => {
    views.current.forEach((view) => view.setLabelFormat(lengthFormat(units)));
  }, [units, screen]);

  // ---------- fit in motion ----------
  function motionClient(index: number): MotionClient | undefined {
    const fit = jackets[index]?.fit;
    if (!body || !fit) return undefined;
    return motionClientFor(body.body_id, fit);
  }
  function motionClientFor(bodyId: string, fit: GarmentFitResponse): MotionClient | undefined {
    let client = motionClients.current.get(fit.fit_id);
    if (client) return client;
    const sizes = motionSizes(fit);
    if (!sizes.length) return undefined;
    client = new MotionClient(bodyId, fit.fit_id, sizes);
    client.store = motionStore.current;
    motionClients.current.set(fit.fit_id, client);
    return client;
  }
  /** Starts baking the first motion (recommended size first) while the judge reads the result. */
  function prewarmMotion(bodyId: string, fits: GarmentFitResponse[]) {
    const fit = fits[0];
    const client = fit && motionClientFor(bodyId, fit);
    if (!client || !fit) return;
    const order = [...client.sizes].sort((a) => (a === fit.recommended_size ? -1 : 1));
    void client
      .load()
      .then(() =>
        Promise.all(order.map((size) => client.bake(size, MOTION_IDS[0], false))).then(() =>
          setMotionReady((ready) => ({ ...ready, [fit.fit_id]: true })),
        ),
      )
      .then(() => startMotionQueue(bodyId, fits))
      .catch(() => undefined); // the Try moves view reports its own errors
  }
  /**
   * After the first motion of the first jacket: bake the rest in the background, one (jacket,
   * motion) pair at a time. Order = most likely clicked first: the first motion of the second
   * jacket (what Try moves opens on), then the motions in button order, first jacket first.
   */
  function startMotionQueue(bodyId: string, fits: GarmentFitResponse[]) {
    if (!motionQueueOn.current || motionQueue.current || resetting.current) return;
    const clients = fits.slice(0, 2).map((fit) => motionClientFor(bodyId, fit));
    const queue = new MotionBakeQueue({
      store: motionStore.current,
      // Hand pull (feel), scan and fitting screens never share the CPU with a new bake; a size
      // switch or an other-size build in flight postpones it too.
      canRun: () =>
        !resetting.current &&
        ['result', 'tryon', 'board'].includes(screenRef.current) &&
        busy.current.builds === 0 &&
        busy.current.switches === 0,
    });
    motionQueue.current = queue;
    const [first, second] = clients;
    if (second) queue.enqueue(second, [MOTION_IDS[0]]);
    for (const motionId of MOTION_IDS.slice(1))
      for (const client of [first, second]) if (client) queue.enqueue(client, [motionId]);
  }
  useEffect(() => {
    // Both camera interactions preempt an already-running bake and resume it on exit.
    syncBackgroundMotion(screen, motionClients.current.values(), () => motionQueue.current?.kick());
  }, [screen]);
  // Try moves open on a jacket: its remaining motions bake first.
  useEffect(() => {
    const fit = motionFor !== null ? jackets[motionFor]?.fit : undefined;
    const client = fit && motionClients.current.get(fit.fit_id);
    if (client) motionQueue.current?.focus(client);
  }, [motionFor]);
  useEffect(() => {
    const clients = motionClients.current;
    return () => {
      motionQueue.current?.dispose();
      clients.forEach((client) => client.dispose());
    };
  }, []);

  // Feel on the second jacket: its viewer stops following the first one's camera meanwhile.
  useEffect(() => {
    const second = views.current[1];
    if (screen === 'feel' && feelJacket === 1) {
      second?.followCamera(null);
      unfollowed.current = true;
    } else if (unfollowed.current) {
      second?.followCamera(views.current[0] ?? null);
      unfollowed.current = false;
    }
    if (screen !== 'feel' && feelJacket !== 0) setFeelJacket(0);
  }, [screen, feelJacket]);

  // Automatic camera move to the X-ray shoulder close-up (the money shot). Key 5 still works.
  useEffect(() => {
    if (screen !== 'result') return;
    const timer = window.setTimeout(() => {
      views.current.forEach((view, i) => {
        view.setMode('xray', jackets[i]?.fit);
        view.showLabels(true);
      });
      views.current[0]?.preset('shoulders');
    }, MONEY_SHOT_DELAY_MS);
    return () => window.clearTimeout(timer);
    // Once per entry into the result screen.
  }, [screen]);

  async function chooseSize(index: number, size: string) {
    const jacket = jackets[index];
    const view = views.current[index];
    if (!jacket?.fit || !view || jacket.size === size || jacket.switching) return;
    setJackets((current) => current.map((j, k) => (k === index ? { ...j, switching: true } : j)));
    busy.current.switches++;
    try {
      const { wallMs, shown, timing } = await view.dress(jacket.fit, size, session.current.signal);
      diagnostics.current.sizeSwitchMs.push(Math.round(wallMs));
      if (timing) diagnostics.current.sizeSwitchPhases.push(timing);
      setJackets((current) =>
        current.map((j, k) =>
          k === index
            ? {
                ...j,
                size,
                switching: false,
                lastSwitchMs: Math.round(wallMs),
                shown: shown ? { ...j.shown, [size]: shown } : j.shown,
              }
            : j,
        ),
      );
    } catch (error) {
      const signal = session.current.signal;
      if (!signal.aborted && (await serviceLost(error))) enterReconnect();
      setJackets((current) =>
        current.map((j, k) => (k === index ? { ...j, switching: false } : j)),
      );
    } finally {
      busy.current.switches--;
      motionQueue.current?.kick();
    }
  }

  async function shop(jacket: Jacket) {
    const link = storeLink(jacket.product, jacket.fit?.recommended_size ?? null);
    if (!link) return;
    const result = await openStore(jacket.product.product_id);
    if (result === 'unavailable') window.open(jacket.product.url, '_blank', 'noopener,noreferrer');
    setStoreNote((notes) => ({
      ...notes,
      [jacket.product.product_id]:
        result === 'dry_run'
          ? `Test mode: would open ${link.store}. ${link.note}`
          : `Opened ${link.store} in a separate browser window. ${link.note}`,
    }));
  }

  // During fitting the stage stays hidden until the judge's own body is on screen.
  const showScene =
    ['attract', 'you', 'result', 'feel'].includes(screen) || (screen === 'fitting' && sceneReady);
  // Hand pull uses the first jacket's view once its cloth is on screen.
  const canFeel = jackets[0]?.settledMs !== undefined && !!views.current[0]?.canPull();
  const twoUp = ['fitting', 'result'].includes(screen);
  const d = diagnostics.current;

  return (
    <main className={`kiosk ks-${screen}`} onPointerDown={() => screen === 'attract' && begin()}>
      <div className={`k-stage ${twoUp ? 'k-two' : ''}`} hidden={!showScene}>
        {containers.map((ref, i) => (
          <div
            key={i}
            className="k-canvas"
            ref={ref}
            hidden={screen === 'feel' ? i !== feelJacket : i === 1 && !twoUp}
          >
            {twoUp && jackets[i] && (
              <div className="k-canvas-label">
                {jackets[i].product.style} · {jackets[i].product.colourway}
                {jackets[i].size && ` · size ${jackets[i].size}`}
              </div>
            )}
          </div>
        ))}
      </div>

      {screen === 'warmup' && (
        <section className="k-center" data-screen="warmup">
          <h1>Satisfy at the First Buy</h1>
          <p className="k-lead">{progress.label}</p>
          <div className="k-progress k-wide">
            <i style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
        </section>
      )}

      {screen === 'attract' && (
        <section className="k-attract" data-screen="attract">
          <h1>Step up to find your size</h1>
          <p className="k-lead">See how a jacket really fits your body — before you buy.</p>
          <p className="k-cta">Press any key or tap to start</p>
        </section>
      )}
      {screen === 'attract' && (
        <small className="k-exit-hint" data-testid="exit-hint">
          Esc to exit
        </small>
      )}
      {screen === 'attract' && (
        // Operator cue only (grey: the jackets' shaders still compile; green: all linked).
        <span
          className={`k-warm${shadersWarmMs !== null ? ' k-warm-on' : ''}`}
          data-testid="shaders-warm"
          aria-hidden="true"
        />
      )}

      {screen === 'you' && (
        <section className="k-panel k-you" data-screen="you">
          <div className="k-eyebrow">Step 1 · You</div>
          <h2>Tell us about you</h2>
          <div className="k-tabs" role="group" aria-label="Units">
            <button aria-pressed={units === 'imperial'} onClick={() => switchUnits('imperial')}>
              ft · lb
            </button>
            <button aria-pressed={units === 'metric'} onClick={() => switchUnits('metric')}>
              cm · kg
            </button>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submitYou();
            }}
          >
            <label className="k-field">
              Height
              {units === 'imperial' ? (
                <span className="k-pair">
                  <input
                    aria-label="Height feet"
                    inputMode="numeric"
                    value={form.heightFt}
                    onChange={(e) => setForm({ ...form, heightFt: e.target.value })}
                    placeholder="5"
                    autoFocus
                  />
                  <em>ft</em>
                  <input
                    aria-label="Height inches"
                    inputMode="decimal"
                    value={form.heightIn}
                    onChange={(e) => setForm({ ...form, heightIn: e.target.value })}
                    placeholder="9"
                  />
                  <em>in</em>
                </span>
              ) : (
                <span className="k-pair">
                  <input
                    aria-label="Height centimetres"
                    inputMode="decimal"
                    value={form.heightCm}
                    onChange={(e) => setForm({ ...form, heightCm: e.target.value })}
                    placeholder="175"
                    autoFocus
                  />
                  <em>cm</em>
                </span>
              )}
              {formErrors.height && <small className="k-error">{formErrors.height}</small>}
            </label>
            <label className="k-field">
              Weight
              <span className="k-pair">
                {units === 'imperial' ? (
                  <input
                    aria-label="Weight pounds"
                    inputMode="decimal"
                    value={form.weightLb}
                    onChange={(e) => setForm({ ...form, weightLb: e.target.value })}
                    placeholder="150"
                  />
                ) : (
                  <input
                    aria-label="Weight kilograms"
                    inputMode="decimal"
                    value={form.weightKg}
                    onChange={(e) => setForm({ ...form, weightKg: e.target.value })}
                    placeholder="68"
                  />
                )}
                <em>{units === 'imperial' ? 'lb' : 'kg'}</em>
              </span>
              {formErrors.weight && <small className="k-error">{formErrors.weight}</small>}
            </label>
            <div className="k-field">
              Body shape
              <div className="k-tabs" role="group" aria-label="Body shape">
                <button
                  type="button"
                  aria-pressed={sex === 'female'}
                  onClick={() => setSex('female')}
                >
                  Female
                </button>
                <button type="button" aria-pressed={sex === 'male'} onClick={() => setSex('male')}>
                  Male
                </button>
              </div>
            </div>
            {!sex && <p className="k-hint">Pick a body shape to continue.</p>}
            <button className="k-primary" type="submit" disabled={!sex}>
              Continue →
            </button>
          </form>
          <p className="k-note">Your numbers stay on this laptop and are erased when you finish.</p>
        </section>
      )}

      {screen === 'scan' && person && (
        <ScanScreen
          heightCm={person.height_cm}
          sex={person.sex}
          units={units}
          onStats={(stats) => {
            diagnostics.current.scan = stats;
          }}
          onDone={(result) => void startFitting(result)}
        />
      )}

      {screen === 'fitting' && (
        <section className="k-banner" data-screen="fitting" role="status" aria-live="polite">
          <h2>{message || 'Fitting…'}</h2>
          <p className="k-note">
            {sceneReady &&
              jackets
                .map(
                  (j) =>
                    `${j.product.style}: ${j.error ?? (j.settledMs !== undefined ? 'settled' : 'preparing cloth…')}`,
                )
                .join(' · ')}
          </p>
        </section>
      )}

      {(screen === 'result' || screen === 'tryon') && body && (
        <section className="k-result" data-screen={screen === 'result' ? 'result' : undefined}>
          {screen === 'result' && (
            <div className="k-cards">
              {jackets.map((jacket, i) => {
                const link = storeLink(jacket.product, jacket.fit?.recommended_size ?? null);
                const rec = jacket.fit?.recommended_size;
                const compare = jacket.fit ? contrastLine(jacket.fit, units) : null;
                const selectedFit = jacket.size ? jacket.fit?.sizes[jacket.size] : undefined;
                const collar = collarLine(selectedFit, units);
                const cut = person ? cutNote(jacket.product, person.sex) : null;
                const settling = jacket.settledMs === undefined && !jacket.error;
                const moves = jacket.fit ? motionReady[jacket.fit.fit_id] : false;
                return (
                  <article className="k-card" key={jacket.product.product_id}>
                    <div className="k-eyebrow">
                      {jacket.product.style} · {jacket.product.colourway}
                      {cut && <span className="k-badge">{cut}</span>}
                    </div>
                    <h3>{rec ? `Your size: ${rec}` : 'No confident size'}</h3>
                    {jacket.fit && <p className="k-reason">{reasonLine(jacket.fit, units)}</p>}
                    {compare && <p className="k-note">X-ray: {compare}</p>}
                    <p className="k-note k-collar" title={selectedFit?.zones.collar?.explanation}>
                      {collar ?? 'Collar: not assessed for this size.'}
                    </p>
                    <p className="k-loading" role="status">
                      {jacket.error
                        ? 'Cloth unavailable.'
                        : settling
                          ? 'Cloth settling… the other sizes load next.'
                          : 'Cloth ready.'}
                    </p>
                    {jacket.error && <p className="k-note">{jacket.error}</p>}
                    <div
                      className="k-sizes"
                      role="group"
                      aria-label={`${jacket.product.style} sizes`}
                    >
                      {jacket.fit &&
                        sortSizes(geometrySizes(jacket.fit)).map((size) => (
                          <button
                            key={size}
                            aria-pressed={jacket.size === size}
                            disabled={jacket.switching || settling}
                            onClick={() => void chooseSize(i, size)}
                          >
                            {size}
                            {size === rec ? ' ★' : ''}
                          </button>
                        ))}
                    </div>
                    <div className="k-shoprow">
                      {jacket.fit && jacket.size && (
                        <button
                          className="k-primary"
                          onClick={() => {
                            setLiveJacket(i);
                            setScreen('live-tryon');
                          }}
                        >
                          Try it on you
                        </button>
                      )}
                      {link && (
                        <button className="k-shop" onClick={() => void shop(jacket)}>
                          {link.label} ↗
                        </button>
                      )}
                      {jacket.fit && body && (
                        <button
                          className="k-secondary k-moves"
                          disabled={settling}
                          onClick={() => setMotionFor(i)}
                          title="Fit in motion: the same jacket in two sizes on your body"
                        >
                          Try moves · {motionSizes(jacket.fit).join(' vs ')}
                          {moves ? ' ✓' : ''}
                        </button>
                      )}
                    </div>
                    {link && (
                      <small className="k-note k-storenote">
                        {storeNote[jacket.product.product_id] ??
                          `${link.store} product page. ${link.note}`}
                      </small>
                    )}
                  </article>
                );
              })}
            </div>
          )}
          {screen === 'tryon' && person && (
            <TryOnPanel
              jackets={jackets
                .filter((j) => j.fit && j.size)
                .map((j) => ({
                  product: j.product,
                  fit: j.fit!,
                  size: j.size!,
                  shown: j.shown?.[j.size!],
                }))}
              units={units}
              sex={person.sex}
              heightCm={person.height_cm}
              scanned={Boolean(scanReport)}
              onBoard={() => setScreen('board')}
            />
          )}
          <aside className="k-bodybar">
            <span>Your body{scanReport ? ' (with scan)' : ''}:</span>
            {BODY_KEYS.map((key) => {
              const m = body.measurements[key];
              const band = bands?.bands[key];
              return (
                <span key={key}>
                  {BODY_LABELS[key]}{' '}
                  <b>
                    {band
                      ? formatPlusMinus(m.value_cm, (band.upper_cm - band.lower_cm) / 2, units)
                      : formatLength(m.value_cm, units).split(' (')[0]}
                  </b>
                </span>
              );
            })}
            {!bands && <small>computing ±…</small>}
          </aside>
          <nav className="k-actions k-footer">
            {screen === 'result' ? (
              <button className="k-primary" onClick={() => setScreen('tryon')}>
                Try it on — check us with a tape →
              </button>
            ) : (
              <button className="k-secondary" onClick={() => setScreen('result')}>
                ← Back to sizes
              </button>
            )}
            <button
              className="k-secondary"
              disabled={!canFeel}
              onClick={() => setScreen('feel')}
              title="Step closer and pull the jacket with your hand"
            >
              Feel the fabric ✋
            </button>
            <button className="k-secondary" onClick={() => void reset()}>
              Start over
            </button>
          </nav>
        </section>
      )}

      {screen === 'live-tryon' && body && jackets[liveJacket]?.fit && jackets[liveJacket]?.size && (
        <TryOnScreen
          {...tryOnBody(body, scanReport)}
          signal={session.current.signal}
          jackets={jackets
            .filter((j) => j.fit && j.size)
            .map((j) => ({ product: j.product, fit: j.fit!, size: j.size! }))}
          initialJacket={jackets
            .filter((j) => j.fit && j.size)
            .findIndex((j) => j.product.product_id === jackets[liveJacket].product.product_id)}
          onExit={() => setScreen('result')}
          onReset={() => void reset()}
          onActivity={() => {
            lastInput.current = performance.now();
          }}
        />
      )}

      {screen === 'feel' && views.current[feelJacket] && (
        <FeelScreen
          key={feelJacket}
          view={views.current[feelJacket]}
          hands={sharedHands.current}
          jacket={feelJacket}
          jackets={jackets.map((j, i) => ({
            label: `${j.product.style} · ${j.product.colourway}`,
            ready: j.settledMs !== undefined && !!views.current[i]?.canPull(),
          }))}
          onJacket={setFeelJacket}
          onExit={() => setScreen('result')}
          onActivity={() => {
            lastInput.current = performance.now();
          }}
        />
      )}

      {screen === 'result' && motionFor !== null && jackets[motionFor]?.fit && (
        <MotionOverlay
          client={motionClient(motionFor)}
          title={[
            `${jackets[motionFor].product.title}, on your body`,
            person ? cutNote(jackets[motionFor].product, person.sex) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          recommended={jackets[motionFor].fit!.recommended_size}
          onClose={() => setMotionFor(null)}
        />
      )}

      {screen === 'board' && (
        <>
          <BoardPanel units={units} />
          <nav className="k-actions k-footer">
            <button className="k-secondary" onClick={() => void reset()}>
              Start over
            </button>
          </nav>
        </>
      )}

      {screen === 'fitting' && failure && (
        <div className="k-overlay">
          <p>{failure}</p>
          <button className="k-primary" onClick={() => void reset()}>
            Start over
          </button>
        </div>
      )}

      {reconnecting && (
        <div className="k-overlay" role="alert">
          <p>Reconnecting…</p>
        </div>
      )}

      {showDiagnostics && (
        <pre className="k-diag">
          {[
            `fps ${views.current.map((v) => v.fps).join(' / ')}`,
            `gpu ${d.gpu ?? '?'}`,
            `warm-up ${d.warmupMs ?? '…'} ms ${JSON.stringify(d.warmupSteps)}`,
            `vision ${d.visionWarm ?? '…'}`,
            `scan ${d.scan ? `${d.scan.inferenceHz} Hz · ${d.scan.delegate} · ${d.scan.inferMs.toFixed(1)} ms` : '—'}`,
            `fit wall ${d.fitWallMs ?? '—'} ms · server ${d.fitServerMs ?? '—'} ms · body visible ${d.bodyVisibleMs ?? '—'} ms`,
            `cloth settle after body ${d.settleMs.join(' / ') || '—'} ms · solver step ${d.solverStepMs?.toFixed(1) ?? '—'} ms`,
            `size switch ${d.sizeSwitchMs.slice(-4).join(', ') || '—'} ms`,
            `render ${JSON.stringify(views.current.map((v) => v.stats()))}`,
            `heap ${((performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1e6} MB`,
            `scan sent ${scan ? Object.keys(scan.measurements).length : 0} values`,
            `hand pull ${(() => {
              const s = window.__handpull?.controller.stats();
              return s
                ? `fps ${s.fpsP50.toFixed(0)} (p5 ${s.fpsP5.toFixed(0)}) · latency p50 ${s.latencyP50.toFixed(0)} / p95 ${s.latencyP95.toFixed(0)} ms (n ${s.latencySamples}) · step ${s.stepP50.toFixed(1)}/${s.stepP95.toFixed(1)} ms · ${s.deliveredHz.toFixed(0)} Hz · grabs ${s.grabs} missed ${s.missedGrabs} · max shell ${s.maxShellRatio.toFixed(3)}`
                : '—';
            })()}`,
          ].join('\n')}
        </pre>
      )}
    </main>
  );
}

/** Fit in motion compares the recommended size with the X-ray contrast size, smaller first. */
function motionSizes(fit: GarmentFitResponse): string[] {
  return sortSizes([fit.recommended_size, contrastSize(fit)].filter((s): s is string => !!s));
}

/** "Try moves": the fit-in-motion view on the judge's own body and fit (agent P2's studio). */
function MotionOverlay({
  client,
  title,
  recommended,
  onClose,
}: {
  client: MotionClient | undefined;
  title: string;
  recommended: string | null | undefined;
  onClose: () => void;
}) {
  // Stable props: MotionStudio reloads when bodyId / fitId / sizes change identity.
  const props = useMemo(
    () => client && { bodyId: client.bodyId, fitId: client.fitId, sizes: client.sizes },
    [client],
  );
  if (!client || !props) return null;
  return (
    <div className="k-motion">
      <MotionStudio
        {...props}
        client={client}
        recommended={recommended}
        title={title}
        onClose={onClose}
      />
    </div>
  );
}
