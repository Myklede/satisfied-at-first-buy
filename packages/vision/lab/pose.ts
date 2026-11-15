// Vision Lab · webcam pose. Live preview with a landmark overlay, a DOF table (value + confidence
// bars), a stick figure redrawn FROM THE ESTIMATED ANGLES (front + side), the neutral calibration
// button, numbers-only pose recording and tracker stats. Nothing is saved or sent automatically.
//
// Bench mode (used by scripts/smoke-pose.mjs): ?bench=1&model=full&seconds=8 opens the first
// camera, runs the tracker for N seconds, then publishes window.__poseBench.
import { ANATOMICAL_DOFS, type AnatomicalDof, type PoseLandmark } from '../src/anatomicalPose';
import { CameraError, listCameras, openCamera } from '../src/camera';
import type { PoseTrackerFrame } from '../src/posePipeline';
import {
  POSE_MOTION_TAGS,
  POSE_RECORDING_FORMAT,
  POSE_RECORDING_VERSION,
  serializePoseRecording,
  type PoseMotionTag,
  type PoseRecording,
  type RecordedPoseFrame,
} from '../src/poseRecording';
import { DEFAULT_SEGMENTS, SKELETON_BONES, poseSkeleton, type JointName } from '../src/poseSynth';
import { createPoseTracker, type PoseTracker, type PoseTrackerModel } from '../src/poseTracker';
import type { CameraHandle } from '../src/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const cameraSelect = $<HTMLSelectElement>('camera');
const modelSelect = $<HTMLSelectElement>('model');
const delegateSelect = $<HTMLSelectElement>('delegate');
const startButton = $<HTMLButtonElement>('start');
const stopButton = $<HTMLButtonElement>('stop');
const statusEl = $<HTMLSpanElement>('status');
const calibrateButton = $<HTMLButtonElement>('calibrate');
const calibEl = $<HTMLSpanElement>('calib');
const motionSelect = $<HTMLSelectElement>('motion');
const noteInput = $<HTMLInputElement>('note');
const recordButton = $<HTMLButtonElement>('record');
const saveButton = $<HTMLButtonElement>('save');
const recStatus = $<HTMLSpanElement>('recStatus');
const preview = $<HTMLCanvasElement>('preview');
const avatar = $<HTMLCanvasElement>('avatar');
const tbody = document.querySelector<HTMLTableSectionElement>('#dofs tbody')!;
const statsEl = $<HTMLPreElement>('stats');
const pctx = preview.getContext('2d')!;
const actx = avatar.getContext('2d')!;

motionSelect.innerHTML = POSE_MOTION_TAGS.map((m) => `<option value="${m}">${m}</option>`).join('');

let camera: CameraHandle | undefined;
let tracker: PoseTracker | undefined;
let lastFrame: PoseTrackerFrame | undefined;
let raf = 0;
let tableTimer = 0;

function setStatus(text: string, error = false) {
  statusEl.textContent = text;
  statusEl.className = error ? 'error' : '';
}

async function refreshCameras() {
  const cams = await listCameras();
  cameraSelect.innerHTML = cams
    .map((c) => `<option value="${c.deviceId}">${c.label.replace(/</g, '&lt;')}</option>`)
    .join('');
}

