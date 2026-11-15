// CX-DAY independent AR scorer. Local files only; no engine changes or dependency installs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import {
  TARGETS,
  fromDiagFrame,
  regressions,
  scoreboard,
  summarise,
  upsertScoreTable,
} from './ar-eval-lib.mjs';
import { captureSteps, perStep } from './ar-eval-steps.mjs';
import { pageSampler } from './ar-eval-sampler.mjs';
import { installRestProbe, restWindowsFor } from './ar-eval-rest.mjs';
import { acquireTimingSlot } from './codex-heavy-slot.mjs';
import { frozenRuler } from './ar-eval-frozen.mjs';
import { restSummary } from './ar-eval-rest.mjs';
import { buildHash } from './demo-day-warm.mjs';
import { motionOnsets, boundedOnsetScore } from './ar-eval-motion.mjs';
import { testsetClips, qualifyStill, anywearNumbers } from './ar-eval-testset.mjs';
import { recordVisual, proofSamples } from './ar-eval-visual.mjs';
import { stockKioskProfile } from './ar-eval-kiosk.mjs';
import { installLayerProbe, layerSummary } from './ar-eval-layers.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} requires a value`);
  return args[i + 1];
};
const flag = (n) => args.includes(n);
// F5 judge A/B pass-through: --flags "k=v&k2=v2" is appended to the AR lab URL (and the kiosk
// profile URL). Absent => byte-identical old behaviour. Case identity (product, body, source,
// still) is fixed by the case, never by a flag, so a flag can never select another style.
export const PROTECTED_FLAGS = new Set([
  'arlab',
  'jacket',
  'size',
  'h',
  'w',
  'sex',
  'source',
  't',
  'nomirror',
  'mirror',
  'still',
]);
export function passThroughFlags(value) {
  const out = new URLSearchParams(value ?? '');
  for (const [k, v] of out)
    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k) ||
      !/^[A-Za-z0-9_.,:-]{0,32}$/.test(v) ||
      PROTECTED_FLAGS.has(k)
    )
      throw new Error(`Unsupported A/B flag: ${k}`);
  return out;
}
const abFlags = passThroughFlags(arg('--flags', ''));
// Judge outputs: private proof directory and a private per-case result row (both under .cache).
const cacheOnly = (p) => {
  if (!p) return null;
  const abs = resolve(p);
  if (!abs.startsWith(join(ROOT, '.cache') + sep))
    throw new Error('Judge output paths must be under .cache');
  return abs;
};
const proofRoot = cacheOnly(arg('--proof-root'));
const resultJson = cacheOnly(arg('--result-json'));
// F5 window A/B: stop both playbacks at this video time (s); the full clip stays the default.
const untilSeconds = arg('--until') == null ? null : Number(arg('--until'));
if (untilSeconds !== null && !(untilSeconds >= 3 && untilSeconds <= 600))
  throw new Error('--until must be 3..600 seconds');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
const revision = () =>
  git('rev-parse', '--short', 'HEAD') + (git('status', '--porcelain') ? '+wip' : '');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const VALIDATION = join(ROOT, 'docs/validation');
const STATUS = join(ROOT, 'docs/STATUS-ar-eval.md');
const PRIVATE = join(ROOT, '.cache/ar-eval');
const queuedRevision = revision();
let batchRevision = queuedRevision;
let snapshotCache = null;
const sourceHashes = () => ({
  web: buildHash(join(ROOT, 'apps/web/src')),
  vision: buildHash(join(ROOT, 'packages/vision/src')),
});
const known = {
  'cam-tshirt': 'data/reference-photos/FB7675-100-parka-trang/video/cam-tshirt.mp4',
  'cam-parka': 'data/reference-photos/FB7675-100-parka-trang/video/cam-parka.mp4',
};

function previous(kind, source) {
  return (
    readdirSync(VALIDATION)
      .filter((f) => /^ar-eval-.*\.json$/.test(f))
      .sort()
      .reverse()
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(join(VALIDATION, f), 'utf8'))];
        } catch {
          return [];
        }
      })
      .find((j) => j.kind === kind && j.source === source && j.complete !== false) ?? null
  );
}

