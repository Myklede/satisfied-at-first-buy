// P29 offline signal study. All tuning is in CONFIG; no product imports/edits.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { freemem } from 'node:os';
import { syncHolds, timingBlocks } from './rtmo-control.mjs';
import { nearest, percentile, correlation } from './track-compare.mjs';

// Search ranges are research hypotheses, NOT pre-calibrated accuracy constants.
// Scores/clock/reset follow P26 and posePipeline.ts; gates are disclosed in the report.
export const CONFIG = {
  score: 0.65,
  matchMs: 25,
  resetMs: 500,
  referenceSmoothMs: 180,
  windows: [
    ['turn-a', 6000, 14000],
    ['arms', 15000, 28000],
    ['turn-b', 30000, 40000],
  ],
  minCutoff: [0.3, 0.6, 1.2, 2.4, 4],
  betaDeg: [0, 0.01, 0.03, 0.1, 0.3],
  betaUnit: [0, 0.5, 2, 8, 24],
  bandsDeg: [0.3, 1, 2, 4, 6],
  bandsUnit: [0.002, 0.005, 0.01, 0.02],
  slewDeg: [45, 90, 180, 360],
  slewUnit: [0.03, 0.1, 0.3, 1],
  sustainMs: [33, 66, 100, 150, 200],
  glideMs: [33, 66, 120, 250],
  kalmanAccelerationDeg: [10, 40, 120, 360],
  kalmanAccelerationUnit: [0.01, 0.04, 0.12, 0.5],
  kalmanR: [0.5, 1, 2, 4],
  maxRecommendedLagMs: 180,
  maxStepOvershootPct: 5,
  motionBypass: { yawDegS: 20, leanDegS: 15, logSizeS: 0.2, widthRatioS: 0.3 },
  // Diagnostic choices: exclude profile roll, use a frontal template, and require
  // identifiable motion. These are hypotheses, not accuracy/rollout guarantees.
  quietBody: { rootWidthsS: 0.05, leanDegS: 5, yawProxyDegS: 12 },
  view: { frontPercentile: 0.95, rollRatio: 0.4, templateRatio: 0.9, templateAfterMs: 1500 },
  event: {
    minSamples: 8,
    minSpanMs: 300,
    maxSpanMs: 5000,
    correlation: 0.75,
    agreement: 0.5,
    afterMs: 300,
    fraction: 0.9,
  },
  motionMinimum: { degrees: 5, normalized: 0.03 },
  minQuietSamples: 12,
  minMatchedFrames: 20,
  minImageSpanPx: 10,
  clockToleranceFrames: 0.1,
  clockMapToleranceMs: 0.01,
};
const DEG = 180 / Math.PI;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const rms = (a) => (a.length ? Math.sqrt(mean(a.map((x) => x * x))) : null);
const med = (a) => percentile(a, 0.5);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sub = (a, b) => a.map((x, i) => x - b[i]);
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const unit = (a) => {
  const n = Math.hypot(...a);
  return n > 1e-8 ? a.map((x) => x / n) : null;
};
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const mid = (a, b) => a.map((v, i) => (v + b[i]) / 2);
const topologyCache = new WeakMap();
function topology(samples) {
  let cached = topologyCache.get(samples);
  if (!cached) {
    cached = {
      neighbours: samples.map((s) =>
        samples.flatMap((q, i) =>
          Math.abs(s.t - q.t) <= CONFIG.referenceSmoothMs && Number.isFinite(q.r) ? [i] : [],
        ),
      ),
      windows: new Map(),
    };
    topologyCache.set(samples, cached);
  }
  return cached;
}
export const wrap = (x, period = 360) => x - period * Math.floor((x + period / 2) / period);

