// Prompt17b item1, literal OR failure policy. Neither threshold is fitted to a result.
export const PSD_LIVE_LIMITS = {
  addedHolePixels: 100,
  holeRatio: 1.5,
  arFpsLossPct: 10,
  addedTrackerMs: 5,
};
export function holeViolation(frame) {
  const off = frame?.holesOff,
    on = frame?.holesOn;
  if (!Number.isFinite(off) || !Number.isFinite(on) || off < 0 || on < 0)
    return { known: false, fail: true, reason: 'invalid/missing paired hole count' };
  const added = on - off,
    ratio = off > 0 ? on / off : null;
  return {
    known: true,
    fail: added > PSD_LIVE_LIMITS.addedHolePixels || on > PSD_LIVE_LIMITS.holeRatio * off,
    added,
    ratio,
    reason: 'fail if added>100 OR on>1.5x off; zero baseline allows zero holes only',
  };
}
export function decidePSDLive(report) {
  const sources = ['cam-parka', 'cam-tshirt'].map((source) => {
    const frames = report?.holes?.[source]?.frames ?? [];
    return {
      source,
      samples: frames.length,
      failures: frames.map((f) => ({ t: f.t, ...holeViolation(f) })).filter((f) => f.fail),
    };
  });
  const holesKnown = sources.every((s) => s.samples > 0);
  const holesPass = holesKnown && sources.every((s) => s.failures.length === 0);
  const base = report?.perf?.['no-bake'],
    two = report?.perf?.['2-workers'];
  const bFps = base?.arFps?.median,
    tFps = two?.arFps?.median,
    bMs = base?.trackerMs?.median,
    tMs = two?.trackerMs?.median;
  const known = [bFps, tFps, bMs, tMs].every(Number.isFinite) && bFps > 0;
  const cost = known
    ? { arFpsLossPct: (100 * (bFps - tFps)) / bFps, addedTrackerMs: tMs - bMs }
    : null;
  const twoPass =
    known &&
    cost.arFpsLossPct <= PSD_LIVE_LIMITS.arFpsLossPct &&
    cost.addedTrackerMs <= PSD_LIVE_LIMITS.addedTrackerMs;
  return {
    limits: PSD_LIVE_LIMITS,
    sources,
    holesKnown,
    holesPass,
    twoWorkers: { known, pass: known ? twoPass : null, cost },
    parkaDefaultAllowed: holesPass,
    workers: twoPass ? 2 : 1,
    note: 'Unknown cost does not certify two workers; use one conservatively. Missing paired samples do not certify default ON.',
  };
}
