// Independent rest probes. Quality targets come from lead-to-CX-DAY 20:20.
// Below are operator sampling/detection choices, not calibrated engine parameters:
// five drawn observations/four pairs and 80% coverage avoid sparse-data zero passes;
// a 2px input floor / 3x observed p95 noise define provisional onset only, not physical latency.
export const REST_POLICY = {
  minFrames: 5,
  minPairs: 4,
  minDrawnFraction: 0.8,
  onsetSearchMs: 10000,
  inputFloorPx: 2,
  noiseMultiplier: 3,
};

export function restWindowsFor(source, steps = []) {
  const labelled = steps.filter((s) =>
    /^(facing_relaxed|facing[ ,_-]+arms[ _-]+relaxed)$/i.test(s.name),
  );
  if (labelled.length)
    return labelled.map((s, i) => ({
      id: `capture-rest-${i}`,
      name: s.name,
      startMs: s.startMs,
      endMs: s.endMs,
    }));
  const range =
    source === 'cam-parka.mp4' ? [1500, 3000] : source === 'cam-tshirt.mp4' ? [1200, 3000] : null;
  return range
    ? [{ id: 'lead-rest', name: 'lead-labelled still window', startMs: range[0], endMs: range[1] }]
    : [];
}

// Playwright installs this trusted function as-is in each document, including after reload.
// Pixel buffers stay inside the browser; only pair statistics enter the numeric/private stream.
export function installRestProbe(target = globalThis) {
  if (target.HTMLVideoElement && !target.__arCameraProbeInstalled) {
    target.__arCameraProbeInstalled = true;
    const original = target.HTMLVideoElement.prototype.requestVideoFrameCallback;
    target.HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      return original.call(this, (now, metadata) => {
        this.__arCameraFrame = {
          index: metadata.presentedFrames,
          mediaMs: metadata.mediaTime * 1000,
        };
        callback(now, metadata);
      });
    };
  }
  target.__arRestPair = (a, b) => {
    if (!a || !b || a.width !== b.width || a.height !== b.height) return null;
    const { width: w, height: h } = a;
    // Corresponding polar contour points about the alpha centroid. Unlike averaging
    // horizontal/vertical normal motion, a 1px rigid shift measures exactly 1px.
    const contour = (im) => {
      const alpha = (x, y) => im.alphas[(y * w + x) * 4 + 2] / 255;
      let mass = 0,
        cx = 0,
        cy = 0;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const v = alpha(x, y);
          mass += v;
          cx += x * v;
          cy += y * v;
        }
      if (!mass) return [];
      cx /= mass;
      cy /= mass;
      const sample = (x, y) => {
        const ix = Math.floor(x),
          iy = Math.floor(y),
          dx = x - ix,
          dy = y - iy;
        return (
          alpha(ix, iy) * (1 - dx) * (1 - dy) +
          alpha(ix + 1, iy) * dx * (1 - dy) +
          alpha(ix, iy + 1) * (1 - dx) * dy +
          alpha(ix + 1, iy + 1) * dx * dy
        );
      };
      return Array.from({ length: 64 }, (_, k) => {
        const theta = (2 * Math.PI * k) / 64,
          ux = Math.cos(theta),
          uy = Math.sin(theta);
        let previous = null,
          point = null;
        for (let r = 0; r < Math.hypot(w, h); r += 0.5) {
          const x = cx + r * ux,
            y = cy + r * uy;
          if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return previous >= 0.5 ? null : point;
          const v = sample(x, y);
          if (previous !== null && previous >= 0.5 && v < 0.5) {
            const radius = r - 0.5 + (0.5 * (0.5 - previous)) / (v - previous);
            point = [cx + radius * ux, cy + radius * uy];
          }
          previous = v;
        }
        return null;
      });
    };
    const ea = contour(a),
      eb = contour(b);
    let distance = 0,
      edgeCount = 0,
      flicker = 0,
      pixels = 0;
    for (let i = 0; i < ea.length; i++)
      if (ea[i] && eb[i]) {
        distance += Math.hypot(eb[i][0] - ea[i][0], eb[i][1] - ea[i][1]) * a.scale;
        edgeCount++;
      }
    const interior = (im, x, y) => {
      const i = (y * w + x) * 4 + 2,
        p = im.alphas;
      return (
        p[i] >= 230 &&
        p[i - 4] >= 230 &&
        p[i + 4] >= 230 &&
        p[i - w * 4] >= 230 &&
        p[i + w * 4] >= 230
      );
    };
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        if (!interior(a, x, y) || !interior(b, x, y)) continue;
        const i = (y * w + x) * 4;
        const aa = a.colour[i + 3] / 255,
          ab = b.colour[i + 3] / 255;
        if (aa < 0.9 || ab < 0.9) continue;
        for (let k = 0; k < 3; k++)
          flicker += Math.abs(b.colour[i + k] / ab - a.colour[i + k] / aa) / 3;
        pixels++;
      }
    return {
      outlinePx: edgeCount >= 20 ? distance / edgeCount : null,
      edgeCount,
      flicker8bit: pixels >= 16 ? flicker / pixels : null,
      interiorPixels: pixels,
    };
  };
}

