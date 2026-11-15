import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { correlation, nearest, percentile } from './track-compare.mjs';

const good = (p) => p?.score >= 0.65;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
export function trackHealth(frames) {
  const logo = { x0: 1130, y0: 575, x1: 1240, y1: 700 }; // reviewed Camo 1280x720 branding bounds
  const inFrame = (f, k) =>
    good(f.keypoints?.[k]) &&
    f.keypoints[k].x >= 0 &&
    f.keypoints[k].x < f.width &&
    f.keypoints[k].y >= 0 &&
    f.keypoints[k].y < f.height;
  const runs = [];
  for (let i = 0; i < frames.length; i++) {
    const state = poseState(frames[i], frames[i - 1]);
    const last = runs.at(-1);
    if (last?.state === state) {
      last.endMs = frames[i].tMs;
      last.frames++;
    } else runs.push({ state, startMs: frames[i].tMs, endMs: frames[i].tMs, frames: 1 });
  }
  return {
    frames: frames.length,
    validReferenceFrames: frames.filter((f) => f.valid).length,
    referenceDropouts: frames.filter((f) => !f.valid).length,
    shouldersScorable: frames.filter((f) => [5, 6].every((k) => inFrame(f, k))).length,
    leftWristScorable: frames.filter((f) => inFrame(f, 9)).length,
    rightWristScorable: frames.filter((f) => inFrame(f, 10)).length,
    primaryBoxesWhollyInsideLogo: frames.filter(
      (f) =>
        f.box &&
        f.box[0] >= logo.x0 &&
        f.box[1] >= logo.y0 &&
        f.box[2] <= logo.x1 &&
        f.box[3] <= logo.y1,
    ).length,
    poseRuns: runs,
    logoBounds: logo,
    caveat:
      'score/in-frame availability only, not labelled pose accuracy. Logo box check covers only selected primary boxes, not person masks or all detections.',
  };
}
export function poseState(f, previous) {
  const p = f.keypoints;
  if (!p || ![5, 6].every((k) => good(p[k]))) return 'untracked';
  const sw = dist(p[5], p[6]);
  if (sw < 15) return 'untracked';
  if ([5, 6].some((k) => p[k].x < 0 || p[k].x >= f.width)) return 'cropped-shoulders';
  if (!good(p[0]) && [1, 2, 3, 4].filter((k) => good(p[k])).length < 2) return 'back-candidate';
  if (f.box && sw / (f.box[3] - f.box[1]) < 0.17) return 'turn-candidate';
  const up = [
    [5, 9],
    [6, 10],
  ].map(([s, w]) => good(p[w]) && p[w].y < p[s].y + 0.15 * sw);
  if (up.every(Boolean)) return 'both-arms-up';
  if (up.some(Boolean)) return 'one-arm-up';
  if (
    [9, 10].every((k) => good(p[k])) &&
    (p[9].x - p[10].x) * (p[5].x - p[6].x) < 0 &&
    Math.abs(p[9].y - p[10].y) < 0.65 * sw
  )
    return 'crossed-hands';
  if (previous?.keypoints && f.tMs - previous.tMs < 200) {
    const speeds = [5, 6, 7, 8, 9, 10]
      .filter((k) => good(p[k]) && good(previous.keypoints[k]))
      .map((k) => dist(p[k], previous.keypoints[k]) / sw / ((f.tMs - previous.tMs) / 1000));
    if (speeds.length >= 4 && mean(speeds) < 0.15) return 'still/down';
  }
  return 'moving/down';
}

export function windowLag(refs, observations, period) {
  const velocity = (frames, t, key, kind) => {
    const a = nearest(frames, t, period * 0.65),
      b = nearest(frames, t - period, period * 0.65);
    if (!a || !b || a === b || a.tMs - b.tMs > 2.5 * period) return null;
    const p = kind === 'raw' ? a.keypoints?.[key] : a.cuffs?.[key]?.renderedEndpoint;
    const q = kind === 'raw' ? b.keypoints?.[key] : b.cuffs?.[key]?.renderedEndpoint;
    if (!p || !q || (kind === 'raw' && (!good(p) || !good(q)))) return null;
    return kind === 'raw'
      ? [(p.x - q.x) / (a.tMs - b.tMs), (p.y - q.y) / (a.tMs - b.tMs)]
      : [(p[0] - q[0]) / (a.tMs - b.tMs), (p[1] - q[1]) / (a.tMs - b.tMs)];
  };
  const scores = [];
  for (let lag = -6; lag <= 6; lag++) {
    const aa = [],
      bb = [];
    for (const [key, side] of [
      [9, 'left'],
      [10, 'right'],
    ]) {
      const a = [[], []],
        b = [[], []];
      for (const r of refs) {
        const x = velocity(refs, r.tMs, key, 'raw');
        const y = velocity(observations, r.tMs + lag * period, side, 'mask');
        if (x && y)
          for (let axis = 0; axis < 2; axis++) {
            a[axis].push(x[axis]);
            b[axis].push(y[axis]);
          }
      }
      for (let axis = 0; axis < 2; axis++)
        if (a[axis].length >= 12) {
          const ma = mean(a[axis]),
            mb = mean(b[axis]);
          aa.push(...a[axis].map((v) => v - ma));
          bb.push(...b[axis].map((v) => v - mb));
        }
    }
    const score = correlation(aa, bb);
    if (score !== null)
      scores.push({ frames: lag, ms: lag * period, correlation: score, components: aa.length });
  }
  scores.sort((a, b) => b.correlation - a.correlation);
  if (!scores.length)
    return { frames: null, reason: 'no varying, confidently associated cuff signal' };
  return {
    ...scores[0],
    margin: scores[0].correlation - (scores[1]?.correlation ?? 0),
    uncertain:
      scores[0].correlation < 0.65 ||
      Math.abs(scores[0].frames) === 6 ||
      scores[0].correlation - (scores[1]?.correlation ?? 0) < 0.03,
    caveat:
      'window-wide cuff velocity association; not certified first-onset, elbow or shoulder latency',
    acceptedAsOnset: false,
  };
}

