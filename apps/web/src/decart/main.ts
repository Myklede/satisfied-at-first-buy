// Decart Lucy V-TON trial page (apps/web/decart.html). Separate from the main app.
// Rule (docs/USER-RULES.md 2026-11-15 00:18): free credits only; the input video goes to Decart
// only from this page; every session auto-stops (75 s) and the token server enforces a daily cap.
// No recording: frames stay in memory (the swap-latency probe reads 64x36 pixels, never stored).
//
// SDK usage follows https://docs.platform.decart.ai/models/realtime/virtual-try-on and the MIT
// sample https://github.com/DecartAI/tryon-examples (ecommerce): createDecartClient +
// models.realtime('lucy-vton-latest') + realtime.connect(stream, { model, onRemoteStream,
// initialState }) + set({ prompt, image, enhance }) + disconnect().
import { createDecartClient, models, type RealTimeClient } from '@decartai/sdk';
import { SessionClock, SESSION_LIMIT_S, formatCountdown, usdFor } from './session-timer';
import { ChangeDetector, meanAbsLumaDiff } from './change-detect';
import { PROMPT_PRESETS, pickDefaultCamera, variantName, type ZipState } from './choices';

const TOKEN_SERVER = 'http://127.0.0.1:5830';
const REF_URL = '/local-textures/decart/';
const MODEL = models.realtime('lucy-vton-latest');
const SWAP_TIMEOUT_MS = 10_000;
const PROBE_W = 64;
const PROBE_H = 36;

interface Status {
  keyPresent: boolean;
  day: string;
  usedS: number;
  reservedS: number;
  totalS: number;
  maxTotalS: number;
  usd: number;
  allTimeUsd: number;
  maxUsd: number;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};
const ui = {
  budget: $<HTMLSpanElement>('budget'),
  credits: $<HTMLSpanElement>('credits'),
  camera: $<HTMLSelectElement>('camera'),
  allowCamera: $<HTMLButtonElement>('allow-camera'),
  mirror: $<HTMLInputElement>('mirror'),
  ref: $<HTMLSelectElement>('ref'),
  refFile: $<HTMLInputElement>('ref-file'),
  refPreview: $<HTMLImageElement>('ref-preview'),
  swapResult: $<HTMLDivElement>('swap-result'),
  prompt: $<HTMLTextAreaElement>('prompt'),
  presetReplace: $<HTMLButtonElement>('preset-replace'),
  presetPolish: $<HTMLButtonElement>('preset-polish'),
  applyPrompt: $<HTMLButtonElement>('apply-prompt'),
  start: $<HTMLButtonElement>('start'),
  countdown: $<HTMLDivElement>('countdown'),
  state: $<HTMLDivElement>('state'),
  videos: $<HTMLDivElement>('videos'),
  inputVideo: $<HTMLVideoElement>('input-video'),
  outputVideo: $<HTMLVideoElement>('output-video'),
  log: $<HTMLDivElement>('log'),
};

function log(message: string, cls = ''): void {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `${new Date().toTimeString().slice(0, 8)} ${message}`;
  ui.log.append(line);
  ui.log.scrollTop = ui.log.scrollHeight;
}

// ---------- token server ----------
async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${TOKEN_SERVER}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `${path}: HTTP ${res.status}`);
  return json as T;
}

function showStatus(s: Status): void {
  const key = s.keyPresent ? '' : ' | NO KEY: put DECART_API_KEY=... in .env';
  ui.budget.textContent =
    `Today ${s.day}: ${s.totalS} s of ${s.maxTotalS} s counted (${s.usedS} s reported + ` +
    `${s.reservedS} s reserved), ~$${s.usd.toFixed(2)} | all time ~$${s.allTimeUsd.toFixed(2)} ` +
    `of the $${s.maxUsd} cap${key}`;
  ui.budget.className = s.keyPresent ? '' : 'err';
}

async function refreshStatus(): Promise<void> {
  try {
    const s = await api<Status>('/status');
    showStatus(s);
    if (s.keyPresent) await refreshCredits();
  } catch {
    ui.budget.textContent =
      'Token server not reachable on 127.0.0.1:5830: run  node scripts/decart-token-server.mjs';
    ui.budget.className = 'err';
  }
}

