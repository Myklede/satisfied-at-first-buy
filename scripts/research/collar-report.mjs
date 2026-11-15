// Offline reporting only. The request runner owns the loopback sweep and pause gates.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { rowsCsv, summarize, monotonicity } from './collar-sweep.mjs';

const root = resolve(import.meta.dirname, '../..');
const cache = resolve(root, '.cache/cx-day/p34b/collar');
const rows = JSON.parse(readFileSync(resolve(cache, 'rows.json'), 'utf8'));
const meta = JSON.parse(readFileSync(resolve(cache, 'meta.json'), 'utf8'));
const report = JSON.parse(readFileSync(resolve(cache, 'report.json'), 'utf8'));
if (rows.length !== 126 || report.count !== rows.length) throw new Error('Incomplete sweep');
if (rows.some((r) => !r.converged || !Number.isFinite(r.neckCm)))
  throw new Error('Inspect unconverged/missing cases before publication');
const summary = summarize(rows);
const mono = monotonicity(rows);
const bmi = rows.filter((r) => r.input.series === 'bmi');
const warnings = rows.filter((r) => r.bodyWarnings?.length);
const csv = rowsCsv(rows);
const csvHash = createHash('sha256').update(csv).digest('hex');
const times = readdirSync(resolve(cache, 'raw'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => statSync(resolve(cache, 'raw', f)).mtimeMs);
const capture = [Math.min(...times), Math.max(...times)].map((t) => new Date(t).toISOString());
const fixed = rows.find((r) => r.input.series === 'fixed-weight').input.weight_kg;
const fmt = (n) => n.toFixed(3);
const count = (group) =>
  `${group.filter((r) => ['tight', 'snug'].includes(r.collarLabel)).length}/${group.length}`;
const first = (group) =>
  group.find((r) => ['tight', 'snug'].includes(r.collarLabel))?.input.weight_kg ?? 'none';
const lines = [
  '# P34b — synthetic puffer S collar sweep',
  '',
  `Captured ${capture[0]} to ${capture[1]} (UTC); finished ${report.completedAt}. No browser, camera, Decart or service restart.`,
  'GET /health succeeded first; then /body/capabilities, /garment/options, /products, sequential POST /body/fit → /fit/garment on 127.0.0.1:8001. Cached checkpoints resumed without refitting.',
  'Service caveat: POST /fit/garment also starts a background warm_cloth thread (app.py). Sequential client requests do not imply one backend job or pause already queued service work. Do not repeat the sweep during a demo/user test.',
  `Product DQ4920-206; regular preference, neutral shape, default service density, t-shirt layer ${meta.options.layer_presets_cm['t-shirt']} cm, no known measurements. All inputs synthetic.`,
  `Grid: 9 heights 155–195 by 5 cm × female/male × BMI targets 18.5,20,22.5,25,27.5,30; weight rounded to 0.1 kg = 108 cases. Plus 18 fixed-${fixed}-kg height controls = 126.`,
  `All ${rows.length}/${rows.length} body fits converged; ${warnings.length} carry the limited-input warning: inferred shape/density/surface landmarks need tape validation. Convergence does not establish anthropometric accuracy.`,
  '',
  '## Collar definition and shares',
  '',
  `Neck = measured S inner collar (${meta.product.sizes.S.collar_inner.value_cm} cm) − returned collar_inner_ease_cm. It is the engine's neck-only section, not the separate neck_base output.`,
  'Closed collar only: tight ≤0; snug (0,2]; regular (2,4]; roomy >4 cm, from services/body/body_service/collar_config.py. Comfort boundaries remain uncalibrated; no total error band is established.',
  'The section is capped below the jaw and can differ from the garment seam height. Missing M/L collar tapes stay unknown; upsizing is not proof of collar relief.',
  '',
  '| BMI grid only | tight | snug | regular | roomy | tight or snug |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...summary.map(
    (s) =>
      `| ${s.sex} | ${s.counts.tight} | ${s.counts.snug} | ${s.counts.regular} | ${s.counts.roomy} | ${s.tightOrSnug}/${s.total} (${(s.shareAll * 100).toFixed(1)}%) |`,
  ),
  `| Both | ${summary.reduce((n, s) => n + s.counts.tight, 0)} | ${summary.reduce((n, s) => n + s.counts.snug, 0)} | ${summary.reduce((n, s) => n + s.counts.regular, 0)} | ${summary.reduce((n, s) => n + s.counts.roomy, 0)} | ${count(bmi)} |`,
  '',
  `Controls are excluded above. With controls: ${count(rows)} tight/snug. These are grid shares, never population prevalence. No unknown S collar labels.`,
  '',
  '| Height cm | Male tight/snug /6 | First sampled male kg | Female tight/snug /6 | First sampled female kg |',
  '| ---: | ---: | ---: | ---: | ---: |',
  ...Array.from({ length: 9 }, (_, i) => 155 + i * 5).map((h) => {
    const m = bmi.filter((r) => r.input.height_cm === h && r.input.sex === 'male');
    const f = bmi.filter((r) => r.input.height_cm === h && r.input.sex === 'female');
    return `| ${h} | ${count(m)} | ${first(m)} | ${count(f)} | ${first(f)} |`;
  }),
  '',
  'First sampled weight is a coarse grid bracket, not an interpolated threshold or a universal kg cutoff.',
  '',
  '## HIGH — neck is not monotonic in height',
  '',
  `Adjacent comparisons: 90 weight-at-fixed-height, 96 height-at-fixed-BMI (weight also changes), 16 height-at-fixed-weight = ${mono.comparisons}; numerical tolerance ${mono.epsilonCm} cm.`,
  'Weight at fixed height has no decreasing edge in this grid. Height has the following decreasing edges, all flagged HIGH for demo/model-consistency review:',
  '',
  '| Axis | Sex | From height/weight | To height/weight | Neck cm from → to | Δ cm |',
  '| --- | --- | --- | --- | --- | ---: |',
  ...mono.decreases.map(
    (d) =>
      `| ${d.axis === 'height-at-bmi' ? 'BMI ' + d.from.target_bmi : 'fixed kg'} | ${d.from.sex} | ${d.from.height_cm}/${d.from.weight_kg} | ${d.to.height_cm}/${d.to.weight_kg} | ${fmt(d.fromNeck)} → ${fmt(d.toNeck)} | ${fmt(d.deltaCm)} |`,
  ),
  '',
  'Fixed-weight taller bodies are leaner, so decreasing neck is not by itself proof of a physiological bug. The male BMI-20 reversal also occurs while both height and weight increase; investigate the model/section, never clamp it to force a demo outcome.',
  '',
  '## Demo guidance and reproducibility',
  '',
  'For an honest synthetic rehearsal, male 170 cm/65 kg predicts tight at S; female 160 cm/51.2 kg predicts roomy. For a judge, use their real voluntary entry and show the returned label, including regular/roomy. Never promise red.',
  'Look first; scroll to see-through, choose S, then close the zipper before discussing collar ease. A negative ease is geometric interference in this estimate; snug is provisional comfort language. Compare against the real jacket without changing the prediction.',
  'S/M/L chest, hem, shoulder, bicep and sleeve/cuff residuals, units, statuses, collar results and engine recommendation for every case are in [collar-sweep.csv](collar-sweep.csv). sleeve is cuff position (sleeve_offset_cm), not wrist-opening girth.',
  'Re-run only when no USER TEST/timing/heavy hold: `node scripts/research/collar-sweep.mjs`; this resumes ignored raw checkpoints. Delete nothing: use a separate reviewed cache lane for a fresh backend version. Offline report: `node scripts/research/collar-report.mjs`.',
  'Pure checks: `node --test --test-concurrency=1 scripts/research/collar-sweep.test.mjs`. Raw API responses/body IDs remain ignored under .cache/cx-day/p34b/collar; no real body data is published.',
  `Metadata HEAD ${meta.head}; collar config SHA-256 ${meta.collarSourceHash}.`,
  `CSV SHA-256 ${csvHash}. Measurements are not FPS or timing claims.`,
];
if (lines.length > 80) throw new Error(`Report exceeds 80 lines: ${lines.length}`);
mkdirSync(resolve(root, 'docs/look'), { recursive: true });
writeFileSync(resolve(root, 'docs/look/collar-sweep.csv'), csv);
writeFileSync(resolve(root, 'docs/look/collar-sweep.md'), lines.join('\n') + '\n');
console.log(
  JSON.stringify(
    {
      cases: rows.length,
      converged: rows.filter((r) => r.converged).length,
      warnings: warnings.length,
      negativeEdges: mono.decreases.length,
      docLines: lines.length,
      csvColumns: 67,
      csvHash,
      summary,
    },
    null,
    2,
  ),
);
