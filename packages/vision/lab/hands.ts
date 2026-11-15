// Vision Lab: hand pinch tracking bench. Served at http://127.0.0.1:5711/hands.html by
// `npm run dev -w packages/vision`. Query params: ?autostart=1&delegate=GPU|CPU&fps=60|30 (used
// by scripts/smoke-hands.mjs). Frames are drawn to on-screen canvases only and never persisted.
// "Record landmarks" saves NUMBERS only (landmarks, labels, timestamps), and only on click.

import { HandLandmarker } from '@mediapipe/tasks-vision';
import { listCameras, openCamera } from '../src/camera';
import {
  HAND_RECORDING_FORMAT,
  HAND_RECORDING_VERSION,
  POSE_TAGS,
  serializeHandRecording,
} from '../src/handRecording';
import type { HandRecording, PoseTag, RecordedHandFrame } from '../src/handRecording';
import { SWAP_MEDIAPIPE_HANDEDNESS, createHandTracker } from '../src/hands';
import { RING_COLOUR, drawGrabRing, ringCaption } from './grabRing';
import type { HandTrackerDetailedStats, TunableHandTracker } from '../src/hands';
import { DEFAULT_PINCH_TUNING, validatePinchTuning } from '../src/pinch';
import type { PinchTuning, TrackedHandFrame } from '../src/pinch';
import type { CameraHandle, CameraInfo, Handedness, NdcPoint, PinchEvent } from '../src/types';

interface LabStatus {
  state: 'idle' | 'starting' | 'running' | 'error';
  error?: string;
  frames: number;
  /** Frames with at least one hand (on the fake camera any of these is a false hand). */
  framesWithHands: number;
  maxHandsSeen: number;
  extrapolatedFrames: number;
  pinchEvents: number;
  /** Frame rate requested from the camera. */
  requestedFps?: number;
  stats?: HandTrackerDetailedStats;
  camera?: CameraInfo;
}

declare global {
  interface Window {
    __handsLab?: LabStatus;
  }
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

const cameraSelect = $<HTMLSelectElement>('camera');
const rotateSelect = $<HTMLSelectElement>('rotate');
const delegateSelect = $<HTMLSelectElement>('delegate');
const mirroredBox = $<HTMLInputElement>('mirrored');
const fpsSelect = $<HTMLSelectElement>('fps');
const recNote = $<HTMLInputElement>('rec-note');
const recPinches = $<HTMLInputElement>('rec-pinches');
const recHand = $<HTMLSelectElement>('rec-hand');
const recStart = $<HTMLButtonElement>('rec-start');
const recStop = $<HTMLButtonElement>('rec-stop');
const recStatus = $<HTMLSpanElement>('rec-status');
const recPose = $<HTMLSelectElement>('rec-pose');
const labelIndicator = $<HTMLSpanElement>('label-indicator');
const meter = $<HTMLCanvasElement>('meter');
const meterCtx = meter.getContext('2d');
for (const pose of POSE_TAGS) {
  const o = document.createElement('option');
  o.value = pose;
  o.textContent = pose;
  recPose.append(o);
}
const startButton = $<HTMLButtonElement>('start');
const stopButton = $<HTMLButtonElement>('stop');
const statusEl = $<HTMLSpanElement>('status');
const statsEl = $<HTMLPreElement>('stats');
const preview = $<HTMLCanvasElement>('preview');
const trail = $<HTMLCanvasElement>('trail');
const previewCtx = preview.getContext('2d');
const trailCtx = trail.getContext('2d');
if (!previewCtx || !trailCtx) throw new Error('2D canvas unavailable.');

const status: LabStatus = {
  state: 'idle',
  frames: 0,
  framesWithHands: 0,
  maxHandsSeen: 0,
  extrapolatedFrames: 0,
  pinchEvents: 0,
};
window.__handsLab = status;

let camera: CameraHandle | undefined;
let tracker: TunableHandTracker | undefined;
let lastFrame: TrackedHandFrame | undefined;
const lastEvent = new Map<Handedness, PinchEvent>();
let tuning: PinchTuning = { ...DEFAULT_PINCH_TUNING };

/** Trail samples kept for this long (ms). */
const TRAIL_MS = 1500;
interface TrailSample {
  t: number;
  hand: Handedness;
  raw: NdcPoint;
  filtered: NdcPoint;
  pinching: boolean;
}
const trailSamples: TrailSample[] = [];
const HAND_COLOUR: Record<Handedness, string> = { left: '#4cc3ff', right: '#ffb347' };

function setStatus(state: LabStatus['state'], text: string): void {
  status.state = state;
  statusEl.textContent = text;
  statusEl.className = state === 'error' ? 'error' : '';
}

// ---------- Sliders ----------
interface SliderSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  get: (t: PinchTuning) => number;
  set: (v: number) => Partial<PinchTuning>;
}

