// Vision Lab · body scan. Live preview with mask/landmark/row overlays, guidance, results
// and a user-triggered calibration-pair download. Nothing is saved or sent automatically.
//
// Bench mode (used by scripts/smoke-scan.mjs): ?bench=1&model=heavy&seconds=8 opens the
// first camera, runs the scanner for N seconds, then publishes window.__scanBench.
import { CameraError, listCameras, openCamera } from '../src/camera';
import { PAIR_SCHEMA, SCAN_MEASUREMENT_NAMES, type CalibrationPair } from '../src/calibration';
import {
  createBodyScanner,
  type BodyScannerHandle,
  type Delegate,
  type PoseModel,
  type ScanFrameDebug,
  type ScanResultDetailed,
} from '../src/scan';
import {
  PROFILE_FRACTIONS,
  STATURE_BANDS,
  armPolyline,
  type ProfileRow,
  type VerticalExtent,
} from '../src/scanGeometry';
import type { CameraHandle, ScanGuidance, ScanIssue } from '../src/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const cameraSelect = $<HTMLSelectElement>('camera');
const rotateSelect = $<HTMLSelectElement>('rotate');
const openButton = $<HTMLButtonElement>('open');
const statusEl = $<HTMLSpanElement>('status');
const heightInput = $<HTMLInputElement>('height');
const sexSelect = $<HTMLSelectElement>('sex');
const modelSelect = $<HTMLSelectElement>('model');
const delegateSelect = $<HTMLSelectElement>('delegate');
const holdInput = $<HTMLInputElement>('hold');
const scanButton = $<HTMLButtonElement>('scan');
const stopButton = $<HTMLButtonElement>('stop');
const preview = $<HTMLCanvasElement>('preview');
const guidanceEl = $<HTMLDivElement>('guidance');
const progressEl = $<HTMLProgressElement>('progress');
const resultsBody = $<HTMLTableElement>('results').tBodies[0];
const warningsEl = $<HTMLPreElement>('warnings');
const personInput = $<HTMLInputElement>('person');
const pairButton = $<HTMLButtonElement>('pair');
const statsEl = $<HTMLPreElement>('stats');
const ctx = preview.getContext('2d')!;

const ISSUE_TEXT: Record<ScanIssue, string> = {
  no_person: 'Step into view',
  multiple_people: 'Only one person in the frame, please',
  not_full_body: 'Whole body must be visible, head to feet',
  too_close: 'Step back',
  too_far: 'Step closer',
  moving: 'Hold still',
  arms_not_apart: 'Face the camera, arms straight and ~30° away from the body',
  not_side_on: 'Turn 90° to show your side, arms relaxed down',
  low_light: 'More light, please',
  loose_clothing_suspected: 'Loose clothing: please wear fitted clothes',
};

let camera: CameraHandle | undefined;
let scanner: BodyScannerHandle | undefined;
let scannerKey = '';
let abort: AbortController | undefined;
let lastDebug: ScanFrameDebug | undefined;
let lastResult: ScanResultDetailed | undefined;
let unsubscribeFrame: (() => void) | undefined;
const maskCanvas = document.createElement('canvas');
const maskCtx = maskCanvas.getContext('2d')!;

function setStatus(text: string, error = false) {
  statusEl.textContent = text;
  statusEl.className = error ? 'error' : '';
}

async function refreshCameras() {
  const cams = await listCameras();
  cameraSelect.replaceChildren(
    ...cams.map((c) => {
      const o = document.createElement('option');
      o.value = c.deviceId;
      o.textContent = c.label;
      return o;
    }),
  );
}