const finite = (v) => v.filter(Number.isFinite);
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const max = (v) => {
  const a = finite(v);
  return a.length ? Math.max(...a) : null;
};
const pct = (values, p) => {
  const a = finite(values).sort((a, b) => a - b);
  if (!a.length) return null;
  const i = (a.length - 1) * p;
  return a[Math.floor(i)] + (a[Math.ceil(i)] - a[Math.floor(i)]) * (i % 1);
};
const wrap = (x) => ((x + 540) % 360) - 180;
function rotationRms(rows) {
  const angles = rows
    .map((r) => r.drawnRotationDeg)
    .filter((r) => r?.length === 3 && r.every(Number.isFinite));
  if (angles.length < REST_POLICY.minFrames) return null;
  const centres = [0, 1, 2].map(
    (k) =>
      (Math.atan2(
        mean(angles.map((a) => Math.sin((a[k] * Math.PI) / 180))),
        mean(angles.map((a) => Math.cos((a[k] * Math.PI) / 180))),
      ) *
        180) /
      Math.PI,
  );
  return Math.sqrt(
    mean(angles.map((a) => a.reduce((sum, x, k) => sum + wrap(x - centres[k]) ** 2, 0))),
  );
}
function rawMotion(a, b) {
  const d = [];
  for (const k of [11, 12, 13, 14, 15, 16, 23, 24])
    if (a?.lm?.[k]?.visibility >= 0.65 && b?.lm?.[k]?.visibility >= 0.65)
      d.push(Math.hypot(a.lm[k].x - b.lm[k].x, a.lm[k].y - b.lm[k].y));
  return d.length >= 4 ? Math.max(...d) : null;
}

