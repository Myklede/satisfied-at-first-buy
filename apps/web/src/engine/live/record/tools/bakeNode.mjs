// Bakes a recorded (or synthetic) move in Node with the same bake as the browser worker (bake.ts,
// WebAssembly kernels), on the person's own body from the local body service (8001), at the
// default solver step and with the step subdivision of subdivision.ts, and applies the sleeve
// sanity gate. No browser (and no browser lock) needed.
//   node apps/web/src/engine/live/record/tools/bakeNode.mjs --synthetic fast-reach [--out name]
//   node apps/web/src/engine/live/record/tools/bakeNode.mjs --eval .cache/v3/eval-x.json --move reach_up_both
// Privacy: the person's figures come from the gitignored data/reference-photos/toi.txt and stay in
// memory; results go to the gitignored .cache/v3/.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { wasmKernels } from '../../../cloth/wasm/kernels.ts';
import { parseArticulatedSdf } from '../../../motion/articulatedCollider.ts';
import { bakeMotion } from '../../../motion/bake.ts';
import { parseFrames, parseRig } from '../../../motion/rig.ts';
import { wasmColliderKernels } from '../../../motion/wasm/colliderKernels.ts';
import { checkSleeves } from '../RecordedBakedMove.ts';
import { subdivisionFor } from '../subdivision.ts';

const root = resolve(import.meta.dirname, '../../../../../../..');
const API = 'http://127.0.0.1:8001';
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const out = opt('--out', 'bake-node');
if (!/^[a-z0-9-]{1,32}$/.test(out)) throw new Error('--out must be [a-z0-9-]');

async function http(path, init) {
  const r = await fetch(API + path, { cache: 'no-store', ...init });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text().catch(() => '')}`);
  return r;
}
const json = async (path, body) =>
  (
    await http(
      path,
      body
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        : undefined,
    )
  ).json();
const bin = async (path, body) =>
  (
    await http(
      path,
      body
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        : undefined,
    )
  ).arrayBuffer();

function person() {
  const text = readFileSync(join(root, 'data/reference-photos/toi.txt'), 'utf8');
  const field = (key) => new RegExp(`^${key}:\\s*([^\\s#]+)`, 'm').exec(text)?.[1];
  return {
    person: {
      height_cm: Number(field('height_cm')),
      weight_kg: Number(field('weight_kg')),
      sex: field('sex'),
    },
    size: field('parka_size_worn'),
  };
}

/**
 * customRequest.customMotionRequest without its @satisfy/vision import (the vision package's
 * extensionless imports do not load in plain Node): ms → s from the first pose, pelvis drop
 * dropped, fps = max(median rate, mean rate). The service validates the rest.
 */
function request(poses) {
  const t0 = poses[0].t;
  const dts = poses
    .slice(1)
    .map((p, i) => p.t - poses[i].t)
    .sort((a, b) => a - b);
  const span = poses[poses.length - 1].t - t0;
  const fps = Math.min(
    60,
    Math.max(1, 1000 / dts[Math.floor(dts.length / 2)], ((poses.length - 1) * 1000) / span),
  );
  return {
    fps,
    poses: poses.map((p, i) => {
      const pose = { ...p.pose };
      delete pose.pelvis_drop_m;
      return { t: i === 0 ? 0 : (p.t - t0) / 1000, pose };
    }),
  };
}

/** Arms already overhead when the recording starts (as at 47 s in the video), held, then lowered. */
function heldUp(lowerS = 0.8) {
  const ease = (x) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));
  const poses = [];
  for (let i = 0; i <= 150; i++) {
    const t = i / 30;
    const up = t < 3 ? 1 : 1 - ease((t - 3) / lowerS);
    const pose = {};
    for (const side of ['L', 'R']) {
      pose[`shoulder_${side}_elevation`] = 15 + 150 * up;
      pose[`shoulder_${side}_plane`] = 30;
      pose[`elbow_${side}_flexion`] = 15 - 5 * up;
    }
    poses.push({ t: t * 1000, pose });
  }
  return poses;
}

/** A fast double-arm raise, sampled at 30 fps (t in ms): down, up in `raiseS`, hold, down. */
function fastReach(raiseS = 0.4, lowerS = 0.5) {
  const ease = (x) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));
  const poses = [];
  for (let i = 0; i <= Math.round((2.4 + lowerS + 0.6) * 30); i++) {
    const t = i / 30;
    const up =
      t < 0.5
        ? 0
        : t < 0.5 + raiseS
          ? ease((t - 0.5) / raiseS)
          : t < 2.4
            ? 1
            : ease(1 - (t - 2.4) / lowerS);
    const pose = {};
    for (const s of ['L', 'R']) {
      pose[`shoulder_${s}_elevation`] = 15 + 150 * up;
      pose[`shoulder_${s}_plane`] = 30;
      pose[`elbow_${s}_flexion`] = 15 - 5 * up;
    }
    poses.push({ t: t * 1000, pose });
  }
  return poses;
}

