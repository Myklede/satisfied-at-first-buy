// Operator detection choices: 2 source px over 3 quiet observations, matching
// REST_POLICY.inputFloorPx. This is an onset probe, never sensor/display latency.
export const MOTION_POLICY = { quietObservations: 3, activationPx: 2, visibility: 0.65 };
const norm = (a, b) => Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0) / (a.length / 2));
export function motionOnsets(frames) {
  const definitions = [
    { kind: 'turn', pairs: [['lShoulder', 11, 'rShoulder', 12]] },
    {
      kind: 'arm-motion',
      pairs: [
        ['lShoulder', 11, 'lWrist', 15],
        ['rShoulder', 12, 'rWrist', 16],
      ],
    },
    { kind: 'crossing-proxy', pairs: [['lWrist', 15, 'rWrist', 16]] },
  ];
  return definitions.map(({ kind, pairs }) => {
    const trace = frames
      .map((f) => {
        const raw = [],
          drawn = [];
        for (const [a, ai, b, bi] of pairs) {
          const p = f.lm?.[ai],
            q = f.lm?.[bi],
            x = f.drawnPoints?.[a],
            y = f.drawnPoints?.[b];
          if (
            !p ||
            !q ||
            p.visibility < MOTION_POLICY.visibility ||
            q.visibility < MOTION_POLICY.visibility ||
            !x ||
            !y
          )
            return null;
          raw.push(q.x - p.x, q.y - p.y);
          drawn.push(y[0] - x[0], y[1] - x[1]);
        }
        return Number.isFinite(f.cameraFrameIndex) ? { ...f, raw, drawn } : null;
      })
      .filter(Boolean);
    const events = [];
    let quiet = [];
    for (let i = 0; i < trace.length; i++) {
      const r = trace[i];
      if (!quiet.length) {
        quiet = [r];
        continue;
      }
      if (norm(r.raw, quiet[0].raw) <= MOTION_POLICY.activationPx) {
        quiet.push(r);
        continue;
      }
      if (quiet.length >= MOTION_POLICY.quietObservations) {
        const baseline = quiet.at(-1),
          inputPrevious = trace[i - 1];
        let outputIndex = -1;
        for (let j = i; j < trace.length && trace[j].videoMs - r.videoMs <= 2000; j++)
          if (norm(trace[j].drawn, baseline.drawn) > MOTION_POLICY.activationPx) {
            outputIndex = j;
            break;
          }
        const out = trace[outputIndex],
          prevOut = trace[outputIndex - 1];
        const point = out ? out.cameraFrameIndex - r.cameraFrameIndex : null;
        const lower =
          out && prevOut ? Math.max(0, prevOut.cameraFrameIndex + 1 - r.cameraFrameIndex) : null;
        const upper = out ? out.cameraFrameIndex - (inputPrevious.cameraFrameIndex + 1) : null;
        events.push({
          inputMs: r.videoMs,
          inputCameraFrame: r.cameraFrameIndex,
          outputMs: out?.videoMs ?? null,
          lagCameraFrames: point,
          lagBoundsCameraFrames: out ? [lower, upper] : null,
          pass: out ? (upper <= 1 ? true : lower > 1 ? false : null) : false,
          reason: out
            ? 'Landmark/control threshold crossings; bounds preserve unobserved camera frames.'
            : 'No drawn control response within2s of detected input onset.',
        });
      }
      quiet = [r];
    }
    const gaps = trace.slice(1).map((r, i) => r.cameraFrameIndex - trace[i].cameraFrameIndex);
    return {
      kind,
      observations: trace.length,
      maxCameraGap: gaps.length ? Math.max(...gaps) : null,
      events,
      pass: events.some((e) => e.pass === false)
        ? false
        : events.length && events.every((e) => e.pass === true)
          ? true
          : null,
      reason: events.length
        ? 'Proxy event; arm-motion/crossing proxy does not certify an operator-labelled raised/crossed-arm pose.'
        : 'No independently bracketed quiet-to-motion onset in valid sampled landmarks; N/A, never zero.',
      policy: MOTION_POLICY,
    };
  });
}

export function boundedOnsetScore(onsets) {
  const events = onsets.flatMap((r) => r.events ?? []),
    values = events.map((e) => e.lagCameraFrames).filter(Number.isFinite);
  return {
    value: values.length ? Math.max(...values) : null,
    pass: onsets.some((r) => r.pass === false)
      ? false
      : onsets.length && onsets.every((r) => r.pass === true)
        ? true
        : null,
    bounds: events.map((e) => e.lagBoundsCameraFrames),
    basis:
      'Bounded raw/control onset proxies; unobserved camera frames and missing motion types cannot certify one-frame response.',
  };
}