const filterSliders: SliderSpec[] = [
  {
    label: 'minCutoff (Hz)',
    min: 0.05,
    max: 5,
    step: 0.05,
    get: (t) => t.pointFilter.minCutoff,
    set: (v) => {
      const pf = { ...tuning.pointFilter, minCutoff: v };
      return { pointFilter: pf, landmarkFilter: { ...tuning.landmarkFilter, minCutoff: v } };
    },
  },
  {
    label: 'beta',
    min: 0,
    max: 30,
    step: 0.1,
    get: (t) => t.pointFilter.beta,
    set: (v) => ({
      pointFilter: { ...tuning.pointFilter, beta: v },
      landmarkFilter: { ...tuning.landmarkFilter, beta: v },
    }),
  },
  {
    label: 'depth minCutoff (Hz)',
    min: 0.05,
    max: 3,
    step: 0.05,
    get: (t) => t.depthFilter.minCutoff,
    set: (v) => ({ depthFilter: { ...tuning.depthFilter, minCutoff: v } }),
  },
];

const pinchSliders: SliderSpec[] = [
  {
    label: 'enter ratio',
    min: 0.05,
    max: 0.6,
    step: 0.01,
    get: (t) => t.enterRatio,
    set: (v) => ({ enterRatio: v }),
  },
  {
    label: 'exit ratio',
    min: 0.1,
    max: 0.9,
    step: 0.01,
    get: (t) => t.exitRatio,
    set: (v) => ({ exitRatio: v }),
  },
  {
    label: 'enter frames',
    min: 1,
    max: 6,
    step: 1,
    get: (t) => t.enterFrames,
    set: (v) => ({ enterFrames: v }),
  },
  {
    label: 'release (ms)',
    min: 50,
    max: 600,
    step: 10,
    get: (t) => t.releaseMs,
    set: (v) => ({ releaseMs: v }),
  },
  {
    label: 'open ratio',
    min: 0.4,
    max: 1.2,
    step: 0.01,
    get: (t) => t.openRatio,
    set: (v) => ({ openRatio: v }),
  },
  {
    label: 'grace (ms)',
    min: 0,
    max: 1000,
    step: 10,
    get: (t) => t.graceMs,
    set: (v) => ({ graceMs: v }),
  },
  {
    label: 'fast exit +ratio',
    min: 0,
    max: 0.5,
    step: 0.01,
    get: (t) => t.fastExitRatioBonus,
    set: (v) => ({ fastExitRatioBonus: v }),
  },
  {
    label: 'fast release +ms',
    min: 0,
    max: 400,
    step: 10,
    get: (t) => t.fastReleaseExtraMs,
    set: (v) => ({ fastReleaseExtraMs: v }),
  },
  {
    label: 'lateral curl centre',
    min: 0.2,
    max: 0.8,
    step: 0.01,
    get: (t) => t.grabModel.lateralCurlCentre,
    set: (v) => ({ grabModel: { ...tuning.grabModel, lateralCurlCentre: v } }),
  },
  {
    label: 'index curl centre',
    min: 0.4,
    max: 1.2,
    step: 0.01,
    get: (t) => t.grabModel.indexCurlCentre,
    set: (v) => ({ grabModel: { ...tuning.grabModel, indexCurlCentre: v } }),
  },
  {
    label: 'thumb palm offset',
    min: 0,
    max: 0.8,
    step: 0.01,
    get: (t) => t.grabModel.thumbPalmOffset,
    set: (v) => ({ grabModel: { ...tuning.grabModel, thumbPalmOffset: v } }),
  },
  {
    label: 'start max speed (h/s)',
    min: 0.2,
    max: 5,
    step: 0.1,
    get: (t) => t.startMaxSpeed,
    set: (v) => ({ startMaxSpeed: v }),
  },
  {
    label: 'fist curl centre',
    min: 0.05,
    max: 0.8,
    step: 0.01,
    get: (t) => t.grabModel.fistCurlCentre,
    set: (v) => ({ grabModel: { ...tuning.grabModel, fistCurlCentre: v } }),
  },
  {
    label: 'curl gain',
    min: 0.3,
    max: 3,
    step: 0.05,
    get: (t) => t.grabModel.curlGain,
    set: (v) => ({ grabModel: { ...tuning.grabModel, curlGain: v } }),
  },
  {
    label: 'dwell for ambiguous (ms)',
    min: 0,
    max: 3000,
    step: 50,
    get: (t) => t.dwellMs,
    set: (v) => ({ dwellMs: v }),
  },
  {
    label: 'dwell max speed (h/s)',
    min: 0.1,
    max: 2,
    step: 0.05,
    get: (t) => t.dwellMaxSpeed,
    set: (v) => ({ dwellMaxSpeed: v }),
  },
  {
    label: 'clear contact gap',
    min: 0.05,
    max: 0.8,
    step: 0.01,
    get: (t) => t.grabModel.clearContactGap,
    set: (v) => ({ grabModel: { ...tuning.grabModel, clearContactGap: v } }),
  },
  {
    label: 'max hands grabbing',
    min: 1,
    max: 2,
    step: 1,
    get: (t) => t.maxConcurrentGrabs,
    set: (v) => ({ maxConcurrentGrabs: v === 2 ? 2 : 1 }),
  },
  {
    label: 'label switch hold (ms)',
    min: 0,
    max: 1500,
    step: 50,
    get: (t) => t.labelSwitchHoldMs,
    set: (v) => ({ labelSwitchHoldMs: v }),
  },
];

