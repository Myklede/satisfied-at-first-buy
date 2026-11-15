// ZB browser check of the Studio pinch chain WITHOUT the real camera (agent ZB).
//
// Opens the running Vite (5810, never restarted) at /studio.html?zbReplay=1&zbDebug=1 in headed Chrome with
// Chrome's FAKE camera (the real webcam is never opened), pushes scripted pose + hand frames
// (numbers only) into the bridge, and measures: bus values over time, the Fit Lab physics status,
// the solver's hood/zip state, and InteractController's latency (pinch frame -> first render frame
// drawing the moved cloth). Never clicks the Decart button (no credits used).
//
// Usage (repo root): node --max-old-space-size=6144 apps/web/src/studio/interact/e2e/zb-studio-e2e.mjs
// Takes the machine-wide browser lock (.cache/locks/browser) and waits while another job holds it.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const out = join(root, '.cache/zb');
const lock = join(root, '.cache/locks/browser');
const base = process.env.ZB_BASE ?? 'http://127.0.0.1:5810';
const jacket = process.argv.includes('--parka') ? 'FB7675-100' : 'DQ4920-206';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

const lockUntil = Date.now() + 15 * 60_000;
for (;;) {
  try {
    mkdirSync(lock);
    break;
  } catch {
    if (Date.now() > lockUntil) throw new Error('browser lock busy for 15 min');
    await sleep(3000);
  }
}
writeFileSync(join(lock, 'owner.txt'), `ZB zb-studio-e2e ${new Date().toISOString()}\n`);

