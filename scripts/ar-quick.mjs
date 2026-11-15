// Bounded P22 diagnostic: eight exact product/clip pairs, one browser then heavy lease.
// Native kiosk timing is a separate pass without evaluation readbacks/screenshots.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireBrowserSlot } from './lookdev/browser-slot.mjs';
import { tryHeavySlot } from './codex-heavy-slot.mjs';
import { syncWorker } from './codex-day-slot.mjs';
import { pageSampler } from './ar-eval-sampler.mjs';
import { installRestProbe } from './ar-eval-rest.mjs';
import { qualifyStill } from './ar-eval-testset.mjs';
import { summarise, scoreboard } from './ar-eval-lib.mjs';
import { motionOnsets, boundedOnsetScore } from './ar-eval-motion.mjs';
import { profileKiosk } from '../apps/web/src/engine/live/ar/finish/eval/kiosk-profile.mjs';
import {
  quickClips,
  quickDeltas,
  quickFlags,
  quickTable,
  QUICK_PROTOCOL,
} from './ar-quick-lib.mjs';
import { buildHash } from './demo-day-warm.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} needs a value`);
  return args[i + 1];
};
const flags = quickFlags(value('--flags', ''));
const clips = quickClips(
  JSON.parse(readFileSync(join(ROOT, 'data/test-videos/manifest.json'), 'utf8')),
);
const styles = ['FB7675-100', 'DQ4920-206'];
const output = join(ROOT, '.cache/cx-day/quick');
const validation = join(ROOT, 'docs/validation');
const baselineFile = join(validation, 'ar-quick-baseline.json');
const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : null;
execFileSync('git', ['check-ignore', '-q', join(output, 'sheet.png')], { cwd: ROOT });
mkdirSync(output, { recursive: true });
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const dirty = !!execFileSync('git', ['status', '--porcelain'], {
  cwd: ROOT,
  encoding: 'utf8',
}).trim();
const report = {
  generatedUtc: new Date().toISOString(),
  commit,
  dirty,
  flags: flags.toString(),
  protocol: QUICK_PROTOCOL,
  rows: [],
  sheets: [],
  complete: false,
  sourceHashes: {
    web: buildHash(join(ROOT, 'apps/web/src')),
    vision: buildHash(join(ROOT, 'packages/vision/src')),
  },
  limitations: [
    'Quick screen, not full prompt20 acceptance; visual/light/real-jacket comparison requires review.',
    'Quality pass plays the first <=8 seconds at native speed; a deadline cutoff or absent onset stays N/A.',
    'Bounded kiosk diagnostic settles1s after the first drawn frame, versus5s in the full profile; not full steady-state acceptance.',
    'Still windows require >=2s raw-landmark qualification. No still PASS on unqualified windows.',
    'FPS is actual drawn calls on the kiosk with a local native video camera fixture, separately from quality readbacks.',
    'cameraToScreen is engine processing totalMs only; exposure, decode, capture and physical display latency are not measured.',
    'Dev server with HMR/watch disabled; shared laptop load; source HEAD plus working-tree state, not a clean production build.',
  ],
};
let releaseBrowser, releaseHeavy, server, context, watchdog, cleanupPromise, finalReportPromise;
const start = Date.now(),
  deadline = start + 350000;
const screenshots = new Map();
const persist = () => {
  mkdirSync(validation, { recursive: true });
  writeFileSync(join(validation, 'ar-quick-latest.json'), JSON.stringify(report, null, 2) + '\n');
};
const cleanup = () =>
  (cleanupPromise ??= (async () => {
    try {
      await context?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        try {
          releaseHeavy?.();
        } finally {
          releaseBrowser?.();
        }
        persist();
      }
    }
  })());
