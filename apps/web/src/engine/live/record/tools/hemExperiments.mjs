// Controlled experiment on the hem lift (V3, lead's request): bake one preset on the person's own
// body (local body service 8001, figures from the gitignored toi.txt) with solver-config variants,
// and measure what lifts the hem. Same bake as the worker (bake.ts, WebAssembly kernels); every
// variant starts from its own relax. Runs inside the browser lock (heavy CPU, prompts/12 §2).
//   node apps/web/src/engine/live/record/tools/hemExperiments.mjs [--preset reach_up_both]
//        [--product FB7675-100] [--variants name=json;name=json] [--out hem-exp]
//        [--api-port 5773] (V3's ridge-on service: python -m body_service.motion.ridge_parity --serve)
// Output (numbers only): .cache/v3/<out>.json.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { acquireTimingSlot } from '../../../../../../../scripts/codex-heavy-slot.mjs';
import { join, resolve } from 'node:path';
import { wasmKernels } from '../../../cloth/wasm/kernels.ts';
import { ArticulatedCollider, parseArticulatedSdf } from '../../../motion/articulatedCollider.ts';
import { RESTRICTION_ZONES, garmentTopology } from '../../../motion/metrics.ts';
import { frameMatrices, skinVertices } from '../../../motion/rig.ts';
import { bakeMotion } from '../../../motion/bake.ts';
import { parseFrames, parseRig } from '../../../motion/rig.ts';
import { wasmColliderKernels } from '../../../motion/wasm/colliderKernels.ts';
import { checkSleeves } from '../RecordedBakedMove.ts';

const root = resolve(import.meta.dirname, '../../../../../../..');
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const dumpRel = opt(
  '--dump-dir',
  args.includes('--neutral') ? '.cache/cx-day/physics/dumps/day-p-18' : '.cache/v3/render',
);
if (
  dumpRel !== '.cache/v3/render' &&
  !/^\.cache\/cx-day\/physics\/dumps\/[a-z0-9-]{1,48}$/.test(dumpRel)
)
  throw new Error('Invalid private dump directory');
const dumpDir = join(root, dumpRel);
const apiPort = Number(opt('--api-port', '8001'));
if (
  ![8001, 5770, 5771, 5772, 5773, 5774, 5775, 5776, 5805, 5806, 5807, 5808, 5809].includes(apiPort)
)
  throw new Error('bad --api-port');
const API = `http://127.0.0.1:${apiPort}`;
// --rig-file / --sdf-file: local rig.bin / sdf.bin for the same body (e.g. the shoulder-ridge
// switch on, written under .cache/v3/), everything else from the service.
const localFile = (flag) => {
  const rel = opt(flag, '');
  if (!rel) return null;
  if (!/^[a-z0-9_-]{1,32}\/[a-z0-9_-]{1,32}\.bin$/.test(rel)) throw new Error(`bad ${flag}`);
  const b = readFileSync(join(root, '.cache/v3', rel));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const rigFile = localFile('--rig-file'),
  sdfFile = localFile('--sdf-file');
const sha = (data) => createHash('sha256').update(data).digest('hex').slice(0, 16);
const preset = opt('--preset', 'reach_up_both');
const style = opt('--product', 'FB7675-100');
const out = opt('--out', 'hem-exp');
if (!/^[a-z_]{1,32}$/.test(preset) || !/^[a-z0-9_-]{1,40}$/.test(out)) throw new Error('bad args');
const DEFAULT_VARIANTS = 'baseline={}';
const variants = opt('--variants', DEFAULT_VARIANTS)
  .split(';')
  .filter(Boolean)
  .map((v) => {
    const [name, json] = [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)];
    const config = JSON.parse(json);
    for (const [k, x] of Object.entries(config))
      if (!/^[a-zA-Z]{1,40}$/.test(k) || typeof x !== 'number' || !Number.isFinite(x))
        throw new Error(`bad override ${k}`);
    return { name, config };
  });
const log = (m) => console.log(`[v3-hem] ${m}`);

