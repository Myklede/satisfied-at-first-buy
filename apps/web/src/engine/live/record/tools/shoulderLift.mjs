// How far the shoulders rise at the hold of a preset (V3, the collar question): bone heads of the
// clavicle, shoulder01 (acromion region) and the glenohumeral joint, plus the highest shoulder-top
// skin point, at the neutral frame and at the hold, on the server rig (the preset's frames) and on
// the TS live rig (V1's liveRig.poseDrivers for the same clamped pose). The person's own body from
// the local body service (figures from the gitignored toi.txt, kept in memory). Numbers only.
//   node apps/web/src/engine/live/record/tools/shoulderLift.mjs [--preset reach_up_both]
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { boneHead } from '../../../motion/armhole.ts';
import { frameMatrices, parseFrames, parseRig, skinVertices } from '../../../motion/rig.ts';
import { loadLiveRig, poseDrivers } from '../../liveRig.ts';

const root = resolve(import.meta.dirname, '../../../../../../..');
const args = process.argv.slice(2);
const apiPort = Number(args.includes('--api-port') ? args[args.indexOf('--api-port') + 1] : 8001);
if (![8001, 5770, 5771, 5772, 5773, 5774].includes(apiPort)) throw new Error('bad --api-port');
const API = `http://127.0.0.1:${apiPort}`;
const preset = args.includes('--preset') ? args[args.indexOf('--preset') + 1] : 'reach_up_both';
if (!/^[a-z_]{1,32}$/.test(preset)) throw new Error('bad preset');

async function http(path, body) {
  const r = await fetch(API + path, {
    cache: 'no-store',
    ...(body
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r;
}
const text = readFileSync(join(root, 'data/reference-photos/toi.txt'), 'utf8');
const field = (key) => new RegExp(`^${key}:\\s*([^\\s#]+)`, 'm').exec(text)?.[1];
const caps = await (await http('/body/capabilities')).json();
const body = await (
  await http('/body/fit', {
    height_cm: Number(field('height_cm')),
    weight_kg: Number(field('weight_kg')),
    sex: field('sex'),
    shape_reference: 'neutral',
    density_kg_m3: caps.default_density_kg_m3,
    known_measurements: {},
  })
).json();
const rigBuffer = await (await http(`/motion/${body.body_id}/rig.bin`)).arrayBuffer();
const framesBuffer = await (
  await http(`/motion/${body.body_id}/${preset}/frames.bin`)
).arrayBuffer();
const rig = parseRig(rigBuffer);
const frames = parseFrames(framesBuffer, rig.drivers.length);
const hold = frames.motion.hold;
const mid = Math.round(((hold.start_s + hold.end_s) / 2) * frames.fps);

const bones = [
  'clavicle.L',
  'clavicle.R',
  'shoulder01.L',
  'shoulder01.R',
  'upperarm01.L',
  'upperarm01.R',
  'neck01',
];
const ids = Object.fromEntries(bones.map((b) => [b, rig.bones.indexOf(b)]));
const heads = (m) =>
  Object.fromEntries(
    bones
      .filter((b) => ids[b] >= 0)
      .map((b) => [b, Array.from(boneHead(rig, m, ids[b], new Float64Array(3)))]),
  );
const m0 = new Float64Array(rig.drivers.length * 12),
  m1 = new Float64Array(rig.drivers.length * 12);
frameMatrices(frames, 0, m0);
frameMatrices(frames, mid, m1);

// Shoulder-top skin point per side: the highest rest vertex within 6 cm (horizontally) of the
// glenohumeral joint's vertical line, tracked by skinning.
const skin0 = skinVertices(rig, m0, new Float32Array(rig.vertexCount * 3));
const skin1 = skinVertices(rig, m1, new Float32Array(rig.vertexCount * 3));
const h0 = heads(m0);
const top = {};
for (const side of ['L', 'R']) {
  const g = h0[`upperarm01.${side}`];
  let best = -1,
    y = -Infinity;
  for (let v = 0; v < rig.vertexCount; v++) {
    const dx = skin0[v * 3] - g[0],
      dz = skin0[v * 3 + 2] - g[2];
    if (dx * dx + dz * dz > 0.06 ** 2) continue;
    if (skin0[v * 3 + 1] > y) {
      y = skin0[v * 3 + 1];
      best = v;
    }
  }
  top[side] = { vertex: best, riseCm: (skin1[best * 3 + 1] - skin0[best * 3 + 1]) * 100 };
}

const h1 = heads(m1);
const rise = (a, b) =>
  Object.fromEntries(Object.keys(a).map((k) => [k, Math.round((b[k][1] - a[k][1]) * 1000) / 10]));
// TS live rig for the same clamped poses.
const live = loadLiveRig(rigBuffer);
const ts0 = poseDrivers(live, frames.poses[0], {});
const ts1 = poseDrivers(live, frames.poses[mid], {});
const t0 = heads(ts0.drivers),
  t1 = heads(ts1.drivers);
const r1 = (x) => Math.round(x * 10) / 10;
console.log(
  JSON.stringify(
    {
      preset,
      holdFrame: mid,
      elevation: {
        L: r1(frames.poses[mid].shoulder_L_elevation),
        R: r1(frames.poses[mid].shoulder_R_elevation),
      },
      serverRigRiseCm: rise(h0, h1),
      tsRigRiseCm: rise(t0, t1),
      shoulderTopSkinRiseCm: { L: r1(top.L.riseCm), R: r1(top.R.riseCm) },
    },
    null,
    1,
  ),
);
