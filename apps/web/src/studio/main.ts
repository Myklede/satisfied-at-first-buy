/// <reference types="vite/client" />
// Studio page (apps/web/studio.html, prompts/31): Decart photoreal view large on the left, our Fit
// Lab on the right, one shared camera, one StudioBus. Decart renders the look only; fit numbers
// come from our engine (FL's FitLabPanel) and are never invented here.
//
// Optional parts load when their owners have committed them (absence is shown, never mocked):
//   FL: ./fitlab/index.ts  export function createFitLabPanel(): FitLabPanel
//   ZB: ./perception.ts     export function createPerception(): Perception
//   ZB: ./bridge.ts         export function startBridge(deps: BridgeDeps): { dispose(): void }
import type { FitLabPanel, Perception, StudioBus } from './contract';
import { createStudioBus } from './bus';
import { openSharedCamera, type SharedCameraHandle } from './camera';
import { createShell, type Shell } from './shell';
import { DecartView, type DecartViewStatus } from './decartView';
import type { FitLabel } from './decartViewMap';
import { creditsText, formatBudget, tokenServer, type TokenStatus } from '../decart/tokenServer';

export interface BridgeDeps {
  bus: StudioBus;
  perception: Perception;
  camera: SharedCameraHandle;
  overlayHost: HTMLElement;
  /** The mounted Fit Lab panel (ZB reads its physics hooks); null when FL is unavailable. */
  fitLab?: unknown;
}

const fitlabModules = import.meta.glob<{ createFitLabPanel?: () => FitLabPanel }>(
  './fitlab/index.ts',
);
const perceptionModules = import.meta.glob<{ createPerception?: () => Perception }>(
  './perception.ts',
);
const bridgeModules = import.meta.glob<{
  startBridge?: (deps: BridgeDeps) => { dispose(): void };
}>('./bridge.ts');

async function loadOptional<M, T>(
  modules: Record<string, () => Promise<M>>,
  pick: (m: M) => T | undefined,
): Promise<T | null> {
  for (const load of Object.values(modules)) {
    const value = pick(await load());
    if (value) return value;
  }
  return null;
}

const root = document.getElementById('studio');
if (!root) throw new Error('#studio missing');
// Demo default (the user's flow): the puffer DQ4920-206 in size S; Parka is one click away.
const bus = createStudioBus({ jacket: 'DQ4920-206', size: 'S' });
const shell: Shell = createShell(root, bus);

async function refreshCredits(): Promise<void> {
  try {
    const c = await tokenServer.credits();
    shell.setCredits(creditsText(c.credits));
  } catch (err) {
    shell.setCredits(`Credits left: ? (${err instanceof Error ? err.message : String(err)})`);
  }
}

function onBudget(s: TokenStatus): void {
  shell.setBudget(formatBudget(s));
  if (s.keyPresent) void refreshCredits();
}

// Decart's own balance (GET /v1/credits via the token server), every 30 s and after each session.
window.setInterval(() => void refreshCredits(), 30_000);

async function boot(): Promise<void> {
  let camera: SharedCameraHandle;
  try {
    camera = await openSharedCamera();
  } catch (err) {
    shell.log(`camera: ${err instanceof Error ? err.message : String(err)}`, 'error');
    shell.setNote('No camera. Allow the camera and reload.');
    return;
  }
  shell.log(`camera: ${camera.label} ${camera.width}x${camera.height}`);
  const fallbackCaption = 'Camera (Decart off)';
  shell.showBig(camera.video, fallbackCaption, true);

  // ---- Fit Lab (FL) + perception/bridge (ZB), when present ----
  let fitlab: FitLabPanel | null = null;
  let perception: Perception | null = null;
  try {
    const createPerception = await loadOptional(perceptionModules, (m) => m.createPerception);
    if (createPerception) {
      perception = createPerception();
      await perception.start(camera);
      shell.log('perception started (ZB)');
    } else shell.log('perception not available yet (ZB)', 'warn');
  } catch (err) {
    shell.log(`perception failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    perception = null;
  }
  try {
    const createFitLabPanel = await loadOptional(fitlabModules, (m) => m.createFitLabPanel);
    if (createFitLabPanel && perception) {
      const panel = createFitLabPanel();
      fitlab = panel;
      shell.fitHost.replaceChildren();
      // Not awaited: building the body can take tens of seconds (body service), and the bridge
      // and the Decart view must not wait for it. verdict() returns null until it is ready.
      panel
        .mount(shell.fitHost, { bus, perception })
        .then(() => shell.log('Fit Lab mounted (FL)'))
        .catch((err: unknown) => {
          shell.log(`Fit Lab failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
          if (fitlab === panel) fitlab = null;
        });
    } else shell.log('Fit Lab not available yet (FL)', 'warn');
  } catch (err) {
    shell.log(`Fit Lab failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    fitlab = null;
  }
  try {
    const startBridge = await loadOptional(bridgeModules, (m) => m.startBridge);
    if (startBridge && perception) {
      startBridge({ bus, perception, camera, overlayHost: shell.overlayHost, fitLab: fitlab });
      shell.log('pinch bridge started (ZB)');
    }
  } catch (err) {
    shell.log(`bridge failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }

  // ---- Decart ----
  const fitLabel = (): FitLabel | null => {
    const v = fitlab?.verdict();
    const s = bus.get();
    if (!v || v.jacket !== s.jacket) return null;
    return v.sizes[s.size]?.label ?? null;
  };
  const view = new DecartView({
    bus,
    camera,
    fitLabel,
    onBudget,
    log: (m, level) => shell.log(m, level),
    onSwap: (r) =>
      shell.setNote(
        `last swap ${r.label}: set() ${r.ackMs ?? '?'} ms → visible ${r.visibleMs ?? '—'} ms`,
      ),
    onStatus: (s: DecartViewStatus) => {
      if (s.kind === 'live') {
        shell.showBig(view.output, 'Decart live (photoreal render; fit from our engine)', true);
        const shown = s.shown ? `${s.shown.file}${s.shown.exact ? '' : ' (nearest)'}` : '…';
        shell.setDecart(`${s.connection} · ${shown}`, true, s.remainingS);
      } else {
        shell.showBig(camera.video, fallbackCaption, true);
        if (s.kind === 'connecting') shell.setDecart('connecting… (click to cancel)', true, null);
        else if (s.kind === 'unavailable') shell.setDecart(`unavailable: ${s.reason}`, false, null);
        else shell.setDecart('ready', false, null);
      }
    },
  });
  shell.setRecordSource(() =>
    view.isLive ? (view.output.srcObject as MediaStream | null) : camera.stream,
  );
  // Review H4: a click while starting cancels; clicks closer than 800 ms apart are ignored, so a
  // double-click cannot start and immediately cancel (or start twice).
  let lastToggle = 0;
  shell.onDecartToggle(() => {
    const now = performance.now();
    if (now - lastToggle < 800) return;
    lastToggle = now;
    if (view.isLive || view.isStarting) void view.stop('stopped by user');
    else void view.start();
  });
  await view.init();
}

// CSP visibility (review M1 narrowed the policy): every blocked load is logged, so a missing host
// shows up in the Studio log instead of failing silently. zod's one eval probe is expected.
document.addEventListener('securitypolicyviolation', (e) => {
  if (e.blockedURI === 'eval') return;
  const msg = `CSP blocked ${e.violatedDirective}: ${e.blockedURI}`;
  console.warn(msg);
  shell.log(msg, 'error');
});

void boot();