async function openPage(budgetMs) {
  const page = await context.newPage();
  page.setDefaultTimeout(Math.min(18000, budgetMs));
  page.setDefaultNavigationTimeout(Math.min(18000, budgetMs));
  const timeout = setTimeout(() => void page.close().catch(() => {}), budgetMs);
  return {
    page,
    close: async () => {
      clearTimeout(timeout);
      await page.close().catch(() => {});
    },
  };
}
const gotoFlags = (page) => {
  const goto = page.goto.bind(page);
  page.goto = (url, options) => {
    const u = new URL(url);
    for (const [k, v] of flags) u.searchParams.set(k, v);
    return goto(u.href, options);
  };
};
async function quality(clip, style, row) {
  const { page, close } = await openPage(Math.min(23000, deadline - Date.now() - 2000));
  try {
    gotoFlags(page);
    await page.addInitScript(installRestProbe);
    await page.exposeFunction('__arScoreCheckpoint', () => {});
    const params = new URLSearchParams({
      arlab: '',
      source: 'file',
      jacket: style,
      size: 'S',
      h: '172',
      w: '65',
      sex: 'male',
      still: '0',
      finish: '1',
      mirror: '0',
    });
    await page.goto(`http://127.0.0.1:5771/?${params}`);
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.arlab select')].some((s) => /^[a-f0-9]{64}$/.test(s.value)),
    );
    row.selectedStyle = await page.evaluate(async () => {
      const selected = [...document.querySelectorAll('.arlab select')].find((s) =>
        /^[a-f0-9]{64}$/.test(s.value),
      );
      return (await fetch('/api/products').then((r) => r.json())).find(
        (p) => p.product_id === selected.value,
      )?.style;
    });
    if (row.selectedStyle !== style) throw new Error('Quality selected product mismatch');
    await page.locator('input[type=file]').setInputFiles(join(ROOT, clip.file));
    await page.getByRole('button', { name: /^(Start|Restart)$/ }).click();
    await page.waitForFunction(
      () =>
        window.__arlab?.engine.currentSource?.video?.readyState >= 2 &&
        window.__arlab.engine.posedScene &&
        window.__arlab.sample().phase === 'tracking',
    );
    const rest = clip.segments.filter((s) => s.name === 'still');
    const measured = await page.evaluate(pageSampler, {
      every: 1,
      maxSeconds: QUICK_PROTOCOL.qualitySeconds,
      steps: clip.segments,
      restWindows: rest,
    });
    const qualification = qualifyStill(measured.frames, clip.segments);
    const summary = summarise(measured.frames, {
      wallSeconds: measured.wallSeconds,
      restWindows: qualification.filter((w) => w.qualified),
    });
    const scores = scoreboard(summary),
      onset = boundedOnsetScore(motionOnsets(measured.frames));
    row.metrics = {
      stillPx: scores.restOutlinePxPerFrame.value,
      rotationDeg: scores.restRotationRmsDeg.value,
      scalePct: scores.restScaleStepP95Pct.value,
      onsetFrames: onset.value,
      residualPx: scores.keypointResidualPx.value,
      uncoveredPct: scores.frontalUncoveredPct.value,
    };
    row.qualityComplete =
      measured.frames.length >= 5 &&
      (measured.completed || measured.wallSeconds >= QUICK_PROTOCOL.qualitySeconds);
    row.fullClipMeasured = measured.completed;
    row.stillQualification = qualification;
    row.observations = measured.frames.length;
    row.onset = onset;
    writeFileSync(
      join(output, `${clip.id}-${style}-quality.json`),
      JSON.stringify({ measured, qualification }),
    );
    // Separate proof pass after numeric quality sampling; no screenshots in kiosk timing.
    const proof = await page.evaluate(async (segments) => {
      const { engine, ar } = window.__arlab,
        v = engine.currentSource.video;
      const segment =
        segments.find((s) => s.name === 'cross_arms') ?? segments.find((s) => s.name === 'still');
      const t = segment ? (segment.startMs + segment.endMs) / 2000 : 2;
      v.pause();
      await new Promise((done) => {
        v.addEventListener('seeked', done, { once: true });
        v.currentTime = t;
        if (!v.seeking) done();
      });
      await new Promise((done) => setTimeout(done, 700));
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      ar.renderer.domElement.id = 'quick-ar';
      if (engine.mirrorCanvas) engine.mirrorCanvas.id = 'quick-mirror';
      return { raw: c.toDataURL(), sourceSeconds: v.currentTime, mirror: !!engine.mirrorCanvas };
    }, clip.segments);
    const ar = await page.locator('#quick-ar').screenshot();
    const mirror = proof.mirror ? await page.locator('#quick-mirror').screenshot() : null;
    const list = screenshots.get(clip.id) ?? [];
    list.push({
      style,
      raw: proof.raw,
      ar: `data:image/png;base64,${ar.toString('base64')}`,
      mirror: mirror ? `data:image/png;base64,${mirror.toString('base64')}` : null,
      sourceSeconds: proof.sourceSeconds,
    });
    screenshots.set(clip.id, list);
  } finally {
    await close();
  }
}
async function kiosk(clip, style, row) {
  const { page, close } = await openPage(Math.min(19000, deadline - Date.now() - 1000));
  try {
    gotoFlags(page);
    const wait = page.waitForTimeout.bind(page);
    page.waitForTimeout = (ms) => wait(ms === 5000 ? QUICK_PROTOCOL.kioskWarmupMs : ms);
    await page.route('**/sandbox/ref?**', (route) =>
      route.fulfill({ path: join(ROOT, clip.file), contentType: 'video/mp4' }),
    );
    const role = page.getByRole.bind(page);
    page.getByRole = (name, options) =>
      name === 'button' && options?.name === 'Try it on you'
        ? page.locator('.k-card').filter({ hasText: style }).getByRole(name, options)
        : role(name, options);
    const result = await profileKiosk(page, {
      port: 5771,
      body: { h: 172, w: 65 },
      seconds: QUICK_PROTOCOL.kioskSeconds,
      cpu: false,
      modes: ['default'],
    });
    const selected = await page.evaluate(async () => {
      const id = window.__tryfEngine.options.productId;
      return (await fetch('/api/products').then((r) => r.json())).find((p) => p.product_id === id)
        ?.style;
    });
    if (selected !== style) throw new Error('Kiosk selected product mismatch');
    const mode = result.modes[0];
    if (mode.violations.length || mode.phase !== 'tracking')
      throw new Error('Kiosk timing invalid');
    row.metrics ??= {};
    row.metrics.kioskArFps = mode.drawnFps;
    row.metrics.processingMs = mode.engine.totalMs;
    row.kioskComplete = true;
    writeFileSync(join(output, `${clip.id}-${style}-kiosk.json`), JSON.stringify(result));
  } finally {
    await close();
  }
}

