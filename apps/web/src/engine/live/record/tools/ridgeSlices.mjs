// Shoulder-ridge body checks (V3, option b1): skin only, no cloth. For each preset, plain LBS
// (rig-off.bin) against the ridge transfer (rig-on.bin) on the same frames.bin:
//   - ridge slices: the shoulder-top skin rise from frame 0 to the hold, per side, in 3 cm lateral
//     slices 9-21 cm from the midline (the 5 highest rest vertices of each slice, tracked);
//   - which frames change at all (only frames with the humerus above 90 degrees may);
//   - shoulder skin (faces within 12 cm of the glenohumeral joints) at the hold: faces whose area
//     falls below 30 % of rest, edges stretched past 1.5× or compressed below 0.5×;
//   - self-intersection: non-adjacent shoulder triangle pairs that cross, worst frame over every
//     frame where the transfer is active, with the ridge off and on.
// Input folder (gitignored): rig-off.bin, rig-on.bin, frames-<preset>.bin, written by
// `python -m body_service.motion.ridge_parity` (neutral reference body) or by ridgeDump.mjs.
//   node apps/web/src/engine/live/record/tools/ridgeSlices.mjs [--dir .cache/v3/parity]
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { boneHead } from '../../../motion/armhole.ts';
import {
  frameMatrices,
  parseFrames,
  parseRig,
  ridgeFactors,
  skinVertices,
} from '../../../motion/rig.ts';