function applyTuning(partial: Partial<PinchTuning>): boolean {
  const next = { ...tuning, ...partial };
  try {
    validatePinchTuning(next);
    tracker?.setTuning(partial);
    tuning = next;
    return true;
  } catch (error) {
    statusEl.textContent = error instanceof Error ? error.message : String(error);
    return false;
  }
}

function mountSliders(container: HTMLElement, specs: SliderSpec[]): void {
  for (const spec of specs) {
    const row = document.createElement('label');
    row.className = 'slider';
    const name = document.createElement('span');
    name.textContent = spec.label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(spec.get(tuning));
    const value = document.createElement('span');
    value.textContent = input.value;
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (applyTuning(spec.set(v))) value.textContent = input.value;
      else input.value = String(spec.get(tuning));
    });
    row.append(name, input, value);
    container.append(row);
  }
}

mountSliders($('sliders-filter'), filterSliders);
mountSliders($('sliders-pinch'), pinchSliders);

mirroredBox.addEventListener('change', () => applyTuning({ mirrored: mirroredBox.checked }));

// ---------- Drawing ----------
function ndcToCanvas(p: NdcPoint, canvas: HTMLCanvasElement): [number, number] {
  return [((p.x + 1) / 2) * canvas.width, ((1 - p.y) / 2) * canvas.height];
}