async function main() {
  const { person: who, size } = person();
  let poses = null;
  const preset = opt('--preset', null);
  if (preset && !/^[a-z_]{1,32}$/.test(preset)) throw new Error('bad preset id');
  if (preset) {
    /* the preset's own frames are fetched below */
  } else if (args.includes('--eval')) {
    const evalJson = JSON.parse(readFileSync(resolve(root, opt('--eval')), 'utf8'));
    const move = evalJson.moves.find((m) => m.id === opt('--move', 'reach_up_both'));
    if (!move) throw new Error('move not found in the eval file');
    poses = move.recordedPoses;
  } else if (opt('--synthetic') === 'held-up') poses = heldUp(Number(opt('--lower-s', '0.8')));
  else poses = fastReach(Number(opt('--raise-s', '0.4')), Number(opt('--lower-s', '0.5')));

  const [caps, options, products] = await Promise.all([
    json('/body/capabilities'),
    json('/garment/options'),
    json('/products'),
  ]);
  const product = products.find((p) => p.style === 'FB7675-100');
  const body = await json('/body/fit', {
    ...who,
    shape_reference: 'neutral',
    density_kg_m3: caps.default_density_kg_m3,
    known_measurements: {},
  });
  const garment = await json('/fit/garment', {
    body_id: body.body_id,
    product_id: product.product_id,
    layer_cm: options.layer_presets_cm.hoodie,
    preference: 'regular',
  });
  const id = body.body_id;
  const [rigBuffer, sdfBuffer, anchors, asset] = await Promise.all([
    bin(`/motion/${id}/rig.bin`),
    bin(`/motion/${id}/sdf.bin`),
    json(`/motion/${id}/anchors`),
    json(`/fit/${garment.fit_id}/${size}/cloth`),
  ]);
  const grid = new Float32Array(await bin(`/collision/${asset.sdf.sdf_id}.bin`));
  const rig = parseRig(rigBuffer);
  const sdf = parseArticulatedSdf(sdfBuffer, rig);
  const frames = parseFrames(
    preset
      ? await bin(`/motion/${id}/${preset}/frames.bin`)
      : await bin(`/motion/${id}/custom/frames.bin`, request(poses)),
    rig.drivers.length,
  );
  const auto = subdivisionFor(frames, asset.config.dt);
  console.log(
    `[v3] ${poses ? `${poses.length} poses` : `preset ${preset}`}, ${frames.count} frames; peak joint ${auto.peakJoint} ` +
      `${auto.peakSpeedMs.toFixed(2)} m/s at frame ${auto.peakFrame}; subdivision ×${auto.factor}`,
  );
  const runs = [];
  for (const factor of [...new Set([1, auto.factor])]) {
    const config = factor > 1 ? { dt: asset.config.dt / factor } : undefined;
    const bake = bakeMotion({ asset, grid, rig, sdf, frames, anchors, size }, undefined, {
      kernels: wasmKernels,
      colliderKernels: wasmColliderKernels,
      ...(config ? { config } : {}),
    });
    const sleeves = checkSleeves(bake, frames, asset);
    // Hem above the hip line (low waistband) and the mid waistband, front / back / sides
    // (ring 0 / 16 / max of 8 and 24), at frame 0 and at the peak of the front rise.
    const hemAt = (f, level) => {
      const v = bake.metrics[f].hemAboveCm[level];
      return { front: v[0], back: v[16], sides: Math.max(v[8], v[24]) };
    };
    const rise = (f) => hemAt(f, 'low').front - hemAt(0, 'low').front;
    let peak = 0;
    for (let f = 0; f < bake.frameCount; f++) if (rise(f) > rise(peak)) peak = f;
    const hem = {
      neutralAboveHipCm: hemAt(0, 'low'),
      peakAboveHipCm: hemAt(peak, 'low'),
      peakAboveMidWaistbandCm: hemAt(peak, 'mid'),
      peakS: peak / frames.fps,
      riseCm: {
        front: hemAt(peak, 'low').front - hemAt(0, 'low').front,
        back: hemAt(peak, 'low').back - hemAt(0, 'low').back,
        sides: hemAt(peak, 'low').sides - hemAt(0, 'low').sides,
      },
    };
    const run = {
      factor,
      sleeves,
      timings: bake.timings,
      checks: bake.checks,
      wristRideUp: bake.summary.wrist,
      exposureMid: bake.summary.exposure.mid,
      hem,
      assetKey: bake.assetKey,
    };
    runs.push(run);
    console.log(
      `[v3] factor ${factor}: sleeves ${sleeves.valid ? 'stay on' : 'LOST'} ` +
        `(max ride-up L ${sleeves.maxRideUpCm.L.toFixed(1)} R ${sleeves.maxRideUpCm.R.toFixed(1)} cm; ` +
        `cuff-to-wrist L ${sleeves.maxCuffToWristCm.L.toFixed(1)} R ${sleeves.maxCuffToWristCm.R.toFixed(1)} cm; ` +
        `forearm ${sleeves.forearmCm.L.toFixed(1)} cm) ${sleeves.reason ?? ''}; bake ` +
        `${(bake.timings.totalMs / 1000).toFixed(1)} s (${bake.timings.steps} steps)`,
    );
    const r1 = (_k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v);
    console.log(
      `[v3] hem ${JSON.stringify(hem, r1)}; exposure mid ${JSON.stringify(bake.summary.exposure.mid, r1)}`,
    );
  }
  mkdirSync(join(root, '.cache/v3'), { recursive: true });
  writeFileSync(
    join(root, '.cache/v3', `${out}.json`),
    JSON.stringify(
      {
        source: preset ? `preset ${preset}` : args.includes('--eval') ? 'recorded' : 'synthetic',
        subdivision: auto,
        runs,
      },
      null,
      1,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
