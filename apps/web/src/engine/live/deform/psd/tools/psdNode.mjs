// PSD offline tool (agent V7): bakes the pose-space corrective samples in Node with the same code
// as the browser worker (bakeSamples.ts → motion/bake.ts bakeMotion, WebAssembly kernels), on the
// NEUTRAL reference body from the local body service (8001), and validates them against true
// solves of hold-out poses. Numbers and caches go to the gitignored .cache/v7/.
//   node apps/web/src/engine/live/deform/psd/tools/psdNode.mjs train   [--product FB7675-100] [--size S] [--out parka-s]
//   node apps/web/src/engine/live/deform/psd/tools/psdNode.mjs holdout [--product ...] [--out parka-s]
//   node apps/web/src/engine/live/deform/psd/tools/psdNode.mjs eval    [--out parka-s]
// Options: --settle s (hold per key pose), --chains id,id, --armhole (bake with the armhole stop on).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import './tsHooks.mjs';

// Engine modules load after the TypeScript hook is registered.
const { wasmKernels } = await import('../../../../cloth/wasm/kernels.ts');
const { wasmColliderKernels } = await import('../../../../motion/wasm/colliderKernels.ts');
const { bakeChain } = await import('../bakeSamples.ts');
const { PSD } = await import('../config.ts');
const { fitModel } = await import('../model.ts');
const { HOLDOUT_POSES, scheduleChain, TRAINING_CHAINS } = await import('../poses.ts');
const { loadNeutral } = await import('./nodeData.mjs');

const root = resolve(import.meta.dirname, '../../../../../../../..');
const args = process.argv.slice(2);
const mode = args[0] ?? 'train';
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const style = opt('--product', 'FB7675-100');
const size = opt('--size', 'S');
const out = opt('--out', 'parka-s');
if (
  !/^[A-Z0-9-]{1,20}$/.test(style) ||
  !/^[A-Z]{1,4}$/.test(size) ||
  !/^[a-z0-9-]{1,40}$/.test(out)
)
  throw new Error('bad args');
const settleS = Number(opt('--settle', String(PSD.settleS)));
const armhole = args.includes('--armhole');
const bakeOptions = armhole ? { armholeStop: true } : undefined;
const dir = join(root, '.cache/v7');
mkdirSync(dir, { recursive: true });
const log = (m) => console.log(`[v7] ${m}`);
const gib = () => (freemem() / 2 ** 30).toFixed(2);

/** Samples / solves: one JSON (meta) + one Float32 blob per array. */
function save(name, meta, arrays) {
  let offset = 0;
  const index = arrays.map((a) => {
    const e = { offset, length: a.length };
    offset += a.length;
    return e;
  });
  const blob = new Float32Array(offset);
  arrays.forEach((a, i) => blob.set(a, index[i].offset));
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ ...meta, index }));
  writeFileSync(join(dir, `${name}.bin`), new Uint8Array(blob.buffer));
}
export function load(name) {
  const meta = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
  const bytes = readFileSync(join(dir, `${name}.bin`));
  const blob = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  return { meta, arrays: meta.index.map((e) => blob.subarray(e.offset, e.offset + e.length)) };
}