const worker = opt('--worker', 'CX-DAY/DAY-P');
let releaseLease = () => {};
async function acquire() {
  releaseLease = await acquireTimingSlot(worker, 'physics bake');
}
function release() {
  releaseLease();
}
function verifyOuterLocks() {
  for (const kind of ['browser', 'heavy']) {
    const owner = readFileSync(join(root, '.cache/locks', kind, 'owner.txt'), 'utf8');
    if (!owner.startsWith(worker + '\n') && !owner.startsWith(worker + ' '))
      throw new Error('Caller must hold both locks as ' + worker);
  }
}

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
const json = async (p, b) => (await http(p, b)).json();
const bin = async (p) => (await http(p)).arrayBuffer();

function person() {
  // Neutral reproducible fixture, never accesses the private body reference.
  if (args.includes('--neutral'))
    return { who: { height_cm: 178, weight_kg: 72, sex: 'male' }, size: 'S' };
  const text = readFileSync(join(root, 'data/reference-photos/toi.txt'), 'utf8');
  const field = (key) => new RegExp(`^${key}:\\s*([^\\s#]+)`, 'm').exec(text)?.[1];
  return {
    who: {
      height_cm: Number(field('height_cm')),
      weight_kg: Number(field('weight_kg')),
      sex: field('sex'),
    },
    size: field(style === 'FB7675-100' ? 'parka_size_worn' : 'puffer_size_worn'),
  };
}

