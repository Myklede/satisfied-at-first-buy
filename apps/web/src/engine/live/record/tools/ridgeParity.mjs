// Shoulder-ridge transfer parity (V3, option b1): the server's skinned body (Python lbs, dumped by
// `python -m body_service.motion.ridge_parity`) against rig.ts for every frame of the six presets,
// with the switch off and on. rig.ts skinVertices is the one TS skinning: the bake (full body),
// the WASM collider (its zone vertices go through skinVertices(…, ids)) and vertexBlend (the bake's
// anchors) all use it, so the ids path and vertexBlend are checked against the full skin too.
// Neutral reference body only; files in the gitignored .cache/v3/parity/.
//   node apps/web/src/engine/live/record/tools/ridgeParity.mjs
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  frameMatrices,
  parseFrames,
  parseRig,
  ridgeFactors,
  skinVertices,
  vertexBlend,
} from '../../../motion/rig.ts';

const root = resolve(import.meta.dirname, '../../../../../../..');
const at = process.argv.indexOf('--dir');
const slug = at < 0 ? 'parity' : process.argv[at + 1];
if (!/^[a-z0-9_-]{1,32}$/.test(slug ?? '')) throw new Error('Invalid parity dump slug');
const dir = join(root, '.cache/v3', slug);
const TOLERANCE_M = 1e-5;
const read = (name) => {
  const b = readFileSync(join(dir, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
const rigs = { off: parseRig(read('rig-off.bin')), on: parseRig(read('rig-on.bin')) };
if (rigs.off.ridge || !rigs.on.ridge) throw new Error('rig-off must be plain LBS, rig-on ridged');
const report = { toleranceM: TOLERANCE_M, presets: {} };
let pass = true;
for (const [preset, info] of Object.entries(summary.presets)) {
  const rows = (report.presets[preset] = {});
  for (const state of ['off', 'on']) {
    const rig = rigs[state];
    const frames = parseFrames(read(`frames-${preset}.bin`), rig.drivers.length);
    const V = rig.vertexCount;
    if (frames.count !== info.frames || V !== info.vertices) throw new Error(`${preset}: shape`);
    const server = new Float32Array(read(`pos-${preset}-${state}.f32`));
    const m = new Float64Array(rig.drivers.length * 12);
    const out = new Float64Array(V * 3);
    // ids path: every ridge vertex plus every 11th vertex, in a scrambled order.
    const idSet = new Set(rigs.on.ridge.vertices);
    for (let v = 0; v < V; v += 11) idSet.add(v);
    const ids = Uint32Array.from(
      [...idSet].sort((a, b) => ((a * 7919) % 104729) - ((b * 7919) % 104729)),
    );
    const sub = new Float64Array(ids.length * 3);
    const blend = new Float64Array(12);
    let maxDiff = 0,
      maxIds = 0,
      maxBlend = 0,
      ridgedFrames = 0;
    for (let f = 0; f < frames.count; f++) {
      frameMatrices(frames, f, m);
      if (rig.ridge) {
        const [a, b] = ridgeFactors(rig.ridge, m);
        if (a || b) ridgedFrames++;
      }
      skinVertices(rig, m, out);
      const o = f * V * 3;
      for (let k = 0; k < V * 3; k++) maxDiff = Math.max(maxDiff, Math.abs(out[k] - server[o + k]));
      skinVertices(rig, m, sub, ids);
      for (let s = 0; s < ids.length; s++)
        for (let a = 0; a < 3; a++)
          maxIds = Math.max(maxIds, Math.abs(sub[s * 3 + a] - out[ids[s] * 3 + a]));
      for (let s = 0; s < ids.length; s += 3) {
        const v = ids[s];
        vertexBlend(rig, v, m, blend);
        const r = rig.restVertices;
        for (let a = 0; a < 3; a++) {
          const p =
            blend[a * 4] * r[v * 3] +
            blend[a * 4 + 1] * r[v * 3 + 1] +
            blend[a * 4 + 2] * r[v * 3 + 2] +
            blend[a * 4 + 3];
          maxBlend = Math.max(maxBlend, Math.abs(p - out[v * 3 + a]));
        }
      }
    }
    const ok = maxDiff <= TOLERANCE_M && maxIds <= TOLERANCE_M && maxBlend <= TOLERANCE_M;
    pass &&= ok;
    rows[state] = {
      frames: frames.count,
      ridgedFrames,
      maxServerVsTsM: maxDiff,
      maxIdsVsFullM: maxIds,
      maxVertexBlendVsFullM: maxBlend,
      ok,
    };
    console.log(
      `[v3-parity] ${preset} ${state}: ${frames.count} frames (${ridgedFrames} ridged) ` +
        `server-ts ${maxDiff.toExponential(2)} m, ids ${maxIds.toExponential(2)} m, ` +
        `blend ${maxBlend.toExponential(2)} m ${ok ? 'OK' : 'FAIL'}`,
    );
  }
  rows.serverFramesChanged = info.frames_changed;
  rows.serverMaxChangeCm = info.max_change_cm;
}
report.pass = pass;
console.log(JSON.stringify(report));
process.exit(pass ? 0 : 1);