export function summarize(track, metrics) {
  const frames = track.frames;
  const period = percentile(
    frames.slice(1).map((f, i) => f.tMs - frames[i].tMs),
    0.5,
  );
  const windows = [];
  for (let i = 0; i < frames.length; i++) {
    const state = poseState(frames[i], frames[i - 1]);
    const last = windows.at(-1);
    if (last?.state === state) {
      last.endMs = frames[i].tMs;
      last.frames++;
    } else windows.push({ state, startMs: frames[i].tMs, endMs: frames[i].tMs, frames: 1 });
  }
  const out = [];
  const ranges = [
    { state: 'whole clip', startMs: 0, endMs: Infinity },
    ...windows.filter((w) => w.endMs - w.startMs >= 600),
  ];
  for (const w of ranges) {
    const rows = metrics.frames.filter((r) => r.rawMs >= w.startMs && r.rawMs <= w.endMs);
    const ref = frames.filter((r) => r.tMs >= w.startMs && r.tMs <= w.endMs);
    const cuffs = rows.flatMap((r) => Object.values(r.cuffs ?? {}));
    const offsets = cuffs.map((c) => c.offsetOverForearm);
    const hands = cuffs.filter((c) => c.handVisibleProxy !== null);
    const stats = (a) => ({
      samples: a.length,
      median: percentile(a, 0.5),
      p95: percentile(a, 0.95),
    });
    const body = {};
    for (const part of ['shoulder', 'torso'])
      for (const side of ['left', 'right'])
        body[part + '-' + side] = stats(
          rows.map((r) => r.bodyProxy?.[part]?.[side + 'OvershootPx']).filter(Number.isFinite),
        );
    out.push({
      ...w,
      endMs: Number.isFinite(w.endMs) ? w.endMs : frames.at(-1).tMs,
      arFrames: rows.length,
      cuffOffsetOverForearm: stats(offsets),
      handVisibleProxy: {
        scorable: hands.length,
        yes: hands.filter((c) => c.handVisibleProxy).length,
      },
      collarMinusNoseOverShoulder: stats(
        rows.map((r) => r.collarMinusNoseOverShoulder).filter(Number.isFinite),
      ),
      bodyProxy: body,
      cuffVelocityLag: windowLag(
        ref,
        rows.map((r) => ({ ...r, tMs: r.rawMs })),
        period,
      ),
    });
  }
  const candidates = [];
  for (let i = 1; i < metrics.frames.length; i++) {
    const a = metrics.frames[i - 1],
      b = metrics.frames[i];
    if (!a.scorable || !b.scorable) continue;
    const relative =
      Math.abs(b.maskPixels - a.maskPixels) / Math.max(1, a.maskPixels, b.maskPixels);
    if (relative > 0.35)
      candidates.push({ rawMs: b.rawMs, arMs: b.arMs, kind: 'mask-area change', relative });
    if (b.maskPixels < 0.05 * b.shoulderSpanPx ** 2)
      candidates.push({
        rawMs: b.rawMs,
        arMs: b.arMs,
        kind: 'low-mask candidate (not proof of missing jacket)',
      });
    for (const side of ['left', 'right']) {
      const p = a.cuffs?.[side]?.renderedEndpoint,
        q = b.cuffs?.[side]?.renderedEndpoint;
      if (p && q && Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.5 * b.shoulderSpanPx)
        candidates.push({ rawMs: b.rawMs, arMs: b.arMs, kind: side + ' cuff association jump' });
    }
  }
  return {
    periodMs: period,
    windows: out,
    allPoseRuns: windows,
    defectCandidates: candidates,
    methodValidity:
      'Exploratory masks only. Manual cuff cross-check failed; zero-lag output is not accepted as onset. Body joint envelopes are not real clothing boundaries.',
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const key = process.argv[2];
  if (!['live-parka', 'live-puffer', 'camo-1'].includes(key))
    throw new Error('Expected live-parka|live-puffer|camo-1');
  if (key === 'camo-1') {
    const track = JSON.parse(readFileSync('.cache/research/tracks/camo-1.json'));
    if (!track.complete) throw new Error('Wait for dense Camo extraction to complete');
    const result = trackHealth(track.frames);
    writeFileSync('.cache/research/live1/camo-1-summary.json', JSON.stringify(result, null, 2));
    console.log(
      JSON.stringify(
        { ...result, poseRuns: result.poseRuns.filter((r) => r.endMs - r.startMs >= 600) },
        null,
        2,
      ),
    );
  } else {
    const result = summarize(
      JSON.parse(readFileSync('.cache/research/tracks/' + key + '.json')),
      JSON.parse(readFileSync('.cache/research/live1/' + key + '-metrics.json')),
    );
    writeFileSync(
      '.cache/research/live1/' + key + '-summary.json',
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result.windows, null, 2));
  }
}
