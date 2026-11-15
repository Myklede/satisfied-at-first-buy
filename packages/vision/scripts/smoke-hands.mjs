// Headed-Chrome smoke bench for the hand tracker (lab/hands.html).
//
//   node packages/vision/scripts/smoke-hands.mjs
//
// Reuses the lab Vite server on 127.0.0.1:5711 if one is already running (`npm run dev -w
// packages/vision`); otherwise starts its own there and stops only that one afterwards. Opens
// installed Chrome headed with Chrome's FAKE camera (a synthetic test pattern; the real webcam is
// never touched), runs the tracker with the GPU delegate and then the CPU delegate, and prints the
// measured inference rate and latency.
//
// LIMITATION: the fake stream contains no hand. This proves the pipeline loads and runs
// (WASM + model + delegate + per-frame inference), and measures the no-hand path (palm detector
// every frame). Pinch accuracy and the with-hand cost are NOT tested by this script.
// Frames with a detected hand are counted: on the hand-free fake stream every one of them is a
// false hand (checks the lowered presence/tracking confidences). 60 fps is requested, as in the lab.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Lab port, same as vite.config.ts. */
const PORT = 5711;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const START_TIMEOUT_MS = 60_000;
/** Warm-up after 'running' before sampling, so shader compile / JIT does not skew the numbers. */
const WARMUP_MS = 2_000;
const MEASURE_MS = 10_000;
/** Camera frame rate to request (`--fps=30` to compare); the lab default is 60. */
/**
 * Headed by default. `--headless` exists because on 2026-11-12 the headed window was throttled to
 * ~1 Hz rendering by the desktop (rAF 1 Hz, no long tasks, GPU idle, same in the old lab code),
 * while headless ran the same page at the fake camera's full 20 Hz.
 */
const HEADLESS = process.argv.includes('--headless');
const REQUEST_FPS = process.argv.find((a) => a.startsWith('--fps='))?.slice(6) ?? '60';
const SAMPLE_EVERY_MS = 1_000;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

async function runDelegate(context, delegate) {
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  page.on('response', (res) => {
    if (res.status() >= 400)
      consoleErrors.push(`HTTP ${res.status()} ${new URL(res.url()).pathname}`);
  });
  await page.goto(`${BASE_URL}/hands.html?autostart=1&delegate=${delegate}&fps=${REQUEST_FPS}`);
  await page.waitForFunction(
    () => ['running', 'error'].includes(window.__handsLab?.state ?? ''),
    undefined,
    { timeout: START_TIMEOUT_MS },
  );
  const started = await page.evaluate(() => ({ ...window.__handsLab }));
  if (started.state === 'error') {
    await page.close();
    return { delegate, ok: false, error: started.error, consoleErrors };
  }
  await page.waitForTimeout(WARMUP_MS);
  const framesBefore = await page.evaluate(() => window.__handsLab.frames);
  const samples = [];
  for (let t = 0; t < MEASURE_MS; t += SAMPLE_EVERY_MS) {
    await page.waitForTimeout(SAMPLE_EVERY_MS);
    samples.push(await page.evaluate(() => ({ ...window.__handsLab.stats })));
  }
  const final = await page.evaluate(() => ({ ...window.__handsLab }));
  await page.close({ runBeforeUnload: true });
  const framesInWindow = final.frames - framesBefore;
  const falseHandFrames = final.framesWithHands;
  return {
    requested: delegate,
    ok: framesInWindow > 0 && !final.stats?.lastError,
    delegate: final.stats?.delegate,
    gpuFallbackReason: final.stats?.gpuFallbackReason,
    camera: final.camera,
    framesInWindow,
    falseHandFrames,
    totalFrames: final.frames,
    requestedFps: final.requestedFps,
    measuredHz: framesInWindow / (MEASURE_MS / 1000),
    inferenceHzMean: mean(samples.map((s) => s.inferenceHz)),
    latencyMsMean: mean(samples.map((s) => s.latencyMs)),
    inferenceMsMean: mean(samples.map((s) => s.inferenceMs)),
    framesSkipped: final.stats?.framesSkipped,
    lastError: final.stats?.lastError,
    consoleErrors,
  };
}

/** True if a server already answers for the lab hands page. */
async function labServerRunning() {
  try {
    const res = await fetch(`${BASE_URL}/hands.html`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Only set when this script started the server; an existing server is never stopped. */
let ownServer;
let browser;
let failed = false;
try {
  if (await labServerRunning()) {
    console.log(`Reusing the lab server already running at ${BASE_URL}`);
  } else {
    ownServer = await createServer({
      configFile: path.join(pkgDir, 'vite.config.ts'),
      root: path.join(pkgDir, 'lab'),
      server: { host: '127.0.0.1', port: PORT, strictPort: true },
      logLevel: 'warn',
    });
    await ownServer.listen();
    console.log(`Started a lab server at ${BASE_URL} (will stop it afterwards)`);
  }
  browser = await chromium.launch({
    channel: 'chrome',
    headless: HEADLESS,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      // The bench window may sit behind the user's windows; without these Chrome throttles an
      // occluded/background page and the measured rate reflects throttling, not the tracker.
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const results = [];
  for (const delegate of ['GPU', 'CPU']) results.push(await runDelegate(context, delegate));

  const mode = HEADLESS ? 'headless' : 'headed';
  console.log(`\nHand tracker smoke bench (${mode} Chrome, fake camera: NO HAND in frame)`);
  for (const r of results) {
    if (r.ok === false && r.error) {
      console.log(`  ${r.delegate}: FAILED to start: ${r.error}`);
      failed = true;
      continue;
    }
    const cam = r.camera ? `${r.camera.width}x${r.camera.height}@${r.camera.fps}fps` : '?';
    console.log(
      `  requested ${r.requested} -> delegate ${r.delegate}` +
        (r.gpuFallbackReason ? ` (GPU fallback: ${r.gpuFallbackReason})` : '') +
        `\n    camera ${cam} (requested ${r.requestedFps} fps); ${r.framesInWindow} frames in ` +
        `${MEASURE_MS / 1000}s = ` +
        `${r.measuredHz.toFixed(1)} Hz (stats window mean ${r.inferenceHzMean.toFixed(1)} Hz)` +
        `\n    latency frame->event mean ${r.latencyMsMean.toFixed(2)} ms; ` +
        `detectForVideo mean ${r.inferenceMsMean.toFixed(2)} ms; skipped ${r.framesSkipped}` +
        `\n    false hands (fake stream has none): ${r.falseHandFrames}/${r.totalFrames} frames` +
        (r.lastError ? `\n    lastError: ${r.lastError}` : '') +
        (r.consoleErrors.length ? `\n    console errors: ${r.consoleErrors.join(' | ')}` : ''),
    );
    if (!r.ok) failed = true;
  }
  console.log('\nJSON:', JSON.stringify(results));
} catch (error) {
  failed = true;
  console.error('Smoke bench failed:', error);
} finally {
  await browser?.close();
  await ownServer?.close();
}
process.exit(failed ? 1 : 0);
