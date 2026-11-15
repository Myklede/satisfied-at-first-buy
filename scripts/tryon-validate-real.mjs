// T1: offline reference images, CPU MediaPipe via public @satisfy/vision API.
// No camera, API requests, personal-profile changes or non-loopback traffic.
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireTimingSlot } from './codex-heavy-slot.mjs';
import { summary, relativeMetric } from './tryon-validate-math.mjs';

export const ROOT = resolve(import.meta.dirname, '..');
export const PRIVATE = join(ROOT, '.cache/cxday-tryon');
export const SOURCES = {
  parka: '.cache/lookdev-frames/FB7675-100-parka-trang/video-parka-baf987fbde/run-IWRlOJ',
  puffer: '.cache/lookdev-frames/DQ4920-206-puffer-kem/video-puffer-884032ba15/run-0l5c8m',
};
// Indexed held windows, docs/look/video-index.md. Also sample both +/-1s endpoints.
export const WINDOWS = {
  parka: {
    neutral: [30, 32],
    reach_up_both: [47, 50],
    reach_up_one: [53, 55],
    reach_forward: [107, 110],
    cross_arms: [66, 68],
    sit: [71, 76],
    bend: [125, 131],
    // DAY-G reviewed full originals91/92: upright side-neutral, near cuff visible.
    // n=2 only; endpoints90/93 transition, far cuff occluded; projected comparison only.
    neutral_side: [91, 92],
    paper: [19, 21],
  },
  puffer: {
    neutral: [38, 42],
    reach_up_both: [46, 50],
    reach_up_one: [52, 56],
    reach_forward: [109, 113],
    cross_arms: [66, 71],
    sit: [74, 78],
    bend: [129, 133],
    neutral_side: [100, 101],
  },
};
export function privateGuard() {
  for (const file of ['.cache/cxday-tryon/probe.png', 'docs/validation/look-cxday-probe.png']) {
    const result = execFileSync('git', ['check-ignore', '--', file], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    if (result !== file) throw new Error(`Privacy guard refused ${file}`);
  }
}
export function jobs() {
  const result = [];
  for (const [jacket, windows] of Object.entries(WINDOWS)) {
    const ts = new Set();
    for (const [a, b] of Object.values(windows)) for (let t = a - 1; t <= b + 1; t++) ts.add(t);
    for (const t of [...ts].sort((a, b) => a - b)) result.push({ jacket, t });
  }
  return result;
}

export async function capture() {
  privateGuard();
  mkdirSync(PRIVATE, { recursive: true });
  const tasks = jobs();
  for (const job of tasks) {
    const index = JSON.parse(readFileSync(join(ROOT, SOURCES[job.jacket], 'index.json'), 'utf8'));
    const frame = index.frames.find((f) => f.requested_seconds === job.t);
    if (!frame || Math.abs(frame.current_time_seconds - job.t) > 0.05)
      throw new Error('Unverified extracted timestamp');
  }
  const release = await acquireTimingSlot('CX-DAY/DAY-G', 'real jacket metrics');
  let server, browser, timer;
  const network = [];
  try {
    timer = setTimeout(() => void browser?.close(), 14 * 60e3);
    const bundle = await build({
      entryPoints: [join(ROOT, 'scripts/tryon-validate-page.mjs')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      tsconfigRaw: { compilerOptions: { target: 'ES2022' } },
    });
    const assets = new Map([
      ['/measure.js', { data: bundle.outputFiles[0].contents, type: 'text/javascript' }],
    ]);
    const assetPaths = [
      'models/pose_landmarker_heavy.task',
      ...['vision_wasm_internal', 'vision_wasm_nosimd_internal'].flatMap((n) => [
        `mediapipe/wasm/${n}.js`,
        `mediapipe/wasm/${n}.wasm`,
      ]),
    ];
    for (const name of assetPaths)
      assets.set('/' + name, {
        path: join(ROOT, 'apps/web/public', name),
        type: name.endsWith('.wasm')
          ? 'application/wasm'
          : name.endsWith('.js')
            ? 'text/javascript'
            : 'application/octet-stream',
      });
    server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<script type="module" src="/measure.js"></script>');
        return;
      }
      const asset = assets.get(req.url);
      if (asset) {
        res.setHeader('Content-Type', asset.type);
        if (asset.data) res.end(asset.data);
        else
          createReadStream(asset.path)
            .on('error', () => {
              res.statusCode = 404;
              res.end();
            })
            .pipe(res);
        return;
      }
      const m = /^\/frame\/(parka|puffer)\/(\d+)$/.exec(req.url ?? '');
      if (m && tasks.some((j) => j.jacket === m[1] && j.t === Number(m[2]))) {
        res.setHeader('Content-Type', 'image/png');
        createReadStream(join(ROOT, SOURCES[m[1]], `frame-${m[2].padStart(4, '0')}.png`)).pipe(res);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise((yes, no) => {
      server.once('error', no);
      server.listen(5790, '127.0.0.1', yes);
    });
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: [
        '--disable-background-networking',
        '--disable-component-update',
        '--no-proxy-server',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      ],
    });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (u.hostname === '127.0.0.1' || ['data:', 'blob:'].includes(u.protocol))
        return route.continue();
      network.push(u.origin + u.pathname);
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`pageerror ${e.message}`));
    await page.exposeFunction('savePrivateOverlay', ({ jacket, t, png }) => {
      if (!tasks.some((j) => j.jacket === jacket && j.t === t))
        throw new Error('Unexpected private frame');
      writeFileSync(join(PRIVATE, `${jacket}-${t}.png`), Buffer.from(png, 'base64'));
    });
    const rows = [];
    await page.exposeFunction('savePrivateRow', (row) => {
      rows.push(row);
      writeFileSync(join(PRIVATE, 'rows.json'), JSON.stringify(rows));
      console.log(`T1 ${row.jacket} ${row.t}s ${row.reason ?? 'measured'}`);
    });
    await page.goto('http://127.0.0.1:5790/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => typeof window.measureReference === 'function');
    const result = await page.evaluate((tasks) => window.measureReference(tasks), tasks);
    writeFileSync(
      join(PRIVATE, 'capture.json'),
      JSON.stringify({ ...result, at: new Date().toISOString(), network }, null, 2),
    );
  } finally {
    clearTimeout(timer);
    try {
      await browser?.close();
    } finally {
      try {
        if (server) await new Promise((done) => server.close(done));
      } finally {
        release();
      }
    }
  }
}