export function similarity(source, target) {
  if (source.length !== target.length || source.length < 2)
    throw new Error('At least two paired points');
  const centre = (p) => [mean(p.map((x) => x[0])), mean(p.map((x) => x[1]))];
  const a = centre(source),
    b = centre(target);
  let aa = 0,
    bb = 0,
    den = 0;
  for (let i = 0; i < source.length; i++) {
    const x = sub(source[i], a),
      y = sub(target[i], b);
    aa += dot(x, y);
    bb += x[0] * y[1] - x[1] * y[0];
    den += dot(x, x);
  }
  if (den < 1e-8) throw new Error('Degenerate torso template');
  const u = aa / den,
    v = bb / den;
  return {
    tx: b[0] - u * a[0] + v * a[1],
    ty: b[1] - v * a[0] - u * a[1],
    angle: Math.atan2(v, u) * DEG,
    logScale: Math.log(Math.hypot(u, v)),
    points: source.map((p) => [
      b[0] + u * (p[0] - a[0]) - v * (p[1] - a[1]),
      b[1] + v * (p[0] - a[0]) + u * (p[1] - a[1]),
    ]),
  };
}

export function imageSignals(points) {
  if (!points || points.length !== 4 || points.some((p) => p.some((x) => !Number.isFinite(x))))
    return null;
  const [ls, rs, lh, rh] = points,
    s = mid(ls, rs),
    h = mid(lh, rh),
    height = Math.hypot(...sub(s, h));
  const width = Math.hypot(...sub(ls, rs));
  if (height < CONFIG.minImageSpanPx || width < CONFIG.minImageSpanPx) return null;
  return {
    x: s[0],
    y: s[1],
    roll: wrap(Math.atan2(ls[1] - rs[1], ls[0] - rs[0]) * DEG, 180),
    lean: Math.atan2(s[0] - h[0], h[1] - s[1]) * DEG,
    logScale: Math.log(height),
    logWidth: Math.log(width),
    widthRatio: (ls[0] - rs[0]) / height,
    height,
    width,
  };
}

export function worldSignals(world) {
  if (!world || ![11, 12, 23, 24].every((k) => world[k]?.[3] >= CONFIG.score)) return null;
  // Matches uncalibrated anatomicalPose.ts camera axes and trunk equations;
  // Includes anatomical clamps but omits confidence holds/calibration; NOT the app's final pose.
  const [ls, rs, lh, rh] = [11, 12, 23, 24].map((k) => [world[k][0], -world[k][1], -world[k][2]]);
  const up = [0, 1, 0],
    u = unit(sub(mid(ls, rs), mid(lh, rh)));
  const hip = sub(rh, lh),
    shoulder = sub(rs, ls);
  const reject = (a, b) =>
    sub(
      a,
      b.map((x) => x * dot(a, b)),
    );
  const rp = unit(reject(hip, up));
  if (!u || !rp) return null;
  const fp = cross(up, rp),
    hl = unit(reject(hip, u)),
    ts = unit(reject(shoulder, u));
  if (!hl || !ts) return null;
  return {
    flex: clamp(Math.atan2(dot(u, fp), dot(u, up)) * DEG, -25, 90),
    lateral: clamp(Math.asin(clamp(dot(u, rp), -1, 1)) * DEG, -35, 35),
    twist: clamp(Math.atan2(dot(cross(hl, ts), u), dot(hl, ts)) * DEG, -45, 45),
    yaw: Math.atan2(world[23][2] - world[24][2], world[23][0] - world[24][0]) * DEG,
  };
}