/** Decart's own remaining balance (the token server asks GET /v1/credits with the secret key). */
async function refreshCredits(): Promise<void> {
  try {
    const c = await api<{ credits: number | null; usd: number | null }>('/credits');
    ui.credits.textContent =
      c.credits === null
        ? 'Decart balance: ?'
        : `Decart balance: ${c.credits} credits (~$${c.usd})`;
  } catch (err) {
    ui.credits.textContent = `Decart balance: ${errText(err)}`;
  }
}

// ---------- camera list ----------
async function listCameras(): Promise<void> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `camera ${i + 1} (name hidden)` }));
  const keep = ui.camera.value;
  ui.camera.replaceChildren(
    ...cams.map((c) => {
      const o = document.createElement('option');
      o.value = c.deviceId;
      o.textContent = c.label;
      return o;
    }),
  );
  const named = cams.some((c) => !c.label.includes('(name hidden)'));
  ui.allowCamera.hidden = named;
  ui.camera.value =
    keep && cams.some((c) => c.deviceId === keep) ? keep : (pickDefaultCamera(cams) ?? '');
}

ui.allowCamera.addEventListener('click', async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    s.getTracks().forEach((t) => t.stop());
    await listCameras();
  } catch (err) {
    log(`camera permission: ${errText(err)}`, 'err');
  }
});

// ---------- reference images ----------
let refFiles: string[] = [];
const uploads = new Map<string, File>();

async function loadRefList(): Promise<void> {
  try {
    refFiles = (await api<{ files: string[] }>('/refs')).files;
  } catch {
    refFiles = [];
  }
  const options = [...refFiles, ...[...uploads.keys()]].map((name) => {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = uploads.has(name) ? `${name} (file)` : name;
    return o;
  });
  const keep = ui.ref.value;
  ui.ref.replaceChildren(...options);
  if (keep && [...ui.ref.options].some((o) => o.value === keep)) ui.ref.value = keep;
  else ui.ref.value = refFiles.find((f) => /parka-closed/i.test(f)) ?? refFiles[0] ?? '';
  if (refFiles.length === 0 && uploads.size === 0)
    log(
      'No reference images in apps/web/public/local-textures/decart/ yet; use the file picker.',
      'warn',
    );
  updateRefPreview();
}

let previewUrl: string | null = null;
function updateRefPreview(): void {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  const name = ui.ref.value;
  const file = uploads.get(name);
  if (file) {
    previewUrl = URL.createObjectURL(file);
    ui.refPreview.src = previewUrl;
  } else if (name) ui.refPreview.src = REF_URL + encodeURIComponent(name);
  else ui.refPreview.removeAttribute('src');
  const zipButtons = document.querySelectorAll<HTMLButtonElement>('button.zip');
  zipButtons.forEach((b) => {
    const target = variantName(refFiles, name, b.dataset.zip as ZipState);
    b.disabled = target === null;
    b.title = target ?? 'no <jacket>-<state> image for the selected jacket';
  });
}

/** The selected reference as a JPEG/PNG blob, longest side <= 1024 (sample repo does the same). */
async function refBlob(name: string): Promise<Blob> {
  const src = uploads.get(name) ?? (await (await fetch(REF_URL + encodeURIComponent(name))).blob());
  const bmp = await createImageBitmap(src);
  const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  if (scale === 1 && /^image\/(jpeg|png|webp)$/.test(src.type)) {
    bmp.close();
    return src;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', 0.9),
  );
}

ui.ref.addEventListener('change', () => {
  updateRefPreview();
  if (live) void applyState(`garment -> ${ui.ref.value}`);
});
ui.refFile.addEventListener('change', () => {
  const f = ui.refFile.files?.[0];
  if (!f) return;
  const key = `upload-${f.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60)}`;
  uploads.set(key, f);
  void loadRefList().then(() => {
    ui.ref.value = key;
    updateRefPreview();
    if (live) void applyState(`garment -> ${key}`);
  });
});

// ---------- prompt ----------
ui.prompt.value = PROMPT_PRESETS.replace;
ui.presetReplace.addEventListener('click', () => (ui.prompt.value = PROMPT_PRESETS.replace));
ui.presetPolish.addEventListener('click', () => (ui.prompt.value = PROMPT_PRESETS.polish));
ui.mirror.addEventListener('change', () => ui.videos.classList.toggle('mirror', ui.mirror.checked));

// ---------- session ----------
interface Live {
  sessionId: string;
  clock: SessionClock;
  input: MediaStream;
  rt: RealTimeClient | null;
  ticker: number;
  stopped: boolean;
}
let live: Live | null = null;

