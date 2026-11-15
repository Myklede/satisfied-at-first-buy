// Headed-Chrome smoke bench for the body scan (scan.html bench mode).
// Uses Chrome's fake camera (--use-fake-device-for-media-stream): the stream contains no
// person, so this proves only that PoseLandmarker initialises and runs, and measures its
// delegate and inference rate. Real-person accuracy is NOT tested here.
//
//   node packages/vision/scripts/smoke-scan.mjs [--seconds 8]
//
// Reuses a Vision Lab dev server already answering on 127.0.0.1:5711; otherwise starts one
// and stops it afterwards (never stops a server it did not start).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const BASE = 'http://127.0.0.1:5711';
const argSeconds = process.argv.indexOf('--seconds');
const SECONDS = argSeconds > 0 ? Number(process.argv[argSeconds + 1]) : 8;
const MODELS = ['heavy', 'full'];

async function responds() {
  try {
    const r = await fetch(`${BASE}/scan.html`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

let server;
if (await responds()) console.log(`reusing dev server at ${BASE}`);
else {
  const require = createRequire(import.meta.url);
  const viteBin = path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
  server = spawn(process.execPath, [viteBin, '--config', 'vite.config.ts'], {
    cwd: pkgRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  const t0 = Date.now();
  while (!(await responds())) {
    if (Date.now() - t0 > 30000 || server.exitCode !== null)
      throw new Error('Vision Lab dev server did not start on 127.0.0.1:5711');
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`started dev server at ${BASE} (pid ${server.pid})`);
}

const results = [];
let context;
try {
  context = await chromium.launchPersistentContext(
    path.join(repoRoot, '.cache', 'playwright', 'vision-scan'),
    {
      channel: 'chrome',
      headless: false,
      viewport: { width: 1400, height: 900 },
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
  );
  for (const model of MODELS) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(`${BASE}/scan.html?bench=1&model=${model}&seconds=${SECONDS}`);
    await page.waitForFunction(() => window.__scanBench, null, {
      timeout: (SECONDS + 120) * 1000,
    });
    const bench = await page.evaluate(() => window.__scanBench);
    results.push({ model, bench, errors });
    await page.close();
  }
} finally {
  await context?.close();
  if (server) {
    server.kill();
    console.log('stopped dev server');
  }
}

let failed = false;
for (const { model, bench, errors } of results) {
  console.log(`\n== pose_${model} ==`);
  if (!bench.ok) {
    failed = true;
    console.log(`FAILED: ${bench.error}`);
  } else {
    const s = bench.stats;
    console.log(`camera        ${bench.camera.label} ${bench.camera.width}x${bench.camera.height}`);
    console.log(`delegate      ${s.delegate}`);
    console.log(`model load    ${bench.loadMs.toFixed(0)} ms (incl. WASM + warm-up)`);
    console.log(
      `inference     ${bench.meanInferenceHz.toFixed(1)} Hz mean over ${bench.runSeconds.toFixed(1)} s; ` +
        `${s.inferMs.toFixed(1)} ms/frame incl. mask readback (last 30)`,
    );
    console.log(`geometry      ${s.analysisMs.toFixed(1)} ms/frame (last 30)`);
    console.log(`mask          ${s.maskWidth}x${s.maskHeight}`);
    console.log(`frames        ${s.framesProcessed}; guidance events ${bench.guidance}`);
    console.log(`issues seen   ${JSON.stringify(bench.issues)}`);
  }
  // MediaPipe logs some informational lines through console.error; show them, don't fail on them.
  if (errors.length)
    console.log(`console errors (${errors.length}): ${errors.slice(0, 5).join(' | ')}`);
}
console.log(
  '\nNote: the fake camera shows no person; this checks initialisation and speed only.' +
    '\nReal-person accuracy is untested until the calibration session (CALIBRATION.md).',
);
process.exitCode = failed ? 1 : 0;
