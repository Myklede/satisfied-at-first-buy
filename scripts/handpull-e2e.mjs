// M4 hand pull: replay-driven end-to-end test + benchmark (prompts/05 Part E).
//
//   node scripts/handpull-e2e.mjs [--url http://127.0.0.1:5710] [--build --port 5745]
//                                 [--quick] [--screenshots] [--out handpull-e2e]
//                                 [--compare] [--shot-prefix handpull] [--queue-busy]
//
// Drives the real kiosk (/?kiosk) to "Feel the fabric" in headed Chrome (real GPU; a fake
// camera so the real MediaPipe hand tracker runs and loads the main thread exactly as live),
// then replays the user's hand recordings (packages/vision/test-data/hands/*.json, local and
// gitignored; numbers only) into the SAME event handlers the live tracker feeds.
// Asserts: no solver explosion; region strain ≤ the clamp; zero grabs while the cursor is off
// the garment; render ≥ 60 fps. Writes docs/validation/handpull-e2e.json and, with
// --screenshots, docs/validation/handpull-*.png.
// --build serves a frozen production build (own port, this script stops it); default attaches
// to the running dev server. The body service must already run on 127.0.0.1:8001.
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startKioskServer } from './kiosk-server.mjs';
// SATISFY_KIOSK_EXTRA_QUERY (e.g. '&aa=smaa'): extra kiosk URL flags for A/B runs; validated.
const extraQuery = process.env.SATISFY_KIOSK_EXTRA_QUERY ?? '';
if (!/^(&[a-z0-9_]+(=[a-z0-9_]+)?)*$/i.test(extraQuery))
  throw new Error('SATISFY_KIOSK_EXTRA_QUERY must look like &flag or &key=value');

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const shots = args.includes('--screenshots');
const quick = args.includes('--quick');
/** F3: after the scenarios, standard-pull the size on screen and the next size (see below). */
const compare = args.includes('--compare');
const outDir = join(root, 'docs/validation');
mkdirSync(outDir, { recursive: true });
const log = (m) => console.log(`[handpull] ${m}`);

let server;
let base = opt('--url', 'http://127.0.0.1:5710');
if (args.includes('--build')) {
  const port = Number(opt('--port', 5745));
  const customDist = opt('--dist', null);
  if (customDist && !/^\.cache\/day-g\/[a-z0-9-]{1,48}$/.test(customDist))
    throw new Error('--dist must be a fresh .cache/day-g/<slug> directory');
  const dist = customDist ? join(root, customDist) : join(root, '.cache/handpull/dist');
  if (customDist && existsSync(dist))
    throw new Error('Custom build directory already exists; preserve it and use a fresh slug');
  log('building a frozen production bundle…');
  const build = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules/vite/bin/vite.js'),
      'build',
      join(root, 'apps/web'),
      '--outDir',
      dist,
      '--emptyOutDir',
    ],
    { stdio: 'inherit', cwd: root },
  );
  if (build.status !== 0) throw new Error('build failed');
  server = await startKioskServer({
    dist,
    port,
    apiPort: 8001,
    log,
    status: () => ({ service: 'up', restarts: 0 }),
    quit: () => undefined,
  });
  base = `http://127.0.0.1:${port}`;
}

// ---------- recordings ----------
const handDir = join(root, 'packages/vision/test-data/hands');
const files = readdirSync(handDir).filter((f) => f.endsWith('.json'));
const load = (stamp) => {
  const file = files.find((f) => f.includes(stamp));
  if (!file) throw new Error(`recording ${stamp} missing in ${handDir}`);
  const json = JSON.parse(readFileSync(join(handDir, file), 'utf8'));
  if (json.meta?.invalid) throw new Error(`recording ${stamp} is marked invalid`);
  return { name: file, json };
};
// [recording, where its first grab is placed, expectation]
const scenarios = [
  ['04-22-24', 'chest', 'grab'],
  ['04-23-26', 'shoulder', 'grab'],
  ['05-10-47', 'sleeve', 'grab'],
  ['04-22-41', 'off', 'none'],
  ...(quick
    ? []
    : [
        ['05-09-55', 'chest', 'grab'],
        ['03-40-22', 'shoulder', 'grab'],
        ['05-11-22', 'off', 'none'],
        ['05-07-51', 'chest', 'grab'],
      ]),
].map(([stamp, place, expect]) => ({ ...load(stamp), stamp, place, expect }));

