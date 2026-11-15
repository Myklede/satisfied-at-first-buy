// Pure maths of the live-AR scoreboard (agent V5). No I/O, no browser: unit-tested in
// scripts/ar-eval.test.mjs. Numbers only. Used by scripts/ar-eval.mjs.
//
// A "frame record" is the normalised per-frame row both modes produce:
//   { t (ms), yawRaw, yawDrawn (deg), depthDrawn (m), status, fade, backView, alignRmsPx,
//     collarFired, armBeforePx, armAfterPx, glueResidualPx, glueCapBound, glueFrames (cumulative),
//     totalMs, lm: landmark array (33 {x,y,visibility}) or null,
//     // video mode only:
//     keypointResidualPx, uncoveredPct, outline: {lShoulder:[x,y],...} }

import { restSummary } from './ar-eval-rest.mjs';

export const TARGETS = {
  keypointResidualPx: { op: '<', value: 5, label: 'keypoint residual px' },
  uncoveredPct: { op: '<', value: 2, label: 'uncovered clothing %' },
  outlineJitterPxPerFrame: { op: '<', value: 1.5, label: 'outline jitter px/frame' },
  facingYawAbsMeanDeg: { op: '<', value: 2, label: 'facing abs yaw mean deg' },
  facingYawSdDeg: { op: '<', value: 2, label: 'facing yaw sd deg' },
  scaleStepP95Pct: { op: '<', value: 0.5, label: 'scale step p95 %' },
  trackedFps: { op: '>=', value: 24, label: 'tracked fps' },
  cameraToScreenMs: { op: '<', value: 50, label: 'camera to screen ms' },
  frontalUncoveredPct: { op: '<', value: 2, label: 'V4 frontal uncovered %' },
  backHandledPct: { op: '>=', value: 95, label: 'labelled back handled %' },
  finisherMainThreadMs: { op: '<=', value: 4, label: 'finisher main-thread ms' },
  arFps: { op: '>=', value: 24, label: 'AR fps' },
  restOutlinePxPerFrame: { op: '<=', value: 0.3, label: 'rest outline px/frame' },
  restRotationRmsDeg: { op: '<=', value: 0.2, label: 'rest rotation RMS deg' },
  restScaleStepP95Pct: { op: '<=', value: 0.1, label: 'rest scale step p95 %' },
  restMotionOnsetLagFrames: { op: '<=', value: 1, label: 'motion onset lag frames' },
  restFlicker8bit: { op: 'report', value: null, label: 'rest pixel flicker 8bit' },
};

// Segmentation thresholds (documented here, not tuned against the AR): a frame is "turning"
// when the raw yaw is beyond TURN_YAW_DEG or moving faster than TURN_RATE_DEG_S; "arms" when
// either upper arm is lifted more than ARM_ELEVATION_DEG from the torso line; else "facing".
export const TURN_YAW_DEG = 20;
export const TURN_RATE_DEG_S = 30;
export const ARM_ELEVATION_DEG = 35;
// "Standing" for the outline jitter: arms down, facing, wrists/elbows slower than this.
export const STAND_LM_SPEED_PX_S = 60;

export const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
export const sd = (v) => {
  if (v.length < 2) return v.length ? 0 : null;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
};
export function percentile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (v.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return v[lo] + (v[hi] - v[lo]) * (i - lo);
}
const finite = (v) => v.filter(Number.isFinite);
const round = (x, d = 2) =>
  x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(d));

/** Angle (deg) between shoulder->elbow and the torso's downward direction, from 2D landmarks. */
export function armElevationDeg(lm, side) {
  const [s, e, h] = side === 'L' ? [11, 13, 23] : [12, 14, 24];
  const [s2, h2] = [lm[s], lm[h]];
  const el = lm[e];
  if (!s2 || !el || !h2 || Math.min(s2.visibility, el.visibility, h2.visibility) < 0.5) return null;
  const down = [h2.x - s2.x, h2.y - s2.y];
  const arm = [el.x - s2.x, el.y - s2.y];
  const nd = Math.hypot(...down);
  const na = Math.hypot(...arm);
  if (!nd || !na) return null;
  const cos = (down[0] * arm[0] + down[1] * arm[1]) / (nd * na);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/** Label every frame record 'facing' | 'arms' | 'turning' | 'untracked'. */
export function segmentFrames(frames) {
  const labels = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (!f.lm || f.status === 'lost' || f.yawRaw == null) {
      labels.push('untracked');
      continue;
    }
    const prev = frames[Math.max(0, i - 3)];
    const next = frames[Math.min(frames.length - 1, i + 3)];
    const dt = (next.t - prev.t) / 1000;
    const rate =
      dt > 0 && prev.yawRaw != null && next.yawRaw != null
        ? Math.abs(next.yawRaw - prev.yawRaw) / dt
        : 0;
    if (Math.abs(f.yawRaw) > TURN_YAW_DEG || rate > TURN_RATE_DEG_S) {
      labels.push('turning');
      continue;
    }
    const el = [armElevationDeg(f.lm, 'L'), armElevationDeg(f.lm, 'R')].filter((x) => x !== null);
    labels.push(el.some((x) => x > ARM_ELEVATION_DEG) ? 'arms' : 'facing');
  }
  return labels;
}