// ---------- DOF table ----------
const rows = new Map<AnatomicalDof, HTMLTableRowElement>();
for (const d of ANATOMICAL_DOFS) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${d}</td><td class="v"></td><td class="r"></td><td><div class="bar"><i></i></div></td>`;
  tbody.append(tr);
  rows.set(d, tr);
}
function updateTable(f: PoseTrackerFrame) {
  for (const d of ANATOMICAL_DOFS) {
    const tr = rows.get(d)!;
    const digits = d === 'pelvis_drop_m' ? 3 : 0;
    const unit = d === 'pelvis_drop_m' ? ' m' : '°';
    const v = tr.querySelector<HTMLTableCellElement>('.v')!;
    v.textContent = f.pose[d].toFixed(digits) + unit;
    v.className = f.clamped.includes(d) ? 'v clamped' : 'v';
    tr.querySelector('.r')!.textContent = f.raw[d].toFixed(digits);
    const c = f.confidence[d];
    const bar = tr.querySelector<HTMLDivElement>('.bar')!;
    bar.className = c >= 0.6 ? 'bar' : c >= 0.3 ? 'bar mid' : 'bar low';
    bar.querySelector('i')!.style.width = `${(c * 100).toFixed(0)}%`;
    bar.title = c.toFixed(2);
  }
}

// ---------- Preview + landmark overlay ----------
const CONNECTIONS: Array<[number, number]> = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [24, 26],
  [26, 28],
  [27, 29],
  [29, 31],
  [28, 30],
  [30, 32],
  [0, 11],
  [0, 12],
];
function drawPreview() {
  raf = requestAnimationFrame(drawPreview);
  if (!camera) return;
  const src = camera.source;
  const w = src instanceof HTMLVideoElement ? src.videoWidth : src.width;
  const h = src instanceof HTMLVideoElement ? src.videoHeight : src.height;
  if (!w || !h) return;
  if (preview.width !== w || preview.height !== h) {
    preview.width = w;
    preview.height = h;
  }
  pctx.drawImage(src, 0, 0, w, h);
  const lms: readonly PoseLandmark[] | undefined = tracker?.lastImageLandmarks();
  if (!lms) return;
  pctx.lineWidth = Math.max(2, w / 320);
  for (const [a, b] of CONNECTIONS) {
    const va = Math.min(lms[a].visibility ?? 0, lms[b].visibility ?? 0);
    pctx.strokeStyle = va > 0.5 ? 'rgba(80,220,255,0.9)' : 'rgba(255,120,80,0.6)';
    pctx.beginPath();
    pctx.moveTo(lms[a].x * w, lms[a].y * h);
    pctx.lineTo(lms[b].x * w, lms[b].y * h);
    pctx.stroke();
  }
  for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    pctx.fillStyle = (lms[i].visibility ?? 0) > 0.5 ? '#fff' : '#f84';
    pctx.beginPath();
    pctx.arc(lms[i].x * w, lms[i].y * h, pctx.lineWidth * 1.5, 0, Math.PI * 2);
    pctx.fill();
  }
}

// ---------- Avatar from angles ----------
/** Which DOF confidences govern each bone's opacity. */
function boneConfidence(f: PoseTrackerFrame, a: JointName, b: JointName): number {
  const c = f.confidence;
  const side = a.startsWith('l') ? 'L' : 'R';
  const key = `${a}-${b}`;
  if (key === 'lShoulder-lElbow' || key === 'rShoulder-rElbow')
    return Math.min(c[`shoulder_${side}_elevation`], Math.max(c[`shoulder_${side}_plane`], 0.5));
  if (key === 'lElbow-lWrist' || key === 'rElbow-rWrist') return c[`elbow_${side}_flexion`];
  if (key === 'lHip-lKnee' || key === 'rHip-rKnee') return c[`hip_${side}_flexion`];
  if (key === 'lKnee-lAnkle' || key === 'rKnee-rAnkle') return c[`knee_${side}_flexion`];
  return Math.min(c.trunk_flexion, c.trunk_lateral);
}
function drawAvatar(f: PoseTrackerFrame | undefined) {
  const W = avatar.width;
  const H = avatar.height;
  actx.fillStyle = '#000';
  actx.fillRect(0, 0, W, H);
  actx.strokeStyle = '#333';
  actx.beginPath();
  actx.moveTo(W / 2, 0);
  actx.lineTo(W / 2, H);
  actx.stroke();
  if (!f) return;
  const sk = poseSkeleton(f.pose);
  const legLen = DEFAULT_SEGMENTS.thigh + DEFAULT_SEGMENTS.shank;
  const s = H / 2.2; // px per metre
  const floorY = H - 20;
  // Body frame: X forward, Y up, Z subject's right; mid-hip at standing height − pelvis drop.
  const hipY = floorY - (legLen - f.pose.pelvis_drop_m) * s;
  const views: Array<{ cx: number; map: (p: [number, number, number]) => [number, number] }> = [
    // Front view as the camera sees it (subject's right on screen left, like the preview).
    { cx: W / 4, map: (p) => [W / 4 - p[2] * s, hipY - p[1] * s] },
    // Right-side view: forward points to screen right.
    { cx: (3 * W) / 4, map: (p) => [(3 * W) / 4 + p[0] * s, hipY - p[1] * s] },
  ];
  for (const v of views) {
    actx.strokeStyle = '#444';
    actx.beginPath();
    actx.moveTo(v.cx - W / 5, floorY);
    actx.lineTo(v.cx + W / 5, floorY);
    actx.stroke();
    actx.lineWidth = 4;
    actx.lineCap = 'round';
    for (const [a, b] of SKELETON_BONES) {
      const conf = f.personDetected ? boneConfidence(f, a, b) : 0;
      const colour = a.startsWith('l')
        ? '80,200,255'
        : a.startsWith('r')
          ? '255,180,80'
          : '220,220,220';
      actx.strokeStyle = `rgba(${colour},${conf >= 0.5 ? 1 : 0.3})`;
      const [x1, y1] = v.map(sk[a]);
      const [x2, y2] = v.map(sk[b]);
      actx.beginPath();
      actx.moveTo(x1, y1);
      actx.lineTo(x2, y2);
      actx.stroke();
    }
    const [hx, hy] = v.map(sk.head);
    actx.strokeStyle = '#ddd';
    actx.lineWidth = 2;
    actx.beginPath();
    actx.arc(hx, hy, 0.09 * s, 0, Math.PI * 2);
    actx.stroke();
  }
  actx.fillStyle = '#888';
  actx.font = '12px system-ui';
  actx.fillText('front (camera view)', 8, 16);
  actx.fillText('right side', W / 2 + 8, 16);
  if (!f.personDetected) actx.fillText('no person: holding last pose', 8, 32);
}

// ---------- Tracker ----------
function onFrame(f: PoseTrackerFrame) {
  lastFrame = f;
  if (f.calibrating) {
    calibEl.textContent = f.calibrating.issues.length
      ? `calibrating… ${f.calibrating.issues.join(', ')}`
      : `calibrating… ${(f.calibrating.progress * 100).toFixed(0)}%`;
  }
}

async function start(deviceId?: string, cameraOverride?: CameraHandle) {
  stop();
  setStatus('opening camera…');
  try {
    camera =
      cameraOverride ??
      (await openCamera({ deviceId: deviceId ?? (cameraSelect.value || undefined) }));
  } catch (error) {
    setStatus(
      error instanceof CameraError ? `${error.code}: ${error.message}` : String(error),
      true,
    );
    throw error;
  }
  await refreshCameras();
  setStatus('loading pose model…');
  tracker = await createPoseTracker(camera, {
    model: modelSelect.value as PoseTrackerModel,
    delegate: delegateSelect.value as 'GPU' | 'CPU',
  });
  tracker.onFrame(onFrame);
  tracker.onRawFrame(onRawFrame);
  tracker.start();
  const st = tracker.stats();
  setStatus(`running · ${st.model} · ${st.delegate}${st.gpuFallbackReason ? ' (GPU failed)' : ''}`);
  startButton.disabled = true;
  stopButton.disabled = false;
  calibrateButton.disabled = false;
  recordButton.disabled = false;
  cancelAnimationFrame(raf);
  drawPreview();
  clearInterval(tableTimer);
  tableTimer = window.setInterval(() => {
    if (lastFrame) updateTable(lastFrame);
    drawAvatar(lastFrame);
    if (tracker) {
      const s = tracker.stats();
      const cam = camera?.info();
      statsEl.textContent =
        `camera     ${cam?.width}×${cam?.height} @ ${cam?.fps} fps\n` +
        `model      ${s.model} · ${s.delegate}\n` +
        `inference  ${s.inferenceHz} Hz · ${s.inferenceMs.toFixed(1)} ms/frame\n` +
        `latency    ${s.latencyMs.toFixed(1)} ms (frame callback → emit)\n` +
        `frames     ${s.framesProcessed} processed · ${s.framesSkipped} skipped\n` +
        `person     ${lastFrame?.personDetected ? 'yes' : 'no'}` +
        (lastFrame?.clamped.length ? `\nclamped    ${lastFrame.clamped.join(', ')}` : '') +
        (s.gpuFallbackReason ? `\nGPU fallback: ${s.gpuFallbackReason}` : '') +
        (s.lastError ? `\nlast error: ${s.lastError}` : '');
    }
  }, 100);
}

function stop() {
  if (recording) void saveRecording();
  tracker?.close();
  tracker = undefined;
  camera?.close();
  camera = undefined;
  cancelAnimationFrame(raf);
  clearInterval(tableTimer);
  startButton.disabled = false;
  stopButton.disabled = true;
  calibrateButton.disabled = true;
  recordButton.disabled = true;
  setStatus('stopped');
}

async function calibrate() {
  if (!tracker) return;
  calibrateButton.disabled = true;
  calibEl.textContent = 'calibrating… stand upright, arms down, hold still';
  try {
    const c = await tracker.calibrate();
    calibEl.textContent =
      `calibrated · vertical tilt ${((Math.acos(c.up[1]) * 180) / Math.PI).toFixed(1)}° from camera up · ` +
      `standing hip height ${c.standingHipHeightM === null ? 'n/a (feet not seen)' : c.standingHipHeightM.toFixed(3) + ' m'}`;
  } catch (error) {
    calibEl.textContent = `calibration failed: ${String(error)}`;
  } finally {
    calibrateButton.disabled = false;
  }
}

// ---------- Recorder (numbers only) ----------
/** Hard cap so a forgotten recording cannot grow without bound (5 min at 30 fps). */
const MAX_RECORDED_FRAMES = 9000;
let recording: RecordedPoseFrame[] | undefined;
let recordingCalibration: PoseRecording['calibration'] = null;
function onRawFrame(f: RecordedPoseFrame) {
  if (!recording) return;
  if (recording.length >= MAX_RECORDED_FRAMES) {
    void saveRecording();
    return;
  }
  recording.push(f);
  if (recording.length % 30 === 0) recStatus.textContent = `recording… ${recording.length} frames`;
}
function startRecording() {
  if (!tracker) return;
  recording = [];
  recordingCalibration = tracker.calibration();
  recStatus.textContent = recordingCalibration
    ? 'recording…'
    : 'recording (NOT calibrated: press Calibrate first for gravity-referenced DOFs)';
  recordButton.disabled = true;
  saveButton.disabled = false;
}
function saveRecording() {
  const frames = recording ?? [];
  recording = undefined;
  recordButton.disabled = !tracker;
  saveButton.disabled = true;
  if (!frames.length) {
    recStatus.textContent = 'nothing recorded';
    return;
  }
  const cam = camera?.info();
  const st = tracker?.stats();
  const rec: PoseRecording = {
    format: POSE_RECORDING_FORMAT,
    version: POSE_RECORDING_VERSION,
    createdAt: new Date().toISOString(),
    source: {
      camera: cam?.label ?? '',
      width: cam?.width ?? 0,
      height: cam?.height ?? 0,
      fps: cam?.fps ?? 0,
      delegate: st?.delegate ?? '',
      model: st?.model ?? '',
    },
    calibration: recordingCalibration,
    meta: {
      motion: motionSelect.value as PoseMotionTag,
      ...(noteInput.value.trim() ? { note: noteInput.value.trim() } : {}),
    },
    frames,
  };
  // User-initiated download of numbers only; never uploaded.
  const blob = new Blob([serializePoseRecording(rec)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pose-${rec.meta.motion}-${rec.createdAt.replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  recStatus.textContent = `saved ${frames.length} frames → move the file to packages/vision/test-data/pose/`;
}

startButton.onclick = () => void start().catch(() => undefined);
stopButton.onclick = stop;
calibrateButton.onclick = () => void calibrate();
recordButton.onclick = startRecording;
saveButton.onclick = () => saveRecording();
void refreshCameras();
drawAvatar(undefined);

// ---------- Bench mode for scripts/smoke-pose.mjs (fake camera, no person) ----------
declare global {
  interface Window {
    __poseBench?: Record<string, unknown>;
  }
}

async function bench(params: URLSearchParams) {
  const seconds = Number(params.get('seconds') ?? 8);
  const m = params.get('model');
  modelSelect.value = m === 'lite' || m === 'heavy' ? m : 'full';
  try {
    const image = params.get('image');
    const cams = image ? [] : await listCameras();
    const t0 = performance.now();
    await start(
      cams[0]?.deviceId,
      image ? await imageCamera(image, params.get('crop')) : undefined,
    );
    const loadMs = performance.now() - t0;
    const tr = tracker!;
    let person = 0;
    let lastSeen: PoseTrackerFrame | undefined;
    tr.onFrame((f) => {
      if (!f.personDetected) return;
      person++;
      lastSeen = f;
    });
    const before = tr.stats().framesProcessed;
    const runStart = performance.now();
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const runSeconds = (performance.now() - runStart) / 1000;
    const s = tr.stats();
    window.__poseBench = {
      ok: true,
      loadMs,
      runSeconds,
      meanInferenceHz: (s.framesProcessed - before) / runSeconds,
      camera: camera?.info(),
      stats: s,
      personFrames: person,
      lastPose: lastSeen?.pose,
      lastConfidence: lastSeen?.confidence,
      lastRaw: lastSeen?.raw,
    };
    stop();
  } catch (error) {
    window.__poseBench = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Bench-only stand-in camera: a still image (e.g. a rendered body from docs/validation) redrawn at
 * 30 fps into a 1280×720 canvas, so the landmark stage runs with a person in view. crop = x,y,w,h
 * in image pixels.
 */
async function imageCamera(url: string, crop: string | null): Promise<CameraHandle> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const [cx, cy, cw, ch] = crop ? crop.split(',').map(Number) : [0, 0, img.width, img.height];
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d')!;
  const scale = Math.min(canvas.width / cw, canvas.height / ch) * 0.9;
  const draw = () => {
    ctx.fillStyle = '#151b20';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const w = cw * scale;
    const h = ch * scale;
    ctx.drawImage(img, cx, cy, cw, ch, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  };
  const listeners = new Set<(t: number) => void>();
  const times: number[] = [];
  const timer = window.setInterval(() => {
    draw();
    const now = performance.now();
    times.push(now);
    while (times.length && now - times[0] > 1000) times.shift();
    for (const l of listeners) l(now);
  }, 1000 / 30);
  return {
    video: document.createElement('video'),
    source: canvas,
    onFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    info: () => ({
      deviceId: 'image',
      label: `image ${url.split('/').pop()}`,
      width: canvas.width,
      height: canvas.height,
      fps: times.length,
      portrait: false,
    }),
    close: () => {
      clearInterval(timer);
      listeners.clear();
    },
  };
}

const params = new URLSearchParams(location.search);
if (params.get('bench') === '1') void bench(params);
