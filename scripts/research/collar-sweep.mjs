// P34b: sequential synthetic-only Fit Lab request sweep. No browser, Decart or service restart.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '../..');
const OUT = resolve(ROOT, '.cache/cx-day/p34b/collar');
const BASE = 'http://127.0.0.1:8001';
export const BMIS = Object.freeze([18.5, 20, 22.5, 25, 27.5, 30]);
export const ZONES = Object.freeze(['collar', 'chest', 'hem', 'shoulder', 'bicep', 'sleeve']);
const round1 = (n) => Math.round(n * 10) / 10;

export function syntheticGrid() {
  const heights = Array.from({ length: 9 }, (_, i) => 155 + i * 5);
  // Fixed weight inside every height's BMI 18.5..30 interval, derived from the common interval.
  const fixed = round1((18.5 * (195 / 100) ** 2 + 30 * (155 / 100) ** 2) / 2);
  return ['female', 'male'].flatMap((sex) =>
    heights.flatMap((height_cm) => [
      ...BMIS.map((bmi) => ({
        series: 'bmi',
        sex,
        height_cm,
        weight_kg: round1(bmi * (height_cm / 100) ** 2),
        target_bmi: bmi,
      })),
      { series: 'fixed-weight', sex, height_cm, weight_kg: fixed, target_bmi: null },
    ]),
  );
}

export function collarLabel(ease, thresholds) {
  if (!Number.isFinite(ease)) return 'unknown';
  if (ease <= thresholds.tight) return 'tight';
  if (ease <= thresholds.snug) return 'snug';
  if (ease <= thresholds.regular) return 'regular';
  return 'roomy';
}

export function summarize(rows) {
  return ['female', 'male'].map((sex) => {
    const group = rows.filter((r) => r.input.sex === sex && r.input.series === 'bmi');
    const counts = Object.fromEntries(
      ['tight', 'snug', 'regular', 'roomy', 'unknown'].map((label) => [
        label,
        group.filter((r) => r.collarLabel === label).length,
      ]),
    );
    const known = group.filter((r) => r.collarLabel !== 'unknown');
    const combined = counts.tight + counts.snug;
    return {
      sex,
      total: group.length,
      known: known.length,
      counts,
      tightOrSnug: combined,
      shareAll: group.length ? combined / group.length : null,
      shareKnown: known.length ? combined / known.length : null,
    };
  });
}

export function rowsCsv(rows) {
  const header = [
    'series',
    'sex',
    'height_cm',
    'weight_kg',
    'target_bmi',
    'actual_bmi',
    'converged',
    'neck_section_cm',
    'neck_base_cm',
    'collar_S_ease_cm',
    'collar_S_label',
    'collar_S_status',
    'recommended_size',
  ];
  for (const size of ['S', 'M', 'L'])
    for (const zone of ZONES)
      header.push(`${size}_${zone}_cm`, `${size}_${zone}_status`, `${size}_${zone}_metric`);
  const cell = (v) => (v === null || v === undefined ? '' : `"${String(v).replaceAll('"', '""')}"`);
  return (
    [
      header,
      ...rows.map((r) => {
        const values = [
          r.input.series,
          r.input.sex,
          r.input.height_cm,
          r.input.weight_kg,
          r.input.target_bmi,
          r.input.actual_bmi,
          r.converged,
          r.neckCm,
          r.neckBaseCm,
          r.collarEaseCm,
          r.collarLabel,
          r.collarStatus,
          r.recommended,
        ];
        for (const size of ['S', 'M', 'L'])
          for (const zone of ZONES) {
            const z = r.sizes[size]?.zones[zone];
            values.push(z?.value_cm, z?.status, z?.metric);
          }
        return values;
      }),
    ]
      .map((row) => row.map(cell).join(','))
      .join('\n') + '\n'
  );
}

