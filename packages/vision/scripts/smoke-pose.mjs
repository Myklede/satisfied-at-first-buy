// Headed-Chrome smoke bench for the webcam pose tracker (pose.html bench mode).
// Uses Chrome's fake camera (--use-fake-device-for-media-stream): the stream contains no
// person, so this proves only that PoseLandmarker initialises and runs, and measures its
// delegate, inference rate and processing latency per model. Real-person angle accuracy is NOT
// tested here (see src/anatomicalPose.test.ts for the synthetic round trip, and the replay of
// test-data/pose recordings).
//
//   node packages/vision/scripts/smoke-pose.mjs [--seconds 8] [--headed]
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
const MODELS = ['lite', 'full', 'heavy'];
/** --headed runs a visible window (the GPU delegate can differ between modes). */
const HEADLESS = !process.argv.includes('--headed');
/**
 * Second source with a body in view: a rendered (synthetic, computed) Anny reference body from
 * docs/validation, redrawn as a still 30 fps canvas. Exercises the landmark stage (the fake camera
 * only exercises the detector) and sanity-checks the angles on a known A-pose. Not a real person.
 */
const BODY_IMAGE = path.join(repoRoot, 'docs', 'validation', 'landmarks-front.png');
const BODY_CROP = '240,370,380,545'; // male 175 cm body, image pixels x,y,w,h
const BODY_URL = `/@fs/${BODY_IMAGE.split(path.sep).join('/')}`;
const SOURCES = [
  { name: 'fake camera', query: '' },
  {
    name: 'rendered A-pose body',
    query: `&image=${encodeURIComponent(BODY_URL)}&crop=${BODY_CROP}`,
  },
];

async function responds() {
  try {
    const r = await fetch(`${BASE}/pose.html`, { signal: AbortSignal.timeout(2000) });
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
    path.join(repoRoot, '.cache', 'playwright', 'vision-pose'),
    {
      channel: 'chrome',
      headless: HEADLESS,
      viewport: { width: 1400, height: 900 },
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
  );
  for (const source of SOURCES)
    for (const model of MODELS) {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await page.goto(`${BASE}/pose.html?bench=1&model=${model}&seconds=${SECONDS}${source.query}`);
      await page.waitForFunction(() => window.__poseBench, null, {
        timeout: (SECONDS + 120) * 1000,
      });
      const bench = await page.evaluate(() => window.__poseBench);
      results.push({ model, source: source.name, bench, errors });
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
for (const { model, source, bench, errors } of results) {
  console.log(`\n== pose_${model} · ${source} (${HEADLESS ? 'headless' : 'headed'}) ==`);
  if (!bench.ok) {
    failed = true;
    console.log(`FAILED: ${bench.error}`);
  } else {
    const s = bench.stats;
    const c = bench.camera;
    console.log(`camera        ${c.label} ${c.width}x${c.height} @ ${c.fps} fps`);
    const fallback = s.gpuFallbackReason ? ` (GPU failed: ${s.gpuFallbackReason})` : '';
    console.log(`delegate      ${s.delegate}${fallback}`);
    console.log(`model load    ${bench.loadMs.toFixed(0)} ms (camera + WASM + model + warm-up)`);
    console.log(
      `inference     ${bench.meanInferenceHz.toFixed(1)} Hz mean over ${bench.runSeconds.toFixed(1)} s; ` +
        `${s.inferenceMs.toFixed(1)} ms/frame detectForVideo (last 30)`,
    );
    console.log(`latency       ${s.latencyMs.toFixed(1)} ms frame callback -> emit (last 30)`);
    console.log(
      `frames        ${s.framesProcessed} processed, ${s.framesSkipped} skipped; ` +
        `person in ${bench.personFrames}`,
    );
    if (s.lastError) console.log(`last error    ${s.lastError}`);
    if (bench.lastPose) {
      const p = bench.lastPose;
      const c = bench.lastConfidence;
      const show = (d) =>
        `${d} ${p[d].toFixed(d === 'pelvis_drop_m' ? 3 : 0)} (c ${c[d].toFixed(2)})`;
      console.log('last pose     ' + Object.keys(p).map(show).join('\n              '));
    }
  }
  // MediaPipe logs some informational lines through console.error; show them, don't fail on them.
  if (errors.length)
    console.log(`console errors (${errors.length}): ${errors.slice(0, 5).join(' | ')}`);
}
console.log(
  '\nNote: the fake camera shows no person (detector only); the rendered body is a synthetic' +
    '\nA-pose render, uncalibrated (trunk/hip angles assume an upright camera). Not a real person.' +
    '\nReal-person validation is pending: record the motions in lab/pose.html (test-data/pose/).',
);
process.exitCode = failed ? 1 : 0;