async function openSelectedCamera(deviceId?: string) {
  stopScan();
  unsubscribeFrame?.();
  scanner?.close();
  scanner = undefined;
  camera?.close();
  camera = undefined;
  const rotate = Number(rotateSelect.value) as 0 | 90 | 270;
  try {
    camera = await openCamera({ deviceId: deviceId ?? (cameraSelect.value || undefined), rotate });
  } catch (error) {
    setStatus(
      error instanceof CameraError ? `${error.code}: ${error.message}` : String(error),
      true,
    );
    throw error;
  }
  await refreshCameras();
  const info = camera.info();
  cameraSelect.value = info.deviceId;
  preview.width = info.width;
  preview.height = info.height;
  setStatus(`camera ${info.width}×${info.height}`);
  scanButton.disabled = false;
  unsubscribeFrame = camera.onFrame(() => draw());
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function bandColour(f: number): string {
  if (f >= STATURE_BANDS.chest_cm.lo && f <= STATURE_BANDS.chest_cm.hi) return '#f55';
  if (f >= STATURE_BANDS.waist_cm.lo && f <= STATURE_BANDS.waist_cm.hi) return '#5d5';
  if (f >= STATURE_BANDS.hip_cm.lo && f <= STATURE_BANDS.hip_cm.hi) return '#59f';
  return '#888';
}

function draw() {
  if (!camera) return;
  const W = preview.width;
  const H = preview.height;
  ctx.drawImage(camera.source, 0, 0, W, H);
  const d = lastDebug;
  if (!d) return;
  if (d.mask) {
    const { width, height, inside } = d.mask;
    if (maskCanvas.width !== width || maskCanvas.height !== height) {
      maskCanvas.width = width;
      maskCanvas.height = height;
    }
    const img = maskCtx.createImageData(width, height);
    for (let i = 0; i < inside.length; i++) {
      if (!inside[i]) continue;
      img.data[i * 4] = d.accepted ? 40 : 255;
      img.data[i * 4 + 1] = d.accepted ? 220 : 160;
      img.data[i * 4 + 2] = 60;
      img.data[i * 4 + 3] = 80;
    }
    maskCtx.putImageData(img, 0, 0);
    ctx.drawImage(maskCanvas, 0, 0, W, H);
  }
  const mw = d.mask?.width ?? W;
  const mh = d.mask?.height ?? H;
  const sx = W / mw;
  const sy = H / mh;
  ctx.lineWidth = Math.max(1, W / 640);

  const measure = d.front ?? d.side;
  if (measure) {
    const e: VerticalExtent = measure.extent;
    ctx.strokeStyle = '#fff';
    for (const y of [e.crownY, e.floorY]) {
      ctx.beginPath();
      ctx.moveTo(0, y * sy);
      ctx.lineTo(W, y * sy);
      ctx.stroke();
    }
    measure.rows.forEach((row: ProfileRow | null, k: number) => {
      if (!row || k % 2) return;
      ctx.strokeStyle = bandColour(PROFILE_FRACTIONS[k]);
      ctx.beginPath();
      ctx.moveTo(row.left * sx, row.y * sy);
      ctx.lineTo(row.right * sx, row.y * sy);
      ctx.stroke();
    });
  }
  if (d.landmarks) {
    const lms = d.landmarks;
    if (d.front) {
      ctx.strokeStyle = '#0ff';
      for (const side of ['left', 'right'] as const) {
        const poly = armPolyline(lms, side);
        ctx.beginPath();
        poly.forEach((p, i) =>
          i ? ctx.lineTo(p.x * sx, p.y * sy) : ctx.moveTo(p.x * sx, p.y * sy),
        );
        ctx.stroke();
      }
    }
    ctx.fillStyle = '#f0f';
    for (const p of lms) {
      if (p.visibility < 0.5) continue;
      ctx.fillRect(p.x * sx - 2, p.y * sy - 2, 4, 4);
    }
  }
  if (d.front) {
    ctx.strokeStyle = '#ff0';
    for (const c of [d.front.acromion.left, d.front.acromion.right]) {
      if (!c) continue;
      const x = c.x * sx;
      const y = c.y * sy;
      ctx.beginPath();
      ctx.moveTo(x - 8, y);
      ctx.lineTo(x + 8, y);
      ctx.moveTo(x, y - 8);
      ctx.lineTo(x, y + 8);
      ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

function showGuidance(g: ScanGuidance) {
  const stageText = g.stage === 'front' ? 'FRONT' : g.stage === 'side' ? 'SIDE' : 'DONE';
  const text = g.ok
    ? g.stage === 'done'
      ? 'Scan complete'
      : 'Hold still…'
    : g.issues.length
      ? g.issues.map((i) => ISSUE_TEXT[i]).join(' · ')
      : g.stage === 'side'
        ? ISSUE_TEXT.not_side_on
        : 'Face the camera, arms ~30° out';
  guidanceEl.textContent = `${stageText}: ${text}`;
  guidanceEl.className = g.ok ? 'ok' : 'bad';
  progressEl.value = g.progress;
}

function fmt(x: number | undefined, d = 1): string {
  return x === undefined || !Number.isFinite(x) ? '–' : x.toFixed(d);
}

function showResult(r: ScanResultDetailed) {
  resultsBody.replaceChildren(
    ...SCAN_MEASUREMENT_NAMES.map((name) => {
      const raw = r.raw[name];
      const m = r.measurements[name];
      const tr = document.createElement('tr');
      const cells = [
        name,
        fmt(raw?.value_cm),
        fmt(raw?.spread_cm, 2),
        fmt(m?.value_cm),
        fmt(m?.sigma_cm),
        raw ? String(raw.frames) : '–',
      ];
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.append(td);
      }
      const method = document.createElement('td');
      method.className = 'method';
      method.textContent = m?.method ?? '';
      tr.append(method);
      return tr;
    }),
  );
  warningsEl.textContent =
    `frames front ${r.frames.front}, side ${r.frames.side}; calibration ${r.calibration}\n` +
    r.warnings.map((w) => `• ${w}`).join('\n');
}

async function ensureScanner(): Promise<BodyScannerHandle> {
  if (!camera) throw new Error('Open a camera first');
  const opts = {
    height_cm: Number(heightInput.value),
    sex: sexSelect.value as 'female' | 'male',
    holdSeconds: Number(holdInput.value),
    model: modelSelect.value as PoseModel,
    delegate: delegateSelect.value as Delegate,
  };
  const key = JSON.stringify(opts);
  if (scanner && key === scannerKey) return scanner;
  scanner?.close();
  setStatus(`loading pose_${opts.model}…`);
  scanner = await createBodyScanner(camera, opts);
  scannerKey = key;
  scanner.onGuidance(showGuidance);
  scanner.onDebug((d) => (lastDebug = d));
  setStatus(`ready: ${opts.model} on ${scanner.stats().delegate}`);
  return scanner;
}

async function startScan(): Promise<ScanResultDetailed | undefined> {
  const s = await ensureScanner();
  abort = new AbortController();
  scanButton.disabled = true;
  stopButton.disabled = false;
  pairButton.disabled = true;
  try {
    const r = await s.run(abort.signal);
    lastResult = r;
    showResult(r);
    pairButton.disabled = false;
    return r;
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError'))
      setStatus(error instanceof Error ? error.message : String(error), true);
    return undefined;
  } finally {
    scanButton.disabled = false;
    stopButton.disabled = true;
  }
}

function stopScan() {
  abort?.abort();
  abort = undefined;
}

function downloadPair() {
  const r = lastResult;
  if (!r || !camera) return;
  const personId = personInput.value.trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(personId)) {
    setStatus('Person id: 1–32 letters, digits, _ or - (anonymous, no names)', true);
    return;
  }
  const info = camera.info();
  const raw: CalibrationPair['raw'] = {};
  const spread: CalibrationPair['raw_spread'] = {};
  const tape: CalibrationPair['tape'] = {};
  for (const name of SCAN_MEASUREMENT_NAMES) {
    const m = r.raw[name];
    if (m) {
      raw[name] = Math.round(m.value_cm * 100) / 100;
      spread[name] = Math.round(m.spread_cm * 100) / 100;
    }
    tape[name] = null;
  }
  const pair: CalibrationPair = {
    schema: PAIR_SCHEMA,
    person_id: personId,
    captured_at: new Date().toISOString(),
    height_cm: r.height_cm,
    sex: r.sex,
    calibration_used: r.calibration,
    setup: {
      model: r.model,
      delegate: r.delegate,
      width: info.width,
      height: info.height,
      portrait: info.portrait,
      hold_seconds: Number(holdInput.value),
    },
    frames: r.frames,
    raw,
    raw_spread: spread,
    tape,
    notes: '',
  };
  const blob = new Blob([JSON.stringify(pair, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${personId}-${pair.captured_at.replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

setInterval(() => {
  const s = scanner?.stats();
  const info = camera?.info();
  const d = lastDebug;
  statsEl.textContent = [
    info ? `camera   ${info.label} ${info.width}×${info.height} @ ${info.fps} fps` : 'camera   –',
    s
      ? `model    pose_${s.model} on ${s.delegate}\n` +
        `infer    ${s.inferenceHz} Hz, ${s.inferMs.toFixed(1)} ms (incl. mask readback)\n` +
        `geometry ${s.analysisMs.toFixed(1)} ms; mask ${s.maskWidth}×${s.maskHeight}; frames ${s.framesProcessed}`
      : 'model    –',
    d
      ? `frame    fill ${fmt(d.fill, 2)}, shoulder sep ${fmt(d.shoulderSeparation, 3)}, ` +
        `abduction L ${fmt(d.abductionDeg?.left, 0)}° R ${fmt(d.abductionDeg?.right, 0)}°, ` +
        `luma ${fmt(d.luma, 2)}\n` +
        `         px/cm ${fmt((d.front ?? d.side)?.pxPerCm, 2)}, shoulder ${fmt(d.front?.shoulderWidthCm ?? undefined)} cm`
      : '',
  ].join('\n');
}, 500);

openButton.onclick = () => void openSelectedCamera().catch(() => undefined);
scanButton.onclick = () => void startScan();
stopButton.onclick = stopScan;
pairButton.onclick = downloadPair;
void refreshCameras();

// ---------------------------------------------------------------------------
// Bench mode for scripts/smoke-scan.mjs (fake camera, no person)
// ---------------------------------------------------------------------------
declare global {
  interface Window {
    __scanBench?: Record<string, unknown>;
  }
}

async function bench(params: URLSearchParams) {
  const seconds = Number(params.get('seconds') ?? 8);
  modelSelect.value = params.get('model') === 'full' ? 'full' : 'heavy';
  try {
    const cams = await listCameras();
    await openSelectedCamera(cams[0]?.deviceId);
    const t0 = performance.now();
    const s = await ensureScanner();
    const loadMs = performance.now() - t0;
    const issues: Record<string, number> = {};
    let guidance = 0;
    s.onGuidance((g) => {
      guidance++;
      for (const i of g.issues) issues[i] = (issues[i] ?? 0) + 1;
    });
    const framesBefore = s.stats().framesProcessed;
    const runStart = performance.now();
    setTimeout(stopScan, seconds * 1000);
    await startScan();
    const runSeconds = (performance.now() - runStart) / 1000;
    window.__scanBench = {
      ok: true,
      loadMs,
      runSeconds,
      meanInferenceHz: (s.stats().framesProcessed - framesBefore) / runSeconds,
      camera: camera?.info(),
      stats: s.stats(),
      guidance,
      issues,
    };
  } catch (error) {
    window.__scanBench = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const params = new URLSearchParams(location.search);
if (params.get('bench') === '1') void bench(params);
