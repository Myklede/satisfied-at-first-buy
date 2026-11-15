// Browser-installable arithmetic. Positions in metres; glue/source landmarks in pixels.
export function installLayerProbe(target = globalThis) {
  target.__arLayerPair = (a, b, gap) => {
    const rms = (x, y, dimensions) => {
      if (!x?.length || x.length !== y?.length) return null;
      let sum = 0;
      for (let i = 0; i < x.length; i++) sum += (y[i] - x[i]) ** 2;
      return Math.sqrt(sum / (x.length / dimensions));
    };
    const normalize = (value) => (Number.isFinite(value) && gap > 0 ? value / gap : null);
    const glue = [];
    for (const [name, p] of Object.entries(a.glue ?? {})) {
      const q = b.glue?.[name];
      if (q) glue.push(Math.hypot(q[0] - p[0], q[1] - p[1]));
    }
    const glueRms = glue.length
      ? Math.sqrt(glue.reduce((s, x) => s + x * x, 0) / glue.length)
      : null;
    const jacket = rms(a.jacket, b.jacket, 3);
    const body = rms(a.body, b.body, 3);
    return {
      cameraGap: gap,
      gluePxPerObservation: glueRms,
      gluePxPerCameraFrame: normalize(glueRms),
      mirrorJacketMmPerObservation: jacket === null ? null : 1000 * jacket,
      mirrorJacketMmPerCameraFrame: normalize(jacket === null ? null : 1000 * jacket),
      mirrorBodyMmPerCameraFrame: normalize(body === null ? null : 1000 * body),
    };
  };
}
const finite = (values) => values.filter(Number.isFinite);
const mean = (values) => {
  const a = finite(values);
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
};
export function layerSummary(frames) {
  const pairs = frames.map((f) => f.layers).filter(Boolean);
  const average = (name) => mean(pairs.map((p) => p[name]));
  let seconds = 0,
    exposure = 0,
    gain = 0,
    lift = 0,
    gradePairs = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1],
      b = frames[i],
      dt = (b.videoMs - a.videoMs) / 1000;
    if (!(dt > 0) || !a.grade || !b.grade) continue;
    seconds += dt;
    gradePairs++;
    exposure += Math.abs(b.grade.exposure - a.grade.exposure);
    gain += Math.max(...b.grade.gain.map((x, k) => Math.abs(x - a.grade.gain[k])));
    lift += Math.abs(b.grade.lift - a.grade.lift);
  }
  return {
    observations: frames.length,
    engagedFraction: mean(
      frames.map((f) => (typeof f.lockEngaged === 'boolean' ? Number(f.lockEngaged) : null)),
    ),
    arBeforeFinisherPxPerCameraFrame: average('arBeforeFinisherPxPerCameraFrame'),
    gluePxPerCameraFrame: average('gluePxPerCameraFrame'),
    gluePxPerObservation: average('gluePxPerObservation'),
    mirrorJacketMmPerCameraFrame: average('mirrorJacketMmPerCameraFrame'),
    mirrorJacketMmPerObservation: average('mirrorJacketMmPerObservation'),
    mirrorBodyMmPerCameraFrame: average('mirrorBodyMmPerCameraFrame'),
    finisherEdgePxPerCameraFrame: average('finisherEdgePxPerCameraFrame'),
    gradeDriftPctPerS:
      gradePairs >= 4 && seconds > 0
        ? {
            exposure: (100 * exposure) / seconds,
            gain: (100 * gain) / seconds,
            lift: (100 * lift) / seconds,
          }
        : null,
    gradePairs,
    units:
      'Endpoint RMS displacement / camera presented-frame gap; grade total absolute parameter variation per media second, normalized to unit gain/exposure/lift. Missing data=N/A.',
  };
}