function record({ source, kind, summary, extra = {}, complete = true }) {
  const score = scoreboard(summary);
  if (extra.motionOnsets) {
    extra.legacyRestCrossing = score.restMotionOnsetLagFrames;
    score.restMotionOnsetLagFrames = {
      ...score.restMotionOnsetLagFrames,
      ...boundedOnsetScore(extra.motionOnsets),
    };
  }
  const now = new Date().toISOString();
  const last = previous(kind, source);
  const out = {
    generatedUtc: now,
    commit: batchRevision,
    headAtEnd: git('rev-parse', '--short', 'HEAD'),
    kind,
    source,
    complete,
    scoreboard: score,
    summary,
    ...extra,
    regressionsVsPrevious: last
      ? regressions(last.scoreboard, score).map((r) => ({ ...r, previousCommit: last.commit }))
      : [],
  };
  if (flag('--no-write')) return out;
  mkdirSync(VALIDATION, { recursive: true });
  // Stable source+commit key: checkpoints overwrite the same numeric JSON; one table row per source/commit.
  const key = sha(`${batchRevision}:${source}:${extra.sourceSha256 ?? ''}`).slice(0, 16);
  writeFileSync(join(VALIDATION, `ar-eval-cxday-${key}.json`), JSON.stringify(out, null, 2) + '\n');
  if (complete || extra.error) {
    let text = existsSync(STATUS) ? readFileSync(STATUS, 'utf8') : '# AR evaluation scoreboard\n';
    text = upsertScoreTable(text, { commit: out.commit, date: now.slice(0, 16), source, score });
    writeFileSync(STATUS, text);
    if (extra.steps?.length) {
      const start = `<!-- steps:${key}:start -->`;
      const end = `<!-- steps:${key}:end -->`;
      let text = readFileSync(STATUS, 'utf8');
      const a = text.indexOf(start),
        b = text.indexOf(end);
      if (a >= 0 && b >= a) text = text.slice(0, a) + text.slice(b + end.length);
      const cell = (r) => (r?.value == null ? 'n/a' : `${r.value} ${r.pass ? 'ok' : 'FAIL'}`);
      const stepRows = extra.steps.map((s) => {
        const name = s.name.replace(/[|\r\n]/g, ' ');
        const align =
          s.alignment.pass == null
            ? `${s.alignment.p50 ?? 'n/a'} n/a`
            : `${s.alignment.p50} ${s.alignment.pass ? 'ok' : 'FAIL'}`;
        return `| ${name} | ${s.startMs}-${s.endMs} | ${s.observedFrames} | ${align} | ${cell(s.scoreboard.keypointResidualPx)} | ${cell(s.scoreboard.frontalUncoveredPct)} | ${cell(s.scoreboard.backHandledPct)} | ${cell(s.scoreboard.finisherMainThreadMs)} | ${cell(s.scoreboard.arFps)} |`;
      });
      text +=
        `\n${start}\n\n### ${source} / ${batchRevision} steps\n\n` +
        '| step | video ms | frames | solve alignment p50 px (<5) | drawn residual px (<5) | frontal uncovered % (<2) | back handled % (>=95) | finisher ms (<=4) | AR fps (>=24) |\n' +
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n' +
        stepRows.join('\n') +
        `\n\n${end}\n`;
      writeFileSync(STATUS, text);
    }
  }
  return out;
}
function print(score) {
  for (const [k, r] of Object.entries(score))
    console.log(
      `${TARGETS[k].label}: ${r.value ?? 'n/a'} (${r.target}) ${r.pass == null ? 'n/a' : r.pass ? 'ok' : 'FAIL'}`,
    );
}
function privacyGuard() {
  git('check-ignore', '-q', '.cache/ar-eval/probe.json');
  git('check-ignore', '-q', 'docs/validation/look-cxday-probe.png');
  mkdirSync(PRIVATE, { recursive: true });
}
function sources() {
  const rows = Object.values(known).map((video) => ({
    video: resolve(ROOT, video),
    manifest: null,
  }));
  const dir = join(ROOT, 'data/reference-photos/live-diag');
  if (existsSync(dir))
    for (const name of readdirSync(dir).sort()) {
      if (!/^capture-.*\.webm$/i.test(name)) continue;
      const manifest = join(dir, name.replace(/\.webm$/i, '.json'));
      if (existsSync(manifest)) rows.push({ video: join(dir, name), manifest });
      else console.log(`Skipped ${name}: paired manifest absent`);
    }
  return rows;
}