async function train() {
  log(`free RAM ${gib()} GiB; ${style} ${size}; settle ${settleS} s; armhole ${armhole}`);
  const t0 = performance.now();
  const data = await loadNeutral(style, size);
  const loadMs = performance.now() - t0;
  log(`loaded in ${loadMs.toFixed(0)} ms: ${data.skin.count} particles; asset ${data.asset.key}`);
  const input = { ...data, skin: data.binding, bound: data.binding.bound };
  const relaxCache = {};
  const pick = opt('--chains', null)?.split(',');
  const chains = TRAINING_CHAINS.filter((c) => !pick || pick.includes(c.id));
  const samples = [],
    solved = [],
    report = [];
  let neutralLocal = null;
  const started = performance.now();
  for (const chain of chains) {
    const c0 = performance.now();
    const schedule = scheduleChain(
      chain.poses.map((p) => p.pose),
      data.rig.neutralPose,
      settleS,
    );
    const frames = await data.frames(schedule.request);
    const framesMs = performance.now() - c0;
    const result = bakeChain(input, chain, schedule.sampleTimes, frames, {
      relaxCache,
      kernels: wasmKernels,
      colliderKernels: wasmColliderKernels,
      keepSolved: true,
      bakeOptions,
    });
    neutralLocal ??= result.neutralLocal;
    samples.push(...result.samples);
    result.solved.forEach((s, i) => solved.push({ id: chain.poses[i].id, ...s }));
    const wallMs = performance.now() - c0;
    const entry = {
      chain: chain.id,
      simulatedS: schedule.durationS,
      framesMs,
      relaxMs: result.timings.relaxMs,
      relaxCached: result.timings.relaxCached,
      motionMs: result.timings.motionMs,
      steps: result.timings.steps,
      meanStepMs: result.timings.meanStepMs,
      wallMs,
      readyAtMs: performance.now() - started,
      settle: result.settle,
      maxPenetrationCm: result.checks.maxPenetrationCm,
      maxStrain: result.checks.maxStrain,
    };
    report.push(entry);
    log(
      `${chain.id}: ${schedule.durationS.toFixed(1)} s sim, ${entry.steps} steps × ${entry.meanStepMs.toFixed(1)} ms; ` +
        `wall ${(wallMs / 1000).toFixed(1)} s (ready at ${(entry.readyAtMs / 1000).toFixed(1)} s); settle p95 ` +
        result.settle.map((s) => `${s.id} ${s.p95Cm.toFixed(2)}`).join(', ') +
        ` cm; RAM ${gib()} GiB`,
    );
  }
  const totalMs = performance.now() - started;
  // Neutral residual: what the bake's relax changed against the live preview's drape (local).
  const n = data.skin.count;
  const res = Array.from({ length: n }, (_, i) =>
    Math.hypot(neutralLocal[i * 3], neutralLocal[i * 3 + 1], neutralLocal[i * 3 + 2]),
  ).sort((a, b) => a - b);
  const neutralResidualCm = {
    mean: (res.reduce((s, v) => s + v, 0) / n) * 100,
    p95: res[Math.floor(0.95 * n)] * 100,
    max: res[n - 1] * 100,
  };
  const f0 = performance.now();
  const model = fitModel(samples, data.rig.neutralPose, data.binding.bound, data.binding.key);
  const fitMs = performance.now() - f0;
  log(
    `bake total ${(totalMs / 1000).toFixed(1)} s (+ load ${(loadMs / 1000).toFixed(1)} s); fit ${fitMs.toFixed(0)} ms; ` +
      `${model.components} components (PCA rms ${(model.pcaRms * 100).toFixed(2)} cm); arm σ ${model.armL.sigma} λ ${model.armL.lambda}` +
      (model.trunk ? `; trunk σ ${model.trunk.sigma} λ ${model.trunk.lambda}` : ''),
  );
  log(
    `neutral residual (relaxed bake drape vs live drape): mean ${neutralResidualCm.mean.toFixed(2)} p95 ${neutralResidualCm.p95.toFixed(2)} max ${neutralResidualCm.max.toFixed(2)} cm`,
  );
  save(
    `${out}-samples`,
    {
      style,
      size,
      settleS,
      armhole,
      bodyId: 'neutral-reference',
      assetKey: data.asset.key,
      samples: samples.map((s) => ({ id: s.id, kind: s.kind, pose: s.pose, mirror: s.mirror })),
      solved: solved.map((s) => ({ id: s.id })),
      report,
      totalMs,
      loadMs,
      fitMs,
      neutralResidualCm,
      components: model.components,
      pcaRms: model.pcaRms,
    },
    [
      neutralLocal,
      ...samples.map((s) => s.field),
      ...solved.flatMap((s) => [s.positions, Float32Array.from(s.drivers)]),
    ],
  );
  log(`saved .cache/v7/${out}-samples.json/.bin`);
}