const root = resolve(import.meta.dirname, '../../../../../../..');
const args = process.argv.slice(2);
const rel = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : '.cache/v3/parity';
if (!/^\.cache\/v3\/[a-z0-9_-]{1,32}$/.test(rel)) throw new Error('--dir must be .cache/v3/<name>');
const dir = join(root, rel);
const PRESETS = [
  'reach_up_both',
  'cross_arms',
  'sit',
  'bend_tie_shoes',
  'reach_forward',
  'reach_up_one',
];
const SLICES_CM = [9, 12, 15, 18, 21];
const read = (name) => {
  const b = readFileSync(join(dir, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const rigs = { off: parseRig(read('rig-off.bin')), on: parseRig(read('rig-on.bin')) };
const rig = rigs.on;
const V = rig.vertexCount,
  F = rig.faces.length / 3;
const r1 = (x) => Math.round(x * 10) / 10;

const sub = (a, i, b, j) => [
  a[i * 3] - b[j * 3],
  a[i * 3 + 1] - b[j * 3 + 1],
  a[i * 3 + 2] - b[j * 3 + 2],
];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function faceNormal(p, f) {
  const [a, b, c] = [rig.faces[f * 3], rig.faces[f * 3 + 1], rig.faces[f * 3 + 2]];
  return cross(sub(p, b, p, a), sub(p, c, p, a)); // length = 2 × area
}

// Segment pq crosses triangle abc (strictly inside, Möller-Trumbore).
function segmentHits(p, q, a, b, c) {
  const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
    e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const h = cross(d, e2),
    det = dot(e1, h);
  if (Math.abs(det) < 1e-14) return false;
  const s = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const u = dot(s, h) / det;
  if (u <= 0 || u >= 1) return false;
  const qv = cross(s, e1),
    w = dot(d, qv) / det;
  if (w <= 0 || u + w >= 1) return false;
  const t = dot(e2, qv) / det;
  return t > 0 && t < 1;
}
const vtx = (p, i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
function crossings(p, faces) {
  let count = 0;
  for (let x = 0; x < faces.length; x++) {
    const fa = faces[x],
      A = [rig.faces[fa * 3], rig.faces[fa * 3 + 1], rig.faces[fa * 3 + 2]];
    const pa = A.map((i) => vtx(p, i));
    for (let y = x + 1; y < faces.length; y++) {
      const fb = faces[y],
        B = [rig.faces[fb * 3], rig.faces[fb * 3 + 1], rig.faces[fb * 3 + 2]];
      if (A.some((i) => B.includes(i))) continue;
      const pb = B.map((i) => vtx(p, i));
      let hit = false;
      for (let k = 0; k < 3 && !hit; k++) {
        hit =
          segmentHits(pa[k], pa[(k + 1) % 3], pb[0], pb[1], pb[2]) ||
          segmentHits(pb[k], pb[(k + 1) % 3], pa[0], pa[1], pa[2]);
      }
      if (hit) count++;
    }
  }
  return count;
}

const report = { dir: rel, presets: {} };
for (const preset of PRESETS) {
  if (!existsSync(join(dir, `frames-${preset}.bin`))) continue;
  const frames = parseFrames(read(`frames-${preset}.bin`), rig.drivers.length);
  const hold = frames.motion.hold;
  const mid = Math.round(((hold.start_s + hold.end_s) / 2) * frames.fps);
  const m0 = new Float64Array(rig.drivers.length * 12),
    m1 = new Float64Array(rig.drivers.length * 12);
  frameMatrices(frames, 0, m0);
  frameMatrices(frames, mid, m1);
  const skin = {};
  for (const s of ['off', 'on'])
    skin[s] = [m0, m1].map((m) => skinVertices(rigs[s], m, new Float64Array(V * 3)));
  const rest = skin.off[0];
  // Frames changed at all, against frames with a nonzero ridge factor.
  const m = new Float64Array(rig.drivers.length * 12);
  const a = new Float64Array(V * 3),
    b = new Float64Array(V * 3);
  let changed = 0,
    ridged = 0,
    changedUnridged = 0;
  for (let f = 0; f < frames.count; f++) {
    frameMatrices(frames, f, m);
    const [fl, fr] = ridgeFactors(rig.ridge, m);
    skinVertices(rigs.off, m, a);
    skinVertices(rigs.on, m, b);
    let diff = false;
    for (let k = 0; k < V * 3 && !diff; k++) diff = a[k] !== b[k];
    if (diff) changed++;
    if (fl || fr) ridged++;
    else if (diff) changedUnridged++;
  }
  // Ridge slices.
  const joints = ['L', 'R'].map((side) =>
    Array.from(boneHead(rig, m0, rig.bones.indexOf(`upperarm01.${side}`), new Float64Array(3))),
  );
  const midX = (joints[0][0] + joints[1][0]) / 2;
  const slices = {};
  for (const [s, side] of ['L', 'R'].entries()) {
    const sign = Math.sign(joints[s][0] - midX);
    slices[side] = {};
    for (const cm of SLICES_CM) {
      const lo = (cm - 1.5) / 100,
        hi = (cm + 1.5) / 100;
      const cand = [];
      for (let v = 0; v < V; v++) {
        const lat = (rest[v * 3] - midX) * sign;
        if (lat < lo || lat >= hi || rest[v * 3 + 1] > joints[s][1] + 0.15) continue;
        cand.push(v);
      }
      cand.sort((x, y) => rest[y * 3 + 1] - rest[x * 3 + 1]);
      const top = cand.slice(0, 5);
      const rise = (st) =>
        r1(
          (top.reduce((acc, v) => acc + skin[st][1][v * 3 + 1] - rest[v * 3 + 1], 0) / top.length) *
            100,
        );
      slices[side][cm] = { off: rise('off'), on: rise('on') };
    }
  }
  // Shoulder skin quality at the hold; self-intersection over the active frames.
  const near = [];
  for (let f = 0; f < F; f++) {
    const ids = [rig.faces[f * 3], rig.faces[f * 3 + 1], rig.faces[f * 3 + 2]];
    if (
      ids.some((i) =>
        joints.some(
          (j) =>
            Math.hypot(rest[i * 3] - j[0], rest[i * 3 + 1] - j[1], rest[i * 3 + 2] - j[2]) < 0.12,
        ),
      )
    )
      near.push(f);
  }
  const edges = new Map();
  for (const f of near)
    for (let k = 0; k < 3; k++) {
      const a = rig.faces[f * 3 + k],
        b = rig.faces[f * 3 + ((k + 1) % 3)];
      edges.set(a < b ? a * 1e6 + b : b * 1e6 + a, [a, b]);
    }
  const len = (p, a, b) => Math.hypot(...sub(p, a, p, b));
  const quality = (p) => {
    let collapsed = 0,
      stretched = 0,
      compressed = 0;
    for (const f of near)
      if (Math.hypot(...faceNormal(p, f)) < 0.3 * Math.hypot(...faceNormal(rest, f))) collapsed++;
    for (const [a, b] of edges.values()) {
      const r = len(p, a, b) / len(rest, a, b);
      if (r > 1.5) stretched++;
      if (r < 0.5) compressed++;
    }
    return { collapsed, stretched, compressed };
  };
  const worst = { off: 0, on: 0 };
  for (let f = 0; f < frames.count; f++) {
    frameMatrices(frames, f, m);
    const [fl, fr] = ridgeFactors(rig.ridge, m);
    if (!fl && !fr && f !== mid) continue;
    for (const s of ['off', 'on'])
      worst[s] = Math.max(worst[s], crossings(skinVertices(rigs[s], m, a), near));
  }
  const q = { off: quality(skin.off[1]), on: quality(skin.on[1]) };
  const row = {
    frames: frames.count,
    holdFrame: mid,
    framesChanged: changed,
    framesWithRidgeFactor: ridged,
    framesChangedWithoutFactor: changedUnridged,
    slicesRiseCm: slices,
    shoulderFaces: near.length,
    shoulderEdges: edges.size,
    atHold: q,
    worstCrossingPairs: worst,
  };
  report.presets[preset] = row;
  const fmt = (side) =>
    SLICES_CM.map((cm) => `${cm}:${slices[side][cm].off}→${slices[side][cm].on}`).join(' ');
  console.log(
    `[v3-ridge] ${preset}: frames changed ${changed}/${frames.count} (ridged ${ridged}, ` +
      `changed without factor ${changedUnridged}); slices L ${fmt('L')} | R ${fmt('R')}; ` +
      `hold: collapsed faces ${q.off.collapsed}→${q.on.collapsed}/${near.length}, edges >1.5× ` +
      `${q.off.stretched}→${q.on.stretched}, <0.5× ${q.off.compressed}→${q.on.compressed}/${edges.size}; ` +
      `worst crossings ${worst.off}→${worst.on}`,
  );
}
console.log(JSON.stringify(report));