/** Mean px/s speed of the elbow and wrist landmarks, per frame (null when unknown). */
export function limbSpeeds(frames) {
  const idx = [13, 14, 15, 16];
  return frames.map((f, i) => {
    const p = frames[i - 1];
    if (!p || !f.lm || !p.lm || f.t <= p.t) return null;
    const d = [];
    for (const k of idx) d.push(Math.hypot(f.lm[k].x - p.lm[k].x, f.lm[k].y - p.lm[k].y));
    return (mean(d) / (f.t - p.t)) * 1000;
  });
}

function stepPct(depths) {
  const out = [];
  for (let i = 1; i < depths.length; i++)
    if (Number.isFinite(depths[i]) && Number.isFinite(depths[i - 1]) && depths[i] > 0)
      out.push((Math.abs(depths[i] - depths[i - 1]) / depths[i]) * 100);
  return out;
}

const q = (v, d = 2) => ({
  p50: round(percentile(v, 0.5), d),
  p90: round(percentile(v, 0.9), d),
  p95: round(percentile(v, 0.95), d),
});

/** Outline step px/frame over runs of standing frames (consecutive in the array). */
export function outlineJitter(frames, labels, speeds) {
  const steps = [];
  const lmSteps = [];
  const names = ['lShoulder', 'rShoulder', 'lHip', 'rHip'];
  const lmIdx = { lShoulder: 11, rShoulder: 12, lHip: 23, rHip: 24 };
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    const stand = (j) =>
      labels[j] === 'facing' && speeds[j] != null && speeds[j] < STAND_LM_SPEED_PX_S;
    if (!stand(i) || !stand(i - 1) || !a.outline || !b.outline) continue;
    for (const n of names) {
      if (a.outline[n] && b.outline[n])
        steps.push(
          Math.hypot(b.outline[n][0] - a.outline[n][0], b.outline[n][1] - a.outline[n][1]),
        );
      if (a.lm && b.lm)
        lmSteps.push(
          Math.hypot(b.lm[lmIdx[n]].x - a.lm[lmIdx[n]].x, b.lm[lmIdx[n]].y - a.lm[lmIdx[n]].y),
        );
    }
  }
  return {
    frames: steps.length / names.length,
    meanPxPerFrame: round(mean(steps), 3),
    p95PxPerFrame: round(percentile(steps, 0.95), 3),
    landmarkMeanPxPerFrame: round(mean(lmSteps), 3),
  };
}