async function runVideo({
  video: file,
  manifest: manifestFile,
  testsetClip = null,
  productStyleOverride = null,
  stillOverride = null,
}) {
  const productStyle = productStyleOverride ?? arg('--product', 'FB7675-100'),
    still = stillOverride ?? arg('--still', '0');
  if (!['FB7675-100', 'DQ4920-206'].includes(productStyle) || !['0', '1'].includes(still))
    throw new Error('Exact style and still0/1 required');
  const source = `video:${basename(file).replace(/[|\r\n]/g, '_')} [${productStyle}, still${still}]`;
  if (!statSync(file).isFile()) throw new Error('Expected a local video file');
  const sourceSha256 = sha(readFileSync(file));
  const manifest = manifestFile ? JSON.parse(readFileSync(manifestFile, 'utf8')) : null;
  const steps = testsetClip?.segments ?? (manifest ? captureSteps(manifest) : []);
  let restWindows = testsetClip
    ? steps.filter((s) => s.name === 'still')
    : restWindowsFor(basename(file), steps);
  const extra = {
    sourceSha256,
    ...(testsetClip
      ? {
          testset: {
            id: testsetClip.id,
            file: testsetClip.file,
            upperBodyOnly: testsetClip.upperBodyOnly,
          },
          bodyMode: 'App default fallback; tracking/coverage/look only, never fit accuracy',
        }
      : {}),
    manifestSha256: manifest ? sha(readFileSync(manifestFile)) : null,
    steps: [],
    restWindows,
    attempt: 0,
    reloadRetries: 0,
    settings: {
      finisher: true,
      productStyle,
      still,
      nominalStillValidity: 'not truly still (TRY-M raw-video proof); diagnostic motion only',
      every: Number(arg('--every', '1')),
      untilSeconds,
      kioskProfile: !flag('--no-kiosk'),
      mirror: Boolean(testsetClip) || flag('--ruler') || flag('--review'),
      coverageMetric: 'V4 independent clothing reference (10225ec)',
      playbackProtocol:
        'wait for lab tracking/drawn readiness, then rewind and sample full clip from zero',
    },
    limitations: [
      'Shared machine load; not an isolated benchmark.',
      'Rest outline uses64 matched centroid-polar outer alpha contour points, source px per camera presented-frame gap; per-observation displacement is reported too. Unsampled within-gap excursions are unobservable.',
      'Rest layer readbacks add instrumentation overhead; flicker is unregistered RGB mean absolute difference in common eroded jacket interior, 8-bit units.',
      'Motion onset is a provisional landmark/output crossing lag in camera presented-frame gaps; observations also reported. It is not sensor/display latency; noise thresholds can hide small initial movements.',
      'V5 uncoveredPct is the pre-finisher torso person-mask proxy; V4 frontalUncoveredPct uses clothing classes after finishing.',
      'Back handling requires an isolated operator-labelled back hold. Detector backView alone is not ground truth.',
      'Finisher applyMs is smoothed main-thread submission time, not GPU completion.',
      'Camera-to-screen uses engine processing totalMs; sensor/display latency is unmeasured.',
      'No AR quality PASS is inferred from missing metrics or insufficient samples.',
    ],
  };
  if (
    !Number.isInteger(extra.settings.every) ||
    extra.settings.every < 1 ||
    extra.settings.every > 120
  )
    throw new Error('--every must be 1..120');
  const old = previous('video', source);
  if (
    flag('--all') &&
    old?.commit === revision() &&
    old?.sourceSha256 === sourceSha256 &&
    old?.manifestSha256 === extra.manifestSha256 &&
    old.complete &&
    !flag('--force')
  ) {
    console.log(`${source}: already scored at ${batchRevision}; --force reruns`);
    return old;
  }
  privacyGuard();
  // Private source body values are used locally and never included in evidence URLs/JSON.
  const body = testsetClip
    ? null
    : readFileSync(join(ROOT, 'data/reference-photos/toi.txt'), 'utf8');
  // KioskApp REFERENCE default fallback, not an estimate of any stock subject.
  const h = testsetClip ? 172 : Number(/height_cm:\s*([\d.]+)/.exec(body)?.[1]);
  const w = testsetClip ? 65 : Number(/weight_kg:\s*([\d.]+)/.exec(body)?.[1]);
  const sex = testsetClip ? 'male' : (/sex:\s*(male|female)/.exec(body)?.[1] ?? 'male');
  if (!(h >= 120 && h <= 220 && w >= 30 && w <= 200)) throw new Error('Body reference unavailable');
  // F5 judge: the parent (scripts/ar-judge.mjs) already holds browser+heavy and passes its
  // token; verify both owner files carry it, never release them here (the parent does).
  const parentLease = arg('--parent-lease');
  if (parentLease) {
    for (const lock of ['browser', 'heavy'])
      if (
        !readFileSync(join(ROOT, '.cache/locks', lock, 'owner.txt'), 'utf8').includes(parentLease)
      )
        throw new Error(`--parent-lease does not own the ${lock} lock`);
  }
  const release = parentLease
    ? () => {}
    : await acquireTimingSlot('CX-DAY', flag('--ruler') ? 'ruler check' : 'AR scoreboard');
  batchRevision = revision();
  extra.queuedRevision = queuedRevision;
  extra.sourceStartHashes = sourceHashes();
  let server,
    context,
    timer,
    latestFrames = [],
    wallSeconds = null;
  const diagnostics = { console: [], requestFailures: [] };
  const deadline = Date.now() + 14 * 60e3;
  // Covers Vite/import/Chrome startup too, not just video playback. If setup hangs before
  // Chrome exists, close our server and terminate only this owned runner after releasing.
  timer = setTimeout(async () => {
    if (context) return void context.close().catch(() => undefined);
    try {
      await server?.close();
    } finally {
      release();
      process.exit(1);
    }
  }, 14 * 60e3);
  const update = (frames, wall, complete = false) => {
    latestFrames = frames;
    wallSeconds = wall;
    extra.steps = perStep(frames, steps);
    writeFileSync(
      join(PRIVATE, 'checkpoint.json'),
      JSON.stringify({ source, frames, steps, wallSeconds: wall }),
    );
    // Judge runs keep their own copy so per-frame metrics can be recomputed without a race.
    if (proofRoot) {
      mkdirSync(proofRoot, { recursive: true });
      writeFileSync(
        join(proofRoot, 'checkpoint.json'),
        JSON.stringify({ source, frames, steps, wallSeconds: wall }),
      );
    }
    return record({
      source,
      kind: 'video',
      summary: summarise(frames, { wallSeconds: wall, restWindows }),
      extra,
      complete,
    });
  };
  try {
    const build = arg('--build');
    let origin;
    if (build) {
      const u = new URL(build);
      if (
        u.protocol !== 'http:' ||
        u.hostname !== '127.0.0.1' ||
        !['5770', '5771', '5772', '5773', '5774'].includes(u.port) ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        u.pathname !== '/'
      )
        throw new Error('--build must be a CX-DAY loopback origin on 5770..5774');
      origin = u.origin;
    } else if (flag('--snapshot') || testsetClip) {
      const { build: buildWeb } = await import('vite');
      const current = JSON.stringify(extra.sourceStartHashes);
      if (!snapshotCache || snapshotCache.source !== current) {
        const dist = join(PRIVATE, `snapshot-${Date.now()}`);
        if (existsSync(dist)) throw new Error('Snapshot collision');
        await buildWeb({
          root: join(ROOT, 'apps/web'),
          configFile: join(ROOT, 'apps/web/vite.config.ts'),
          logLevel: 'error',
          build: { outDir: dist, emptyOutDir: false },
        });
        snapshotCache = { dist, hash: buildHash(dist), source: current, head: batchRevision };
      }
      const dist = snapshotCache.dist;
      extra.snapshotHash = snapshotCache.hash;
      extra.snapshotHead = snapshotCache.head;
      extra.snapshotSourceEndHashes = sourceHashes();
      extra.snapshotSourceStable = current === JSON.stringify(extra.snapshotSourceEndHashes);
      const { startKioskServer } = await import('./kiosk-server.mjs');
      const staticServer = await startKioskServer({
        dist,
        port: 5771,
        apiPort: 8001,
        status: () => ({ service: 'up' }),
        quit: () => {},
      });
      server = { close: () => new Promise((done) => staticServer.close(done)) };
      origin = 'http://127.0.0.1:5771';
    } else {
      const { createServer } = await import('vite');
      server = await createServer({
        root: join(ROOT, 'apps/web'),
        configFile: join(ROOT, 'apps/web/src/engine/live/ar/finish/eval/vite.v4.config.ts'),
        cacheDir: join(PRIVATE, 'vite'),
        logLevel: 'error',
        server: {
          host: '127.0.0.1',
          port: 5771,
          strictPort: true,
          hmr: false,
          watch: { ignored: ['**/*'] },
        },
      });
      await server.listen();
      origin = 'http://127.0.0.1:5771';
    }
    const { chromium } = await import('playwright');
    context = await chromium.launchPersistentContext(join(PRIVATE, 'chrome'), {
      channel: 'chrome',
      headless: !flag('--headed'),
      serviceWorkers: 'block',
      viewport: { width: 1500, height: 900 },
      args: [
        '--disable-background-networking',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    let blocked = 0;
    await context.route('**/*', (route) => {
      const u = new URL(route.request().url());
      if (
        ['127.0.0.1', 'localhost'].includes(u.hostname) ||
        ['data:', 'blob:'].includes(u.protocol)
      )
        return route.continue();
      blocked++;
      return route.abort();
    });
    const page = context.pages()[0] ?? (await context.newPage());
    page.on('pageerror', (e) => diagnostics.console.push(e.message));
    page.on('response', (r) => {
      if (r.status() >= 400)
        diagnostics.requestFailures.push({ status: r.status(), path: new URL(r.url()).pathname });
    });
    await page.addInitScript(installRestProbe);
    await page.addInitScript(installLayerProbe);
    const frozenDir = join(
      ROOT,
      '.cache/cx-day/frozen',
      `${basename(file).replace(/[^a-zA-Z0-9.-]/g, '_')}-${productStyle}`,
    );
    git('check-ignore', '-q', join(frozenDir, 'probe.png'));
    mkdirSync(frozenDir, { recursive: true });
    await page.exposeFunction('__arFrozenClip', (bytes) =>
      writeFileSync(join(frozenDir, 'repeated-frame.webm'), Buffer.from(bytes)),
    );
    await page.exposeFunction('__arFrozenProof', async (meta) => {
      if (
        ![false, true].includes(meta.finish) ||
        ![false, true].includes(meta.still) ||
        !Number.isInteger(meta.index) ||
        meta.index < 0 ||
        meta.index >= 12
      )
        throw new Error('Invalid proof metadata');
      const prefix = `s${Number(meta.still)}-f${Number(meta.finish)}-${String(meta.index).padStart(2, '0')}`;
      const boxes = await page.evaluate(() => {
        const L = window.__arlab,
          mirror = L.engine.mirrorView;
        const list = [
          L.ar.renderer.domElement,
          mirror?.renderer?.domElement ?? mirror?.viewer?.renderer?.domElement,
        ];
        return list.map((e) => {
          if (!e) return null;
          const r = e.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        });
      });
      const paths = { ...meta };
      for (const [i, name] of ['ar', 'mirror'].entries())
        if (boxes[i]?.width > 0 && boxes[i]?.height > 0) {
          const path = join(frozenDir, `${prefix}-${name}.png`);
          git('check-ignore', '-q', path);
          await page.screenshot({ path, clip: boxes[i] });
          paths[name] = path.slice(ROOT.length + 1).replaceAll('\\', '/');
        }
      const raw = await page.evaluate(() => {
        const v = window.__arlab.engine.currentSource.video;
        const c = document.createElement('canvas');
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0);
        return c.toDataURL('image/png');
      });
      const path = join(frozenDir, `${prefix}-raw.png`);
      git('check-ignore', '-q', path);
      writeFileSync(path, Buffer.from(raw.split(',')[1], 'base64'));
      paths.rawSha256 = sha(Buffer.from(raw.split(',')[1], 'base64'));
      paths.raw = path.slice(ROOT.length + 1).replaceAll('\\', '/');
      return paths;
    });
    const proofDir =
      proofRoot ??
      join(
        ROOT,
        '.cache/cx-day',
        testsetClip ? 'testset' : 'look',
        testsetClip?.id ?? basename(file),
        `${productStyle}-s${still}`,
      );
    git('check-ignore', '-q', join(proofDir, 'probe.png'));
    mkdirSync(proofDir, { recursive: true });
    await page.exposeFunction('__arStockProof', (meta) => {
      if (
        !/^(segment-\d+|still-\d+)$/.test(meta.key) ||
        !['raw', 'ar', 'mirror'].includes(meta.channel)
      )
        throw new Error('Invalid proof key');
      const path = join(proofDir, `${meta.key}-${meta.channel}.png`);
      git('check-ignore', '-q', path);
      writeFileSync(path, Buffer.from(meta.image.split(',')[1], 'base64'));
      return path.slice(ROOT.length + 1).replaceAll('\\', '/');
    });
    await page.exposeFunction('__arStockVideo', (name, bytes) => {
      if (!['raw', 'ar', 'mirror'].includes(name)) throw new Error('Invalid stream');
      const path = join(proofDir, `${name}.webm`);
      git('check-ignore', '-q', path);
      writeFileSync(path, Buffer.from(bytes));
    });
    await page.exposeFunction('__arScoreCheckpoint', (frames, wall) => update(frames, wall));
    const params = new URLSearchParams({
      arlab: '',
      jacket: productStyle,
      still,
      size: arg('--size', 'S'),
      h: String(h),
      w: String(w),
      sex,
      source: 'file',
      t: '0',
      nomirror: '',
      mirror: '0',
      finish: '1',
    });
    if (testsetClip || flag('--ruler') || flag('--review')) params.delete('nomirror');
    for (const [k, v] of abFlags) params.set(k, v);
    extra.settings.abFlags = abFlags.toString();
    for (let attempt = 1; attempt <= 2; attempt++) {
      extra.attempt = attempt;
      try {
        console.log(`${source}: setup attempt ${attempt}, ${batchRevision}`);
        await page.goto(`${origin}/?${params}`, { timeout: 90000 });
        // F5 (lead 22:05): record the URL the page actually runs with; the judge refuses a run
        // whose page search lacks any requested flag.
        extra.settings.pageSearch = new URL(page.url()).search;
        await page.waitForFunction(() => window.__arlab, null, { timeout: 90000 });
        // Product discovery is asynchronous; Start is enabled before productId is populated.
        // Wait for a real selected catalogue ID, rather than a fixed delay under shared load.
        await page.waitForFunction(
          () =>
            [...document.querySelectorAll('.arlab select')].some((s) =>
              /^[a-f0-9]{64}$/.test(s.value),
            ),
          null,
          { timeout: 60000 },
        );
        extra.selectedProduct = await page.evaluate(async (expected) => {
          const selected = [...document.querySelectorAll('.arlab select')].find((s) =>
            /^[a-f0-9]{64}$/.test(s.value),
          );
          const products = await fetch('/api/products').then((r) => r.json());
          const p = products.find((p) => p.product_id === selected?.value);
          if (p?.style !== expected) throw new Error('Selected style mismatch');
          return { style: p.style, productId: p.product_id };
        }, productStyle);
        await page.locator('input[type=file]').setInputFiles(file);
        await page.getByRole('button', { name: /^(Start|Restart)$/ }).click();
        // Accept calibration/lost frames in the sample; never wait for a convenient drawn pose.
        await page.waitForFunction(
          () =>
            window.__arlab.engine.currentSource?.video?.readyState >= 2 &&
            window.__arlab.engine.posedScene,
          null,
          { timeout: testsetClip ? 45000 : 180000 },
        );
        // Calibration intentionally holds the source. Never force playback through that
        // hold: otherwise early still windows measure startup/calibration drift instead.
        await page.waitForFunction(
          () => {
            const s = window.__arlab.sample();
            return s.phase === 'tracking' && s.status === 'drawn';
          },
          null,
          { timeout: testsetClip ? 30000 : 90000 },
        );
        const result = await page.evaluate(pageSampler, {
          every: extra.settings.every,
          maxSeconds: Math.max(1, (deadline - Date.now() - 5000) / 1000),
          steps,
          restWindows,
          untilSeconds,
        });
        if (testsetClip) {
          extra.stillQualification = qualifyStill(result.frames, steps);
          restWindows = extra.stillQualification.filter((w) => w.qualified);
          extra.restWindows = restWindows;
        }
        extra.duration = result.duration;
        extra.motionOnsets = motionOnsets(result.frames);
        extra.hasGlue = result.hasGlue;
        extra.blockedExternalRequests = blocked;
        extra.engineStats = result.engineStats;
        extra.arStats = result.arStats;
        extra.sourceEndHashes = sourceHashes();
        let out = update(result.frames, result.wallSeconds, result.completed);
        print(out.scoreboard);
        if (!result.completed)
          throw new Error('Video exceeded the bounded lease; partial evidence saved');
        if (testsetClip || flag('--review')) {
          try {
            extra.visual = await page.evaluate(recordVisual, {
              samples: proofSamples(
                steps.length
                  ? steps
                  : [
                      { name: 'still', startMs: 1500, endMs: 4500 },
                      { name: 'first-view', startMs: 500, endMs: 501 },
                      { name: 'moment-1', startMs: 4000, endMs: 4001 },
                      { name: 'moment-2', startMs: 6000, endMs: 6001 },
                      { name: 'moment-3', startMs: 8000, endMs: 8001 },
                      { name: 'moment-4', startMs: 10000, endMs: 10001 },
                      { name: 'moment-5', startMs: 12500, endMs: 12501 },
                      { name: 'moment-6', startMs: 14000, endMs: 14001 },
                    ],
                extra.stillQualification ?? [],
              ),
              maxSeconds: Math.min(100, Math.max(15, (result.duration ?? 30) + 8)),
              untilSeconds,
            });
          } catch (error) {
            writeFileSync(join(proofDir, 'visual-error.txt'), String(error));
            extra.visual = { error: 'Private proof capture error; see cache, no visual PASS.' };
          }
          await page.close();
          if (testsetClip && !flag('--no-kiosk')) {
            try {
              const full = await stockKioskProfile(context, {
                root: ROOT,
                file,
                style: productStyle,
                still,
                flags: abFlags,
              });
              writeFileSync(join(proofDir, 'kiosk-profile.json'), JSON.stringify(full));
              extra.kioskProfile = {
                selectedStyle: full.selectedStyle,
                fixtureResponses: full.fixtureResponses,
                scope: full.scope,
                modes: full.modes.map((m) => ({
                  mode: m.mode,
                  drawnFps: m.drawnFps,
                  renderFps: m.renderFps,
                  elapsedS: m.elapsedS,
                  drawn: m.drawn,
                  violations: m.violations,
                  timings: m.timings,
                })),
              };
            } catch (error) {
              writeFileSync(join(proofDir, 'profile-error.txt'), String(error));
              extra.kioskProfile = {
                error: 'No valid kiosk profile; private diagnostic in cache.',
              };
            }
          }
          extra.sourceEndHashes = sourceHashes();
          out = update(result.frames, result.wallSeconds, result.completed);
        }
        if (flag('--ruler')) {
          const frozen = await page.evaluate(frozenRuler, {
            warmupMs: 2500,
            measureMs: 4000,
            proofFrames: 12,
          });
          writeFileSync(join(frozenDir, 'raw-frozen.json'), JSON.stringify(frozen.cases));
          const ruler = {
            generatedUtc: new Date().toISOString(),
            commit: batchRevision,
            method: frozen.method,
            source: basename(file),
            selectedProduct: extra.selectedProduct,
            snapshotHash: extra.snapshotHash ?? null,
            snapshotSourceStable: extra.snapshotSourceStable ?? null,
            sourceStartHashes: extra.sourceStartHashes,
            sourceEndHashes: sourceHashes(),
            realStill: out.summary.rest,
            cases: frozen.cases.map((c) => ({
              finish: c.finish,
              still: c.still,
              complete: c.complete,
              wallMs: c.wallMs,
              layers: layerSummary(c.frames),
              proofPaths: c.proofPaths,
              rest: restSummary(c.frames, [
                { id: 'frozen', name: 'repeated frame', startMs: 0, endMs: 15000 },
              ]),
            })),
            limitations: [
              'Finish OFF colour flicker is N/A; alpha is actual glued torso+sleeve union. Finish ON alpha is final finisher alpha before contact shadow.',
              'Camera count is browser presentedFrames, not encoded-frame count; browser skipped presentation is unobservable.',
            ],
          };
          writeFileSync(
            join(
              VALIDATION,
              `ar-eval-frozen-${basename(file).replace(/[^a-zA-Z0-9-]/g, '_')}.json`,
            ),
            JSON.stringify(ruler, null, 2) + '\n',
          );
          console.log('RULER saved docs/validation/ar-eval-ruler.json');
        }
        return out;
      } catch (error) {
        if (
          attempt === 1 &&
          Date.now() < deadline - 180000 &&
          /destroyed|reload|navigation|Execution context|Target closed/i.test(String(error))
        ) {
          extra.reloadRetries++;
          latestFrames = [];
          wallSeconds = null;
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    // Do not persist exception messages: Playwright may include the private body URL or file path.
    writeFileSync(join(PRIVATE, 'last-error.txt'), String(error));
    const page = context?.pages()[0];
    if (page && !page.isClosed()) {
      const state = await page
        .evaluate(() => ({
          state: window.__arlab?.state(),
          sample: window.__arlab?.sample(),
          text: document.querySelector('.arlab')?.innerText,
        }))
        .catch(() => null);
      writeFileSync(
        join(PRIVATE, 'last-state.json'),
        JSON.stringify({ state, diagnostics }, null, 2),
      );
      const shot = join(PRIVATE, 'last-failure.png');
      git('check-ignore', '-q', shot);
      await page.screenshot({ path: shot }).catch(() => undefined);
    }
    extra.error = 'Run incomplete; private diagnostic is .cache/ar-eval/last-error.txt';
    const out = update(latestFrames, wallSeconds, false);
    console.log(
      `${source}: INCOMPLETE; ${latestFrames.length} frames saved; see private diagnostic`,
    );
    process.exitCode = 1;
    return out;
  } finally {
    clearTimeout(timer);
    try {
      await context?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        release();
      }
    }
  }
}

if (arg('--diag')) {
  const file = resolve(arg('--diag'));
  const d = JSON.parse(readFileSync(file, 'utf8'));
  if (d.format !== 'satisfy-live-diagnostics') throw new Error('Expected satisfy-live-diagnostics');
  const out = record({
    source: `diag:${basename(file)}`,
    kind: 'diag',
    summary: summarise(d.frames.map(fromDiagFrame), { wallSeconds: d.seconds }),
  });
  print(out.scoreboard);
} else if (flag('--testset')) {
  const clips = testsetClips(ROOT),
    start = Number(arg('--start-case', '0')),
    limit = Number(arg('--limit', '60'));
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(limit) || limit < 1 || limit > 60)
    throw new Error('Invalid case bounds');
  const target = join(VALIDATION, 'ar-eval-testset.json');
  const aggregate = existsSync(target)
    ? JSON.parse(readFileSync(target, 'utf8'))
    : { generated: new Date().toISOString(), rows: [] };
  const jobs = clips.flatMap((c) =>
    ['FB7675-100', 'DQ4920-206'].flatMap((style) =>
      ['0', '1'].map((still) => ({ c, style, still })),
    ),
  );
  for (let i = start; i < Math.min(jobs.length, start + limit); i++) {
    const { c, style, still } = jobs[i];
    console.log(`TESTSET ${i + 1}/${jobs.length} clip${c.id} ${style} s${still}`);
    const out = await runVideo({
      video: c.video,
      manifest: null,
      testsetClip: c,
      productStyleOverride: style,
      stillOverride: still,
    });
    const row = {
      caseIndex: i,
      file: c.file,
      style,
      still,
      complete: out.complete,
      snapshotHash: out.snapshotHash,
      selectedProduct: out.selectedProduct,
      scoreboard: out.scoreboard,
      stillQualification: out.stillQualification,
      motionOnsets: out.motionOnsets,
      kioskProfile: out.kioskProfile,
      visual: out.visual,
    };
    row.criteria = anywearNumbers(row);
    row.pass = Object.values(row.criteria).every((v) => v === true);
    aggregate.rows = aggregate.rows.filter((r) => r.caseIndex !== i);
    aggregate.rows.push(row);
    aggregate.rows.sort((a, b) => a.caseIndex - b.caseIndex);
    aggregate.updated = new Date().toISOString();
    aggregate.targetRows = jobs.length;
    aggregate.attempted = aggregate.rows.length;
    aggregate.complete = aggregate.rows.length === jobs.length;
    aggregate.pass = aggregate.complete && aggregate.rows.every((r) => r.pass);
    aggregate.scope =
      'Unknown stock sizes; fallback body, tracking/coverage/look only. No fit verdict. Missing/unreviewed criteria never pass. Nominal still is qualified from raw landmarks.';
    aggregate.failureCatalogue = Object.keys(row.criteria).map((cause) => ({
      cause,
      cases: aggregate.rows.filter((r) => r.criteria[cause] !== true).map((r) => r.caseIndex),
    }));
    if (resultJson)
      writeFileSync(
        resultJson,
        JSON.stringify(
          {
            ...row,
            flags: abFlags.toString(),
            commit: out.commit,
            settings: out.settings,
            duration: out.duration,
            snapshotSourceStable: out.snapshotSourceStable,
            sourceStartHashes: out.sourceStartHashes,
            error: out.error ?? null,
            summaryRest: out.summary?.rest ?? null,
          },
          null,
          2,
        ) + '\n',
      );
    // Judge runs (--no-write) never touch the tracked aggregate.
    if (!flag('--no-write')) writeFileSync(target, JSON.stringify(aggregate, null, 2) + '\n');
  }
} else if (flag('--all')) {
  for (const source of sources()) {
    if (!existsSync(source.video)) {
      console.log(`Missing ${basename(source.video)}`);
      process.exitCode = 1;
      continue;
    }
    try {
      await runVideo(source);
    } catch (error) {
      console.log(`Source setup failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
} else if (arg('--video')) {
  const out = await runVideo({
    video: resolve(ROOT, known[arg('--video')] ?? arg('--video')),
    manifest: arg('--manifest') ? resolve(arg('--manifest')) : null,
  });
  // F5 judge: the same private per-case row as --testset (no kiosk profile on this path).
  if (resultJson) {
    const row = {
      file: arg('--video'),
      style: out.settings?.productStyle,
      still: out.settings?.still,
      complete: out.complete,
      settings: out.settings,
      selectedProduct: out.selectedProduct,
      scoreboard: out.scoreboard,
      // Nominal rest windows on this path are not raw-qualified: the still row stays N/A.
      stillQualification: [],
      motionOnsets: out.motionOnsets,
      visual: out.visual,
    };
    row.criteria = anywearNumbers(row);
    writeFileSync(
      resultJson,
      JSON.stringify(
        { ...row, flags: abFlags.toString(), commit: out.commit, error: out.error ?? null },
        null,
        2,
      ) + '\n',
    );
  }
} else
  console.log(
    'node scripts/ar-eval.mjs --all | --video <local-path> [--manifest <capture.json>] | --diag <path>',
  );
