// Read-only comparison: never retunes any engine or fills missing measurements.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const ROOT = resolve(import.meta.dirname, '..');

export function compareMetric(
  real,
  sim,
  {
    compatible = false,
    reason = '2D projected held-window median versus 3D peak; not an accuracy verdict',
  } = {},
) {
  const a = real?.valueCm,
    b = sim?.value;
  if (!Number.isFinite(a) || !Number.isFinite(b))
    return {
      realCm: Number.isFinite(a) ? a : null,
      simCm: Number.isFinite(b) ? b : null,
      deltaCm: null,
      withinUncertainty: null,
      status: 'unavailable',
      reason: real?.reason ?? sim?.withheld ?? 'missing measurement',
    };
  const delta = b - a,
    u = real.uncertaintyCm;
  return {
    realCm: a,
    simCm: b,
    deltaCm: delta,
    realUncertaintyCm: u ?? null,
    numericalOverlap: Number.isFinite(u) ? Math.abs(delta) <= u : null,
    withinUncertainty: compatible && Number.isFinite(u) ? Math.abs(delta) <= u : null,
    status: compatible ? 'comparable' : 'descriptive-only',
    reason: compatible ? null : reason,
  };
}

export function comparisons(real, physics, ar, supplemental = null) {
  const rows = [];
  const products = structuredClone(real?.products ?? []);
  const productFor = (jacket) => {
    let p = products.find((p) => p.jacket === jacket);
    if (!p) {
      p = { jacket, moves: [] };
      products.push(p);
    }
    return p;
  };
  if (String(physics?.garment?.style).includes('FB7675-100')) {
    const p = productFor('parka');
    for (const sim of physics.moves ?? [])
      if (!p.moves.some((m) => m.move === sim.id))
        p.moves.push({ move: sim.id, windowSeconds: sim.videoWindowS, cuffRideUp: {} });
  }
  if (supplemental?.observation?.jacket === 'puffer') {
    const o = supplemental.observation,
      p = productFor('puffer');
    let m = p.moves.find((m) => m.move === o.move);
    if (!m) {
      m = { move: o.move, windowSeconds: o.windowSeconds, cuffRideUp: {} };
      p.moves.push(m);
    }
    if (!Number.isFinite(m.frontExposure?.valueCm)) m.frontExposure = o;
  }
  for (const product of products)
    for (const move of product.moves) {
      if (move.move === 'neutral') continue;
      const matching =
        physics &&
        product.jacket === 'parka' &&
        String(physics.garment?.style).includes('FB7675-100');
      const sim = matching ? physics.moves?.find((m) => m.id === move.move) : null;
      const valid = sim?.sleeveGate?.valid === true && !sim?.physics?.withheld;
      const peak = valid ? sim.physics.peak : {};
      for (const [metric, measured, key] of [
        ['hemRise', move.hemRise, 'hemRiseFrontCm'],
        ['leftCuffRideUp', move.cuffRideUp?.left, 'rideUpLeftCm'],
        ['rightCuffRideUp', move.cuffRideUp?.right, 'rideUpRightCm'],
        ['frontExposure', move.frontExposure, 'exposureFrontCm'],
      ]) {
        rows.push({
          jacket: product.jacket,
          move: move.move,
          metric,
          ...compareMetric(measured, peak?.[key]),
          physicsStatus: !sim
            ? 'missing move/product'
            : valid
              ? 'valid bake'
              : 'withheld by physics gate',
          physicsRefusal:
            sim?.refusedBeforeBaking ?? sim?.physics?.withheld ?? sim?.sleeveGate?.reason ?? null,
          realWindowSeconds: move.windowSeconds,
          physicsWindowSeconds: sim?.videoWindowS ?? null,
          basis:
            'real=projected image relative to same-view neutral; simulation=3D peak relative to fitted-body neutral',
        });
      }
    }
  return {
    schemaVersion: 1,
    at: new Date().toISOString(),
    sources: {
      real: Boolean(real),
      physics: Boolean(physics),
      ar: Boolean(ar),
      supplementalExposure: Boolean(supplemental),
    },
    verdict:
      'No calibrated real-world accuracy pass: image projection, peak/median, pose windows and waistband definitions differ.',
    rows,
    ar: ar
      ? {
          status: 'present, separate scope',
          note: 'AR alignment/coverage is owned and graded by V2/V5; no conversion into cloth ground truth here.',
        }
      : { status: 'not available' },
  };
}
export function main() {
  const sourceDigests = {};
  const read = (name) => {
    const p = join(ROOT, 'docs/validation', name);
    if (!existsSync(p)) return null;
    const bytes = readFileSync(p);
    sourceDigests[name] = createHash('sha256').update(bytes).digest('hex');
    return JSON.parse(bytes.toString('utf8'));
  };
  const result = comparisons(
    read('tryon-real-metrics.json'),
    read('tryon-physics-eval.json'),
    read('tryon-ar-eval.json'),
    read('tryon-real-exposure.json'),
  );
  result.sourceDigests = sourceDigests;
  writeFileSync(
    join(ROOT, 'docs/validation/tryon-compare-metrics.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log('jacket | move | metric | real cm | sim cm | delta cm | status');
  for (const r of result.rows)
    console.log(
      [
        r.jacket,
        r.move,
        r.metric,
        r.realCm ?? 'N/A',
        r.simCm ?? 'N/A',
        r.deltaCm ?? 'N/A',
        r.status,
      ].join(' | '),
    );
  return result;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