const result = { jacket, steps: [], errors: [], nonLoopback: [] };
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
    if (
      ['127.0.0.1', 'localhost'].includes(url.hostname) ||
      ['data:', 'blob:'].includes(url.protocol)
    )
      return route.continue();
    result.nonLoopback.push(url.href);
    return route.abort('blockedbyclient');
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('pageerror', (e) => result.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') result.errors.push(`console: ${m.text()}`);
  });
  const shot = async (name) => {
    const file = join(out, `e2e-${jacket}-${name}.png`);
    await page.screenshot({ path: file });
    return file;
  };
  const snap = () => page.evaluate(() => window.__studioBridge.snapshot());
  const step = async (name, extra = {}) => {
    const s = await snap();
    const bus = await page.evaluate(() => window.__studioBus.get());
    const entry = {
      name,
      t: Date.now(),
      bus,
      physics: s.physics,
      physicsError: s.physicsError,
      ui: s.physicsUi,
      ...extra,
    };
    result.steps.push(entry);
    console.log(
      JSON.stringify({
        name,
        zip: bus.zip,
        hoodOn: bus.hoodOn,
        physics: s.physics,
        ui: s.physicsUi && {
          zipOpen: s.physicsUi.zipOpen,
          hood: s.physicsUi.hood,
          open: s.physicsUi.open,
        },
        err: s.physicsError,
      }),
    );
    return entry;
  };

  await page.goto(`${base}/studio.html?zbReplay=1&zbDebug=1`);
  await page.waitForFunction(
    () => window.__zbReplay && window.__studioBridge && window.__studioBus,
    null,
    {
      timeout: 90_000,
    },
  );
  // The scripted person is perception's own synthetic standing pose (?zbReplay=1, __zbPose).
  await page.evaluate((jacketId) => {
    const pose = window.__zbPose;
    const cx = (pose[11].x + pose[12].x) / 2,
      sy = (pose[11].y + pose[12].y) / 2,
      T = (pose[23].y + pose[24].y) / 2 - sy;
    const video = document.querySelector('video');
    const aspect = video && video.videoWidth ? video.videoWidth / video.videoHeight : 16 / 9;
    window.__zbBody = { cx, sy, T, aspect };
    window.__zbLog = [];
    window.__studioBus.subscribe((s, _p, src) =>
      window.__zbLog.push({
        t: performance.now(),
        zip: s.zip,
        hoodOn: s.hoodOn,
        hemPull: s.hemPull,
        src,
      }),
    );
    const at = (u, v) => ({ x: cx + (u * T) / aspect, y: sy + v * T });
    window.__zbHand = (pinching, u, v) =>
      window.__zbReplay.pushHands({
        timeMs: performance.now(),
        hands: [{ handedness: 'Right', points: [], pinching, pinchPoint: at(u, v) }],
      });
    // Plays [{ms, pinching, u, v}] keyframes at 30 Hz (linear between keyframes).
    window.__zbPlay = (keys) =>
      new Promise((done) => {
        const t0 = performance.now(),
          total = keys[keys.length - 1].ms;
        const id = setInterval(() => {
          const t = performance.now() - t0;
          let k = 0;
          while (k < keys.length - 2 && keys[k + 1].ms <= t) k++;
          const a = keys[k],
            b = keys[Math.min(k + 1, keys.length - 1)],
            f = b.ms > a.ms ? Math.min(1, Math.max(0, (t - a.ms) / (b.ms - a.ms))) : 1;
          window.__zbHand(
            t >= total ? b.pinching : a.pinching,
            a.u + (b.u - a.u) * f,
            a.v + (b.v - a.v) * f,
          );
          if (t >= total) {
            clearInterval(id);
            done();
          }
        }, 33);
      });
    window.__studioBus.set({ jacket: jacketId, zip: 0, hoodOn: true }, 'ui');
  }, jacket);
  console.log('body', JSON.stringify(await page.evaluate(() => window.__zbBody)));
  await step('loaded');

  // Wait for the Fit Lab to have a 3D view, then wake physics with a short pinch on the pull.
  const vTop = -0.2,
    vHem = jacket === 'FB7675-100' ? 1.15 : 1.0;
  let ready = false;
  const started = Date.now();
  while (!ready && Date.now() - started < 120_000) {
    await page.evaluate(
      (v) =>
        window.__zbPlay([
          { ms: 0, pinching: false, u: 0, v },
          { ms: 200, pinching: true, u: 0, v },
          { ms: 500, pinching: false, u: 0, v },
        ]),
      vTop,
    );
    for (let i = 0; i < 20 && !ready; i++) {
      await sleep(500);
      const s = await snap();
      ready = s.physics === 'ready';
      if (s.physics === 'unavailable') console.log('physics unavailable:', s.physicsError);
    }
  }
  await step('physics-wake', { ready, waitMs: Date.now() - started });
  await shot('0-ready');

  // 1. Zip: grab at the collar, pull to the hem in 2.5 s, hold, let go.
  await page.evaluate(() => window.__studioBridge.stats());
  await page.evaluate(
    ({ vTop, vHem }) =>
      window.__zbPlay([
        { ms: 0, pinching: false, u: 0.02, v: vTop },
        { ms: 300, pinching: true, u: 0.02, v: vTop },
        { ms: 2800, pinching: true, u: 0.04, v: vHem + 0.05 },
        { ms: 3600, pinching: true, u: 0.04, v: vHem + 0.05 },
        { ms: 3700, pinching: false, u: 0.04, v: vHem + 0.05 },
      ]),
    { vTop, vHem },
  );
  await sleep(1500);
  await step('zip-open');
  await shot('1-zip-open');
  if (await page.evaluate(() => typeof window.__studioFitLab?.setReveal === 'function')) {
    await page.evaluate(() => window.__studioFitLab.setReveal(1, false));
    await sleep(1200);
    await shot('1b-see-through-open');
    await page.evaluate(() => window.__studioFitLab.setReveal(0, false));
    await sleep(300);
  }

  // 2. Hood off: pinch behind the head, pull back/down.
  await page.evaluate(() =>
    window.__zbPlay([
      { ms: 0, pinching: false, u: 0.2, v: -0.75 },
      { ms: 300, pinching: true, u: 0.2, v: -0.75 },
      { ms: 1500, pinching: true, u: 0.35, v: -0.1 },
      { ms: 1600, pinching: false, u: 0.35, v: -0.1 },
    ]),
  );
  await sleep(2000);
  await step('hood-off');
  await shot('2-hood-off');

  // 3. Hood on: pinch at the shoulder, lift over the head.
  await page.evaluate(() =>
    window.__zbPlay([
      { ms: 0, pinching: false, u: 0.6, v: 0.2 },
      { ms: 300, pinching: true, u: 0.6, v: 0.2 },
      { ms: 1400, pinching: true, u: 0.5, v: -0.45 },
      { ms: 1500, pinching: false, u: 0.5, v: -0.45 },
    ]),
  );
  await sleep(2500);
  await step('hood-on');
  await shot('3-hood-on');

  // 4. Zip closed again: grab the pull at the hem, push it to the collar.
  await page.evaluate(
    ({ vTop, vHem }) =>
      window.__zbPlay([
        { ms: 0, pinching: false, u: 0, v: vHem },
        { ms: 300, pinching: true, u: 0, v: vHem },
        { ms: 2500, pinching: true, u: 0, v: vTop - 0.1 },
        { ms: 2600, pinching: false, u: 0, v: vTop - 0.1 },
      ]),
    { vTop, vHem },
  );
  await sleep(2000);
  await step('zip-closed');
  // The measured shell must be back (restore cross-fade) before a fit pull: wait for it.
  for (let i = 0; i < 40; i++) {
    const s = await snap();
    if (s.physicsUi && !s.physicsUi.open) break;
    await sleep(250);
  }
  // 5. Hem: pinch the front hem and pull down; screenshot while held, then let go.
  const hemPlay = page.evaluate(
    ({ vHem }) =>
      window.__zbPlay([
        { ms: 0, pinching: false, u: 0.35, v: vHem },
        { ms: 300, pinching: true, u: 0.35, v: vHem },
        { ms: 1500, pinching: true, u: 0.35, v: vHem + 0.4 },
        { ms: 3000, pinching: true, u: 0.35, v: vHem + 0.4 },
        { ms: 3100, pinching: false, u: 0.35, v: vHem + 0.4 },
      ]),
    { vHem },
  );
  await sleep(2200);
  await step('hem-held', {
    hand: await page.evaluate(() => window.__studioBridge.stats().physics?.handNow),
  });
  await shot('5-hem-held');
  await hemPlay;
  await sleep(1500);
  await step('hem-released', {
    hand: await page.evaluate(() => window.__studioBridge.stats().physics?.handNow),
  });
  await shot('6-hem-released');
  await shot('4-zip-closed');
  if (await page.evaluate(() => typeof window.__studioFitLab?.setReveal === 'function')) {
    await page.evaluate(() => window.__studioFitLab.setReveal(1, false));
    await sleep(1200);
    await shot('4b-see-through-closed');
    await page.evaluate(() => window.__studioFitLab.setReveal(0, false));
    await sleep(300);
  }
  const stats = await page.evaluate(() => window.__studioBridge.stats());
  result.stats = stats;
  result.busLog = await page.evaluate(() => window.__zbLog);
  await sleep(17000); // physics leaves after 15 s closed + idle
  await step('after-idle');
  // 6. Size switch while the jacket is open: physics must leave cleanly and come back for the new size.
  await page.evaluate(() => window.__studioBus.set({ zip: 0.5 }, 'slider'));
  for (let i = 0; i < 80; i++) {
    if ((await snap()).physics === 'ready') break;
    await sleep(250);
  }
  await sleep(1500);
  await step('open-before-size');
  const before = await page.evaluate(() => window.__studioBus.get().size);
  const next = before === 'M' ? 'L' : 'M';
  await page.evaluate((size) => window.__studioBus.set({ size }, 'ui'), next);
  await sleep(600);
  await step('size-switched', { from: before, to: next });
  for (let i = 0; i < 120; i++) {
    if ((await snap()).physics === 'ready') break;
    await sleep(250);
  }
  await sleep(1500);
  await step('size-reentered');
  await shot('8-size-reentered');
  await page.evaluate(() => window.__studioBus.set({ zip: 0 }, 'slider'));
  await shot('7-after-idle');
  console.log(
    'stats',
    JSON.stringify({
      ...stats,
      physics: stats.physics && {
        latencyP50: stats.physics.latencyP50,
        latencyP95: stats.physics.latencyP95,
        latencySamples: stats.physics.latencySamples,
        enter: stats.physics.enter,
        fpsP50: stats.physics.fpsP50,
        grabs: stats.physics.grabs,
      },
    }),
  );
} finally {
  writeFileSync(join(out, `e2e-${jacket}.json`), JSON.stringify(result, null, 1));
  await context?.close().catch(() => undefined);
  rmSync(lock, { recursive: true, force: true });
  console.log('errors', result.errors.length, result.errors.slice(0, 8));
}