export function monotonicity(rows, epsilon = 1e-6) {
  // Numerical comparison tolerance only; negative edges are observations, not population truth.
  const comparisons = [];
  const compare = (items, axis, order) => {
    const sorted = [...items].sort((a, b) => order(a) - order(b));
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1],
        b = sorted[i];
      if (!Number.isFinite(a.neckCm) || !Number.isFinite(b.neckCm)) continue;
      comparisons.push({
        axis,
        from: a.input,
        to: b.input,
        fromNeck: a.neckCm,
        toNeck: b.neckCm,
        deltaCm: b.neckCm - a.neckCm,
      });
    }
  };
  for (const sex of ['female', 'male']) {
    const bmiRows = rows.filter((r) => r.input.sex === sex && r.input.series === 'bmi');
    for (const h of new Set(bmiRows.map((r) => r.input.height_cm)))
      compare(
        bmiRows.filter((r) => r.input.height_cm === h),
        'weight-at-height',
        (r) => r.input.weight_kg,
      );
    for (const bmi of BMIS)
      compare(
        bmiRows.filter((r) => r.input.target_bmi === bmi),
        'height-at-bmi',
        (r) => r.input.height_cm,
      );
    compare(
      rows.filter((r) => r.input.sex === sex && r.input.series === 'fixed-weight'),
      'height-at-fixed-weight',
      (r) => r.input.height_cm,
    );
  }
  return {
    epsilonCm: epsilon,
    comparisons: comparisons.length,
    decreases: comparisons.filter((c) => c.deltaCm < -epsilon),
  };
}