// ---------- browser ----------
const context = await chromium.launchPersistentContext(join(root, '.cache/handpull/chrome'), {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: 1,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--force_high_performance_gpu',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
  ],
});
await context.route('**/*', (route) => {
  const url = new URL(route.request().url());
  return ['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.protocol === 'data:' ||
    url.protocol === 'blob:'
    ? route.continue()
    : route.abort('blockedbyclient');
});
const page = context.pages()[0] ?? (await context.newPage());
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});
const screen = (name, timeout = 180000) =>
  page.waitForSelector(`[data-screen="${name}"]`, { timeout });

const outName = opt('--out', 'handpull-e2e');
if (!/^[a-z0-9-]{1,40}$/.test(outName)) throw new Error('--out must be a short [a-z0-9-] name');
/** Screenshot file prefix in docs/validation (default keeps the historical names). */
const shotPrefix = opt('--shot-prefix', 'handpull');
if (!/^[a-z0-9-]{1,40}$/.test(shotPrefix))
  throw new Error('--shot-prefix must be a short [a-z0-9-] name');
/** Machine CPU load (%): other agents share this laptop; timings depend on it. */
const cpuLoad = () => {
  if (process.platform !== 'win32') return null;
  const out = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor).LoadPercentage'],
    { encoding: 'utf8' },
  ).stdout;
  const value = Number(out?.trim().split(/\s+/)[0]);
  return Number.isFinite(value) ? value : null;
};
const report = {
  base,
  startedAt: new Date().toISOString(),
  cpuLoadAtStart: cpuLoad(),
  scenarios: [],
  errors,
};
let exitCode = 0;
try {
  // Kiosk → result → Feel. The kiosk reloads itself when the shared body service restarts
  // (watchdog) or after 90 s without input, so the flow is retried and kept awake.
  const feelEnabled = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('button')].some(
        (b) => /Feel the fabric/.test(b.textContent ?? '') && !b.disabled,
      ),
    );
  report.flowAttempts = 0;
  const enterFeel = async () => {
    for (;;) {
      report.flowAttempts++;
      try {
        await page.goto(`${base}/?kiosk${extraQuery}`);
        await screen('attract', 300000);
        report.gpu = await page.evaluate(() => window.__kiosk?.diagnostics.gpu ?? null);
        await page.keyboard.press('Space');
        await screen('you');
        await page.getByRole('button', { name: 'cm · kg' }).click();
        await page.getByLabel('Height centimetres').fill('172');
        await page.getByLabel('Weight kilograms').fill('65');
        await page.getByRole('button', { name: 'Male', exact: true }).click();
        await page.getByRole('button', { name: 'Continue →' }).click();
        await screen('scan');
        await page.waitForTimeout(2000);
        await page
          .getByRole('button', { name: /Skip scan|Continue without scan|Continue →/ })
          .click();
        await screen('result', 300000);
        const deadline = Date.now() + 240000;
        while (!(await feelEnabled())) {
          if (Date.now() > deadline)
            throw new Error(
              `Feel the fabric never enabled; jackets ${JSON.stringify(
                await page.evaluate(() => window.__kiosk?.jackets),
              )}`,
            );
          if (!(await page.$('[data-screen="result"]'))) throw new Error('kiosk left the result');
          await page.mouse.move(700 + Math.random() * 20, 300);
          await page.waitForTimeout(2000);
        }
        break;
      } catch (error) {
        log(`kiosk flow attempt ${report.flowAttempts} failed: ${error.message}`);
        if (report.flowAttempts >= 4) throw error;
        await page.waitForTimeout(10000);
      }
    }
    if (args.includes('--queue-busy')) {
      // Agent E2: press Feel while the kiosk's background motion queue has a bake running, so the
      // first scenarios replay with the worker threads busy (the queue itself pauses in Feel).
      const deadline = Date.now() + 300000;
      while (!(await page.evaluate(() => window.__kiosk?.motion().running))) {
        if (Date.now() > deadline) throw new Error('no background motion bake started in 300 s');
        await page.mouse.move(700 + Math.random() * 20, 300); // kiosk 90 s idle reset
        await page.waitForTimeout(500);
      }
      report.queueBusyAtFeel = await page.evaluate(() => window.__kiosk?.motion());
    }
    const feel = page.getByRole('button', { name: /Feel the fabric/ });
    const enteredAt = Date.now();
    await feel.click();
    await screen('feel');
    await page.waitForFunction(() => window.__handpull?.controller.isReady, null, {
      timeout: 60000,
    });
    report.relaxMs ??= Date.now() - enteredAt;
    // The fake camera never shows a hand: hold the 20 s no-hand exit while replaying (tested
    // explicitly at the end).
    await page.evaluate(() => window.__handpull.holdOpen(true));
  };
  await enterFeel();
  await page.waitForTimeout(1500); // camera framing tween, tracker start
  report.camera = await page.evaluate(() => {
    const h = window.__handpull;
    return h?.camera ? h.camera.info() : null;
  });
  if (shots) await page.screenshot({ path: join(outDir, `${shotPrefix}-ready.png`) });

  // Viewport targets on the garment from pick probes (no hard-coded geometry).
  report.targets = await page.evaluate(() => {
    const h = window.__handpull;
    const hits = [];
    for (let y = -0.95; y <= 0.95; y += 0.05)
      for (let x = -0.95; x <= 0.95; x += 0.025) if (h.probe(x, y)) hits.push([x, y]);
    if (!hits.length) return null;
    const ys = hits.map((p) => p[1]),
      top = Math.max(...ys),
      bottom = Math.min(...ys),
      span = top - bottom,
      xs = hits.map((p) => p[0]),
      cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const near = (x, y) =>
      hits.reduce((b, p) =>
        Math.hypot(p[0] - x, p[1] - y) < Math.hypot(b[0] - x, b[1] - y) ? p : b,
      );
    // Sleeve: centre of the outermost run of hits on a row below mid height (A-pose arm).
    const mid = bottom + span * 0.4;
    const row = hits
      .filter((p) => Math.abs(p[1] - mid) < 0.026)
      .map((p) => p[0])
      .sort((a, b) => a - b);
    const runs = [];
    for (const x of row)
      if (runs.length && x - runs[runs.length - 1].at(-1) < 0.03) runs[runs.length - 1].push(x);
      else runs.push([x]);
    const last = runs[runs.length - 1] ?? [0];
    const outer = [last.reduce((a, b) => a + b, 0) / last.length, mid];
    return {
      chest: near(cx + 0.08, bottom + span * 0.68),
      shoulder: near(cx + 0.14, top - span * 0.1),
      sleeve: outer,
      sleeveRuns: runs.length,
      // Background right next to the jacket: 0.12 NDC outside the leftmost hit of the chest row.
      off: (() => {
        const y = bottom + span * 0.68,
          rowX = hits.filter((p) => Math.abs(p[1] - y) < 0.026).map((p) => p[0]);
        return [Math.min(...rowX) - 0.12, y];
      })(),
      garmentHits: hits.length,
    };
  });
  if (!report.targets) throw new Error('garment not pickable on screen');
  report.targets.offIsGarment = await page.evaluate(
    ([x, y]) => window.__handpull.probe(x, y),
    report.targets.off,
  );
  if (report.targets.offIsGarment) throw new Error('"off" target is on the garment');

  for (const s of scenarios) {
    // A kiosk reload (shared service restarted) destroys the page: re-enter Feel, retry once.
    for (let attempt = 0; ; attempt++) {
      try {
        const at = report.targets[s.place];
        await page.mouse.move(800 + Math.random() * 10, 450); // kiosk 90 s idle reset: operator input
        await page.evaluate(() => window.__handpull.controller.resetStats());
        // Background motion bakes (agent E2): the queue pauses in Feel; a bake already running
        // when Feel opened finishes. The state before/after each scenario shows the overlap.
        const queueBefore = await page.evaluate(() => window.__kiosk?.motion() ?? null);
        const before = await page.evaluate(() => window.__handpull.controller.snapshot());
        const targetProbe = await page.evaluate(
          ([x, y]) => [0, 24, 48].map((tol) => window.__handpull.probe(x, y, tol)),
          at,
        );
        const run = page.evaluate(
          ({ json, at }) => window.__handpull.replay(json, { firstGrabAt: { x: at[0], y: at[1] } }),
          { json: s.json, at },
        );
        run.catch(() => undefined); // awaited below; never an unhandled rejection
        // Evidence frames: while the first grab pulls, and after its release.
        let pulled = false,
          released = false;
        if (shots && s.expect === 'grab' && ['shoulder', 'sleeve', 'chest'].includes(s.place)) {
          const deadline = Date.now() + 120000;
          let grabSeen = 0;
          while (Date.now() < deadline && !released) {
            const st = await page.evaluate(() => window.__handpull.controller.snapshot());
            if (st.grabbing && !grabSeen) grabSeen = Date.now();
            if (st.grabbing && grabSeen && !pulled && Date.now() - grabSeen > 700) {
              await page.screenshot({ path: join(outDir, `${shotPrefix}-${s.place}-pull.png`) });
              pulled = true;
            }
            if (pulled && !st.grabbing) {
              await page.waitForTimeout(150);
              await page.screenshot({ path: join(outDir, `${shotPrefix}-${s.place}-release.png`) });
              await page.waitForTimeout(1500);
              await page.screenshot({
                path: join(outDir, `${shotPrefix}-${s.place}-sprungback.png`),
              });
              released = true;
            }
            await page.waitForTimeout(50);
          }
        }
        const summary = await run;
        // Let the release spring back finish before reading the stats.
        await page.waitForTimeout(2500);
        const stats = await page.evaluate(() => window.__handpull.controller.stats());
        const queueAfter = await page.evaluate(() => window.__kiosk?.motion() ?? null);
        // Gating audit: re-probe every pinch start now that the cloth is back at rest. A grab must
        // not start where even a 2× tolerance finds no garment; a start where a direct ray hits the
        // garment must grab. (Between the two, the cloth's own motion near a silhouette edge decides.)
        const starts = await page.evaluate(() =>
          window.__handpull.controller.startLog().map((s) => ({
            ...s,
            clearlyOn: window.__handpull.probe(s.x, s.y, 0),
            nearby: window.__handpull.probe(s.x, s.y, 48),
          })),
        );
        const gatingViolations = starts.filter(
          (s) => (s.grabbed && !s.nearby) || (!s.grabbed && s.clearlyOn),
        );
        for (const v of gatingViolations) log(`gating violation ${JSON.stringify(v)}`);
        const after = await page.evaluate(() => window.__handpull.controller.snapshot());
        const tracker = await page.evaluate(() => {
          const t = window.__handpull.tracker;
          return t ? t.stats() : null;
        });
        const margin = 0.02; // HAND_PULL.strainMargin (engine/hand/config.ts)
        const checks = {
          noExplosion: !errors.some((e) => /non-finite|explod/i.test(e)),
          // Per edge: never longer than max(limit + margin, its length at grab start). Absolute
          // excess and the pre-grab residue are reported too.
          strainWithinClamp: !(stats.maxOverClamp > 1e-6),
          strainWithinMargin: !(stats.maxExcess > margin + 1e-6),
          // First pinch placed on (grab) or right beside (none) the jacket.
          // (A non-grab pose may close the hand zero times: then nothing may be grabbed either.)
          firstStartAsExpected:
            s.expect === 'grab'
              ? starts.length > 0 && starts[0].grabbed
              : starts.length === 0
                ? stats.grabs === 0
                : !starts[0].grabbed,
          gating: gatingViolations.length === 0,
          render60: stats.fpsP50 >= 60,
        };
        const { strainWithinMargin: _strict, ...required } = checks;
        void _strict;
        const ok = Object.values(required).every(Boolean);
        if (!ok) exitCode = 1;
        const entry = {
          recording: s.name,
          place: s.place,
          at,
          expect: s.expect,
          summary,
          stats,
          motionQueue: {
            runningBefore: queueBefore?.running ?? null,
            runningAfter: queueAfter?.running ?? null,
            completedBefore: queueBefore?.completed ?? null,
            completedAfter: queueAfter?.completed ?? null,
            preemptions: queueAfter?.preemptions ?? null,
          },
          tracker,
          before,
          after,
          targetProbe,
          // Counts only: the hand trajectories come from the user's recordings and stay local.
          pinchStarts: starts.length,
          grabbedStarts: starts.filter((x) => x.grabbed).length,
          gatingViolations: gatingViolations.length,
          checks,
          ok,
        };
        report.scenarios.push(entry);
        log(
          `${s.stamp} @${s.place}: ${ok ? 'PASS' : 'FAIL'} grabs ${stats.grabs} missed ${stats.missedGrabs} ` +
            `fps p50 ${stats.fpsP50.toFixed(0)} p5 ${stats.fpsP5.toFixed(0)} latency p50 ${stats.latencyP50.toFixed(0)} p95 ${stats.latencyP95.toFixed(0)} ms (n ${stats.latencySamples}) ` +
            `step p50 ${stats.stepP50.toFixed(1)} p95 ${stats.stepP95.toFixed(1)} ms ${stats.deliveredHz.toFixed(0)} Hz ` +
            `over-clamp ${Number.isFinite(stats.maxOverClamp) ? stats.maxOverClamp.toExponential(1) : '—'} excess ${stats.maxExcess.toFixed(4)} (baseline ${stats.maxBaseline.toFixed(4)}) shell ${stats.maxShellRatio.toFixed(3)} region ${stats.regionParticles} ` +
            `follow max ${(stats.followMaxM * 100).toFixed(2)} cm taut frames ${stats.tautFrames}/${stats.pullFrames} readout-on-jacket frames ${stats.readoutOverlapFrames}`,
        );
        break;
      } catch (error) {
        if (attempt >= 1 || !/destroyed|navigation|__handpull|controller/.test(String(error)))
          throw error;
        report.reloads = (report.reloads ?? 0) + 1;
        log(`kiosk reloaded during ${s.stamp}; re-entering Feel the fabric and retrying`);
        await enterFeel();
      }
    }
  }
  // F3 (--compare): the "Measure" button's standard pull (same pull path, fixed chest point,
  // straight out) on the size on screen, then on the next size after switching on the result
  // screen. Numbers come from the solver; the comparison card is screenshotted.
  if (compare) {
    const standard = async (label) => {
      await page.mouse.move(800 + Math.random() * 10, 450);
      const run = page.evaluate(() => window.__handpull.measure());
      run.catch(() => undefined);
      if (shots && label) {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const st = await page.evaluate(() => window.__handpull.controller.snapshot());
          if (st.taut || !st.measuring) break;
          await page.waitForTimeout(40);
        }
        await page.screenshot({ path: join(outDir, `${shotPrefix}-${label}.png`) });
      }
      const result = await run;
      await page.waitForTimeout(2500); // spring back before anything else
      log(
        `standard pull size ${result.size}: follow max ${(result.followMaxM * 100).toFixed(2)} cm, ` +
          `end ${(result.followEndM * 100).toFixed(2)} cm, taut ${result.taut} (at end ${result.tautAtEnd}), ` +
          `${result.frames} frames, request ${(result.requestM * 100).toFixed(0)} cm`,
      );
      return result;
    };
    report.compare = { standard: [await standard('taut')] };
    const first = report.compare.standard[0].size;
    await page.getByRole('button', { name: '← Done' }).click();
    await screen('result');
    const sizes = await page.evaluate(() =>
      [...document.querySelectorAll('.k-sizes')][0]
        ? [...document.querySelectorAll('.k-sizes')[0].querySelectorAll('button')].map((b) =>
            (b.textContent ?? '').replace('★', '').trim(),
          )
        : [],
    );
    const i = sizes.indexOf(first);
    const next = sizes[i + 1] ?? sizes[i - 1];
    if (!next) throw new Error(`no other size to compare with ${first} (sizes ${sizes})`);
    report.compare.sizes = sizes;
    log(`switching ${first} → ${next} for the comparison`);
    await page.mouse.move(700, 300);
    await page
      .locator('.k-sizes')
      .first()
      .getByRole('button', { name: new RegExp(`^${next}( ★)?$`) })
      .click();
    await page.waitForFunction(
      (size) => {
        const group = document.querySelector('.k-sizes');
        const on = group?.querySelector('button[aria-pressed="true"]');
        return (
          on &&
          (on.textContent ?? '').replace('★', '').trim() === size &&
          [...document.querySelectorAll('button')].some(
            (b) => /Feel the fabric/.test(b.textContent ?? '') && !b.disabled,
          )
        );
      },
      next,
      { timeout: 240000 },
    );
    await page.getByRole('button', { name: /Feel the fabric/ }).click();
    await screen('feel');
    await page.waitForFunction(() => window.__handpull?.controller.isReady, null, {
      timeout: 60000,
    });
    await page.evaluate(() => window.__handpull.holdOpen(true));
    await page.waitForTimeout(1500); // camera framing tween
    report.compare.standard.push(await standard(null));
    report.compare.card = await page.evaluate(() => window.__handpull.compare());
    report.compare.cardText = await page.evaluate(
      () => document.querySelector('.k-feel-compare')?.textContent ?? null,
    );
    if (shots) await page.screenshot({ path: join(outDir, `${shotPrefix}-compare.png`) });
    log(`comparison card: ${report.compare.cardText}`);
  }
  // Part D: with no hand for 20 s the screen exits by itself; tracker and camera stop.
  await page.evaluate(() => window.__handpull.holdOpen(false));
  const waitStarted = Date.now();
  await screen('result', 40000);
  report.noHandExitMs = Date.now() - waitStarted;
  report.exitStopsTracker = await page.evaluate(() => !window.__handpull);
  report.noHandExitOk = report.noHandExitMs >= 19000 && report.exitStopsTracker;
  if (!report.noHandExitOk) exitCode = 1;
  log(
    `no-hand exit after ${report.noHandExitMs} ms; tracker/camera released: ${report.exitStopsTracker}`,
  );
  // "Done" button path.
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('button')].some(
        (b) => /Feel the fabric/.test(b.textContent ?? '') && !b.disabled,
      ),
    null,
    { timeout: 60000 },
  );
  await page.getByRole('button', { name: /Feel the fabric/ }).click();
  await screen('feel');
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: '← Done' }).click();
  await screen('result');
  report.doneButtonExits = await page.evaluate(() => !window.__handpull);
} catch (error) {
  exitCode = 1;
  report.fatal = String(error?.stack ?? error);
  log(`FATAL ${report.fatal}`);
  try {
    await page.screenshot({ path: join(root, '.cache/handpull/fatal.png') });
  } catch {
    /* ignore */
  }
} finally {
  report.finishedAt = new Date().toISOString();
  report.cpuLoadAtEnd = cpuLoad();
  report.passed = exitCode === 0;
  writeFileSync(join(outDir, `${outName}.json`), JSON.stringify(report, null, 2));
  await context.close();
  server?.close();
  log(
    `${report.passed ? 'PASSED' : 'FAILED'}; errors ${errors.length}; report docs/validation/${outName}.json`,
  );
  process.exit(exitCode);
}