export function filterSeries(samples, spec) {
  let x,
    v = 0,
    t,
    dx = 0,
    p00 = 1,
    p01 = 0,
    p11 = 1,
    since,
    lastDirection = 0,
    moving = false;
  return samples.map((s) => {
    if (!Number.isFinite(s.x)) return { ...s, y: null };
    let raw = s.x;
    if (x !== undefined && spec.period) raw = x + wrap(raw - x, spec.period);
    if (x === undefined || s.t <= t || s.t - t > CONFIG.resetMs) {
      if (x !== undefined && s.t === t) return { ...s, y: x };
      x = raw;
      v = dx = 0;
      p00 = p11 = 1;
      p01 = 0;
      since = undefined;
      moving = false;
      t = s.t;
      return { ...s, y: x };
    }
    const dt = (s.t - t) / 1000;
    t = s.t;
    if (spec.motionBypass && s.bypass) {
      x = raw;
      dx = v = 0;
      since = undefined;
      moving = false;
      return { ...s, y: x };
    }
    if (spec.family === 'raw') x = raw;
    else if (spec.family === 'euro' || spec.family === 'rigid') {
      const alpha = (f) => 1 / (1 + 1 / (2 * Math.PI * f * dt));
      dx += alpha(spec.dCutoff ?? 1) * ((raw - x) / dt - dx);
      x += alpha(spec.cutoff + spec.beta * Math.abs(dx)) * (raw - x);
    } else if (spec.family === 'slew') {
      const d = raw - x;
      if (Math.abs(d) > spec.band)
        x += Math.sign(d) * Math.min(Math.abs(d) - spec.band, spec.slew * dt);
    } else if (spec.family === 'hold') {
      const d = raw - x,
        dir = Math.sign(d);
      if (!moving) {
        if (Math.abs(d) > spec.band) {
          if (dir !== lastDirection) since = s.t;
          since ??= s.t;
          if (s.t - since >= spec.sustainMs) moving = true;
        } else since = undefined;
      }
      lastDirection = dir;
      if (moving) {
        x += (raw - x) * (1 - Math.exp((-dt * 1000) / spec.glideMs));
        if (Math.abs(raw - x) < spec.band * 0.25) {
          moving = false;
          since = undefined;
        }
      }
    } else if (spec.family === 'kalman') {
      const q = spec.acceleration ** 2,
        R = spec.measurement ** 2;
      x += v * dt;
      const a = p00 + 2 * dt * p01 + dt * dt * p11 + (q * dt ** 4) / 4,
        b = p01 + dt * p11 + (q * dt ** 3) / 2,
        c = p11 + q * dt * dt;
      const k0 = a / (a + R),
        k1 = b / (a + R),
        res = raw - x;
      x += k0 * res;
      v += k1 * res;
      p00 = (1 - k0) * a;
      p01 = (1 - k0) * b;
      p11 = c - k1 * b;
    } else throw new Error('Unknown filter family');
    return { ...s, y: x };
  });
}

export function smoothReference(samples, key, halfWindow = CONFIG.referenceSmoothMs) {
  return samples.map((s) => ({
    ...s,
    z: med(
      samples
        .filter((v) => Math.abs(v.t - s.t) <= halfWindow && Number.isFinite(v[key]))
        .map((v) => v[key]),
    ),
  }));
}