function selectedSource(): 'camera' | 'tab' {
  const el = document.querySelector<HTMLInputElement>('input[name="source"]:checked');
  return el?.value === 'tab' ? 'tab' : 'camera';
}

async function openInput(): Promise<MediaStream> {
  const fps = MODEL.fps;
  if (selectedSource() === 'tab') {
    log('Pick the RC5 tab (http://127.0.0.1:5810/?rc5) in the share dialog.');
    return navigator.mediaDevices.getDisplayMedia({
      video: { width: MODEL.width, height: MODEL.height, frameRate: fps },
      audio: false,
    });
  }
  const deviceId = ui.camera.value;
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      width: { ideal: MODEL.width },
      height: { ideal: MODEL.height },
      frameRate: fps,
    },
  });
}

function setUi(state: string): void {
  ui.state.textContent = state;
  const running = live !== null && !live.stopped;
  ui.start.textContent = running ? 'STOP' : `Start (${SESSION_LIMIT_S} s)`;
  ui.start.classList.toggle('live', running);
}

/** Review H4: a start in progress. Stop / tab hide / unload cancel it; it is re-checked after
 *  every await, so a cancelled start never opens a session, asks for a token or connects. */
let starting: { cancelled: boolean } | null = null;

async function start(): Promise<void> {
  if (live || starting) return;
  const attempt = { cancelled: false };
  starting = attempt;
  const check = () => {
    if (attempt.cancelled || document.visibilityState !== 'visible')
      throw new Error('start cancelled');
  };
  ui.start.disabled = true;
  let input: MediaStream | null = null;
  try {
    setUi('opening input…');
    input = await openInput();
    check();
    const [track] = input.getVideoTracks();
    const st = track?.getSettings();
    log(
      `input: ${track?.label ?? '?'} ${st?.width ?? '?'}x${st?.height ?? '?'} @ ${st?.frameRate ?? '?'} fps`,
    );
    ui.inputVideo.srcObject = input;
    const refName = ui.ref.value;
    if (!refName) throw new Error('choose a garment reference image first');
    const image = await refBlob(refName);
    check();

    setUi('asking the token server…');
    const session = await api<Status & { sessionId: string }>('/session', { page: 'trial' });
    showStatus(session);
    if (attempt.cancelled || document.visibilityState !== 'visible') {
      // No token was minted for it: this report releases the reservation on the server.
      void api('/usage', { sessionId: session.sessionId, seconds: 0 }).catch(() => {});
      throw new Error('start cancelled');
    }
    const clock = new SessionClock(SESSION_LIMIT_S);
    clock.start();
    const current: Live = {
      sessionId: session.sessionId,
      clock,
      input,
      rt: null,
      ticker: 0,
      stopped: false,
    };
    live = current;
    current.ticker = window.setInterval(tick, 200);
    ui.start.disabled = false;
    setUi('connecting…');
    track?.addEventListener('ended', () => void stop('input track ended (share stopped?)'));

    // SDK warnings and errors go to the on-page log too (the first trial failed with no detail).
    const sdkLog = (level: string) => (message: string, data?: Record<string, unknown>) =>
      log(`sdk ${level}: ${message} ${data ? JSON.stringify(data).slice(0, 200) : ''}`, 'err');
    const client = createDecartClient({
      telemetry: false,
      // Info/debug are logged too: the 2026-11-15 01:22 trial connected but no media ever flowed
      // (bytesSent 0, no generation_started) and the quiet logger hid why.
      logger: {
        debug: (m, d) => log(`sdk debug: ${m} ${d ? JSON.stringify(d).slice(0, 200) : ''}`),
        info: (m, d) => log(`sdk info: ${m} ${d ? JSON.stringify(d).slice(0, 200) : ''}`),
        warn: sdkLog('warn'),
        error: sdkLog('error'),
      },
      // No token once the session was stopped (the server also allows exactly one per session).
      apiKeyProvider: async () => {
        if (current.stopped) throw new Error('session stopped');
        return (await api<{ apiKey: string }>('/token', { sessionId: current.sessionId })).apiKey;
      },
    });
    const rt = await client.realtime.connect(input, {
      model: MODEL,
      mirror: false,
      onRemoteStream: (stream) => {
        ui.outputVideo.srcObject = stream;
        startProbe();
      },
      initialState: { prompt: { text: ui.prompt.value, enhance: false }, image },
    });
    if (current.stopped) {
      rt.disconnect();
      return;
    }
    current.rt = rt;
    log(`connected: session ${rt.sessionId ?? '?'}; garment ${refName}`, 'ok');
    rt.on('connectionChange', (s) => {
      setUi(s);
      if (s === 'disconnected') void stop('disconnected');
    });
    rt.on('error', (e) => void stop(`error: ${e.message}`));
    rt.on('sessionEnded', (e) => void stop(`server ended the session: ${String(e.reason)}`));
    rt.on('generationEnded', (e) => log(`generation ended: ${e.seconds} s, ${e.reason}`));
    // Lead diagnosis (first live trial ended "0 s, error" with no detail): log the queue and
    // the first generation tick, plus the SDK's diagnostics, so the next failure says why.
    rt.on('queuePosition', (q) => log(`queue: ${JSON.stringify(q)}`));
    let ticked = false;
    rt.on('generationTick', (t) => {
      if (!ticked) log(`generation started (tick ${t.seconds} s)`, 'ok');
      ticked = true;
    });
    rt.on('diagnostic', (d) => log(`diag: ${JSON.stringify(d).slice(0, 600)}`));
    let lastStatsLog = 0;
    rt.on('stats', (st) => {
      const now = performance.now();
      if (now - lastStatsLog < 8000) return;
      lastStatsLog = now;
      log(`stats: ${JSON.stringify(st).slice(0, 500)}`);
    });
    setUi(rt.getConnectionState());
  } catch (err) {
    log(`start failed: ${errText(err)}`, 'err');
    if (live) await stop('start failed');
    else {
      input?.getTracks().forEach((t) => t.stop());
      ui.inputVideo.srcObject = null;
      setUi('idle');
    }
  } finally {
    if (starting === attempt) starting = null;
    ui.start.disabled = false;
  }
}