// Public report generation requires explicit per-frame human acceptance in the private review.
export function report() {
  privateGuard();
  const capture = JSON.parse(readFileSync(join(PRIVATE, 'capture.json'), 'utf8'));
  const review = JSON.parse(readFileSync(join(PRIVATE, 'review.json'), 'utf8'));
  if (!review.scale || !review.accepted)
    throw new Error('Manual mask/edge review and scale required');
  const rows = capture.rows;
  const out = {
    schemaVersion: 1,
    at: new Date().toISOString(),
    method: {
      pose: 'public createPoseTracker heavy CPU, MediaPipe person mask',
      frames: 'previous verified 1 Hz Chrome video extraction; docs/look/video-index.md',
      geometry:
        'hem vertical image distance from pose-estimated hip midpoint; cuff proximal distance along pose-estimated projected forearm, same-view neutral subtraction',
      uncertainty:
        'additive spread + +/-1s endpoint sensitivity + scale disagreement + pixel sensitivity; not statistical confidence or 3D truth',
      settings: capture.settings,
      scale: review.scale,
      limitations: review.limitations,
    },
    networkBlocked: capture.network,
    delegate: capture.stats.delegate,
    products: [],
  };
  for (const jacket of Object.keys(WINDOWS)) {
    const scale = review.scale[jacket],
      moves = [];
    const allowed = (row, metric) => review.accepted[jacket]?.[metric]?.includes(row.t);
    const vals = (window, metric, expanded = false) =>
      rows
        .filter(
          (r) =>
            r.jacket === jacket &&
            r.t >= window[0] - (expanded ? 1 : 0) &&
            r.t <= window[1] + (expanded ? 1 : 0) &&
            allowed(r, metric),
        )
        .map((r) =>
          metric === 'hem' ? r.hem?.offsetPx : r.cuffs?.find((c) => c.side === metric)?.offsetPx,
        )
        .filter(Number.isFinite);
    const temporal = (window, metric) => {
      const before = vals([window[0] - 1, window[0] - 1], metric);
      const after = vals([window[1] + 1, window[1] + 1], metric);
      return before.length && after.length ? vals(window, metric, true) : [];
    };
    for (const [move, window] of Object.entries(WINDOWS[jacket])) {
      if (['paper', 'neutral_side'].includes(move)) continue;
      const baseline =
        WINDOWS[jacket][move === 'reach_forward' || move === 'bend' ? 'neutral_side' : 'neutral'];
      const metric = {
        move,
        windowSeconds: window,
        neutralWindowSeconds: baseline,
        hemRise: relativeMetric(
          vals(baseline, 'hem'),
          vals(window, 'hem'),
          scale.pxPerCm,
          scale.fraction,
          -1,
          temporal(window, 'hem'),
          temporal(baseline, 'hem'),
        ),
        cuffRideUp: {},
      };
      for (const side of ['left', 'right'])
        metric.cuffRideUp[side] = relativeMetric(
          vals(baseline, side),
          vals(window, side),
          scale.pxPerCm,
          scale.fraction,
          1,
          temporal(window, side),
          temporal(baseline, side),
        );
      metric.frames = rows
        .filter((r) => r.jacket === jacket && r.t >= window[0] - 1 && r.t <= window[1] + 1)
        .map((r) => ({
          seconds: r.t,
          hemAccepted: allowed(r, 'hem'),
          leftCuffAccepted: allowed(r, 'left'),
          rightCuffAccepted: allowed(r, 'right'),
        }));
      metric.frontExposure = review.exposure?.[jacket]?.[move] ?? {
        valueCm: null,
        reason: 'waistband or front edge not independently visible/annotated; no fabricated zero',
      };
      moves.push(metric);
    }
    out.products.push({
      jacket,
      moves,
      acceptedCounts: Object.fromEntries(
        ['hem', 'left', 'right'].map((k) => [
          k,
          summary(rows.filter((r) => r.jacket === jacket && allowed(r, k)).map((r) => r.t)).n,
        ]),
      ),
    });
  }
  writeFileSync(
    join(ROOT, 'docs/validation/tryon-real-metrics.json'),
    JSON.stringify(out, null, 2) + '\n',
  );
  return out;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.includes('--report')) report();
  else await capture();
}