function drawPreview(frame: TrackedHandFrame): void {
  if (!camera || !previewCtx) return;
  const ctx = previewCtx;
  ctx.save();
  if (tuning.mirrored) {
    ctx.translate(preview.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(camera.source, 0, 0, preview.width, preview.height);
  ctx.restore();
  for (const hand of frame.hands) {
    const colour = HAND_COLOUR[hand.hand];
    const pts = hand.landmarks.map((l) => ndcToCanvas(l, preview));
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const c of HandLandmarker.HAND_CONNECTIONS) {
      ctx.moveTo(pts[c.start][0], pts[c.start][1]);
      ctx.lineTo(pts[c.end][0], pts[c.end][1]);
    }
    ctx.stroke();
    ctx.fillStyle = colour;
    for (const [x, y] of pts) ctx.fillRect(x - 2, y - 2, 4, 4);
    const [px, py] = ndcToCanvas(hand.pinchNdc, preview);
    drawGrabRing(ctx, px, py, hand.grabProgress, hand.gripConfidence, hand.pinching);
    ctx.font = '14px system-ui';
    ctx.fillStyle = RING_COLOUR[hand.gripConfidence];
    ctx.fillText(
      `${hand.hand} ${ringCaption(hand.grabProgress, hand.gripConfidence, hand.pinching)} · ` +
        `${hand.grip} ${hand.openness.toFixed(2)}`,
      px + 20,
      py - 12,
    );
  }
}

function drawTrail(now: number): void {
  if (!trailCtx) return;
  const ctx = trailCtx;
  while (trailSamples.length && now - trailSamples[0].t > TRAIL_MS) trailSamples.shift();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, trail.width, trail.height);
  ctx.strokeStyle = '#222';
  ctx.beginPath();
  ctx.moveTo(trail.width / 2, 0);
  ctx.lineTo(trail.width / 2, trail.height);
  ctx.moveTo(0, trail.height / 2);
  ctx.lineTo(trail.width, trail.height / 2);
  ctx.stroke();
  for (const s of trailSamples) {
    const [rx, ry] = ndcToCanvas(s.raw, trail);
    ctx.fillStyle = '#666';
    ctx.fillRect(rx - 1, ry - 1, 2, 2);
    const [fx, fy] = ndcToCanvas(s.filtered, trail);
    ctx.fillStyle = HAND_COLOUR[s.hand];
    ctx.fillRect(fx - 1.5, fy - 1.5, 3, 3);
    if (s.pinching) {
      ctx.strokeStyle = '#3f3';
      ctx.strokeRect(fx - 4, fy - 4, 8, 8);
    }
  }
}

function onTrackedFrame(frame: TrackedHandFrame): void {
  lastFrame = frame;
  status.frames += 1;
  if (frame.hands.length > 0) status.framesWithHands += 1;
  if (frame.extrapolated.length > 0) status.extrapolatedFrames += 1;
  status.maxHandsSeen = Math.max(status.maxHandsSeen, frame.hands.length);
  for (const h of frame.hands)
    trailSamples.push({
      t: frame.frameTime,
      hand: h.hand,
      raw: h.rawPinchNdc,
      filtered: h.pinchNdc,
      pinching: h.pinching,
    });
  drawPreview(frame);
  drawTrail(frame.frameTime);
  drawMeter(frame);
}

const fmt = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : String(n));

function renderStats(): void {
  if (!tracker || !camera) return;
  const s = tracker.stats();
  const c = camera.info();
  status.stats = s;
  status.camera = c;
  const lines = [
    `delegate      ${s.delegate}${s.gpuFallbackReason ? ` (GPU failed: ${s.gpuFallbackReason})` : ''}`,
    `inference     ${fmt(s.inferenceHz)} Hz, ${fmt(s.inferenceMs)} ms/frame`,
    `latency       ${fmt(s.latencyMs)} ms (frame callback -> event)`,
    `frames        ${s.framesProcessed} processed, ${s.framesSkipped} skipped`,
    `camera        ${c.width}x${c.height} @ ${c.fps} fps (requested ${status.requestedFps})` +
      (c.portrait ? ' (rotated)' : ''),
    `hands seen    ${status.framesWithHands}/${status.frames} frames, max ${status.maxHandsSeen}; ` +
      `extrapolated ${status.extrapolatedFrames} frames`,
    `              ${c.label}`,
    '',
  ];
  const hands = lastFrame?.hands ?? [];
  if (!hands.length) lines.push('no hand');
  if (lastFrame?.extrapolated.length)
    lines.push(`extrapolating: ${lastFrame.extrapolated.join(', ')}`);
  for (const h of hands) {
    const e = lastEvent.get(h.hand);
    lines.push(
      `${h.hand.padEnd(5)} #${h.trackId} ${h.pinching ? 'GRABBING' : 'open    '} grip ` +
        `${h.grip.padEnd(7)} ${h.gripConfidence.padEnd(9)} progress ${fmt(h.grabProgress, 2)} ` +
        `openness ${fmt(h.openness, 2)} tip ${fmt(h.pinchRatio, 2)} ` +
        `conf ${fmt(h.confidence, 2)}`,
      `      raw label ${h.rawLabel} evidence ${fmt(h.labelEvidence, 2)} speed ${fmt(h.speed, 2)} h/s`,
      `      ndc (${fmt(h.pinchNdc.x, 3)}, ${fmt(h.pinchNdc.y, 3)}) dist~${fmt(h.distanceM, 2)} m`,
      e
        ? `      last event ${e.type} depthDelta ${fmt(e.depthDelta * 100, 1)} cm`
        : '      no event yet',
    );
  }
  if (s.lastError) lines.push('', `last error: ${s.lastError}`);
  statsEl.textContent = lines.join('\n');
}

