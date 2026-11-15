import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MP = [11, 12, 13, 14, 15, 16, 23, 24];
const COCO = [5, 6, 7, 8, 9, 10, 11, 12];
const NAMES = ['lShoulder', 'rShoulder', 'lElbow', 'rElbow', 'lWrist', 'rWrist', 'lHip', 'rHip'];
// P24/P26 shared score cutoff; scores from different models are not calibrated probabilities.
const SCORE = 0.65;
export function canonical(log, drawn = false) {
  return (Array.isArray(log) ? log : log.frames)
    .map((f) => {
      const tMs = f.tMs ?? f.videoMs;
      if (!Number.isFinite(tMs))
        throw new Error(
          'Source timestamp tMs/videoMs required; wall time t is not interchangeable.',
        );
      const keypoints = f.keypoints ?? Array.from({ length: 17 }, () => null);
      if (!f.keypoints)
        for (let i = 0; i < COCO.length; i++) {
          const shown = f.status === 'drawn' && Number.isFinite(f.fade) && f.fade < 0.99;
          const p = drawn ? (shown ? f.drawnPoints?.[NAMES[i]] : null) : f.lm?.[MP[i]];
          keypoints[COCO[i]] = !p
            ? null
            : Array.isArray(p)
              ? // Drawn coordinates have no independent model confidence. Gate them with
                // the recorded raw joint visibility, never invent a confidence of 1.
                { x: p[0], y: p[1], score: f.lm?.[MP[i]]?.visibility ?? 0 }
              : { x: p.x, y: p.y, score: p.visibility };
        }
      return { tMs, keypoints };
    })
    .sort((a, b) => a.tMs - b.tMs);
}
const usable = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.score >= SCORE;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
export function percentile(a, q) {
  if (!a.length) return null;
  const s = [...a].sort((a, b) => a - b);
  return s[Math.ceil(q * s.length) - 1];
}
export function nearest(frames, t, tolerance) {
  let lo = 0,
    hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].tMs < t) lo = mid + 1;
    else hi = mid;
  }
  const a = [frames[lo - 1], frames[lo]]
    .filter(Boolean)
    .sort((a, b) => Math.abs(a.tMs - t) - Math.abs(b.tMs - t));
  return a[0] && Math.abs(a[0].tMs - t) <= tolerance ? a[0] : null;
}
export function correlation(a, b) {
  if (a.length < 12 || a.length !== b.length) return null;
  const x = mean(a),
    y = mean(b);
  let ab = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += (a[i] - x) * (b[i] - y);
    aa += (a[i] - x) ** 2;
    bb += (b[i] - y) ** 2;
  }
  return aa * bb > 1e-12 ? ab / Math.sqrt(aa * bb) : null;
}
export function velocityLag(reference, observed, fps, maxLag = 8) {
  const dt = 1000 / fps;
  // Sparse logs cannot certify a camera-frame lag. Never fabricate interpolated motion.
  const gaps = observed.slice(1).map((f, i) => f.tMs - observed[i].tMs);
  if (!gaps.length || percentile(gaps, 0.95) > 2.5 * dt)
    return { lagFrames: null, reason: 'AR cadence too sparse for camera-frame lag' };
  const velocity = (frames, t, k) => {
    const a = nearest(frames, t, dt * 0.45),
      b = nearest(frames, t - dt, dt * 0.45);
    if (!a || !b || a === b || !usable(a.keypoints[k]) || !usable(b.keypoints[k])) return null;
    return [(a.keypoints[k].x - b.keypoints[k].x) / dt, (a.keypoints[k].y - b.keypoints[k].y) / dt];
  };
  const scores = [];
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const a = [],
      b = [];
    const channels = Array.from({ length: 8 }, () => ({ a: [], b: [] }));
    for (const f of reference)
      for (const [j, k] of [7, 8, 9, 10].entries()) {
        const x = velocity(reference, f.tMs, k),
          y = velocity(observed, f.tMs + lag * dt, k);
        if (x && y) {
          for (let axis = 0; axis < 2; axis++) {
            channels[j * 2 + axis].a.push(x[axis]);
            channels[j * 2 + axis].b.push(y[axis]);
          }
        }
      }
    // Centre each joint/axis separately: constant velocity or unequal x/y means
    // must not manufacture temporal variation when channels are concatenated.
    for (const ch of channels)
      if (ch.a.length) {
        const ma = mean(ch.a),
          mb = mean(ch.b);
        a.push(...ch.a.map((v) => v - ma));
        b.push(...ch.b.map((v) => v - mb));
      }
    const score = correlation(a, b);
    if (score !== null) scores.push({ lagFrames: lag, correlation: score, components: a.length });
  }
  scores.sort((a, b) => b.correlation - a.correlation);
  if (!scores.length) return { lagFrames: null, reason: 'No varying valid velocity signal' };
  return {
    ...scores[0],
    secondBestCorrelation: scores[1]?.correlation ?? null,
    meaning:
      'positive = observed delayed; window-wide correlation, not certified first-onset latency',
  };
}
export function compare(reference, observed, windows, fps = 30) {
  return windows.map((w) => {
    const refs = reference.filter((f) => f.tMs >= w.startMs && f.tMs <= w.endMs);
    const obs = observed.filter((f) => f.tMs >= w.startMs && f.tMs <= w.endMs);
    const errors = [],
      byJoint = Object.fromEntries(COCO.map((k) => [k, []]));
    let unmatched = 0,
      dropouts = 0,
      referenceDropouts = 0,
      unscorableIntersection = 0,
      swaps = 0,
      paired = 0;
    for (const a of obs) {
      const b = nearest(refs, a.tMs, 40);
      if (!b) {
        unmatched++;
        continue;
      }
      paired++;
      if (COCO.filter((k) => usable(b.keypoints[k])).length < 4) {
        referenceDropouts++;
        continue;
      }
      if (COCO.filter((k) => usable(a.keypoints[k])).length < 4) {
        dropouts++;
        continue;
      }
      const ks = COCO.filter((k) => usable(a.keypoints[k]) && usable(b.keypoints[k]));
      if (ks.length < 4) {
        unscorableIntersection++;
        continue;
      }
      for (const k of ks) {
        const e = distance(a.keypoints[k], b.keypoints[k]);
        errors.push(e);
        byJoint[k].push(e);
      }
      let direct = 0,
        swapped = 0,
        n = 0;
      for (const [l, r] of [
        [5, 6],
        [7, 8],
        [9, 10],
      ])
        if ([a.keypoints[l], a.keypoints[r], b.keypoints[l], b.keypoints[r]].every(usable)) {
          direct +=
            distance(a.keypoints[l], b.keypoints[l]) + distance(a.keypoints[r], b.keypoints[r]);
          swapped +=
            distance(a.keypoints[l], b.keypoints[r]) + distance(a.keypoints[r], b.keypoints[l]);
          n++;
        }
      // Exploratory swap indicator, not a labelled anatomical identity verdict.
      if (n >= 2 && direct > 3 && swapped < 0.6 * direct) swaps++;
    }
    return {
      ...w,
      observations: obs.length,
      referenceSamples: refs.length,
      paired,
      unmatched,
      dropoutObservations: dropouts,
      referenceDropoutObservations: referenceDropouts,
      unscorableIntersection,
      swapCandidates: swaps,
      meanPx: errors.length ? mean(errors) : null,
      p95Px: percentile(errors, 0.95),
      byJoint: Object.fromEntries(
        Object.entries(byJoint).map(([k, a]) => [
          k,
          { samples: a.length, meanPx: a.length ? mean(a) : null, p95Px: percentile(a, 0.95) },
        ]),
      ),
      onset: velocityLag(refs, obs, fps),
    };
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [ref, ar] = process.argv.slice(2).filter((x) => !x.startsWith('--'));
  if (!ref || !ar)
    throw new Error('Usage: node track-compare.mjs <RTMO.json> <AR-log.json> [--drawn]');
  const r = JSON.parse(readFileSync(ref)),
    a = JSON.parse(readFileSync(ar));
  const windows = [
    { name: 'still', startMs: 3400, endMs: 6400 },
    { name: 'cross', startMs: 22000, endMs: 28000 },
    { name: 'turn', startMs: 31000, endMs: 43000 },
    { name: 'back', startMs: 44000, endMs: 49000 },
  ];
  console.log(
    JSON.stringify(
      {
        referenceNotGroundTruth: true,
        referenceSource: r.source,
        arSource: a.source ?? 'unrecorded; caller must verify matching clip',
        track: process.argv.includes('--drawn') ? 'drawn' : 'raw MP',
        windows: compare(
          canonical(r),
          canonical(a, process.argv.includes('--drawn')),
          windows,
          r.frames[0]?.fps ?? 30,
        ),
      },
      null,
      2,
    ),
  );
}