export function restSummary(frames, windows) {
  const rows = windows.map((window) => {
    const indexes = frames
      .map((f, i) => (f.videoMs >= window.startMs && f.videoMs < window.endMs ? i : -1))
      .filter((i) => i >= 0);
    const selected = indexes.map((i) => frames[i]);
    const drawn = selected.filter((f) => f.status === 'drawn' && f.fade < 0.01 && !f.backView);
    const measurements = drawn
      .map((f) => f.restMeasurements?.find((r) => r.id === window.id)?.pair)
      .filter((p) => p && (!Number.isFinite(p.fromVideoMs) || p.fromVideoMs >= window.startMs));
    const outlineObserved = finite(measurements.map((p) => p.outlinePx));
    const outline = finite(
      measurements.map((p) =>
        p.cameraFrameDelta > 0 && Number.isFinite(p.outlinePx)
          ? p.outlinePx / p.cameraFrameDelta
          : null,
      ),
    );
    const flicker = finite(measurements.map((p) => p.flicker8bit));
    const depthSteps = [],
      inputSteps = [],
      inputCameraSteps = [],
      depthObserved = [];
    for (let i = 1; i < indexes.length; i++)
      if (indexes[i] === indexes[i - 1] + 1) {
        const a = frames[indexes[i - 1]],
          b = frames[indexes[i]];
        if (a.status === 'drawn' && b.status === 'drawn' && a.depthDrawn > 0 && b.depthDrawn > 0) {
          const step = (100 * Math.abs(b.depthDrawn - a.depthDrawn)) / b.depthDrawn;
          depthObserved.push(step);
          if (b.cameraFrameIndex > a.cameraFrameIndex)
            depthSteps.push(
              100 *
                Math.abs(
                  Math.expm1(
                    Math.log(a.depthDrawn / b.depthDrawn) /
                      (b.cameraFrameIndex - a.cameraFrameIndex),
                  ),
                ),
            );
        }
        const d = rawMotion(a, b);
        if (d !== null) {
          inputSteps.push(d);
          if (b.cameraFrameIndex > a.cameraFrameIndex)
            inputCameraSteps.push(d / (b.cameraFrameIndex - a.cameraFrameIndex));
        }
      }
    const enough =
      drawn.length >= REST_POLICY.minFrames &&
      drawn.length / Math.max(1, selected.length) >= REST_POLICY.minDrawnFraction;
    const baseline = frames[indexes.at(-1)];
    const inputThresholdPx = Math.max(
      REST_POLICY.inputFloorPx,
      REST_POLICY.noiseMultiplier * (pct(inputSteps, 0.95) ?? 0),
    );
    const outputThresholdPx = Math.max(
      0.3,
      REST_POLICY.noiseMultiplier * (pct(outline, 0.95) ?? 0),
    );
    const after = frames
      .map((f, i) => ({ f, i }))
      .filter(
        ({ f }) =>
          f.videoMs >= window.endMs && f.videoMs < window.endMs + REST_POLICY.onsetSearchMs,
      );
    const onset = after.findIndex(({ f }) => (rawMotion(baseline, f) ?? 0) > inputThresholdPx);
    let motionOnset = {
      lagFrames: null,
      lagMs: null,
      pass: null,
      reason: 'no independently detected movement after rest',
    };
    if (enough && baseline && onset >= 0) {
      const output = after.findIndex(
        ({ f }, i) =>
          i >= onset &&
          (f.restMeasurements?.find((r) => r.id === window.id)?.fromRestOutlinePx ?? 0) >
            outputThresholdPx,
      );
      const observedAfterInput = after.length - onset;
      motionOnset =
        output >= 0
          ? {
              lagFrames:
                after[output].f.cameraFrameIndex >= after[onset].f.cameraFrameIndex
                  ? after[output].f.cameraFrameIndex - after[onset].f.cameraFrameIndex
                  : null,
              lagObservations: output - onset,
              lagMs: after[output].f.videoMs - after[onset].f.videoMs,
              pass:
                Number.isFinite(after[output].f.cameraFrameIndex) &&
                Number.isFinite(after[onset].f.cameraFrameIndex)
                  ? after[output].f.cameraFrameIndex - after[onset].f.cameraFrameIndex <= 1
                  : null,
              reason:
                'independent landmark/output crossings; camera presented-frame delta, not observations',
            }
          : {
              lagFrames: null,
              lagMs: null,
              pass: observedAfterInput >= 2 ? false : null,
              reason: 'output did not cross threshold during observed moving frames',
              observedAfterInput,
            };
    }
    return {
      ...window,
      frames: selected.length,
      drawnFrames: drawn.length,
      enough,
      outlinePxPerFrame: enough && outline.length >= REST_POLICY.minPairs ? mean(outline) : null,
      outlinePxPerObservation:
        enough && outlineObserved.length >= REST_POLICY.minPairs ? mean(outlineObserved) : null,
      outlinePairs: outline.length,
      cameraFrameDeltas: measurements.map((p) => p.cameraFrameDelta).filter(Number.isFinite),
      rawLandmarkNoisePxPerCameraFrame:
        inputCameraSteps.length >= REST_POLICY.minPairs ? mean(inputCameraSteps) : null,
      rawLandmarkNoisePxPerObservation:
        inputSteps.length >= REST_POLICY.minPairs ? mean(inputSteps) : null,
      rawLandmarkNoiseP95PxPerCameraFrame: pct(inputCameraSteps, 0.95),
      scaleStepP95PctPerObservation:
        enough && depthObserved.length >= REST_POLICY.minPairs ? pct(depthObserved, 0.95) : null,
      rotationRmsDeg: enough ? rotationRms(drawn) : null,
      scaleStepP95Pct:
        enough && depthSteps.length >= REST_POLICY.minPairs ? pct(depthSteps, 0.95) : null,
      flicker8bit: enough && flicker.length >= REST_POLICY.minPairs ? mean(flicker) : null,
      flickerPairs: flicker.length,
      motionOnset,
      inputThresholdPx,
      outputThresholdPx,
    };
  });
  const onsets = rows.map((r) => r.motionOnset);
  return {
    units: {
      outlineTarget: 'source px per camera presented frame',
      scaleTarget: '% per camera presented frame',
      rotation: 'degrees RMS about circular mean (not a temporal derivative)',
      sampling:
        'Endpoint displacement divided by camera presented-frame gap; unsampled within-gap excursions are unobservable.',
    },
    policy: REST_POLICY,
    windows: rows,
    outlinePxPerFrame: max(rows.map((r) => r.outlinePxPerFrame)),
    rotationRmsDeg: max(rows.map((r) => r.rotationRmsDeg)),
    scaleStepP95Pct: max(rows.map((r) => r.scaleStepP95Pct)),
    flicker8bit: max(rows.map((r) => r.flicker8bit)),
    motionOnsetLagFrames: max(onsets.map((r) => r.lagFrames)),
    motionOnsetPass: onsets.some((r) => r.pass === false)
      ? false
      : onsets.length && onsets.every((r) => r.pass === true)
        ? true
        : null,
  };
}