// ---------- Lifecycle ----------
async function refreshCameras(): Promise<void> {
  const selected = cameraSelect.value;
  const cams = await listCameras();
  cameraSelect.replaceChildren(
    ...cams.map((c) => {
      const o = document.createElement('option');
      o.value = c.deviceId;
      o.textContent = c.label;
      return o;
    }),
  );
  if (selected && cams.some((c) => c.deviceId === selected)) cameraSelect.value = selected;
}

// ---------- Labelled mode: Space = "I am grabbing" ----------
let spaceHeld = false;
const labelledMode = () => recPose.value !== '';
function setSpace(held: boolean): void {
  spaceHeld = held;
  labelIndicator.textContent = held ? 'LABEL: GRABBING (Space)' : 'Space: not grabbing';
  labelIndicator.className = held ? 'on' : '';
}
const isTextField = (t: EventTarget | null) =>
  t instanceof HTMLInputElement && t.type !== 'range' && t.type !== 'checkbox';
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || isTextField(e.target)) return;
  e.preventDefault(); // no page scroll, no button activation
  if (!e.repeat) setSpace(true);
});
window.addEventListener('keyup', (e) => {
  if (e.code !== 'Space' || isTextField(e.target)) return;
  e.preventDefault();
  setSpace(false);
});
// A key released while the window is unfocused would otherwise leave the label stuck on.
window.addEventListener('blur', () => setSpace(false));

// ---------- Closed/open meter ----------
const METER_MAX = 1.0;
function drawMeter(frame: TrackedHandFrame): void {
  if (!meterCtx) return;
  const ctx = meterCtx;
  const W = meter.width;
  const H = meter.height;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, W, H);
  const want = recHand.value;
  const h = frame.hands.find((x) => x.hand === want) ?? frame.hands[0];
  const x = (v: number) => (Math.min(METER_MAX, Math.max(0, v)) / METER_MAX) * W;
  if (h) {
    ctx.fillStyle = h.pinching ? '#3f3' : '#888';
    ctx.fillRect(0, 8, x(h.openness), H - 22);
  }
  for (const [v, colour] of [
    [tuning.enterRatio, '#3f3'],
    [tuning.exitRatio, '#fc3'],
    [tuning.openRatio, '#f44'],
  ] as const) {
    ctx.fillStyle = colour;
    ctx.fillRect(x(v) - 1, 2, 2, H - 10);
  }
  ctx.fillStyle = '#ddd';
  ctx.font = '12px system-ui';
  ctx.fillText(
    h
      ? `${h.hand} ${h.pinching ? 'GRABBING' : 'open'} · grip ${h.grip} · openness ${h.openness.toFixed(2)}`
      : 'no hand',
    4,
    H - 2,
  );
}

// ---------- Landmark recorder (numbers only) ----------
let recording: RecordedHandFrame[] | undefined;
/** Hard cap so a forgotten recording cannot grow without bound (~5 min at 60 fps). */
const MAX_RECORDED_FRAMES = 18_000;

function onRawFrame(frame: RecordedHandFrame): void {
  if (!recording) return;
  if (recording.length >= MAX_RECORDED_FRAMES) {
    recStatus.textContent = `limit of ${MAX_RECORDED_FRAMES} frames reached; press Save`;
    return;
  }
  // A fresh object per frame; nothing else holds it. Labelled mode adds the Space state.
  recording.push(labelledMode() ? { ...frame, grab: spaceHeld } : frame);
  if (recording.length % 30 === 0) recStatus.textContent = `recording… ${recording.length} frames`;
}