export function leadHold(text) {
  let held = false;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\d{4}-\d\d-\d\d\s+\d\d:\d\d\s+lead:\s*(.*)/i);
    if (!m) continue;
    if (/^(?:HOLD lifted|USER TEST(?:\s+#\d+)?\s+(?:END|DONE))\b/i.test(m[1])) held = false;
    else if (
      /^USER TEST\b/i.test(m[1]) &&
      /\b(NOW|FULL HOLD|BEGIN|starts? now)\b/i.test(
        m[1].split(/(?:Wait for|until|USER VERDICT)/i)[0],
      )
    )
      held = true;
  }
  return held;
}

function blocked() {
  if (leadHold(readFileSync(resolve(ROOT, 'docs/requests/codex-sync.md'), 'utf8'))) return true;
  if (existsSync(resolve(ROOT, '.cache/locks/heavy'))) return true;
  const dir = resolve(ROOT, '.cache/lead/service/control');
  if (existsSync(dir))
    for (const file of readdirSync(dir)) {
      // PIVOT stops obsolete render lanes, not authorized offline research/body API work.
      if (!/^timing.*\.json$/.test(file) || /PIVOT/i.test(file)) continue;
      try {
        if (JSON.parse(readFileSync(resolve(dir, file), 'utf8')).expiresAt > Date.now())
          return true;
      } catch {
        return true;
      }
    }
  return false;
}
let announced = false;
async function gate() {
  while (blocked()) {
    if (!announced) {
      console.log('P34b PAUSED: no new service requests during hold/timing/heavy lease');
      announced = true;
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  if (announced) {
    console.log('P34b RESUMED');
    announced = false;
  }
}
async function request(path, body) {
  await gate();
  const response = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok)
    throw new Error(`${path}: HTTP ${response.status}: ${(await response.text()).slice(0, 350)}`);
  return response.json();
}
const hash = (text) => createHash('sha256').update(text).digest('hex');
function thresholdsFromSource() {
  const source = readFileSync(resolve(ROOT, 'services/body/body_service/collar_config.py'), 'utf8');
  const read = (name) => {
    const m = source.match(new RegExp(`^${name} = ([0-9.]+)$`, 'm'));
    if (!m) throw new Error(`Missing ${name}`);
    return Number(m[1]);
  };
  return {
    values: {
      tight: read('TIGHT_EASE_MAX_CM'),
      snug: read('SNUG_EASE_MAX_CM'),
      regular: read('REGULAR_EASE_MAX_CM'),
    },
    hash: hash(source),
  };
}

export function extractRow(input, body, fit, product, thresholds) {
  const metric = fit.sizes.S?.zones.collar;
  const ease =
    metric?.metric === 'collar_inner_ease_cm' && Number.isFinite(metric.value_cm)
      ? metric.value_cm
      : null;
  const tape = product.sizes.S?.collar_inner?.value_cm;
  return {
    input: { ...input, actual_bmi: input.weight_kg / (input.height_cm / 100) ** 2 },
    bodyId: body.body_id,
    fitId: fit.fit_id,
    converged: body.converged,
    bodyWarnings: body.warnings,
    bodyResiduals: body.residuals,
    neckBaseCm: body.measurements.neck_base?.value_cm ?? null,
    neckCm: ease !== null && Number.isFinite(tape) ? tape - ease : null,
    collarEaseCm: ease,
    collarLabel: collarLabel(ease, thresholds),
    collarStatus: metric?.status ?? 'unknown',
    collarExplanation: metric?.explanation ?? '',
    recommended: fit.recommended_size,
    sizes: Object.fromEntries(
      ['S', 'M', 'L'].map((size) => [
        size,
        {
          score: fit.sizes[size]?.score,
          estimated: fit.sizes[size]?.estimated,
          zones: Object.fromEntries(
            ZONES.map((zone) => [zone, fit.sizes[size]?.zones[zone] ?? null]),
          ),
        },
      ]),
    ),
  };
}

async function run() {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--limit' && /^\d+$/.test(args[1])))
    throw new Error('Usage: node scripts/research/collar-sweep.mjs [--limit N]');
  const limit = args.length ? Number(args[1]) : Infinity;
  execFileSync('git', ['check-ignore', '-q', '.cache/cx-day/p34b/collar/rows.json'], { cwd: ROOT });
  mkdirSync(resolve(OUT, 'raw'), { recursive: true });
  const health = await request('/health');
  if (health.model_loaded !== true)
    throw new Error('Model unavailable; do not restart the existing service');
  const capabilities = await request('/body/capabilities'),
    options = await request('/garment/options'),
    products = await request('/products');
  const product = products.find((p) => p.style === 'DQ4920-206');
  if (!product || !Number.isFinite(options.layer_presets_cm['t-shirt']))
    throw new Error('Missing Fit Lab product/layer');
  const threshold = thresholdsFromSource();
  const meta = {
    startedAt: new Date().toISOString(),
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    health,
    capabilities,
    options,
    product,
    thresholds: threshold.values,
    collarSourceHash: threshold.hash,
    inputs: 'synthetic grid only; no scan or known measurements',
  };
  writeFileSync(resolve(OUT, 'meta.json'), JSON.stringify(meta, null, 2));
  const rows = [];
  for (const input of syntheticGrid().slice(0, limit)) {
    await gate();
    const key = `${input.sex}-${input.height_cm}-${String(input.weight_kg).replace('.', 'p')}`;
    const path = resolve(OUT, 'raw', `${key}.json`);
    let body, fit;
    if (existsSync(path)) ({ body, fit } = JSON.parse(readFileSync(path, 'utf8')));
    else {
      body = await request('/body/fit', {
        height_cm: input.height_cm,
        weight_kg: input.weight_kg,
        sex: input.sex,
        shape_reference: 'neutral',
        density_kg_m3: capabilities.default_density_kg_m3,
        known_measurements: {},
      });
      fit = await request('/fit/garment', {
        body_id: body.body_id,
        product_id: product.product_id,
        layer_cm: options.layer_presets_cm['t-shirt'],
        preference: 'regular',
      });
      writeFileSync(path, JSON.stringify({ input, body, fit }));
    }
    rows.push(extractRow(input, body, fit, product, threshold.values));
    writeFileSync(resolve(OUT, 'rows.json'), JSON.stringify(rows, null, 2));
    console.log(
      `P34b ${rows.length}/${Math.min(limit, 126)} ${input.sex} ${input.height_cm}/${input.weight_kg}: neck ${rows.at(-1).neckCm?.toFixed(3)} ease ${rows.at(-1).collarEaseCm?.toFixed(3)} ${rows.at(-1).collarLabel}; recommendation ${fit.recommended_size}`,
    );
  }
  if (thresholdsFromSource().hash !== threshold.hash)
    throw new Error('Collar source changed during sweep; do not merge measurements silently');
  const report = {
    completedAt: new Date().toISOString(),
    count: rows.length,
    summary: summarize(rows),
    monotonicity: monotonicity(rows),
  };
  writeFileSync(resolve(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      completed: rows.length,
      summary: report.summary,
      negativeEdges: report.monotonicity.decreases.length,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