export function eventMetrics(samples, output, start, end, minimum) {
  const a = samples
    .map((s, i) => ({ ...s, y: output[i].y }))
    .filter((s) => s.t >= start && s.t <= end && Number.isFinite(s.r) && Number.isFinite(s.y));
  if (a.length < CONFIG.event.minSamples)
    return { lagMs: null, reason: 'insufficient matched samples' };
  let best = null;
  for (let i = 0; i < a.length; i++)
    for (let j = i + 1; j < a.length; j++) {
      const dt = a[j].t - a[i].t;
      if (dt < CONFIG.event.minSpanMs || dt > CONFIG.event.maxSpanMs) continue;
      const amp = Math.abs(a[j].r - a[i].r);
      if (!best || amp > best.amp) best = { i, j, amp };
    }
  if (!best || best.amp < minimum) return { lagMs: null, reason: 'no large reference excursion' };
  const first = a[best.i],
    last = a[best.j],
    dir = Math.sign(last.r - first.r);
  const ref90 = a
    .slice(best.i, best.j + 1)
    .find((s) => dir * (s.r - first.r) >= CONFIG.event.fraction * best.amp)?.t;
  // Per-model endpoint calibration avoids treating constant MP-vs-RTMO bias as filter lag.
  const baseline = first.x,
    target = last.x,
    amp = dir * (target - baseline);
  if (amp < minimum * CONFIG.event.agreement)
    return { lagMs: null, reason: 'model/reference excursion disagree' };
  const after = a.slice(best.i),
    crossing = after.find((s) => dir * (s.y - baseline) >= CONFIG.event.fraction * amp)?.t;
  const raw90 = after.find((s) => dir * (s.x - baseline) >= CONFIG.event.fraction * amp)?.t;
  const referenceCorrelation = correlation(
    a.slice(best.i, best.j + 1).map((s) => s.x),
    a.slice(best.i, best.j + 1).map((s) => s.r),
  );
  const lo = Math.min(baseline, target),
    hi = Math.max(baseline, target);
  const overshoot = Math.max(
    0,
    ...after
      .filter((s) => s.t <= last.t + CONFIG.event.afterMs)
      .map((s) => Math.max(s.y - hi, lo - s.y)),
  );
  return {
    lagMs:
      crossing === undefined ||
      referenceCorrelation === null ||
      referenceCorrelation < CONFIG.event.correlation
        ? null
        : crossing - ref90,
    referenceCorrelation,
    addedLagMs: crossing === undefined || raw90 === undefined ? null : crossing - raw90,
    censored: crossing === undefined,
    amplitude: best.amp,
    overshoot,
    reference90Ms: ref90,
    startMs: first.t,
    endMs: last.t,
  };
}

export function evaluate(samples, output, unitScale, minimum, windows = CONFIG.windows) {
  const quiet = [];
  const errors = [];
  const full = [];
  const rawFull = [];
  const cached = topology(samples);
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1],
      b = samples[i],
      dt = (b.t - a.t) / 1000;
    if (
      dt <= 0 ||
      dt > CONFIG.resetMs / 1000 ||
      !Number.isFinite(a.r) ||
      !Number.isFinite(b.r) ||
      !Number.isFinite(output[i].y)
    )
      continue;
    // Reference-conditioned small-motion residual; remove constant cross-model bias.
    if (b.quiet ?? Math.abs(b.r - a.r) / dt < minimum) {
      const metricRef = (s) => s.metricRef ?? s.r;
      full.push(output[i].y - metricRef(b));
      rawFull.push(b.x - metricRef(b));
      const local = cached.neighbours[i]
        .filter((j) => Number.isFinite(output[j].y))
        .map((j) => ({ s: samples[j], j }));
      const centre = med(local.map(({ s, j }) => output[j].y - metricRef(s)));
      const rawCentre = med(local.map(({ s }) => s.x - metricRef(s)));
      quiet.push(output[i].y - metricRef(b) - centre);
      errors.push(b.x - metricRef(b) - rawCentre);
    }
  }
  const centered = (a) => {
    const m = med(a);
    return rms(a.map((v) => (v - m) * unitScale));
  };
  const jitter = centered(quiet),
    rawJitter = centered(errors);
  return {
    quietSamples: quiet.length,
    jitter,
    rawJitter,
    fullResidualRms: centered(full),
    rawFullResidualRms: centered(rawFull),
    reductionPct: rawJitter ? 100 * (1 - jitter / rawJitter) : null,
    windows: windows.map(([name, start, end]) => {
      const key = start + ':' + end;
      let selection = cached.windows.get(key);
      if (!selection) {
        const indices = samples.flatMap((s, i) => (s.t >= start && s.t <= end ? [i] : []));
        selection = { indices, samples: indices.map((i) => samples[i]) };
        cached.windows.set(key, selection);
      }
      const j = evaluate(
        selection.samples,
        selection.indices.map((i) => output[i]),
        unitScale,
        minimum,
        [],
      );
      return {
        name,
        ...eventMetrics(samples, output, start, end, minimum),
        jitter: j.jitter,
        rawJitter: j.rawJitter,
        quietSamples: j.quietSamples,
        reductionPct: j.reductionPct,
        fullResidualRms: j.fullResidualRms,
        rawFullResidualRms: j.rawFullResidualRms,
      };
    }),
  };
}
export function stepResponse(spec, amplitude, dtMs) {
  const samples = Array.from({ length: Math.ceil(3500 / dtMs) }, (_, i) => ({
    t: i * dtMs,
    x: i * dtMs >= 1000 ? amplitude : 0,
  }));
  const output = filterSeries(samples, spec);
  const start = samples.find((s) => s.x === amplitude).t;
  const t90 = output.find((s) => s.t >= start && s.y >= CONFIG.event.fraction * amplitude)?.t;
  return {
    lag90Ms: t90 === undefined ? null : t90 - start,
    overshoot: Math.max(0, ...output.map((s) => s.y - amplitude)),
  };
}