recStart.addEventListener('click', () => {
  if (!tracker) {
    recStatus.textContent = 'start the camera first';
    return;
  }
  recording = [];
  recStart.disabled = true;
  recStop.disabled = false;
  // Space must reach the page, not a focused button or text field.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  recStatus.textContent =
    labelledMode() && !recHand.value
      ? 'recording (labelled) – set "Expected hand": labels refer to that hand'
      : labelledMode()
        ? 'recording (labelled): hold Space while grabbing'
        : 'recording…';
});

recStop.addEventListener('click', () => {
  const frames = recording ?? [];
  recording = undefined;
  recStart.disabled = false;
  recStop.disabled = true;
  if (!frames.length) {
    recStatus.textContent = 'nothing recorded';
    return;
  }
  const info = camera?.info();
  const pinches = recPinches.value.trim();
  const rec: HandRecording = {
    format: HAND_RECORDING_FORMAT,
    version: HAND_RECORDING_VERSION,
    createdAt: new Date().toISOString(),
    swapHandedness: SWAP_MEDIAPIPE_HANDEDNESS,
    source: {
      camera: info?.label ?? '',
      width: info?.width ?? 0,
      height: info?.height ?? 0,
      fps: info?.fps ?? 0,
      delegate: tracker?.stats().delegate ?? '',
    },
    tuning,
    meta: {
      note: recNote.value || undefined,
      expectedPinches: pinches === '' ? undefined : Number(pinches),
      expectedHand:
        recHand.value === 'left' || recHand.value === 'right' ? recHand.value : undefined,
      pose: labelledMode() ? (recPose.value as PoseTag) : undefined,
    },
    frames,
  };
  // User-initiated download of numbers only; never uploaded.
  const blob = new Blob([serializeHandRecording(rec)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hands-${rec.createdAt.replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  recStatus.textContent = `saved ${frames.length} frames`;
});

function teardown(): void {
  recording = undefined;
  recStart.disabled = false;
  recStop.disabled = true;
  tracker?.close();
  tracker = undefined;
  camera?.close();
  camera = undefined;
  lastFrame = undefined;
  lastEvent.clear();
  trailSamples.length = 0;
}

async function start(): Promise<void> {
  teardown();
  startButton.disabled = true;
  setStatus('starting', 'starting…');
  try {
    const rotate = Number(rotateSelect.value) as 0 | 90 | 270;
    // Ask for 60 fps (less blur and latency); getUserMedia treats it as "ideal", so a camera
    // that cannot do it delivers its best rate (typically 30). The real rate is in the stats.
    const frameRate = Number(fpsSelect.value);
    status.requestedFps = frameRate;
    camera = await openCamera({ deviceId: cameraSelect.value || undefined, rotate, frameRate });
    const info = camera.info();
    const scale = Math.min(1, 640 / info.width, 480 / info.height);
    preview.width = Math.round(info.width * scale);
    preview.height = Math.round(info.height * scale);
    tracker = await createHandTracker(camera, {
      delegate: delegateSelect.value === 'CPU' ? 'CPU' : 'GPU',
      mirrored: mirroredBox.checked,
      tuning,
    });
    tracker.onFrame(onTrackedFrame);
    tracker.onRawFrame(onRawFrame);
    tracker.onPinch((e) => {
      status.pinchEvents += 1;
      lastEvent.set(e.hand, e);
    });
    tracker.start();
    await refreshCameras();
    setStatus('running', `running (${tracker.stats().delegate})`);
    stopButton.disabled = false;
  } catch (error) {
    teardown();
    status.error = error instanceof Error ? error.message : String(error);
    setStatus('error', `error: ${status.error}`);
  } finally {
    startButton.disabled = false;
  }
}

startButton.addEventListener('click', () => void start());
stopButton.addEventListener('click', () => {
  teardown();
  stopButton.disabled = true;
  setStatus('idle', 'stopped');
});
setInterval(renderStats, 250);
window.addEventListener('beforeunload', teardown);

const params = new URLSearchParams(location.search);
const wantedDelegate = params.get('delegate');
if (wantedDelegate === 'CPU' || wantedDelegate === 'GPU') delegateSelect.value = wantedDelegate;
const wantedFps = params.get('fps');
if (wantedFps === '60' || wantedFps === '30') fpsSelect.value = wantedFps;
void refreshCameras().then(() => {
  if (params.get('autostart') === '1') void start();
});
