// PSD validation (agent V7), run by psdNode.mjs `eval`: fits the model on the training samples
// and compares it with TRUE solves of hold-out poses (psdNode.mjs `holdout`), per region, in cm.
// Also: training reproduction, penetrations, hem/collar lift on reach_up_both, the relaxed-arm
// sleeve gap, and the run-time cost per frame. Output: .cache/v7/<out>-eval.json (numbers only).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { ArticulatedCollider } = await import('../../../../motion/articulatedCollider.ts');
const { frameAnchors } = await import('../../../../motion/bake.ts');
const { garmentTopology, hemAboveWaistband } = await import('../../../../motion/metrics.ts');
const { uniqueEdges } = await import('../../../garmentSkin.ts');
const { fitModel, PsdEvaluator } = await import('../model.ts');
const { skinFromBound, toWorld } = await import('../localFrame.ts');
const { TRAINING_CHAINS } = await import('../poses.ts');
const { loadNeutral } = await import('./nodeData.mjs');
const { bodyGuard } = await import('../guard.ts');
const { occluderIndex } = await import('../../../ar/occluder.ts');
const { headTriangles, jacketHoles, windingSign } = await import('./holes.mjs');
const { skinVertices } = await import('../../../../motion/rig.ts');
const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const { jointPositions, poseDrivers } = await import('../../../liveRig.ts');

export const REGIONS = {
  front: [0, 1],
  back: [2],
  yoke: [3],
  sleeve_L: [4],
  sleeve_R: [5],
  collar: [6],
  hood: [7],
};

/** Per-particle vector lengths of a N·3 array (cm). */
const lengthsCm = (v) => {
  const n = v.length / 3;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.hypot(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]) * 100;
  return out;
};
function stats(values, ids) {
  const v = Float64Array.from(ids ? ids.map((i) => values[i]) : values).sort();
  const n = v.length;
  if (!n) return null;
  let sum = 0;
  for (const x of v) sum += x;
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    mean: r2(sum / n),
    p95: r2(v[Math.min(n - 1, Math.floor(0.95 * n))]),
    max: r2(v[n - 1]),
    n,
  };
}
function regional(values, panels) {
  const out = { all: stats(values) };
  for (const [name, list] of Object.entries(REGIONS)) {
    const ids = [];
    for (let i = 0; i < panels.length; i++) if (list.includes(panels[i])) ids.push(i);
    if (ids.length) out[name] = stats(values, ids);
  }
  return out;
}