function segmentStats(frames, idxs, wallSeconds) {
  const rows = idxs.map((i) => frames[i]);
  // Time and fps over runs of recording-adjacent frames only (segments interleave).
  let secs = 0;
  let pairs = 0;
  for (let k = 1; k < idxs.length; k++)
    if (idxs[k] === idxs[k - 1] + 1 && rows[k].t > rows[k - 1].t) {
      secs += (rows[k].t - rows[k - 1].t) / 1000;
      pairs++;
    }
  // Consecutive-frame scale change only between frames adjacent in the recording.
  const steps = [];
  for (let k = 1; k < idxs.length; k++)
    if (idxs[k] === idxs[k - 1] + 1)
      steps.push(...stepPct([rows[k - 1].depthDrawn, rows[k].depthDrawn]));
  const yaw = finite(rows.map((r) => r.yawDrawn));
  const capDelta = [];
  for (let k = 1; k < idxs.length; k++) {
    const a = rows[k - 1];
    const b = rows[k];
    if (idxs[k] === idxs[k - 1] + 1 && Number.isFinite(b.glueFrames) && b.glueFrames > a.glueFrames)
      capDelta.push((b.glueCapBound - a.glueCapBound) / (b.glueFrames - a.glueFrames));
  }
  const resid = finite(rows.map((r) => r.glueResidualPx));
  return {
    frames: rows.length,
    seconds: round(secs, 2),
    trackedFps: secs > 0 ? round(pairs / secs, 1) : null,
    cameraToScreenMs: round(mean(finite(rows.map((r) => r.totalMs))), 1),
    yawDrawnDeg: { mean: round(mean(yaw), 2), sd: round(sd(yaw), 2) },
    scaleStepPct: q(steps, 3),
    armFitPx: {
      before: q(finite(rows.map((r) => r.armBeforePx)), 1),
      after: q(finite(rows.map((r) => r.armAfterPx)), 1),
    },
    collarFireRate: rows.length
      ? round(rows.filter((r) => r.collarFired).length / rows.length, 3)
      : null,
    fadeFrames: rows.filter((r) => r.fade > 0).length,
    backViewFrames: rows.filter((r) => r.backView).length,
    alignmentRmsPx: { ...q(finite(rows.map((r) => r.alignRmsPx)), 1) },
    glue: resid.length
      ? {
          postWarpResidualPx: { mean: round(mean(resid), 2), ...q(resid, 2) },
          capBindRate: round(mean(capDelta), 3),
        }
      : null,
    ...(rows.some((r) => r.keypointResidualPx != null)
      ? {
          keypointResidualPx: {
            mean: round(mean(finite(rows.map((r) => r.keypointResidualPx))), 2),
            ...q(finite(rows.map((r) => r.keypointResidualPx)), 2),
          },
          uncoveredPct: {
            mean: round(mean(finite(rows.map((r) => r.uncoveredPct))), 2),
            ...q(finite(rows.map((r) => r.uncoveredPct)), 2),
            samples: finite(rows.map((r) => r.uncoveredPct)).length,
          },
        }
      : {}),
    wallSeconds: wallSeconds ?? null,
  };
}

/** Whole-recording summary: per segment kind plus the overall block. */
export function summarise(frames, { wallSeconds = null, restWindows = [] } = {}) {
  const labels = segmentFrames(frames);
  const speeds = limbSpeeds(frames);
  const out = { frames: frames.length, segments: {} };
  for (const kind of ['facing', 'arms', 'turning']) {
    const idxs = labels.map((l, i) => (l === kind ? i : -1)).filter((i) => i >= 0);
    out.segments[kind] = idxs.length ? segmentStats(frames, idxs, null) : null;
  }
  const tracked = labels.map((l, i) => (l !== 'untracked' ? i : -1)).filter((i) => i >= 0);
  out.untrackedFrames = labels.filter((l) => l === 'untracked').length;
  out.overall = tracked.length ? segmentStats(frames, tracked, wallSeconds) : null;
  if (out.overall && wallSeconds) out.overall.trackedFps = round(tracked.length / wallSeconds, 1);
  // Facing + arms-up frames: the "calm" set the residual / uncovered targets are scored on (a
  // turn is reported on its own under segments.turning; scoring it would hide real regressions).
  const calmIdx = labels
    .map((l, i) => (l === 'facing' || l === 'arms' ? i : -1))
    .filter((i) => i >= 0);
  out.calm = calmIdx.length ? segmentStats(frames, calmIdx, null) : null;
  out.outlineJitter = outlineJitter(frames, labels, speeds);
  // Scale step over everything that is not a turn (a turn legitimately changes the apparent size).
  const calm = tracked.filter((i) => labels[i] !== 'turning');
  const calmSteps = [];
  for (let k = 1; k < calm.length; k++)
    if (calm[k] === calm[k - 1] + 1)
      calmSteps.push(...stepPct([frames[calm[k - 1]].depthDrawn, frames[calm[k]].depthDrawn]));
  out.scaleStepNonTurningPct = q(calmSteps, 3);
  out.rest = restSummary(frames, restWindows);
  // V4's post-finisher clothing-class metric, never the person-mask fallback.
  const frontal = frames.filter(
    (r) =>
      r.status === 'drawn' &&
      !r.backView &&
      Number.isFinite(r.yawDrawn) &&
      Math.abs(r.yawDrawn) <= TURN_YAW_DEG &&
      r.fade < 0.01,
  );
  const coverage = finite(frontal.map((r) => r.frontalUncoveredPct));
  const back = frames.filter((r) => r.expectedBack === true);
  out.quality = {
    frontalUncoveredPct: { mean: round(mean(coverage)), samples: coverage.length },
    backFrames: back.length,
    // F5 2026-11-14 (defect atlas D2): "handled" means the jacket is DRAWN as its back view
    // (status drawn, backView, not faded). A hidden/faded jacket on the back used to count as
    // handled and reported 100 % while no jacket was drawn; it now fails.
    backHandledPct: back.length
      ? round(
          (100 *
            back.filter(
              (r) =>
                r.correctBack === true ||
                (r.status === 'drawn' && r.backView === true && (r.fade ?? 0) < 0.05),
            ).length) /
            back.length,
        )
      : null,
    finisherMainThreadMs: {
      mean: round(mean(finite(frames.map((r) => r.finisherMainThreadMs)))),
      samples: finite(frames.map((r) => r.finisherMainThreadMs)).length,
    },
    arFps: {
      mean: round(mean(finite(frames.map((r) => r.arFps)))),
      samples: finite(frames.map((r) => r.arFps)).length,
    },
    alignmentRmsPx: {
      ...q(finite(frames.map((r) => r.alignRmsPx))),
      samples: finite(frames.map((r) => r.alignRmsPx)).length,
    },
  };
  return out;
}