// F5 judge v2 onset probe (2026-11-14, from F1's evidence that the 2 px probe fires on
// landmark noise: 0.9-1.9 px per observation on cam-still). Legacy motionOnsets is unchanged.
// Activation is per vector: max(6 px, 4 x the median observation-to-observation step of that
// vector), the input must stay beyond it for >= 3 observations (sustained), after >= 3 quiet
// observations within half of it. Lag = first drawn crossing of the SAME threshold from the
// drawn baseline, in camera presented frames, with the legacy unobserved-frame bounds.
export const MOTION_POLICY_V2 = {
  quietObservations: 3,
  sustainObservations: 3,
  minActivationPx: 6,
  noiseMultiple: 4,
  visibility: 0.65,
  maxResponseMs: 2000,
};
export function motionOnsetsV2(frames, policy = MOTION_POLICY_V2) {
  const definitions = [
    { kind: 'turn', pairs: [['lShoulder', 11, 'rShoulder', 12]] },
    {
      kind: 'arm-motion',
      pairs: [
        ['lShoulder', 11, 'lWrist', 15],
        ['rShoulder', 12, 'rWrist', 16],
      ],
    },
    { kind: 'crossing-proxy', pairs: [['lWrist', 15, 'rWrist', 16]] },
  ];
  return definitions.map(({ kind, pairs }) => {
    const trace = frames
      .map((f) => {
        const raw = [],
          drawn = [];
        for (const [a, ai, b, bi] of pairs) {
          const p = f.lm?.[ai],
            q = f.lm?.[bi],
            x = f.drawnPoints?.[a],
            y = f.drawnPoints?.[b];
          if (!p || !q || p.visibility < policy.visibility || q.visibility < policy.visibility)
            return null;
          if (!x || !y) return null;
          raw.push(q.x - p.x, q.y - p.y);
          drawn.push(y[0] - x[0], y[1] - x[1]);
        }
        return Number.isFinite(f.cameraFrameIndex) ? { ...f, raw, drawn } : null;
      })
      .filter(Boolean);
    const steps = trace
      .slice(1)
      .map((r, i) => norm(r.raw, trace[i].raw))
      .sort((a, b) => a - b);
    const noise = steps.length ? steps[Math.floor(steps.length / 2)] : null;
    const act = Math.max(policy.minActivationPx, policy.noiseMultiple * (noise ?? 0));
    const events = [];
    let i = 0;
    while (i < trace.length) {
      // quiet run
      let q = i + 1;
      while (q < trace.length && norm(trace[q].raw, trace[i].raw) <= act / 2) q++;
      if (q - i < policy.quietObservations || q >= trace.length) {
        i = Math.max(i + 1, q);
        continue;
      }
      const baseline = trace[q - 1];
      // sustained departure
      let k = q;
      while (k < trace.length && norm(trace[k].raw, baseline.raw) <= act) k++;
      if (k >= trace.length) break;
      let sustained = true;
      for (let s = k; s < k + policy.sustainObservations; s++)
        if (s >= trace.length || norm(trace[s].raw, baseline.raw) <= act) sustained = false;
      if (!sustained) {
        i = k;
        continue;
      }
      const r = trace[k],
        inputPrevious = trace[k - 1];
      let outIdx = -1;
      for (let j = k; j < trace.length && trace[j].videoMs - r.videoMs <= policy.maxResponseMs; j++)
        if (norm(trace[j].drawn, baseline.drawn) > act) {
          outIdx = j;
          break;
        }
      const out = trace[outIdx],
        prevOut = trace[outIdx - 1];
      const point = out ? out.cameraFrameIndex - r.cameraFrameIndex : null;
      const lower =
        out && prevOut ? Math.max(0, prevOut.cameraFrameIndex + 1 - r.cameraFrameIndex) : null;
      const upper = out
        ? Math.max(0, out.cameraFrameIndex - (inputPrevious.cameraFrameIndex + 1))
        : null;
      events.push({
        inputMs: r.videoMs,
        inputCameraFrame: r.cameraFrameIndex,
        outputMs: out?.videoMs ?? null,
        lagCameraFrames: point,
        lagBoundsCameraFrames: out ? [lower, upper] : null,
        pass: out ? (upper <= 1 ? true : lower > 1 ? false : null) : false,
      });
      // skip to the end of this motion (input back within act of its own running value)
      i = k + policy.sustainObservations;
    }
    return {
      kind,
      observations: trace.length,
      noisePx: noise,
      activationPx: act,
      events,
      pass: events.some((e) => e.pass === false)
        ? false
        : events.length && events.every((e) => e.pass === true)
          ? true
          : null,
      policy,
    };
  });
}