function candidates(degrees, noise) {
  const out = [{ family: 'raw' }];
  for (const cutoff of CONFIG.minCutoff)
    for (const beta of degrees ? CONFIG.betaDeg : CONFIG.betaUnit)
      for (const motionBypass of [false, true])
        out.push({
          family: 'euro',
          cutoff,
          beta,
          dCutoff: 1,
          ...(motionBypass ? { motionBypass: true } : {}),
        });
  for (const band of degrees ? CONFIG.bandsDeg : CONFIG.bandsUnit) {
    for (const slew of degrees ? CONFIG.slewDeg : CONFIG.slewUnit)
      out.push({ family: 'slew', band, slew });
    for (const sustainMs of CONFIG.sustainMs)
      for (const glideMs of CONFIG.glideMs) out.push({ family: 'hold', band, sustainMs, glideMs });
  }
  for (const acceleration of degrees ? CONFIG.kalmanAccelerationDeg : CONFIG.kalmanAccelerationUnit)
    for (const k of CONFIG.kalmanR)
      out.push({ family: 'kalman', acceleration, measurement: Math.max(noise, 1e-4) * k });
  for (const cutoff of CONFIG.minCutoff)
    for (const beta of degrees ? CONFIG.betaDeg : CONFIG.betaUnit)
      out.push({ family: 'rigid', cutoff, beta, dCutoff: 1 });
  return out;
}