/** The scoreboard metrics (null when not measurable in this mode) and their pass/fail. */
// A metric from fewer frames than this is reported as not measurable (null), not as a pass/fail.
export const MIN_FRAMES = 30;
export const MIN_UNCOVERED_SAMPLES = 8;

export function scoreboard(summary) {
  const o = summary.overall;
  const f = summary.segments.facing;
  const c = summary.calm;
  const enough = (n) => (n ?? 0) >= MIN_FRAMES;
  const metrics = {
    keypointResidualPx: enough(c?.frames) ? (c?.keypointResidualPx?.p50 ?? null) : null,
    uncoveredPct:
      (c?.uncoveredPct?.samples ?? 0) >= MIN_UNCOVERED_SAMPLES ? c.uncoveredPct.mean : null,
    outlineJitterPxPerFrame: enough(summary.outlineJitter?.frames)
      ? summary.outlineJitter.meanPxPerFrame
      : null,
    facingYawAbsMeanDeg:
      enough(f?.frames) && f.yawDrawnDeg.mean != null ? Math.abs(f.yawDrawnDeg.mean) : null,
    facingYawSdDeg: enough(f?.frames) ? (f.yawDrawnDeg.sd ?? null) : null,
    scaleStepP95Pct: summary.scaleStepNonTurningPct?.p95 ?? null,
    trackedFps: o?.trackedFps ?? null,
    cameraToScreenMs: o?.cameraToScreenMs ?? null,
    frontalUncoveredPct:
      (summary.quality?.frontalUncoveredPct.samples ?? 0) >= MIN_UNCOVERED_SAMPLES
        ? summary.quality.frontalUncoveredPct.mean
        : null,
    backHandledPct: enough(summary.quality?.backFrames) ? summary.quality.backHandledPct : null,
    finisherMainThreadMs: enough(summary.quality?.finisherMainThreadMs.samples)
      ? summary.quality.finisherMainThreadMs.mean
      : null,
    arFps: enough(summary.quality?.arFps.samples) ? summary.quality.arFps.mean : null,
    restOutlinePxPerFrame: summary.rest?.outlinePxPerFrame ?? null,
    restRotationRmsDeg: summary.rest?.rotationRmsDeg ?? null,
    restScaleStepP95Pct: summary.rest?.scaleStepP95Pct ?? null,
    restMotionOnsetLagFrames: summary.rest?.motionOnsetLagFrames ?? null,
    restFlicker8bit: summary.rest?.flicker8bit ?? null,
  };
  const result = {};
  for (const [k, t] of Object.entries(TARGETS)) {
    const v = metrics[k];
    const pass =
      t.op === 'report'
        ? null
        : v == null
          ? null
          : t.op === '<'
            ? v < t.value
            : t.op === '<='
              ? v <= t.value
              : v >= t.value;
    result[k] = {
      value: v,
      target: t.op === 'report' ? 'report only' : `${t.op} ${t.value}`,
      pass,
    };
  }
  if (summary.rest && result.restMotionOnsetLagFrames)
    result.restMotionOnsetLagFrames.pass = summary.rest.motionOnsetPass;
  return result;
}

