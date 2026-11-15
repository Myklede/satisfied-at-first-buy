// ZB: close-up shots of the Fit Lab zip (0 -> 50 -> 100 % and back) for continuity and stiffness
// checks. Fake camera, ?zbReplay=1, never Decart; takes the browser lock.
// Usage (repo root): node apps/web/src/studio/interact/e2e/zb-zip-shots.mjs <tag> [--parka]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const out = join(root, '.cache/zb/zip');
const lock = join(root, '.cache/locks/browser');
const tag = process.argv[2] ?? 'run';
const jacket = process.argv.includes('--parka') ? 'FB7675-100' : 'DQ4920-206';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });
const until = Date.now() + 15 * 60_000;
for (;;) {
  try {
    mkdirSync(lock);
    break;
  } catch {
    if (Date.now() > until) throw new Error('browser lock busy');
    await sleep(3000);
  }
}
writeFileSync(join(lock, 'owner.txt'), `ZB zb-zip-shots ${new Date().toISOString()}\n`);
const log = { jacket, tag, shots: [], errors: [] };
let context;
try {
  context = await chromium.launchPersistentContext(join(root, '.cache/zb/chrome'), {
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
      ['data:', 'blob:'].includes(url.protocol)
      ? route.continue()
      : route.abort('blockedbyclient');
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('console', (m) => {
    if (m.type() === 'error') log.errors.push(m.text().slice(0, 300));
  });
  await page.goto('http://127.0.0.1:5810/studio.html?zbReplay=1');
  await page.waitForFunction(() => window.__studioBridge && window.__studioBus, null, {
    timeout: 90_000,
  });
  await page.evaluate((j) => window.__studioBus.set({ jacket: j, size: 'M', zip: 0 }, 'ui'), jacket);
  await sleep(4000);
  // Enter physics (slider a hair open), wait for ready.
  let ready = false;
  for (let i = 0; i < 160 && !ready; i++) {
    if (i % 40 === 0) await page.evaluate(() => window.__studioBridge.prewarm());
    await sleep(500);
    ready = (await page.evaluate(() => window.__studioBridge.snapshot().physics)) === 'ready';
  }
  log.ready = ready;
  // Close-up of the front: the controller's own orbit (front, chest height, closer).
  await page.evaluate(() => window.__studioBridge.interact()?.orbit(0, 0.35, 0.55));
  await sleep(1200);
  const canvas = page.locator('.fl-canvas-host canvas').first();
  const shot = async (name) => {
    const file = join(out, `${tag}-${jacket}-${name}.png`);
    await canvas.screenshot({ path: file }).catch(() => page.screenshot({ path: file }));
    log.shots.push(file);
  };
  const ramp = async (from, to, ms) => {
    const steps = Math.max(1, Math.round(ms / 50));
    for (let i = 1; i <= steps; i++) {
      const z = from + ((to - from) * i) / steps;
      await page.evaluate((v) => window.__studioBus.set({ zip: v }, 'slider'), z);
      await sleep(50);
    }
  };
  await shot('z000');
  await ramp(0, 0.5, 1500);
  await sleep(1500);
  await shot('z050');
  await ramp(0.5, 1, 1500);
  await sleep(1500);
  await shot('z100');
  // Side view of the opened front (does it swing out as a thick panel or sag like a sheet?).
  await page.evaluate(() => window.__studioBridge.interact()?.orbit(55, 0.3, 0.7));
  await sleep(1500);
  await shot('z100-side');
  await page.evaluate(() => window.__studioBridge.interact()?.orbit(0, 0.35, 0.55));
  await sleep(1000);
  await ramp(1, 0.5, 1500);
  await sleep(1500);
  await shot('z050-back');
  await ramp(0.5, 0, 1500);
  await sleep(2500);
  await shot('z000-back');
  log.ui = await page.evaluate(() => window.__studioBridge.snapshot().physicsUi);
  log.stats = await page.evaluate(() => {
    const s = window.__studioBridge.stats().physics;
    return s && { latencyP50: s.latencyP50, maxGapM: s.maxGapM, stepP50: s.stepP50, enter: s.enter };
  });
} finally {
  writeFileSync(join(out, `${tag}-${jacket}.json`), JSON.stringify(log, null, 1));
  await context?.close().catch(() => undefined);
  rmSync(lock, { recursive: true, force: true });
  console.log(JSON.stringify({ ready: log.ready, ui: log.ui, stats: log.stats, errors: log.errors.length }));
}