function tick(): void {
  if (!live) return;
  ui.countdown.textContent = formatCountdown(live.clock.remainingS());
  if (live.clock.expired()) void stop(`auto-stop at ${SESSION_LIMIT_S} s`);
}

/** Idempotent: disconnect, stop the tracks, report the seconds (beacon when the page is going). */
async function stop(reason: string, unloading = false): Promise<void> {
  if (starting) starting.cancelled = true;
  const current = live;
  if (!current || current.stopped) return;
  current.stopped = true;
  window.clearInterval(current.ticker);
  try {
    current.rt?.disconnect();
  } catch {
    /* already closed */
  }
  current.input.getTracks().forEach((t) => t.stop());
  stopProbe();
  ui.inputVideo.srcObject = null;
  ui.outputVideo.srcObject = null;
  const seconds = current.clock.stop() ?? current.clock.elapsedS();
  live = null;
  ui.countdown.textContent = formatCountdown(SESSION_LIMIT_S);
  setUi('idle');
  const body = JSON.stringify({
    sessionId: current.sessionId,
    seconds: Math.round(seconds * 10) / 10,
  });
  if (unloading) {
    // text/plain keeps the beacon a simple request; the server accepts it for /usage only.
    navigator.sendBeacon(`${TOKEN_SERVER}/usage`, new Blob([body], { type: 'text/plain' }));
    return;
  }
  log(`stopped (${reason}): ${seconds.toFixed(1)} s streamed, ~$${usdFor(seconds).toFixed(2)}`);
  try {
    const res = await fetch(`${TOKEN_SERVER}/usage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showStatus((await res.json()) as Status);
    await refreshCredits();
  } catch (err) {
    log(`usage report failed (${errText(err)}); the server keeps the full 75 s reserved`, 'err');
  }
}

ui.start.addEventListener('click', () => {
  if (live && !live.stopped) void stop('stopped by user');
  else void start();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void stop('tab hidden', false);
});
window.addEventListener('pagehide', () => void stop('page unload', true));
window.addEventListener('beforeunload', () => void stop('page unload', true));

// ---------- set() + swap latency ----------
const probeCanvas = document.createElement('canvas');
probeCanvas.width = PROBE_W;
probeCanvas.height = PROBE_H;
const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true });
let probeRunning = false;
let lastFrame: Uint8ClampedArray | null = null;
const noise: number[] = [];
let pendingSwap: {
  t0: number;
  baseline: Uint8ClampedArray;
  detector: ChangeDetector;
  ackMs: number | null;
  label: string;
} | null = null;

function grab(): Uint8ClampedArray | null {
  const v = ui.outputVideo;
  if (!probeCtx || v.readyState < 2) return null;
  probeCtx.drawImage(v, 0, 0, PROBE_W, PROBE_H);
  return probeCtx.getImageData(0, 0, PROBE_W, PROBE_H).data;
}

function onFrame(): void {
  if (!probeRunning) return;
  const now = performance.now();
  const frame = grab();
  if (frame) {
    if (lastFrame && !pendingSwap) {
      noise.push(meanAbsLumaDiff(frame, lastFrame));
      if (noise.length > 30) noise.shift();
    }
    if (pendingSwap) {
      const at = pendingSwap.detector.feed(now, meanAbsLumaDiff(frame, pendingSwap.baseline));
      if (at !== null) finishSwap(`visible change ${Math.round(at - pendingSwap.t0)} ms`);
      else if (now - pendingSwap.t0 > SWAP_TIMEOUT_MS) finishSwap('no visible change within 10 s');
    }
    lastFrame = frame;
  }
  scheduleFrame();
}

function scheduleFrame(): void {
  const v = ui.outputVideo as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number;
  };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(onFrame);
  else requestAnimationFrame(onFrame);
}

function startProbe(): void {
  if (probeRunning) return;
  probeRunning = true;
  lastFrame = null;
  noise.length = 0;
  scheduleFrame();
}
function stopProbe(): void {
  probeRunning = false;
  lastFrame = null;
  pendingSwap = null;
}

function finishSwap(result: string): void {
  if (!pendingSwap) return;
  const ack =
    pendingSwap.ackMs === null ? 'set() pending' : `set() resolved ${pendingSwap.ackMs} ms`;
  const text = `Swap ${pendingSwap.label}: ${ack}; ${result} (threshold ${pendingSwap.detector.threshold.toFixed(1)})`;
  ui.swapResult.textContent = text;
  log(text, 'ok');
  pendingSwap = null;
}

/** set() replaces the whole state, so prompt + image are always sent together. */
async function applyState(label: string): Promise<void> {
  const current = live;
  if (!current?.rt) {
    log('not live: Start first', 'warn');
    return;
  }
  try {
    const image = await refBlob(ui.ref.value);
    const baseline = lastFrame;
    const t0 = performance.now();
    if (baseline) {
      pendingSwap = { t0, baseline, detector: new ChangeDetector(noise), ackMs: null, label };
      ui.swapResult.textContent = `Swap ${label}: waiting…`;
    }
    await current.rt.set({ prompt: ui.prompt.value, image, enhance: false });
    const ackMs = Math.round(performance.now() - t0);
    if (pendingSwap && pendingSwap.t0 === t0) pendingSwap.ackMs = ackMs;
    log(`set(${label}) resolved in ${ackMs} ms`);
  } catch (err) {
    log(`set failed: ${errText(err)}`, 'err');
  }
}

document.querySelectorAll<HTMLButtonElement>('button.zip').forEach((b) =>
  b.addEventListener('click', () => {
    const target = variantName(refFiles, ui.ref.value, b.dataset.zip as ZipState);
    if (!target) return;
    ui.ref.value = target;
    updateRefPreview();
    void applyState(`zip ${b.dataset.zip ?? ''} (${target})`);
  }),
);
ui.applyPrompt.addEventListener('click', () => void applyState('prompt'));

// ---------- CSP visibility ----------
document.addEventListener('securitypolicyviolation', (e) => {
  // zod 4 probes `new Function('')` once to pick its fast path; blocking it is intended (no eval).
  if (e.blockedURI === 'eval') return;
  log(
    `CSP blocked ${e.violatedDirective}: ${e.blockedURI} (add the host to decart.html if it is Decart's)`,
    'err',
  );
});

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------- boot (no camera, no network to Decart until Start) ----------
void refreshStatus();
void loadRefList();
void listCameras();
setUi('idle');

// Lead diagnosis: one-click network preflight (no generation, no credits).
{
  const btn = document.createElement('button');
  btn.textContent = 'Check network (Decart preflight)';
  btn.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9;padding:8px 12px';
  btn.onclick = async () => {
    btn.disabled = true;
    log('network check: running…');
    try {
      const report = await createDecartClient({
        telemetry: false,
        apiKey: 'preflight',
      }).realtime.checkConnectivity({ model: MODEL });
      log(`network check: ${JSON.stringify(report).slice(0, 600)}`, 'ok');
    } catch (err) {
      log(`network check failed: ${errText(err)}`, 'err');
    } finally {
      btn.disabled = false;
    }
  };
  document.body.appendChild(btn);
}