/** One markdown table row for docs/STATUS-ar-eval.md. */
export function markdownRow({ commit, date, source, score }) {
  const cell = (k) => {
    const r = score[k];
    if (r?.value == null) return r?.pass === false ? 'FAIL (no response)' : 'n/a';
    return `${r.value}${r.target === 'report only' ? ' reported' : r.pass == null ? ' n/a' : r.pass ? ' ok' : ' FAIL'}`;
  };
  return `| ${commit} | ${date} | ${source} | ${Object.keys(TARGETS).map(cell).join(' | ')} |`;
}

export function markdownHeader() {
  const cols = Object.entries(TARGETS).map(
    ([, t]) => `${t.label} (${t.op === 'report' ? 'report' : `${t.op} ${t.value}`})`,
  );
  return `| commit | UTC date | source | ${cols.join(' | ')} |\n|${' --- |'.repeat(cols.length + 3)}`;
}

/** Replace just the owned scoreboard table, preserving historical rows and step sections. */
export function upsertScoreTable(text, input) {
  const start = '<!-- cxday-score:start -->',
    end = '<!-- cxday-score:end -->';
  let a = text.indexOf(start),
    b = text.indexOf(end);
  if (a < 0 || b < a) {
    text += `\n## CX-DAY prompt 16b\n\n${start}\n${markdownHeader()}\n${end}\n`;
    a = text.indexOf(start);
    b = text.indexOf(end);
  }
  const data = text
    .slice(a + start.length, b)
    .split('\n')
    .filter(
      (line) =>
        line.startsWith('| ') &&
        !/^\|\s*commit\s*\|/.test(line) &&
        !/^\|[\s|-]+$/.test(line) &&
        !(
          line.split('|')[1]?.trim() === input.commit && line.split('|')[3]?.trim() === input.source
        ),
    );
  const cells = Object.keys(TARGETS).length + 3;
  const padded = data.map((line) => {
    const values = line
      .split('|')
      .slice(1, -1)
      .map((v) => v.trim());
    while (values.length < cells) values.push('n/a');
    return `| ${values.join(' | ')} |`;
  });
  const block = `${start}\n${markdownHeader()}\n${[...padded, markdownRow(input)].join('\n')}\n${end}`;
  return text.slice(0, a) + block + text.slice(b + end.length);
}

/** Metrics that got worse between two scoreboards (ignoring unmeasured ones). */
export function regressions(prev, next) {
  const out = [];
  for (const [k, t] of Object.entries(TARGETS)) {
    if (t.op === 'report') continue;
    const a = prev?.[k]?.value;
    const b = next?.[k]?.value;
    if (a == null || b == null) continue;
    const worse = t.op.startsWith('<') ? b > a * 1.1 + 1e-9 : b < a * 0.9 - 1e-9;
    if (worse || (prev[k].pass && next[k].pass === false)) out.push({ metric: k, from: a, to: b });
  }
  return out;
}

/** Mean post-warp residual (px) over V5's keypoints in debugState().glue.residualPx. */
export function glueResidual(g) {
  const r = g?.residualPx;
  if (!r || typeof r !== 'object')
    return Number.isFinite(g?.lastResidualPx) ? g.lastResidualPx : null;
  const v = ['lShoulder', 'rShoulder', 'lElbow', 'rElbow', 'lWrist', 'rWrist']
    .map((k) => r[k])
    .filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** Normalise one of V1's diagnostics entries into a frame record. */
export function fromDiagFrame(d) {
  const ar = d.ar ?? null;
  const g = ar?.glue ?? null;
  return {
    t: d.t,
    yawRaw: ar?.yawRawDeg ?? null,
    yawDrawn: ar?.yawDrawnDeg ?? null,
    depthDrawn: ar?.depthDrawnM ?? null,
    status: d.phase === 'tracking' ? (ar?.status ?? 'unknown') : 'lost',
    fade: ar?.fade ?? 0,
    backView: !!ar?.backView,
    alignRmsPx: ar?.alignment?.rmsPx ?? null,
    collarFired: !!ar?.collar?.fired,
    armBeforePx: ar?.armFit?.beforePx ?? null,
    armAfterPx: ar?.armFit?.afterPx ?? null,
    glueResidualPx: glueResidual(g),
    glueCapBound: g?.capBoundFrames ?? g?.capBound ?? null,
    glueFrames: g?.frames ?? null,
    totalMs: d.timing?.totalMs ?? null,
    lm: d.landmarks2d ?? null,
  };
}