export function sourceTime(videoMs, clockMap) {
  if (!clockMap) return videoMs;
  const position = (videoMs * clockMap.encodedFps) / 1000,
    index = Math.round(position);
  if (
    Math.abs(position - index) > CONFIG.clockToleranceFrames ||
    !Number.isFinite(clockMap.sourceMs[index])
  )
    throw new Error('Replay clock is not the mapped CFR encoding');
  return clockMap.sourceMs[index];
}
export function reconstruct(replay, reference, clockMap = null) {
  if (
    clockMap &&
    (clockMap.sourceMs.length !== reference.frames.length ||
      reference.frames.some(
        (f) => Math.abs(f.tMs - clockMap.sourceMs[f.index]) > CONFIG.clockMapToleranceMs,
      ))
  )
    throw new Error('Timestamp map does not match the RTMO source');
  const refs = reference.frames.map((f) => ({ tMs: f.tMs, ...f }));
  const matched = [];
  for (const f of replay.frames) {
    const t = sourceTime(f.videoMs, clockMap);
    if (!Number.isFinite(t) || !f.lm) continue;
    const r = nearest(refs, t, CONFIG.matchMs);
    if (
      !r ||
      !r.keypoints ||
      ![5, 6, 11, 12].every((k) => r.keypoints[k].score >= CONFIG.score) ||
      ![11, 12, 23, 24].every((k) => f.lm[k]?.[2] >= CONFIG.score)
    )
      continue;
    const mp = [11, 12, 23, 24].map((k) => f.lm[k].slice(0, 2));
    const rt = [5, 6, 11, 12].map((k) => [r.keypoints[k].x, r.keypoints[k].y]);
    if (
      [...mp, ...rt].some(
        (p) => p[0] < 0 || p[0] > replay.video[0] || p[1] < 0 || p[1] > replay.video[1],
      )
    )
      continue;
    const m = imageSignals(mp),
      q = imageSignals(rt);
    if (!m || !q) continue;
    matched.push({ t, mp, rt, m, q, world: worldSignals(f.world) });
  }
  matched.sort((a, b) => a.t - b.t);
  const unique = matched.filter((f, i) => !i || f.t > matched[i - 1].t);
  if (unique.length < CONFIG.minMatchedFrames)
    throw new Error('Insufficient valid source-time torso pairs');
  const frontRatio = percentile(
    unique.map((f) => Math.abs(f.q.widthRatio)),
    CONFIG.view.frontPercentile,
  );
  const width0 = med(unique.map((f) => f.q.width));
  const template =
    unique.find(
      (f) =>
        Math.abs(f.q.widthRatio) > CONFIG.view.templateRatio * frontRatio &&
        f.t > CONFIG.view.templateAfterMs,
    ) ?? unique[0];
  for (const f of unique) {
    f.rigid = imageSignals(similarity(template.mp, f.mp).points);
    f.m.yawProxy = Math.acos(clamp(f.m.widthRatio / frontRatio, -1, 1)) * DEG;
    f.q.yawProxy = Math.acos(clamp(f.q.widthRatio / frontRatio, -1, 1)) * DEG;
  }
  const rtSmooth = unique.map((f) => ({
    t: f.t,
    x: f.q.x / width0,
    y: f.q.y / width0,
    lean: f.q.lean,
    yaw: f.q.yawProxy,
  }));
  const smoothKeys = ['x', 'y', 'lean', 'yaw'].map((k) => smoothReference(rtSmooth, k));
  for (let i = 0; i < unique.length; i++) {
    const j = Math.max(0, i - 3),
      dt = (unique[i].t - unique[j].t) / 1000;
    unique[i].quietBody =
      dt > 0 &&
      Math.hypot(smoothKeys[0][i].z - smoothKeys[0][j].z, smoothKeys[1][i].z - smoothKeys[1][j].z) /
        dt <
        CONFIG.quietBody.rootWidthsS &&
      Math.abs(smoothKeys[2][i].z - smoothKeys[2][j].z) / dt < CONFIG.quietBody.leanDegS &&
      Math.abs(smoothKeys[3][i].z - smoothKeys[3][j].z) / dt < CONFIG.quietBody.yawProxyDegS;
    const p = unique[i - 1],
      f = unique[i],
      elapsed = p ? (f.t - p.t) / 1000 : 0,
      c = CONFIG.motionBypass;
    f.motionBypass =
      elapsed > 0 &&
      elapsed < CONFIG.resetMs / 1000 &&
      ((f.world && p.world && Math.abs(wrap(f.world.yaw - p.world.yaw)) / elapsed > c.yawDegS) ||
        Math.abs(f.m.lean - p.m.lean) / elapsed > c.leanDegS ||
        Math.abs(f.m.logScale - p.m.logScale) / elapsed > c.logSizeS ||
        Math.abs(f.m.widthRatio - p.m.widthRatio) / elapsed > c.widthRatioS);
  }
  return { frames: unique, width0, frontRatio };
}