async function holdout() {
  log(`free RAM ${gib()} GiB; hold-out true solves, ${style} ${size}; armhole ${armhole}`);
  const data = await loadNeutral(style, size);
  const input = { ...data, skin: data.binding, bound: data.binding.bound };
  const relaxCache = {};
  const pick = opt('--only', null)?.split(',');
  const poses = HOLDOUT_POSES.filter((h) => !pick || pick.includes(h.id));
  const results = [];
  for (const h of poses) {
    const c0 = performance.now();
    // From the neutral drape: ramp of at least 1 s at the presets' speed, a 0.6 s hold, 30 fps.
    const schedule = scheduleChain([h.pose], data.rig.neutralPose, 0.6, 1.0);
    const frames = await data.frames(schedule.request);
    const r = bakeChain(
      input,
      { id: h.id, poses: [{ id: h.id, kind: 'arm', pose: h.pose }] },
      schedule.sampleTimes,
      frames,
      {
        relaxCache,
        kernels: wasmKernels,
        colliderKernels: wasmColliderKernels,
        keepSolved: true,
        fps: 30,
        bakeOptions,
      },
    );
    results.push({ h, r });
    log(
      `${h.id}: ${((performance.now() - c0) / 1000) | 0} s; settle p95 ${r.settle[0].p95Cm.toFixed(2)} cm`,
    );
  }
  // reach_up_both: the preset itself (its hold end, 2.5 s). --no-preset skips it.
  if (args.includes('--no-preset')) {
    save(
      `${out}-holdout`,
      {
        style,
        size,
        armhole,
        holdouts: results.map(({ h, r }) => ({
          id: h.id,
          pose: h.pose,
          settle: r.settle[0],
          checks: r.checks,
        })),
      },
      results.flatMap(({ r }) => [
        r.samples[0].field,
        r.solved[0].positions,
        Float32Array.from(r.solved[0].drivers),
        r.neutralLocal,
      ]),
    );
    log(`saved .cache/v7/${out}-holdout.json/.bin`);
    return;
  }
  const c0 = performance.now();
  const preset = await data.preset('reach_up_both');
  const holdEnd = Math.round(preset.motion.hold.end_s * 30);
  const pose = preset.motion.keyframes[1].pose;
  const r = bakeChain(
    input,
    { id: 'reach_up_both', poses: [{ id: 'reach_up_both', kind: 'arm', pose }] },
    [holdEnd / 30],
    preset,
    {
      relaxCache,
      kernels: wasmKernels,
      colliderKernels: wasmColliderKernels,
      keepSolved: true,
      fps: 30,
      bakeOptions,
    },
  );
  results.push({ h: { id: 'reach_up_both', pose }, r });
  log(`reach_up_both preset: ${((performance.now() - c0) / 1000) | 0} s`);
  save(
    `${out}-holdout`,
    {
      style,
      size,
      armhole,
      holdouts: results.map(({ h, r }) => ({
        id: h.id,
        pose: h.pose,
        settle: r.settle[0],
        checks: r.checks,
      })),
    },
    results.flatMap(({ r }) => [
      r.samples[0].field,
      r.solved[0].positions,
      Float32Array.from(r.solved[0].drivers),
      r.neutralLocal,
    ]),
  );
  log(`saved .cache/v7/${out}-holdout.json/.bin`);
}

/** Side-by-side frames (LBS | PSD | true solve), after the evaluation, to .cache/v7/. */
async function render() {
  const { evaluate } = await import('./psdEval.mjs');
  const { renderComparison } = await import('./render.mjs');
  const { skinVertices } = await import('../../../../motion/rig.ts');
  const { scenes, data } = await evaluate({ dir, out, style, size, load });
  const names = (
    opt('--poses', null) ??
    'relaxed,reach_up_both,raise-mid,reach-up-one,cross-arms-preset,hug-wide'
  ).split(',');
  for (const name of names) {
    const sc = scenes[name];
    if (!sc) continue;
    const body = skinVertices(data.rig, sc.drivers, new Float32Array(data.rig.vertexCount * 3));
    const file = join(dir, `render-${out}-${name}.png`);
    renderComparison(file, {
      body,
      bodyFaces: data.rig.faces,
      triangles: data.asset.triangles,
      jacketColour: [120, 142, 180], // false colour, for contrast with the body
      variants: [
        { bar: [150, 150, 150], positions: sc.lbs },
        { bar: [40, 110, 220], positions: sc.psd },
        { bar: [40, 170, 80], positions: sc.truth },
      ],
    });
    log(`wrote .cache/v7/render-${out}-${name}.png`);
  }
}

if (mode === 'train') await train();
else if (mode === 'holdout') await holdout();
else if (mode === 'render') await render();
else if (mode === 'eval')
  await import('./psdEval.mjs').then((m) => m.evaluate({ dir, out, style, size, load }));
else throw new Error(`unknown mode ${mode}`);
if (!existsSync(dir)) process.exit(1);
