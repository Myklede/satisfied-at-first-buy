// Replay viewer for recorded hand files (numbers only, no images). Files are read locally with
// FileReader; nothing is uploaded. The tracker is re-run on the recording, so what you see is
// what the current code would do with that motion.
import { HandLandmarker } from '@mediapipe/tasks-vision';
import {
  parseHandRecording,
  primaryHand,
  replayRecording,
  type HandRecording,
} from '../src/handRecording';
import type { GripConfidence } from '../src/grip';
import type { PinchUpdate } from '../src/pinch';
import { RING_COLOUR, drawGrabRing, ringCaption } from './grabRing';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

const filesInput = $<HTMLInputElement>('files');
const list = $<HTMLSelectElement>('list');
const playButton = $<HTMLButtonElement>('play');
const speedSelect = $<HTMLSelectElement>('speed');
const mirrorBox = $<HTMLInputElement>('mirror');
const view = $<HTMLCanvasElement>('view');
const timeline = $<HTMLCanvasElement>('timeline');
const info = $<HTMLDivElement>('info');
const vctx = view.getContext('2d')!;
const tctx = timeline.getContext('2d')!;

/** Display levels on the openness scale (match pinch.ts defaults: grab below, release above). */
const GRAB_LEVEL = 0.25;
const RELEASE_LEVEL = 0.4;
const OPENNESS_MAX = 1;
const HAND_COLOUR: Record<string, string> = { left: '#4cc3ff', right: '#ffb347' };

interface Loaded {
  name: string;
  rec: HandRecording;
  updates: PinchUpdate[];
  primary: string;
  /** Per frame: openness of the primary hand (NaN when absent), tracker grabbing, label. */
  openness: number[];
  grabbing: boolean[];
  label: (boolean | undefined)[];
  /** Per frame: grab progress (0..1, NaN when absent) and confidence class of the primary hand. */
  progress: number[];
  confidence: (GripConfidence | undefined)[];
  /** Frame indices where label and tracker disagree (start of each disagreement run). */
  issues: number[];
}

const loaded: Loaded[] = [];
let current: Loaded | undefined;
let index = 0;
let playing = false;
let lastWall = 0;

function analyse(name: string, rec: HandRecording): Loaded {
  const { updates } = replayRecording(rec);
  const primary = primaryHand(rec).hand;
  const openness: number[] = [];
  const grabbing: boolean[] = [];
  const label: (boolean | undefined)[] = [];
  const progress: number[] = [];
  const confidence: (GripConfidence | undefined)[] = [];
  for (let i = 0; i < updates.length; i++) {
    const hands = updates[i].frame.hands;
    const mine = hands.find((h) => h.hand === primary) ?? hands[0];
    openness.push(mine ? mine.openness : Number.NaN);
    progress.push(mine ? mine.grabProgress : Number.NaN);
    confidence.push(mine?.gripConfidence);
    grabbing.push(hands.some((h) => h.pinching));
    label.push(rec.frames[i].grab);
  }
  const issues: number[] = [];
  const labelled = label.some((l) => l !== undefined);
  for (let i = 1; i < updates.length; i++) {
    const now = labelled && label[i] !== grabbing[i];
    const before = labelled && label[i - 1] !== grabbing[i - 1];
    if (now && !before) issues.push(i);
  }
  return { name, rec, updates, primary, openness, grabbing, label, progress, confidence, issues };
}