export async function evaluate({ out, style, size, load, dir }) {
  const S = load(`${out}-samples`);
  const meta = S.meta;
  const K = meta.samples.length;
  const neutralLocal = S.arrays[0];
  const samples = meta.samples.map((s, k) => ({ ...s, field: Float32Array.from(S.arrays[1 + k]) }));
  const solved = meta.samples.map((_, k) => ({
    positions: S.arrays[1 + K + 2 * k],
    drivers: S.arrays[2 + K + 2 * k],
  }));
  // --extra name,name: more sample files (other chains baked separately) appended in order.
  for (const name of flag('--extra')?.split(',') ?? []) {
    const E = load(`${name}-samples`);
    const KE = E.meta.samples.length;
    E.meta.samples.forEach((s, k) => {
      samples.push({ ...s, field: Float32Array.from(E.arrays[1 + k]) });
      solved.push({ positions: E.arrays[1 + KE + 2 * k], drivers: E.arrays[2 + KE + 2 * k] });
    });
  }
  // --exclude id,id: leave samples out of the fit (experiments).
  for (const id of flag('--exclude')?.split(',') ?? []) {
    const k = samples.findIndex((x) => x.id === id);
    if (k >= 0) {
      samples.splice(k, 1);
      solved.splice(k, 1);
    }
  }
  const data = await loadNeutral(style, size);
  const { binding, rig, sdf, asset } = data;
  const n = binding.count;
  if (samples[0].field.length !== n * 3) throw new Error('Samples do not match the current asset');
  const panels = asset.panels;
  const report = {
    style,
    size,
    particles: n,
    assetKey: asset.key,
    samplesAssetKey: meta.assetKey,
    train: {},
  };
  if (meta.assetKey !== asset.key)
    console.warn('[v7] WARNING: the asset changed since the samples were baked');

  // --- Bake budget (from the training run) ---
  report.bake = {
    totalS: meta.totalMs / 1000,
    loadS: meta.loadMs / 1000,
    chains: meta.report.map((c) => ({
      chain: c.chain,
      simulatedS: c.simulatedS,
      steps: c.steps,
      meanStepMs: Math.round(c.meanStepMs * 10) / 10,
      wallS: Math.round(c.wallMs / 100) / 10,
      readyAtS: Math.round(c.readyAtMs / 100) / 10,
      settleP95Cm: Object.fromEntries(c.settle.map((s) => [s.id, Math.round(s.p95Cm * 100) / 100])),
      settleMaxCm: Object.fromEntries(c.settle.map((s) => [s.id, Math.round(s.maxCm * 100) / 100])),
      maxPenetrationCm: c.maxPenetrationCm,
    })),
    neutralResidualCm: meta.neutralResidualCm,
  };

  // --- Fit ---
  const f0 = performance.now();
  const guard = bodyGuard(rig, data.neutralDrivers, binding, binding.bound, asset.panels);
  const { smoothNormals } = await import('../../../../cloth/normals.ts');
  const posedBody = (drivers) => {
    const positions = skinVertices(rig, drivers, new Float32Array(rig.vertexCount * 3));
    const normals = new Float32Array(positions.length);
    smoothNormals(positions, rig.faces, normals);
    return { positions, normals };
  };
  const fitOptions = {
    ...(flag('--components') ? { maxComponents: Number(flag('--components')), toleranceM: 0 } : {}),
    ...(flag('--lambdas') ? { lambdas: flag('--lambdas').split(',').map(Number) } : {}),
    ...(flag('--sigmas') ? { sigmas: flag('--sigmas').split(',').map(Number) } : {}),
  };
  const model = fitModel(samples, rig.neutralPose, binding.bound, binding.key, fitOptions, guard);
  report.fitOptions = fitOptions;
  report.fit = {
    ms: Math.round(performance.now() - f0),
    components: model.components,
    pcaRmsCm: model.pcaRms * 100,
    arm: {
      K: model.armL.K,
      sigma: [model.armL.sigma, model.armR.sigma],
      lambda: [model.armL.lambda, model.armR.lambda],
      looRmsCm: model.armL.looRms * 100,
    },
    samples: model.samples.length,
    guardedParticles: Array.from(guard.distance).filter((v) => v > 0).length,
    trunk: model.trunk && {
      K: model.trunk.K,
      sigma: model.trunk.sigma,
      lambda: model.trunk.lambda,
      looRmsCm: model.trunk.looRms * 100,
    },
  };
  const ev = new PsdEvaluator(model);
  if (flag('--guard')) ev.guardMode = flag('--guard');
  // --fade full,zero (deg) or --fade off: the elevation fade (PSD.fade).
  if (flag('--fade'))
    ev.fadeDeg =
      flag('--fade') === 'off'
        ? null
        : {
            full: Number(flag('--fade').split(',')[0]),
            zero: Number(flag('--fade').split(',')[1]),
          };
  report.fade = ev.fadeDeg;

  // --- Training reproduction (the model at its own samples) ---
  const solvedOf = (k) => solved[k];
  for (const [k, s] of samples.entries()) {
    const pred = ev.local(s.pose);
    const diff = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) diff[i] = pred[i] - s.field[i];
    const w = toWorld(binding, solvedOf(k).drivers, diff, new Float32Array(n * 3));
    report.train[s.id] = {
      error: stats(lengthsCm(w)),
      correction: stats(
        lengthsCm(toWorld(binding, solvedOf(k).drivers, s.field, new Float32Array(n * 3))),
      ),
    };
  }

  // --- Hold-outs ---
  // --holdout a,b: one or more hold-out files, concatenated.
  const holdouts = (flag('--holdout') ?? out).split(',').flatMap((name) => {
    const H = load(`${name}-holdout`);
    return H.meta.holdouts.map((h, j) => ({
      ...h,
      field: H.arrays[j * 4],
      solved: H.arrays[j * 4 + 1],
      drivers: Float64Array.from(H.arrays[j * 4 + 2]),
      neutralLocal: H.arrays[j * 4 + 3],
    }));
  });
  let relaxSame = 0;
  for (let i = 0; i < n * 3; i++)
    relaxSame = Math.max(relaxSame, Math.abs(holdouts[0].neutralLocal[i] - neutralLocal[i]));
  report.relaxIdenticalMaxDiffCm = relaxSame * 100;
  const collider = new ArticulatedCollider(sdf, rig);
  const depth = (positions) => {
    let max = 0,
      over0 = 0,
      over2 = 0,
      over5 = 0;
    const byPanel = {};
    for (let i = 0; i < n; i++) {
      const d = collider.distance(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      if (-d > max) max = -d;
      if (d < 0) over0++;
      if (d < -0.002) over2++;
      if (d < -0.005) {
        over5++;
        byPanel[panels[i]] = (byPanel[panels[i]] ?? 0) + 1;
      }
    }
    return {
      maxCm: Math.round(max * 1000) / 10,
      over0mm: over0,
      over2mm: over2,
      over5mm: over5,
      byPanel,
    };
  };
  const m0 = data.neutralDrivers;
  const occluder = occluderIndex(rig);
  const headTri = headTriangles(rig, occluder);
  const sign = windingSign(binding.bound, asset.triangles, panels);
  // --hole-bias m: the occluder pushed back by this much (what-if for the AR occluder).
  const biasM = Number(flag('--hole-bias') ?? 0.001);
  const holesOf = (body, jacket, png) =>
    jacketHoles({
      body,
      occluder,
      head: headTri,
      jacket,
      triangles: asset.triangles,
      sign,
      png,
      biasM,
    });
  const holesPng = flag('--holes-png');
  report.holdout = {};
  const scenes = {};
  for (const h of holdouts) {
    const lbs = skinFromBound(binding, binding.bound, m0, h.drivers, new Float32Array(n * 3));
    const truthW = toWorld(binding, h.drivers, h.field, new Float32Array(n * 3));
    const predLocal = ev.local(h.pose);
    const predW = toWorld(binding, h.drivers, predLocal, new Float32Array(n * 3));
    const err = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) err[i] = predW[i] - truthW[i];
    const psd = lbs.map((v, i) => v + predW[i]);
    const target = lbs.map((v, i) => v + truthW[i]);
    const posed = posedBody(h.drivers);
    const body = posed.positions;
    const guarded = Float32Array.from(lbs);
    ev.apply(h.pose, h.drivers, binding, guarded, 1, posed);
    const guardedCount = ev.guarded;
    const errG = guarded.map((v, i) => v - target[i]);
    collider.setFrame(h.drivers);
    const png = (v) => (holesPng ? join(dir, `holes-${out}-${h.id}-${v}.png`) : undefined);
    const holes = {
      lbs: holesOf(body, lbs, png('lbs')),
      psd: holesOf(body, guarded, png('psd')),
      truth: holesOf(body, target, png('truth')),
    };
    report.holdout[h.id] = {
      holes,
      psdVsTruth: regional(lengthsCm(err), panels),
      psdGuardedVsTruth: regional(lengthsCm(errG), panels),
      guardMoved: guardedCount,
      lbsVsTruth: regional(lengthsCm(truthW), panels),
      penetration: {
        lbs: depth(lbs),
        psd: depth(psd),
        psdGuarded: depth(guarded),
        truth: depth(target),
        solvedRaw: depth(h.solved),
      },
      settle: h.settle,
    };
    scenes[h.id] = {
      lbs,
      psd: guarded,
      psdUnguarded: psd,
      truth: target,
      solved: h.solved,
      drivers: h.drivers,
    };
    const a = report.holdout[h.id];
    console.log(
      `[v7] ${h.id.padEnd(18)} PSD vs truth mean ${a.psdVsTruth.all.mean} p95 ${a.psdVsTruth.all.p95} max ${a.psdVsTruth.all.max} cm | ` +
        `LBS vs truth mean ${a.lbsVsTruth.all.mean} p95 ${a.lbsVsTruth.all.p95} max ${a.lbsVsTruth.all.max} | ` +
        `guarded mean ${a.psdGuardedVsTruth.all.mean} p95 ${a.psdGuardedVsTruth.all.p95} | holes px LBS ${holes.lbs.holes} PSD ${holes.psd.holes} truth ${holes.truth.holes} (limb LBS ${holes.lbs.limbPx} PSD ${holes.psd.limbPx} truth ${holes.truth.limbPx}) | pen>5mm LBS ${a.penetration.lbs.over5mm} PSD ${a.penetration.psd.over5mm} guarded ${a.penetration.psdGuarded.over5mm} (max ${a.penetration.psdGuarded.maxCm}) truth ${a.penetration.truth.over5mm}`,
    );
  }

  // --- Hem and collar lift on reach_up_both (the preset's hold end) ---
  const preset = await data.preset('reach_up_both');
  const holdEnd = Math.round(preset.motion.hold.end_s * preset.fps);
  const topo = garmentTopology(asset, binding.bound, uniqueEdges(asset.triangles));
  const hem = (p, f) => {
    const v = hemAboveWaistband(topo, p, frameAnchors(preset, f)).low;
    return { front: v[0], back: v[16], sides: Math.max(v[8], v[24]) };
  };
  const rise = (a, b) => ({
    front: +(b.front - a.front).toFixed(1),
    back: +(b.back - a.back).toFixed(1),
    sides: +(b.sides - a.sides).toFixed(1),
  });
  const neck = asset.paths.neckline;
  const meanY = (p) => (neck.reduce((s, i) => s + p[i * 3 + 1], 0) / neck.length) * 100;
  const R = scenes.reach_up_both;
  const H0 = holdouts.find((h) => h.id === 'reach_up_both');
  const relaxed0 = H0 ? null : null;
  void relaxed0;
  const live = data.live;
  const neckJoint = (pose) =>
    jointPositions(live, poseDrivers(live, { ...rig.neutralPose, ...pose }, {}).world).neck;
  const nj0 = neckJoint({}),
    nj1 = neckJoint(H0.pose);
  report.reachUpBoth = {
    note: 'Hem rise vs the neutral stand at the low (hip-line) waistband, cm; collar = mean neckline Y rise, cm',
    hemRiseCm: {
      lbs: rise(hem(binding.bound, 0), hem(R.lbs, holdEnd)),
      psd: rise(hem(binding.bound, 0), hem(R.psd, holdEnd)),
      truth: rise(hem(binding.bound, 0), hem(R.truth, holdEnd)),
    },
    collarRiseCm: {
      lbs: +(meanY(R.lbs) - meanY(binding.bound)).toFixed(1),
      psd: +(meanY(R.psd) - meanY(binding.bound)).toFixed(1),
      truth: +(meanY(R.truth) - meanY(binding.bound)).toFixed(1),
      neckJoint: nj0 && nj1 ? +((nj1[1] - nj0[1]) * 100).toFixed(1) : null,
    },
    video: {
      hemRiseCm: 23,
      collarRiseCm: 9,
      source: 'V3, user video by eye (docs/STATUS-tryon-physics.md)',
    },
  };
  console.log(
    `[v7] reach_up_both: ${JSON.stringify(report.reachUpBoth.hemRiseCm)} collar ${JSON.stringify(report.reachUpBoth.collarRiseCm)}`,
  );

  // --- Relaxed arms: sleeve-to-body gap, LBS vs PSD vs the true solve (training pose) ---
  const kRelaxed = samples.findIndex((s) => s.id === 'relaxed');
  if (kRelaxed >= 0) {
    const sv = solvedOf(kRelaxed);
    const drivers = Float64Array.from(sv.drivers);
    collider.setFrame(drivers);
    const lbs = skinFromBound(binding, binding.bound, m0, drivers, new Float32Array(n * 3));
    const truthW = toWorld(binding, drivers, samples[kRelaxed].field, new Float32Array(n * 3));
    const predW = toWorld(
      binding,
      drivers,
      ev.local(samples[kRelaxed].pose),
      new Float32Array(n * 3),
    );
    const gap = (p, side) => {
      const ids = [];
      for (let i = 0; i < n; i++) if (panels[i] === (side === 'L' ? 4 : 5)) ids.push(i);
      const g = ids.map((i) => collider.distance(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) * 100);
      return stats(g);
    };
    const psd = lbs.map((v, i) => v + predW[i]);
    const truth = lbs.map((v, i) => v + truthW[i]);
    report.relaxedArms = {
      note: 'Sleeve particle distance to the body surface (collider), cm; relaxed arms (elevation 5, elbow 8)',
      lbs: { L: gap(lbs, 'L'), R: gap(lbs, 'R') },
      psd: { L: gap(psd, 'L'), R: gap(psd, 'R') },
      truth: { L: gap(truth, 'L'), R: gap(truth, 'R') },
    };
    scenes.relaxed = { lbs, psd, truth, solved: sv.positions, drivers };
    console.log(
      `[v7] relaxed sleeve gap mean L: LBS ${report.relaxedArms.lbs.L.mean} PSD ${report.relaxedArms.psd.L.mean} truth ${report.relaxedArms.truth.L.mean} cm`,
    );
  }

  // --- Run time: apply() on interpolated poses ---
  const positions = new Float32Array(n * 3);
  const poses = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < 400; i++) {
    const pose = {};
    for (const s of ['L', 'R']) {
      pose[`shoulder_${s}_elevation`] = 5 + 165 * rnd();
      pose[`shoulder_${s}_plane`] = -20 + 130 * rnd();
      pose[`elbow_${s}_flexion`] = 120 * rnd();
    }
    pose.trunk_twist = -20 + 40 * rnd();
    poses.push(pose);
  }
  const times = [],
    guardedTimes = [];
  const pct = (a, q) =>
    +a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))].toFixed(3);
  for (const [i, pose] of poses.entries()) {
    const drivers = poseDrivers(live, { ...rig.neutralPose, ...pose }, {}).drivers;
    const body = posedBody(drivers);
    positions.set(binding.bound);
    let t = performance.now();
    ev.apply(pose, drivers, binding, positions, 1);
    if (i >= 50) times.push(performance.now() - t);
    positions.set(binding.bound);
    t = performance.now();
    ev.apply(pose, drivers, binding, positions, 1, body);
    if (i >= 50) guardedTimes.push(performance.now() - t);
  }
  report.runtime = {
    note: 'PsdEvaluator.apply (features, RBF, PCA blend, local to world, add; guarded = with the body guard), Node, this laptop',
    components: model.components,
    medianMs: pct(times, 0.5),
    p95Ms: pct(times, 0.95),
    maxMs: pct(times, 1),
    guardedMedianMs: pct(guardedTimes, 0.5),
    guardedP95Ms: pct(guardedTimes, 0.95),
    guardedMaxMs: pct(guardedTimes, 1),
  };
  console.log(`[v7] apply ${JSON.stringify(report.runtime)}`);
  report.trainingSet = TRAINING_CHAINS.map((c) => ({
    chain: c.id,
    poses: c.poses.map((p) => p.id),
  }));
  writeFileSync(join(dir, `${out}-eval.json`), JSON.stringify(report, null, 1));
  console.log(`[v7] wrote .cache/v7/${out}-eval.json`);
  return { report, scenes, data, model };
}