async function main() {
  const { who, size } = person();
  const [caps, options, products] = await Promise.all([
    json('/body/capabilities'),
    json('/garment/options'),
    json('/products'),
  ]);
  const product = products.find((p) => p.style === style);
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
  const [serverRig, serverSdf, anchors, asset, framesBuffer] = await Promise.all([
    bin(`/motion/${id}/rig.bin`),
    bin(`/motion/${id}/sdf.bin`),
    json(`/motion/${id}/anchors`),
    json(`/fit/${garment.fit_id}/${size}/cloth`),
    bin(`/motion/${id}/${preset}/frames.bin`),
  ]);
  const rigBuffer = rigFile ?? serverRig,
    sdfBuffer = sdfFile ?? serverSdf;
  const grid = new Float32Array(await bin(`/collision/${asset.sdf.sdf_id}.bin`));
  const rig = parseRig(rigBuffer);
  const sdf = parseArticulatedSdf(sdfBuffer, rig);
  const frames = parseFrames(framesBuffer, rig.drivers.length);
  const hold = frames.motion.hold;
  const holdFrames = [Math.round(hold.start_s * frames.fps), Math.round(hold.end_s * frames.fps)];
  const roots = [...new Set((asset.tethers ?? []).filter((_, i) => i % 2 === 0))];
  const edgeSet = new Set();
  const edgeList = [];
  const addEdge = (a, b) => {
    const key = a < b ? a * 1e6 + b : b * 1e6 + a;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edgeList.push(a, b);
  };
  for (let t = 0; t < asset.triangles.length; t += 3) {
    const [a, b, c] = [asset.triangles[t], asset.triangles[t + 1], asset.triangles[t + 2]];
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  }
  for (let w = 0; w < (asset.welds ?? []).length; w += 2)
    addEdge(asset.welds[w], asset.welds[w + 1]);
  const restLength = edgeList
    .map((_, i) => i)
    .filter((i) => i % 2 === 0)
    .map((i) => {
      const a = edgeList[i] * 3,
        b = edgeList[i + 1] * 3,
        r = asset.rest;
      return Math.hypot(r[a] - r[b], r[a + 1] - r[b + 1], r[a + 2] - r[b + 2]);
    });
  let restFrame0 = null;
  const hemIds = asset.paths.hem.slice(0, -1);
  const neckIds = asset.paths.neckline.slice(0, -1);
  // Prompt18: bake timings hold browser THEN heavy. --no-lock requires a verified outer lease.
  if (!args.includes('--no-lock')) await acquire();
  else verifyOuterLocks();
  const loadAtStart = { freeRamGiB: Math.round((freemem() / 2 ** 30) * 10) / 10 };
  const results = [];
  try {
    for (const v of variants) {
      const started = Date.now();
      // rootArmWeightMax is a bake option (root anchor binding), not a solver config key.
      const {
        rootArmWeightMax,
        armholeStop,
        armholeBandM,
        armholeStiffness,
        armholeToAnchor,
        armholeLra,
        armholeLraVertical,
        ...config
      } = v.config;
      const bakeStarted = performance.now();
      const bake = bakeMotion({ asset, grid, rig, sdf, frames, anchors, size }, undefined, {
        kernels: wasmKernels,
        colliderKernels: wasmColliderKernels,
        config,
        ...(rootArmWeightMax !== undefined ? { rootArmWeightMax } : {}),
        ...(armholeStop !== undefined
          ? {
              armholeStop:
                armholeStop === 1
                  ? {
                      ...(armholeBandM !== undefined ? { bandM: armholeBandM } : {}),
                      ...(armholeStiffness !== undefined ? { stiffness: armholeStiffness } : {}),
                      ...(armholeToAnchor === 1 ? { direction: 'anchor' } : {}),
                      ...(armholeLra !== undefined ? { lra: armholeLra } : {}),
                      ...(armholeLraVertical === 1 ? { lraMode: 'vertical' } : {}),
                    }
                  : false,
            }
          : {}),
      });
      const bakeDurationMs = performance.now() - bakeStarted;
      const n = bake.particles * 3;
      const meanY = (ids, f) =>
        ids.reduce((s, i) => s + bake.positions[f * n + i * 3 + 1], 0) / ids.length;
      const hemAt = (f, level) => {
        const x = bake.metrics[f].hemAboveCm[level];
        return { front: x[0], back: x[16], sides: Math.max(x[8], x[24]) };
      };
      // Mean over the hold (the measured peak pose of the preset).
      const holdMean = (fn) => {
        const vals = [];
        for (let f = holdFrames[0]; f <= holdFrames[1]; f++) vals.push(fn(f));
        return vals.reduce((a, b) => a + b, 0) / vals.length;
      };
      const r1 = (x) => Math.round(x * 10) / 10;
      // Edge strain (len / rest - 1) at frame f: percentiles over all edges, and the share above
      // 10 % inside the underarm (edges touching the armpit zone) and outside it.
      const strainDistribution = (f) => {
        const topo0 = garmentTopology(asset, bake.positions.subarray(0, n), new Uint32Array(0));
        const armpitZone = RESTRICTION_ZONES.indexOf('armpit');
        const all = [],
          outside = [];
        let underarmCount = 0,
          underarmOver = 0,
          outsideOver = 0;
        for (let e = 0; e < restLength.length; e++) {
          const rest = restLength[e];
          if (!(rest > 1e-6)) continue;
          const a = f * n + edgeList[e * 2] * 3,
            b = f * n + edgeList[e * 2 + 1] * 3,
            q = bake.positions;
          const strain =
            Math.hypot(q[a] - q[b], q[a + 1] - q[b + 1], q[a + 2] - q[b + 2]) / rest - 1;
          all.push(strain);
          const underarm =
            topo0.zone[edgeList[e * 2]] === armpitZone ||
            topo0.zone[edgeList[e * 2 + 1]] === armpitZone;
          if (underarm) {
            underarmCount++;
            if (strain > 0.1) underarmOver++;
          } else {
            outside.push(strain);
            if (strain > 0.1) outsideOver++;
          }
        }
        const pct = (arr, q) => {
          const sorted = Float64Array.from(arr).sort();
          return (
            Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] * 1e4) /
            1e4
          );
        };
        return {
          edges: all.length,
          p50: pct(all, 0.5),
          p95: pct(all, 0.95),
          p99: pct(all, 0.99),
          shareOver10pct: Math.round((all.filter((x) => x > 0.1).length / all.length) * 1e5) / 1e5,
          underarm: {
            edges: underarmCount,
            shareOver10pctOfAll: Math.round((underarmOver / all.length) * 1e5) / 1e5,
          },
          outside: {
            p99: pct(outside, 0.99),
            shareOver10pctOfAll: Math.round((outsideOver / all.length) * 1e5) / 1e5,
          },
        };
      };
      // Rest pose: largest frame-0 cloth difference from the first variant (cm).
      const restDelta = () => {
        const f0 = bake.positions.subarray(0, n);
        if (!restFrame0) {
          restFrame0 = Float32Array.from(f0);
          return 0;
        }
        let worst = 0;
        for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(f0[i] - restFrame0[i]));
        return r1(worst * 100);
      };
      // Where the cloth is inside the body at the middle of the hold: count and deepest per zone
      // (metrics.ts restriction zones on the frame-0 cloth).
      const mid = Math.round((holdFrames[0] + holdFrames[1]) / 2);
      const m = new Float64Array(rig.drivers.length * 12);
      frameMatrices(frames, mid, m);
      const probe = new ArticulatedCollider(sdf, rig).setFrame(m);
      const topo = garmentTopology(asset, bake.positions.subarray(0, n), new Uint32Array(0));
      const inside = {};
      for (let i = 0; i < bake.particles; i++) {
        const k = mid * n + i * 3;
        const d = probe.distance(bake.positions[k], bake.positions[k + 1], bake.positions[k + 2]);
        if (d < -0.005) {
          const z = RESTRICTION_ZONES[topo.zone[i]];
          const e = (inside[z] ??= { count: 0, deepestCm: 0 });
          e.count++;
          e.deepestCm = Math.max(e.deepestCm, r1(-d * 100));
        }
      }
      const sleeves = checkSleeves(bake, frames, asset);
      const row = {
        variant: v.name,
        config: v.config,
        hemAboveHipCm: {
          neutral: r1(hemAt(0, 'low').front),
          holdFront: r1(holdMean((f) => hemAt(f, 'low').front)),
          holdBack: r1(holdMean((f) => hemAt(f, 'low').back)),
          holdSides: r1(holdMean((f) => hemAt(f, 'low').sides)),
        },
        hemRiseCm: {
          front: r1(holdMean((f) => hemAt(f, 'low').front) - hemAt(0, 'low').front),
          back: r1(holdMean((f) => hemAt(f, 'low').back) - hemAt(0, 'low').back),
          sides: r1(holdMean((f) => hemAt(f, 'low').sides) - hemAt(0, 'low').sides),
          meanHemRingY: r1(holdMean((f) => (meanY(hemIds, f) - meanY(hemIds, 0)) * 100)),
        },
        yokeLiftCm: r1(holdMean((f) => (meanY(roots, f) - meanY(roots, 0)) * 100)),
        collarRiseCm: r1(holdMean((f) => (meanY(neckIds, f) - meanY(neckIds, 0)) * 100)),
        sleeves: {
          valid: sleeves.valid,
          maxRideUpCm: { L: r1(sleeves.maxRideUpCm.L), R: r1(sleeves.maxRideUpCm.R) },
        },
        exposureMidCm: bake.summary.exposure.mid,
        insideAtHoldMid: inside,
        strainAtHoldMid: strainDistribution(mid),
        restDeltaCm: restDelta(),
        // Where the fabric is stretched: peak edge strain (len/rest - 1) per restriction zone.
        zonePeakStrain: Object.fromEntries(
          bake.summary.restriction.map((r) => [r.zone, Math.round(r.peakStrain * 1000) / 1000]),
        ),
        checks: {
          maxPenetrationCm: r1(bake.checks.maxPenetrationCm),
          penetratingShare: Math.round(bake.checks.penetratingShare * 1e4) / 1e4,
          maxStrain: Math.round(bake.checks.maxStrain * 1e3) / 1e3,
          finite: bake.checks.finite,
        },
        bakeS: bakeDurationMs / 1000,
        metricsAndBakeS: (Date.now() - started) / 1000,
        positionsSha256: createHash('sha256')
          .update(
            Buffer.from(
              bake.positions.buffer,
              bake.positions.byteOffset,
              bake.positions.byteLength,
            ),
          )
          .digest('hex'),
        framePositionHashes: Array.from({ length: bake.positions.length / n }, (_, f) =>
          sha(Buffer.from(bake.positions.buffer, bake.positions.byteOffset + f * n * 4, n * 4)),
        ),
      };
      results.push(row);
      // Render inputs for the avatar-only frame at mid-hold (gitignored .cache/v3/render/):
      // skinned body, simulated cloth, triangles. No camera image.
      {
        const dir = dumpDir;
        mkdirSync(dir, { recursive: true });
        const tag = `${preset}-${v.name}`;
        const body = skinVertices(rig, m, new Float32Array(rig.vertexCount * 3));
        writeFileSync(join(dir, `${tag}-body.f32`), Buffer.from(body.buffer));
        writeFileSync(
          join(dir, `${tag}-cloth.f32`),
          Buffer.from(Float32Array.from(bake.positions.subarray(mid * n, mid * n + n)).buffer),
        );
        writeFileSync(join(dir, 'faces.u32'), Buffer.from(Uint32Array.from(rig.faces).buffer));
        writeFileSync(
          join(dir, 'triangles.u32'),
          Buffer.from(Uint32Array.from(asset.triangles).buffer),
        );
      }
      log(
        `${v.name}: hem rise F ${row.hemRiseCm.front} B ${row.hemRiseCm.back} S ${row.hemRiseCm.sides} ` +
          `(ring ${row.hemRiseCm.meanHemRingY}); hem vs hip F ${row.hemAboveHipCm.holdFront}; ` +
          `yoke +${row.yokeLiftCm}; collar +${row.collarRiseCm}; sleeves ${sleeves.valid ? 'on' : 'LOST'} ` +
          `(${row.sleeves.maxRideUpCm.L}/${row.sleeves.maxRideUpCm.R}); pen ${row.checks.maxPenetrationCm} cm ` +
          `share ${row.checks.penetratingShare} [inside ${JSON.stringify(inside)}]; strain ${row.checks.maxStrain} ` +
          `[p50 ${row.strainAtHoldMid.p50} p95 ${row.strainAtHoldMid.p95} p99 ${row.strainAtHoldMid.p99} >10%: all ${row.strainAtHoldMid.shareOver10pct} underarm ${row.strainAtHoldMid.underarm.shareOver10pctOfAll} outside ${row.strainAtHoldMid.outside.shareOver10pctOfAll} outside-p99 ${row.strainAtHoldMid.outside.p99}; rest d ${row.restDeltaCm} cm] (${Object.entries(
            row.zonePeakStrain,
          )
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([z, x]) => `${z} ${x}`)
            .join(', ')}); ${row.bakeS} s`,
      );
      mkdirSync(join(root, '.cache/v3'), { recursive: true });
      writeFileSync(
        join(root, '.cache/v3', `${out}.json`),
        JSON.stringify(
          {
            preset,
            style,
            size,
            loadAtStart,
            assetKey: bake.assetKey.split(':').slice(1).join(':'),
            // Same inputs across services, except the rig's skinning mode (ridge on 5773).
            inputs: {
              apiPort,
              rigFile: opt('--rig-file', null),
              sdfFile: opt('--sdf-file', null),
              serverRigSha: sha(new Uint8Array(serverRig)),
              serverSdfSha: sha(new Uint8Array(serverSdf)),
              rigSha: sha(new Uint8Array(rigBuffer)),
              skinning: rig.ridge ? 'lbs-ridge1' : 'lbs',
              framesSha: sha(new Uint8Array(framesBuffer)),
              clothSha: sha(JSON.stringify(asset)),
              sdfSha: sha(new Uint8Array(sdfBuffer)),
            },
            results,
          },
          null,
          1,
        ),
      );
    }
  } finally {
    release();
  }
}
main().catch((e) => {
  console.error(e);
  release();
  process.exit(1);
});