filesInput.addEventListener('change', async () => {
  const files = Array.from(filesInput.files ?? []);
  for (const file of files) {
    try {
      const rec = parseHandRecording(JSON.parse(await file.text()));
      loaded.push(analyse(file.name, rec));
    } catch (error) {
      info.textContent = `${file.name}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  list.replaceChildren(
    ...loaded.map((l, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      const pose = l.rec.meta.pose ? ` [${l.rec.meta.pose}]` : '';
      const bad = l.rec.meta.invalid ? ' (invalid)' : '';
      o.textContent = `${l.name}${pose}${bad}`;
      return o;
    }),
  );
  if (loaded.length) select(loaded.length - files.length);
});
list.addEventListener('change', () => select(Number(list.value)));

function select(i: number) {
  current = loaded[Math.max(0, i)];
  list.value = String(Math.max(0, i));
  index = 0;
  playing = false;
  playButton.textContent = '▶ Play';
  draw();
}

const t0 = () => current?.rec.frames[0]?.t ?? 0;

function drawHand() {
  vctx.fillStyle = '#000';
  vctx.fillRect(0, 0, view.width, view.height);
  if (!current) return;
  const frame = current.rec.frames[index];
  const tracked = current.updates[index].frame.hands;
  const mirror = mirrorBox.checked;
  const W = view.width;
  const H = view.height;
  const px = (x: number) => (mirror ? 1 - x : x) * W;
  for (const raw of frame.hands) {
    const label = raw.label.toLowerCase();
    const hand = current.rec.swapHandedness ? (label === 'left' ? 'right' : 'left') : label;
    const t = tracked.find((h) => h.hand === hand);
    const lm = raw.landmarks;
    vctx.lineWidth = 3;
    vctx.strokeStyle = HAND_COLOUR[hand] ?? '#ccc';
    for (const c of HandLandmarker.HAND_CONNECTIONS) {
      const a = lm[c.start];
      const b = lm[c.end];
      if (!a || !b) continue;
      vctx.beginPath();
      vctx.moveTo(px(a[0]), a[1] * H);
      vctx.lineTo(px(b[0]), b[1] * H);
      vctx.stroke();
    }
    vctx.fillStyle = '#fff';
    for (const p of lm) {
      vctx.beginPath();
      vctx.arc(px(p[0]), p[1] * H, 3, 0, Math.PI * 2);
      vctx.fill();
    }
    // Thumb tip and index tip highlighted: the pair that defines a pinch.
    for (const k of [4, 8]) {
      const p = lm[k];
      if (!p) continue;
      vctx.beginPath();
      vctx.arc(px(p[0]), p[1] * H, 7, 0, Math.PI * 2);
      vctx.strokeStyle = k === 4 ? '#f6f' : '#6ff';
      vctx.lineWidth = 2;
      vctx.stroke();
    }
    if (t) {
      // Grab point + progress ring. pinchNdc is mirrored (tracker default); undo it if unmirrored.
      const mx = (t.pinchNdc.x + 1) / 2;
      drawGrabRing(
        vctx,
        (mirror ? mx : 1 - mx) * W,
        ((1 - t.pinchNdc.y) / 2) * H,
        t.grabProgress,
        t.gripConfidence,
        t.pinching,
        20,
      );
    }
    const wrist = lm[0];
    if (wrist) {
      const grabbing = t?.pinching ?? false;
      vctx.font = 'bold 18px system-ui';
      vctx.fillStyle = t ? RING_COLOUR[t.gripConfidence] : '#ddd';
      const text = t
        ? `${hand} · ${t.grip} · ${ringCaption(t.grabProgress, t.gripConfidence, t.pinching)} · openness ${t.openness.toFixed(2)}`
        : `${hand} ${grabbing ? 'GRAB' : 'open'}`;
      const width = vctx.measureText(text).width;
      vctx.fillText(
        text,
        Math.max(8, Math.min(px(wrist[0]) + 12, W - width - 8)),
        Math.min(wrist[1] * H + 28, H - 8),
      );
    }
  }
  if (frame.grab !== undefined) {
    vctx.font = 'bold 20px system-ui';
    vctx.fillStyle = frame.grab ? '#e33' : '#666';
    vctx.fillText(frame.grab ? '● SPACE HELD' : '○ space up', 16, 30);
  }
  if (!frame.hands.length) {
    vctx.font = '18px system-ui';
    vctx.fillStyle = '#888';
    vctx.fillText('no hand detected in this frame', 16, H - 16);
  }
}

function drawTimeline() {
  const W = timeline.width;
  const H = timeline.height;
  tctx.fillStyle = '#000';
  tctx.fillRect(0, 0, W, H);
  if (!current) return;
  const n = current.rec.frames.length;
  const x = (i: number) => (i / Math.max(1, n - 1)) * W;
  // Bands: label (top) and tracker (second row).
  for (let i = 0; i < n; i++) {
    const w = Math.max(1, x(i + 1) - x(i));
    if (current.label[i]) {
      tctx.fillStyle = '#e33';
      tctx.fillRect(x(i), 4, w, 12);
    }
    if (current.grabbing[i]) {
      tctx.fillStyle = '#3c3';
      tctx.fillRect(x(i), 20, w, 12);
    }
  }
  // Confidence / progress row: bar height = grab progress, colour = clear (green) / ambiguous (amber).
  for (let i = 0; i < n; i++) {
    const p = current.progress[i];
    const c = current.confidence[i];
    if (!c || !Number.isFinite(p) || p < 0.02) continue;
    const w = Math.max(1, x(i + 1) - x(i));
    tctx.fillStyle = RING_COLOUR[c];
    tctx.fillRect(x(i), 48 - 12 * p, w, 12 * p);
  }
  // Openness curve.
  const top = 54;
  const bottom = H - 6;
  const y = (v: number) => bottom - (Math.min(v, OPENNESS_MAX) / OPENNESS_MAX) * (bottom - top);
  tctx.strokeStyle = '#888';
  tctx.setLineDash([4, 4]);
  for (const level of [GRAB_LEVEL, RELEASE_LEVEL]) {
    tctx.beginPath();
    tctx.moveTo(0, y(level));
    tctx.lineTo(W, y(level));
    tctx.stroke();
  }
  tctx.setLineDash([]);
  tctx.strokeStyle = '#fc3';
  tctx.lineWidth = 1.5;
  tctx.beginPath();
  let pen = false;
  for (let i = 0; i < n; i++) {
    const v = current.openness[i];
    if (!Number.isFinite(v)) {
      pen = false;
      continue;
    }
    if (pen) tctx.lineTo(x(i), y(v));
    else tctx.moveTo(x(i), y(v));
    pen = true;
  }
  tctx.stroke();
  // Disagreement markers and cursor.
  tctx.fillStyle = '#f0f';
  for (const i of current.issues) tctx.fillRect(x(i) - 1, 0, 2, 4);
  tctx.fillStyle = '#fff';
  tctx.fillRect(x(index) - 1, 0, 2, H);
}

function drawInfo() {
  if (!current) return;
  const f = current.rec.frames[index];
  const m = current.rec.meta;
  const sec = ((f.t - t0()) / 1000).toFixed(2);
  const total = ((current.rec.frames[current.rec.frames.length - 1].t - t0()) / 1000).toFixed(1);
  const starts = current.updates.reduce(
    (s, u) => s + u.events.filter((e) => e.type === 'start').length,
    0,
  );
  info.textContent =
    `File        ${current.name}\n` +
    `Pose        ${m.pose ?? '-'}   expected hand ${m.expectedHand ?? '-'}   expected grabs ${m.expectedPinches ?? '-'}\n` +
    `Time        ${sec} s / ${total} s   frame ${index + 1} / ${current.rec.frames.length}\n` +
    `Tracker     ${starts} grab start(s); ${current.issues.length} label/tracker disagreement(s) (magenta ticks)\n` +
    (m.invalid ? `INVALID     ${m.invalidReason ?? ''}\n` : '') +
    (m.reviewNote ? `Review      ${m.reviewNote}\n` : '');
}

function draw() {
  drawHand();
  drawTimeline();
  drawInfo();
}

function step(delta: number) {
  if (!current) return;
  index = Math.max(0, Math.min(current.rec.frames.length - 1, index + delta));
  draw();
}

function tick(now: number) {
  if (playing && current) {
    const elapsed = (now - lastWall) * Number(speedSelect.value);
    lastWall = now;
    const target = current.rec.frames[index].t + elapsed;
    while (index < current.rec.frames.length - 1 && current.rec.frames[index + 1].t <= target)
      index++;
    if (index >= current.rec.frames.length - 1) {
      playing = false;
      playButton.textContent = '▶ Play';
    }
    draw();
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

playButton.addEventListener('click', () => {
  if (!current) return;
  if (index >= current.rec.frames.length - 1) index = 0;
  playing = !playing;
  lastWall = performance.now();
  playButton.textContent = playing ? '⏸ Pause' : '▶ Play';
});
$('back').addEventListener('click', () => step(-1));
$('fwd').addEventListener('click', () => step(1));
$('nextIssue').addEventListener('click', () => {
  if (!current) return;
  const next = current.issues.find((i) => i > index) ?? current.issues[0];
  if (next !== undefined) {
    // Start a little before the disagreement so the lead-in is visible.
    index = Math.max(0, next - 15);
    draw();
  }
});
mirrorBox.addEventListener('change', draw);
timeline.addEventListener('click', (e) => {
  if (!current) return;
  const rect = timeline.getBoundingClientRect();
  const frac = (e.clientX - rect.left) / rect.width;
  index = Math.round(frac * (current.rec.frames.length - 1));
  draw();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === ' ') {
    e.preventDefault();
    playButton.click();
  }
});