let lastQuietCheck = -Infinity;
async function quiet() {
  if (Date.now() - lastQuietCheck < 100) return;
  for (;;) {
    const dir = '.cache/lead/service/control';
    const controls = existsSync(dir)
      ? readdirSync(dir)
          .filter((n) => /^timing.*\.json$/.test(n))
          .flatMap((n) => {
            try {
              return [JSON.parse(readFileSync(join(dir, n)))];
            } catch (e) {
              if (e.code === 'ENOENT') return [];
              throw e;
            }
          })
      : [];
    if (
      !syncHolds(readFileSync('docs/requests/codex-sync.md', 'utf8')).blocked &&
      !timingBlocks(controls, existsSync('.cache/locks/heavy'), Date.now()) &&
      freemem() >= 2 * 2 ** 30
    ) {
      lastQuietCheck = Date.now();
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function run(clip) {
  const input = JSON.parse(readFileSync('.cache/replay/' + clip + '.json'));
  const reference = JSON.parse(readFileSync('.cache/research/tracks/' + clip + '.json'));
  if (!reference.complete) throw new Error('Wait for complete RTMO reference: ' + clip);
  const mapPath = '.cache/lead/service/clips/' + clip + '.timestamps.json';
  const clockMap =
    clip === 'live5' && existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, 'utf8')) : null;
  const data = reconstruct(input, reference, clockMap),
    channels = {};
  mkdirSync('.cache/research/torso', { recursive: true });
  for (const name of [
    'x',
    'y',
    'roll',
    'lean',
    'logScale',
    'logWidth',
    'yawProxy',
    'flex',
    'lateral',
    'twist',
    'yaw',
  ]) {
    await quiet();
    const world = ['flex', 'lateral', 'twist', 'yaw'].includes(name);
    const degrees = ['roll', 'lean', 'yawProxy', 'flex', 'lateral', 'twist', 'yaw'].includes(name),
      scale = degrees ? 1 : name === 'x' || name === 'y' ? data.width0 : 100;
    let priorM, priorR, priorT;
    const samples = data.frames
      .filter(
        (f) =>
          name !== 'roll' ||
          (Math.abs(f.q.widthRatio) > CONFIG.view.rollRatio * data.frontRatio &&
            Math.abs(f.m.widthRatio) > CONFIG.view.rollRatio * data.frontRatio),
      )
      .map((f) => {
        let x = world ? f.world?.[name] : f.m[name],
          r = world ? x : f.q[name],
          rigid = f.rigid[name] ?? x;
        if (name === 'x' || name === 'y') {
          x /= data.width0;
          r /= data.width0;
          rigid /= data.width0;
        }
        const period = name === 'roll' ? 180 : name === 'yaw' ? 360 : 0;
        if (priorT !== undefined && f.t - priorT > CONFIG.resetMs) {
          priorM = priorR = undefined;
        }
        if (period && priorM !== undefined) {
          x = priorM + wrap(x - priorM, period);
          r = priorR + wrap(r - priorR, period);
        }
        if (period) rigid = x + wrap(rigid - x, period);
        if (Number.isFinite(x)) {
          priorM = x;
          priorR = r;
          priorT = f.t;
        }
        return {
          t: f.t,
          x,
          r,
          rigid,
          quiet: world ? f.quietBody : undefined,
          metricRef: world ? 0 : undefined,
          bypass: f.motionBypass,
        };
      })
      .filter((s) => Number.isFinite(s.x));
    if (world) {
      const baseline = filterSeries(
        samples,
        name === 'yaw'
          ? { family: 'raw', period: 360 }
          : {
              family: 'euro',
              cutoff: name === 'twist' ? 0.5 : 0.8,
              beta: name === 'twist' ? 0.005 : 0.01,
            },
      );
      for (let i = 0; i < samples.length; i++) {
        samples[i].x = baseline[i].y;
        samples[i].rigid = baseline[i].y;
      }
      // This is an MP low-frequency surrogate, not an independent 3D truth.
      for (let i = 0; i < samples.length; i++) samples[i].r = samples[i].x;
    }
    const referenceSmooth = smoothReference(samples, 'r');
    for (let i = 0; i < samples.length; i++) samples[i].r = referenceSmooth[i].z;
    const residual = samples.map((s) => s.x - s.r),
      offset = med(residual);
    const noise = rms(residual.map((v) => v - offset)) || 0.001;
    const results = [];
    for (const spec of candidates(degrees, noise)) {
      await quiet();
      const period = name === 'roll' ? 180 : name === 'yaw' ? 360 : undefined;
      const input = spec.family === 'rigid' ? samples.map((s) => ({ ...s, x: s.rigid })) : samples;
      const output = filterSeries(input, { ...spec, period });
      const metrics = evaluate(
        samples,
        output,
        scale,
        degrees ? CONFIG.motionMinimum.degrees : CONFIG.motionMinimum.normalized,
      );
      const step = stepResponse(
        { ...spec, period },
        degrees ? 15 : 0.1,
        med(samples.slice(1).map((s, i) => s.t - samples[i].t)),
      );
      const measured = metrics.windows.filter((w) => Number.isFinite(w.addedLagMs));
      const lag =
        step.lag90Ms === null || metrics.windows.some((w) => w.censored)
          ? null
          : Math.max(step.lag90Ms, ...measured.map((w) => Math.max(0, w.addedLagMs)));
      const score =
        metrics.jitter === null || metrics.quietSamples < CONFIG.minQuietSamples
          ? Infinity
          : metrics.jitter;
      results.push({
        spec,
        ...metrics,
        step,
        stepOvershootPct: (100 * step.overshoot) / (degrees ? 15 : 0.1),
        worstAddedLagMs: lag,
        score,
      });
    }
    results.sort((a, b) => a.score - b.score);
    const eligible = (r) =>
      r.worstAddedLagMs !== null &&
      r.worstAddedLagMs <= CONFIG.maxRecommendedLagMs &&
      r.stepOvershootPct <= CONFIG.maxStepOvershootPct;
    const bestFamilies = Object.fromEntries(
      ['raw', 'euro', 'slew', 'hold', 'kalman', 'rigid'].map((f) => [
        f,
        results.find((r) => r.spec.family === f && eligible(r)) ??
          results.find((r) => r.spec.family === f),
      ]),
    );
    channels[name] = {
      worldSurrogate: world,
      winner:
        results.find(
          (r) =>
            r.worstAddedLagMs !== null &&
            r.worstAddedLagMs <= CONFIG.maxRecommendedLagMs &&
            r.stepOvershootPct <= CONFIG.maxStepOvershootPct,
        ) ?? results[0],
      bestFamilies,
      grid: results,
    };
    console.log(clip, name, JSON.stringify(channels[name].winner));
    writeFileSync(
      '.cache/research/torso/' + clip + '-partial.json',
      JSON.stringify({ clip, channels, matchedFrames: data.frames.length }),
    );
  }
  const report = {
    clockMap: clockMap
      ? {
          path: mapPath,
          encodedFps: clockMap.encodedFps,
          maxCorrectionMs: Math.max(
            ...input.frames.map((f) => Math.abs(sourceTime(f.videoMs, clockMap) - f.videoMs)),
          ),
        }
      : null,
    clip,
    sourceHead: input.head,
    video: input.video,
    referenceSource: reference.source,
    referenceSha: reference.sourceSha256,
    referenceNotGroundTruth: true,
    matchedFrames: data.frames.length,
    totalReplayFrames: input.frames.length,
    cadenceMedianMs: med(data.frames.slice(1).map((f, i) => f.t - data.frames[i].t)),
    width0: data.width0,
    config: CONFIG,
    channels,
    world: data.frames.map((f) => ({ t: f.t, ...f.world })),
    caveats: [
      '2D signal/filter simulation, not a skinned-jacket render or wobble measurement',
      'RTMO has no 3D ground truth. Yaw is unsigned span/height proxy; depth is relative apparent size.',
      'Sparse replay cannot certify one-camera-frame lag. Parameters selected on this same clip need held-out confirmation.',
    ],
  };
  mkdirSync('.cache/research/torso', { recursive: true });
  writeFileSync('.cache/research/torso/' + clip + '-search.json', JSON.stringify(report, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.chdir(resolve(import.meta.dirname, '../..'));
  const clip = process.argv[2] ?? 'live5';
  if (!['live5', 'camo-1', 'venue-khong-ao'].includes(clip)) throw new Error('Unknown fixed clip');
  await quiet();
  await run(clip);
}