try {
  syncWorker(
    'CX-DAY',
    'SLOT REQUEST P22 ar-quick baseline; browser then heavy; command deadline6min',
  );
  readFileSync(join(ROOT, 'docs/requests/codex-sync.md'), 'utf8');
  releaseBrowser = await acquireBrowserSlot('CX-DAY P22 ar-quick', {
    pause: async () => {
      throw new Error('Browser/RAM unavailable; quick run not started');
    },
  });
  releaseHeavy = tryHeavySlot('CX-DAY', 'P22 ar-quick');
  if (!releaseHeavy) throw new Error('Heavy/RAM unavailable; returning browser immediately');
  syncWorker('CX-DAY', 'SLOT ACQUIRED P22 ar-quick browser and heavy; bounded command6min');
  watchdog = setTimeout(
    () => {
      report.error = 'Six-minute deadline';
      void cleanup()
        .then(finishReport)
        .finally(() => process.exit(1));
    },
    Math.max(1, deadline - Date.now()),
  );
  const { createServer } = await import('vite');
  server = await createServer({
    root: join(ROOT, 'apps/web'),
    configFile: join(ROOT, 'apps/web/vite.config.ts'),
    cacheDir: join(output, 'vite'),
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
  const { chromium } = await import('playwright');
  context = await chromium.launchPersistentContext(join(output, 'chrome'), {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1280, height: 800 },
    serviceWorkers: 'block',
    args: [
      '--disable-background-networking',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    return ['127.0.0.1', 'localhost'].includes(u.hostname) ||
      ['blob:', 'data:'].includes(u.protocol)
      ? route.continue()
      : route.abort();
  });
  for (const clip of clips)
    for (const style of styles) {
      const row = { clip: clip.id, style, metrics: {}, complete: false, errors: [] };
      report.rows.push(row);
      if (Date.now() > deadline - 5000) {
        row.errors.push('Budget exhausted before case');
        continue;
      }
      try {
        await quality(clip, style, row);
      } catch (error) {
        row.errors.push(`quality: ${error.message.split('\n')[0]}`);
      }
      if (Date.now() < deadline - 5000) {
        try {
          await kiosk(clip, style, row);
        } catch (error) {
          row.errors.push(`kiosk: ${error.message.split('\n')[0]}`);
        }
      }
      row.complete = !!row.qualityComplete && !!row.kioskComplete;
      persist();
    }
  for (const clip of clips) {
    const page = await context.newPage();
    try {
      await page.setContent(
        '<html><body style="margin:0;background:#222;color:white;font:16px sans-serif"><div id="sheet"></div></body></html>',
      );
      await page.evaluate(
        (rows) => {
          const sheet = document.getElementById('sheet');
          for (const r of rows) {
            const label = document.createElement('p');
            label.textContent = `${r.style} source ${r.sourceSeconds.toFixed(3)}s — raw | AR | mirror`;
            sheet.append(label);
            for (const src of [r.raw, r.ar, r.mirror]) {
              const image = document.createElement('img');
              image.width = 400;
              image.height = 300;
              image.style.objectFit = 'contain';
              if (src) image.src = src;
              else image.alt = 'MISSING';
              sheet.append(image);
            }
          }
          if (!rows.length) sheet.textContent = 'NO VALID PROOF — run incomplete';
          return Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
        },
        screenshots.get(clip.id) ?? [],
      );
      const file = join(output, `${clip.id}-raw-ar-mirror.png`);
      await page.locator('#sheet').screenshot({ path: file });
      report.sheets.push({
        clip: clip.id,
        path: file.slice(ROOT.length + 1).replaceAll('\\', '/'),
        complete: screenshots.get(clip.id)?.length === 2,
      });
    } finally {
      await page.close();
    }
  }
  report.complete =
    report.rows.length === 8 &&
    report.rows.every((r) => r.complete) &&
    report.sheets.every((s) => s.complete);
} catch (error) {
  report.error = error.message;
  if (/Access is denied/i.test(error.message))
    syncWorker(
      'CX-DAY',
      'LEAD RUN REQUEST: npm.cmd run ar:quick -- --save-baseline ; Vite/esbuild Access is denied; no sandbox retry.',
    );
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await finishReport();
}

function finishReport() {
  return (finalReportPromise ??= writeFinalReport());
}
async function writeFinalReport() {
  report.sourceStable =
    report.sourceHashes.web === buildHash(join(ROOT, 'apps/web/src')) &&
    report.sourceHashes.vision === buildHash(join(ROOT, 'packages/vision/src'));
  report.complete &&= report.sourceStable;
  for (const clip of clips)
    for (const style of styles)
      if (!report.rows.some((r) => r.clip === clip.id && r.style === style))
        report.rows.push({
          clip: clip.id,
          style,
          complete: false,
          metrics: {},
          errors: ['Setup blocked; not measured'],
        });
  report.delta = quickDeltas(report.rows, baseline);
  report.baselineCommit = baseline?.commit ?? null;
  if (args.includes('--save-baseline') && report.complete)
    writeFileSync(baselineFile, JSON.stringify(report, null, 2) + '\n');
  await cleanup();
  syncWorker('CX-DAY', 'SLOT RELEASE P22 ar-quick; owned browser/server/heavy closed');
  const table = quickTable(report.rows),
    delta = quickTable(report.delta, true);
  console.log(
    table + '\n\nDelta vs saved baseline (' + (report.baselineCommit ?? 'none') + '):\n' + delta,
  );
  appendFileSync(
    join(ROOT, 'docs/STATUS-ar-eval.md'),
    `\n\n## P22 quick attempt ${report.generatedUtc}\n\nHEAD ${commit}, working tree dirty=${dirty}; flags=${flags.toString() || 'defaults'}. Complete=${report.complete}. ${report.error ? 'Setup/run blocked; no acceptance evidence.' : 'Partial diagnostic; visual acceptance pending.'}\n\n${table}\n\n${delta}\n\n${report.limitations.join(' ')}\n\nNumeric attempt: docs/validation/ar-quick-latest.json. Baseline is saved only after eight complete cases and four complete sheets.\n`,
  );
  if (!report.complete) process.exitCode = 1;
}
