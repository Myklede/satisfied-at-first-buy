import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { TARGETS } from './ar-eval-lib.mjs';
export const STILL_SELECTION = {
  minMs: 2000,
  maxMs: 3000,
  minSamples: 5,
  maxRmsPx: 2,
  minVisibility: 0.65,
};
// Operator qualification, not a new pose/fit threshold:2 source-px RMS about the
// window mean over >=2s, >=5 observations, >=4 continuously visible landmarks.
export function validTestsetFile(file) {
  return (
    typeof file === 'string' &&
    (/^(?:stock|venue)\/[a-zA-Z0-9_.-]+\.mp4$/.test(file) ||
      /^\.\.\/reference-photos\/(?:FB7675-100-parka-trang|DQ4920-206-puffer-kem)\/video\/(?:cam-still|venue-mac-ao|venue-khong-ao)\.mp4$/.test(
        file,
      ))
  );
}

export function testsetClips(root) {
  const rows = JSON.parse(readFileSync(join(root, 'data/test-videos/manifest.json'), 'utf8'));
  if (!Array.isArray(rows)) throw new Error('Expected testset array');
  const kinds = new Set([
    'still',
    'relaxed',
    'cross_arms',
    'arms_up_both',
    'arms_up_one',
    'back',
    'turn',
    'closeup',
    'enter_exit',
  ]);
  return rows
    .filter((r) => !r.probeOnly)
    .map((r) => {
      if (!validTestsetFile(r.file) || !(r.duration_s > 0 && r.duration_s <= 1800))
        throw new Error('Invalid local clip');
      const video = resolve(root, 'data/test-videos', r.file);
      if (!existsSync(video)) throw new Error('Missing local test clip');
      const segments = r.segments.map((s, k) => {
        if (
          !kinds.has(s.kind) ||
          !(s.start_s >= 0 && s.end_s > s.start_s && s.end_s <= r.duration_s + 0.1)
        )
          throw new Error('Invalid segment');
        return {
          id: `segment-${k}`,
          name: s.kind,
          startMs: s.start_s * 1000,
          endMs: s.end_s * 1000,
          expectedBack: s.kind === 'back',
        };
      });
      return {
        id: /mixkit-(\d+)/.exec(r.file)?.[1] ?? r.file.replace(/[^a-zA-Z0-9_-]/g, '_'),
        file: r.file,
        video,
        duration: r.duration_s,
        segments,
        upperBodyOnly: /seated|desk|video.call|therapist|doctor/i.test(
          `${r.framing} ${r.notes} ${r.file}`,
        ),
      };
    });
}
export function qualifyStill(frames, segments) {
  const output = [];
  for (const seg of segments.filter((s) => s.name === 'still')) {
    const rows = frames.filter((f) => f.videoMs >= seg.startMs && f.videoMs < seg.endMs && f.lm);
    let best = null;
    for (let start = 0; start < rows.length; start++) {
      const window = rows
        .slice(start)
        .filter((f) => f.videoMs - rows[start].videoMs <= STILL_SELECTION.maxMs);
      if (
        window.length < STILL_SELECTION.minSamples ||
        window.at(-1).videoMs - window[0].videoMs < STILL_SELECTION.minMs
      )
        continue;
      const ids = [0, 11, 12, 13, 14, 15, 16, 23, 24].filter((k) =>
        window.every((f) => f.lm[k]?.visibility >= STILL_SELECTION.minVisibility),
      );
      if (ids.length < 4) continue;
      let sum = 0;
      for (const k of ids) {
        const cx = window.reduce((s, f) => s + f.lm[k].x, 0) / window.length,
          cy = window.reduce((s, f) => s + f.lm[k].y, 0) / window.length;
        for (const f of window) sum += (f.lm[k].x - cx) ** 2 + (f.lm[k].y - cy) ** 2;
      }
      const rms = Math.sqrt(sum / (window.length * ids.length));
      if (!best || rms < best.rawRmsPx)
        best = {
          ...seg,
          startMs: window[0].videoMs,
          endMs: window.at(-1).videoMs + 0.001,
          rawRmsPx: rms,
          samples: window.length,
          landmarks: ids.length,
          qualified: rms <= STILL_SELECTION.maxRmsPx,
        };
    }
    output.push(
      best ?? {
        ...seg,
        qualified: false,
        rawRmsPx: null,
        reason: 'No >=2s valid raw-landmark interval; N/A.',
      },
    );
  }
  return output;
}
export function anywearNumbers(row) {
  const score = row.scoreboard ?? {},
    v = (k) => score[k]?.value ?? null,
    less = (x, n) => (Number.isFinite(x) ? x < n : null),
    within = (key) => (Number.isFinite(v(key)) ? v(key) <= TARGETS[key].value : null);
  const still = row.stillQualification?.some((w) => w.qualified)
    ? [within('restOutlinePxPerFrame'), within('restRotationRmsDeg'), within('restScaleStepP95Pct')]
    : [];
  const profile = row.kioskProfile?.modes?.[0];
  const onsets =
    row.motionOnsets?.filter((x) => ['turn', 'arm-motion', 'crossing-proxy'].includes(x.kind)) ??
    [];
  return {
    stationarity: still.length
      ? still.every((x) => x === true)
        ? true
        : still.some((x) => x === false)
          ? false
          : null
      : null,
    follows: onsets.some((x) => x.pass === false)
      ? false
      : onsets.length && onsets.every((x) => x.pass === true)
        ? true
        : null,
    residual: less(v('keypointResidualPx'), TARGETS.keypointResidualPx.value),
    coverage: less(v('frontalUncoveredPct'), TARGETS.frontalUncoveredPct.value),
    kioskFps: Number.isFinite(profile?.drawnFps)
      ? profile.drawnFps >= TARGETS.arFps.value && (profile.violations?.length ?? 0) === 0
      : null,
    lighting: null,
    garmentLook: null,
    visualStick: null,
    stationarityVisual: null,
    flicker: null,
  };
}
