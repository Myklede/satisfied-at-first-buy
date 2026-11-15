// Agent Z: interactive zip and detachable hood, end to end in the real kiosk.
//
//   node scripts/interact-e2e.mjs [--url http://127.0.0.1:5710] [--build --port 5745]
//                                 [--screenshots] [--out interact-e2e] [--jackets 0,1]
//
// Drives the kiosk (/?kiosk) to "Feel the fabric" in headed Chrome (real GPU, fake camera so the
// real MediaPipe tracker runs and loads the main thread as live), then on each jacket:
//  - mouse: drags the zip pull down to the hem and back up (real pointer events);
//  - synthetic pinch: the same through the hand-pull handlers (__handpull.sink.onPinch);
//  - hood (puffer): mouse pulls it off and brings it back; pinch does the same;
//  - checks: the shown shell hashes the same before and after (bit-identical closed state),
//    zero page errors, fps while interacting ≥ 90 % of the idle Feel screen's p50, cloth
//    latency p95 ≤ 100 ms, the zip opened (gap > 1 cm) and closed again, the hood detached
//    and re-attached.
// Writes docs/validation/<out>.json and, with --screenshots, docs/validation/interact-*.png
// (renders only). The body service must already run on 127.0.0.1:8001.
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startKioskServer } from './kiosk-server.mjs';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const shots = args.includes('--screenshots');
const outDir = join(root, 'docs/validation');
mkdirSync(outDir, { recursive: true });
const log = (m) => console.log(`[interact] ${m}`);
const outName = opt('--out', 'interact-e2e');
if (!/^[a-z0-9-]{1,40}$/.test(outName)) throw new Error('--out must be a short [a-z0-9-] name');
const jacketList = opt('--jackets', '0,1')
  .split(',')
  .map(Number)
  .filter((n) => n === 0 || n === 1);

let server;
let base = opt('--url', 'http://127.0.0.1:5710');
if (args.includes('--build')) {
  const port = Number(opt('--port', 5745));
  const customDist = opt('--dist', null);
  if (customDist && !/^\.cache\/day-g\/[a-z0-9-]{1,48}$/.test(customDist))
    throw new Error('--dist must be a fresh .cache/day-g/<slug> directory');
  const dist = customDist ? join(root, customDist) : join(root, '.cache/interact/dist');
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

const context = await chromium.launchPersistentContext(join(root, '.cache/interact/chrome'), {
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
const nonLoopback = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});
page.on('request', (r) => {
  const u = new URL(r.url());
  if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !['data:', 'blob:'].includes(u.protocol))
    nonLoopback.push(u.hostname);
});
// --dump-assets: keep the cloth assets the kiosk loads (reference body only) in .cache/interact
// for offline debugging of the zip line (never committed).
if (args.includes('--dump-assets'))
  page.on('response', async (response) => {
    const m = /\/fit\/([a-f0-9]{64})\/([A-Za-z0-9]{1,4})\/cloth$/.exec(
      new URL(response.url()).pathname,
    );
    if (!m || !response.ok()) return;
    try {
      const body = await response.body();
      mkdirSync(join(root, '.cache/interact/assets'), { recursive: true });
      writeFileSync(
        join(root, '.cache/interact/assets', `${m[1].slice(0, 12)}-${m[2]}.json`),
        body,
      );
    } catch {
      /* navigation */
    }
  });
const screen = (name, timeout = 180000) =>
  page.waitForSelector(`[data-screen="${name}"]`, { timeout });
const report = { base, startedAt: new Date().toISOString(), jackets: [], errors, nonLoopback };
let exitCode = 0;
const fail = (msg) => {
  exitCode = 1;
  log(`FAIL ${msg}`);
  (report.failures ??= []).push(msg);
};

/** Viewport NDC → page pixels (the Feel canvas fills the visible stage). */
async function px(ndc) {
  return page.evaluate((p) => {
    const c = [...document.querySelectorAll('.k-canvas')].find((e) => !e.hidden);
    const r = c.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  }, ndc);
}
const state = () => page.evaluate(() => window.__interact?.state());
const idle = async (ms) => {
  // Keep the kiosk's 90 s idle reset away (operator input outside the canvas).
  await page.mouse.move(40 + Math.random() * 5, 880);
  await page.waitForTimeout(ms);
};

async function rafFps(ms) {
  return page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const t = [];
        const start = performance.now();
        const loop = (now) => {
          t.push(now);
          if (now - start < ms) requestAnimationFrame(loop);
          else {
            const fps = t
              .slice(1)
              .map((v, i) => 1000 / (v - t[i]))
              .sort((a, b) => a - b);
            resolve({
              p50: fps[Math.floor(fps.length / 2)],
              p5: fps[Math.floor(fps.length * 0.05)],
              n: fps.length,
            });
          }
        };
        requestAnimationFrame(loop);
      }),
    ms,
  );
}

async function shot(name, closeup = true) {
  if (!shots) return;
  await page.screenshot({ path: join(outDir, `interact-${name}.png`) });
  // Close-up of the zip pull (the hardware is ~1 cm; the full frame cannot judge it).
  const at = closeup && (await page.evaluate(() => window.__interact.pullScreen()));
  if (at) {
    const q = await px(at);
    await page.screenshot({
      path: join(outDir, `interact-${name}-closeup.png`),
      clip: { x: Math.max(0, q.x - 140), y: Math.max(0, q.y - 120), width: 280, height: 280 },
    });
  }
}
async function threeQuarter(name) {
  if (!shots) return;
  await page.evaluate(() => window.__interact.orbit(35, 0.1));
  await page.waitForTimeout(900);
  await shot(name);
  await page.evaluate(() => window.__interact.orbit(0, 0));
  await page.waitForTimeout(800);
}

/** Mouse drag along NDC points (real pointer events), `ms` per step. */
async function mouseDrag(points, ms = 40) {
  const first = await px(points[0]);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const p of points.slice(1)) {
    const q = await px(p);
    await page.mouse.move(q.x, q.y, { steps: 2 });
    await page.waitForTimeout(ms);
  }
}

/** Synthetic pinch along NDC points through the hand-pull handlers (camera NDC = vp × 0.7). */
async function pinchDrag(points, release = true, ms = 33) {
  return page.evaluate(
    async ({ points, release, ms }) => {
      const sink = window.__handpull.sink;
      const ev = (type, p) => ({
        type,
        hand: 'right',
        ndc: { x: p.x * 0.7, y: p.y * 0.7 },
        depthDelta: 0,
        frameTime: performance.now(),
        confidence: 1,
        grip: 'pinch',
      });
      sink.onPinch(ev('start', points[0]));
      const began = window.__interact.state().dragging;
      for (const p of points.slice(1)) {
        await new Promise((r) => setTimeout(r, ms));
        sink.onPinch(ev('move', p));
      }
      if (release) {
        await new Promise((r) => setTimeout(r, ms));
        sink.onPinch(ev('end', points[points.length - 1]));
      }
      return began;
    },
    { points, release, ms },
  );
}
const pinchEnd = (p) =>
  page.evaluate((p) => {
    window.__handpull.sink.onPinch({
      type: 'end',
      hand: 'right',
      ndc: { x: p.x * 0.7, y: p.y * 0.7 },
      depthDelta: 0,
      frameTime: performance.now(),
      confidence: 1,
    });
  }, p);

/** Track points from fraction a to b of the zip (NDC), dense. */
async function trackPath(a, b, steps = 30) {
  const track = await page.evaluate(() => window.__interact.zipTrackNdc());
  const at = (f) => {
    const x = f * (track.length - 1),
      k = Math.min(track.length - 2, Math.floor(x)),
      t = x - k;
    return {
      x: track[k].x + (track[k + 1].x - track[k].x) * t,
      y: track[k].y + (track[k + 1].y - track[k].y) * t,
    };
  };
  const out = [];
  for (let i = 0; i <= steps; i++) out.push(at(a + ((b - a) * i) / steps));
  if (b >= 1) {
    // Past the hem end: the separating pin leaves the box.
    const end = out[out.length - 1];
    out.push({ x: end.x, y: end.y - 0.05 });
  }
  return out;
}

/** Like a person: if the zip is not closed after a drag, grab the pull again and finish (≤ 2). */
async function finishClosing(source) {
  for (let k = 0; k < 2; k++) {
    await page.waitForTimeout(700);
    const s = await state();
    if (s.zipOpen === 0 || !s.open) return k;
    const from = await page.evaluate(() => window.__interact.pullScreen());
    const path = await trackPath(Math.min(1, s.zipOpen), 0, 20);
    path[0] = from;
    path.push({ x: path[path.length - 1].x, y: path[path.length - 1].y + 0.06 });
    if (source === 'mouse') {
      await mouseDrag(path);
      await page.mouse.up();
    } else await pinchDrag(path);
  }
  return 2;
}

async function waitClosed(timeout = 15000) {
  log(`waiting for closed: ${JSON.stringify(await state())}`);
  await page.waitForFunction(
    () => {
      const s = window.__interact?.state();
      return s && !s.open && s.zipOpen === 0 && (!s.hasHood || s.hood === 'attached');
    },
    null,
    { timeout },
  );
  await page.waitForTimeout(400); // the base frame re-sent by the worker
}

async function enterFeel() {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(`${base}/?kiosk`);
      await screen('attract', 300000);
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
      await page.waitForFunction(
        () => {
          const k = window.__kiosk;
          const both = (k?.jackets ?? []).filter((j) => j.settled).length >= 2;
          return (
            both &&
            [...document.querySelectorAll('button')].some(
              (b) => /Feel the fabric/.test(b.textContent ?? '') && !b.disabled,
            )
          );
        },
        null,
        { timeout: 300000 },
      );
      break;
    } catch (error) {
      log(`kiosk flow attempt ${attempt} failed: ${error.message}`);
      if (attempt >= 3) throw error;
      await page.waitForTimeout(10000);
    }
  }
  await page.getByRole('button', { name: /Feel the fabric/ }).click();
  await screen('feel');
}

async function feelReady() {
  // Keep Feel open while it prepares (the fake camera never shows a hand: the 20 s no-hand
  // exit would close it); holdOpen is per screen instance.
  await page.waitForFunction(() => window.__handpull, null, { timeout: 30000 });
  await page.evaluate(() => window.__handpull.holdOpen(true));
  const diag = setTimeout(async () => {
    try {
      log(
        `still preparing: ${JSON.stringify(
          await page.evaluate(() => ({
            screen: window.__kiosk?.screen,
            ready: window.__handpull?.controller.isReady,
            interact: window.__interact?.state() ?? null,
            errors: [...document.querySelectorAll('.k-feel-error')].map((e) => e.textContent),
          })),
        )}`,
      );
    } catch {
      /* page gone */
    }
  }, 30000);
  await page.waitForFunction(
    () => window.__handpull?.controller.isReady && window.__interact?.state().ready,
    null,
    { timeout: 90000 },
  );
  clearTimeout(diag);
  await page.evaluate(() => window.__handpull.holdOpen(true));
  await page.waitForTimeout(1500); // framing tween, tracker start
}

try {
  await enterFeel();
  await feelReady();
  for (const index of jacketList) {
    if (index === 1) {
      const labels = await page.$$eval('[aria-label="Jacket"] button', (b) =>
        b.map((e) => e.textContent),
      );
      await page.locator('[aria-label="Jacket"] button').nth(1).click();
      log(`switched to ${labels[1]}`);
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Jacket"] button[aria-pressed="true"]')?.textContent,
      );
      await page.waitForTimeout(500);
      await feelReady();
    }
    const label = await page
      .$eval('[aria-label="Jacket"] button[aria-pressed="true"]', (e) => e.textContent)
      .catch(() => `jacket ${index}`);
    const slug = /DQ4920/.test(label) ? 'puffer' : /FB7675/.test(label) ? 'parka' : `j${index}`;
    const r = { index, label, slug, hasHood: (await state()).hasHood };
    report.jackets.push(r);
    log(`${label}: hood ${r.hasHood}`);
    await idle(500);
    r.idleFps = await rafFps(3000);
    r.hashBefore = await page.evaluate(() => window.__interact.shellHash());
    await shot(`${slug}-zip-0-front`);
    await threeQuarter(`${slug}-zip-0-34`);

    // ---- mouse: zip down to 50 %, then to the hem, then back up
    await page.evaluate(() => window.__interact.resetStats());
    const pull = await page.evaluate(() => window.__interact.pullScreen());
    if (!pull) throw new Error('zip pull not on screen');
    const down1 = await trackPath(0, 0.5);
    down1[0] = pull;
    await mouseDrag(down1);
    await page.waitForTimeout(1500);
    r.mouseHalf = await state();
    await shot(`${slug}-zip-50-front`);
    const down2 = await trackPath(0.5, 1);
    for (const p of down2.slice(1)) {
      const q = await px(p);
      await page.mouse.move(q.x, q.y, { steps: 2 });
      await page.waitForTimeout(40);
    }
    await page.mouse.up();
    await page.waitForTimeout(2500);
    r.mouseOpen = await state();
    r.mouseOpenStats = await page.evaluate(() => window.__interact.stats());
    await shot(`${slug}-zip-100-front`);
    await threeQuarter(`${slug}-zip-100-34`);
    if (!(r.mouseOpen.zipOpen >= 1))
      fail(`${slug}: mouse drag did not open the zip to the hem (${r.mouseOpen.zipOpen})`);
    if (!(r.mouseOpenStats.maxGapM > 0.01))
      fail(`${slug}: the fronts did not separate (${r.mouseOpenStats.maxGapM} m)`);
    // Half closed for the 50 % 3/4 shot, then closed.
    const pull2 = await page.evaluate(() => window.__interact.pullScreen());
    r.pullAtHem = pull2;
    r.hitAtHem = await page.evaluate((p) => window.__interact.hit(p)?.kind ?? null, pull2);
    log(
      `pull at hem ${JSON.stringify(pull2)} → px ${JSON.stringify(await px(pull2))}, hit ${r.hitAtHem}`,
    );
    const up1 = await trackPath(1, 0.5);
    up1[0] = pull2;
    await mouseDrag(up1);
    await page.mouse.up();
    await page.waitForTimeout(1500);
    r.mouseBackHalf = await state();
    log(`after dragging up to 50 %: ${JSON.stringify(r.mouseBackHalf)}`);
    await threeQuarter(`${slug}-zip-50-34`);
    const pull3 = await page.evaluate(() => window.__interact.pullScreen());
    const up2 = await trackPath(0.5, 0);
    up2[0] = pull3;
    up2.push({ x: up2[up2.length - 1].x, y: up2[up2.length - 1].y + 0.05 });
    await mouseDrag(up2);
    await page.mouse.up();
    r.mouseCloseRetries = await finishClosing('mouse');
    await waitClosed();
    r.mouseStats = await page.evaluate(() => window.__interact.stats());
    r.hashAfterMouseZip = await page.evaluate(() => window.__interact.shellHash());
    if (r.hashAfterMouseZip !== r.hashBefore)
      fail(`${slug}: shell changed after the mouse zip (${r.hashBefore} → ${r.hashAfterMouseZip})`);

    // ---- pinch: zip open and closed with the hand-pull handlers
    await page.evaluate(() => window.__interact.resetStats());
    const pp = await page.evaluate(() => window.__interact.pullScreen());
    const pinchDown = await trackPath(0, 1, 40);
    pinchDown[0] = pp;
    r.pinchBegan = await pinchDrag(pinchDown);
    await page.waitForTimeout(2000);
    r.pinchOpen = await state();
    if (r.pinchBegan !== 'pull')
      fail(`${slug}: pinch on the pull did not grab it (${r.pinchBegan})`);
    if (!(r.pinchOpen.zipOpen >= 1))
      fail(`${slug}: pinch did not open the zip (${r.pinchOpen.zipOpen})`);
    const pp2 = await page.evaluate(() => window.__interact.pullScreen());
    const pinchUp = await trackPath(1, 0, 40);
    pinchUp[0] = pp2;
    pinchUp.push({ x: pinchUp[pinchUp.length - 1].x, y: pinchUp[pinchUp.length - 1].y + 0.05 });
    await pinchDrag(pinchUp);
    r.pinchCloseRetries = await finishClosing('pinch');
    await waitClosed();
    r.pinchStats = await page.evaluate(() => window.__interact.stats());
    r.hashAfterPinchZip = await page.evaluate(() => window.__interact.shellHash());
    if (r.hashAfterPinchZip !== r.hashBefore) fail(`${slug}: shell changed after the pinch zip`);

    // ---- hood
    if (r.hasHood) {
      await page.evaluate(() => window.__interact.viewHood(true));
      await page.waitForTimeout(1200);
      await shot(`${slug}-hood-on`);
      await page.evaluate(() => window.__interact.resetStats());
      const h = await page.evaluate(() => window.__interact.hoodScreen());
      if (!h) throw new Error('hood not on screen');
      const away = [];
      for (let i = 0; i <= 30; i++)
        away.push({ x: h.x + 0.42 * (i / 30), y: h.y - 0.12 * (i / 30) });
      await mouseDrag(away.slice(0, 16));
      await page.waitForTimeout(800);
      r.hoodMid = await state();
      log(`hood mid-drag: ${JSON.stringify(r.hoodMid)}`);
      await shot(`${slug}-hood-mid`);
      for (const p of away.slice(16)) {
        const q = await px(p);
        await page.mouse.move(q.x, q.y, { steps: 2 });
        await page.waitForTimeout(40);
      }
      await page.waitForTimeout(800);
      await page.mouse.up();
      await page.waitForTimeout(1500);
      r.hoodOff = await state();
      log(`hood after release: ${JSON.stringify(r.hoodOff)}`);
      await shot(`${slug}-hood-off`);
      if (r.hoodOff.hood !== 'detached')
        fail(`${slug}: mouse pull did not take the hood off (${r.hoodOff.hood})`);
      // Bring it back: grab it where it hangs and drag to where it was grabbed when on.
      // The hood is held by its zip edge, which follows the hand rigidly: bring it back by the
      // way it went (the reverse screen drag), from wherever the hood hangs now.
      const h2 = await page.evaluate(() => window.__interact.hoodScreen());
      if (!h2) {
        r.hoodDebug = await page.evaluate(() => window.__interact.hoodDebug());
        log(`hood not found after set-down: ${JSON.stringify(r.hoodDebug)}`);
      }
      // Drag the hood onto the collar's zip track on screen (what a judge does).
      const e1 = await page.evaluate(() => window.__interact.hoodEdges());
      const dx = e1.collar.x - h2.x,
        dy = e1.collar.y - h2.y;
      const back = [];
      for (let i = 0; i <= 30; i++) back.push({ x: h2.x + dx * (i / 30), y: h2.y + dy * (i / 30) });
      await mouseDrag(back);
      // Correct like a person would: look again and nudge the edge onto the collar (≤ 4 times).
      let cursor = back[back.length - 1];
      for (let k = 0; k < 4; k++) {
        await page.waitForTimeout(500);
        const e = await page.evaluate(() => window.__interact.hoodEdges());
        if ((await state()).hoodProgress <= 0.3) break;
        cursor = { x: cursor.x + (e.collar.x - e.hood.x), y: cursor.y + (e.collar.y - e.hood.y) };
        const q = await px(cursor);
        await page.mouse.move(q.x, q.y, { steps: 8 });
      }
      r.hoodBackCorrections = (await state()).hoodProgress;
      await page.waitForTimeout(600);
      await page.mouse.up();
      await waitClosed(20000).catch(() => undefined);
      r.hoodBack = await state();
      r.hoodMouseStats = await page.evaluate(() => window.__interact.stats());
      if (r.hoodBack.hood !== 'attached')
        fail(`${slug}: mouse did not zip the hood back on (${r.hoodBack.hood})`);
      r.hashAfterMouseHood = await page.evaluate(() => window.__interact.shellHash());
      if (r.hashAfterMouseHood !== r.hashBefore)
        fail(`${slug}: shell changed after the hood (mouse)`);
      // Pinch: off and back on.
      const hp = await page.evaluate(() => window.__interact.hoodScreen());
      const pAway = [];
      for (let i = 0; i <= 40; i++)
        pAway.push({ x: hp.x + 0.42 * (i / 40), y: hp.y - 0.12 * (i / 40) });
      r.pinchHoodBegan = await pinchDrag(pAway);
      await page.waitForTimeout(1200);
      r.pinchHoodOff = await state();
      if (r.pinchHoodOff.hood !== 'detached')
        fail(`${slug}: pinch did not take the hood off (${r.pinchHoodOff.hood})`);
      const hp2 = await page.evaluate(() => window.__interact.hoodScreen());
      const e2 = await page.evaluate(() => window.__interact.hoodEdges());
      const pdx = e2.collar.x - hp2.x,
        pdy = e2.collar.y - hp2.y;
      const pBack = [];
      for (let i = 0; i <= 40; i++)
        pBack.push({ x: hp2.x + pdx * (i / 40), y: hp2.y + pdy * (i / 40) });
      await pinchDrag(pBack, false);
      let hand = pBack[pBack.length - 1];
      for (let k = 0; k < 4; k++) {
        await page.waitForTimeout(500);
        const e = await page.evaluate(() => window.__interact.hoodEdges());
        if ((await state()).hoodProgress <= 0.3) break;
        const next = { x: hand.x + (e.collar.x - e.hood.x), y: hand.y + (e.collar.y - e.hood.y) };
        const path = [];
        for (let i = 1; i <= 10; i++)
          path.push({
            x: hand.x + (next.x - hand.x) * (i / 10),
            y: hand.y + (next.y - hand.y) * (i / 10),
          });
        await page.evaluate(async (path) => {
          for (const p of path) {
            await new Promise((r) => setTimeout(r, 33));
            window.__handpull.sink.onPinch({
              type: 'move',
              hand: 'right',
              ndc: { x: p.x * 0.7, y: p.y * 0.7 },
              depthDelta: 0,
              frameTime: performance.now(),
              confidence: 1,
            });
          }
        }, path);
        hand = next;
      }
      await page.waitForTimeout(600);
      await pinchEnd(hand);
      await waitClosed(20000).catch(() => undefined);
      r.pinchHoodBack = await state();
      if (r.pinchHoodBack.hood !== 'attached')
        fail(`${slug}: pinch did not zip the hood back on (${r.pinchHoodBack.hood})`);
      r.hoodPinchStats = await page.evaluate(() => window.__interact.stats());
      r.hashAfterPinchHood = await page.evaluate(() => window.__interact.shellHash());
      if (r.hashAfterPinchHood !== r.hashBefore)
        fail(`${slug}: shell changed after the hood (pinch)`);
      // HOOD_DEFAULT 'off-resting' (the same call a session makes at its start): the hood
      // starts set down by the right foot; attach it by mouse.
      await page.evaluate(() => window.__interact.applyHoodDefault('off-resting'));
      await page.waitForTimeout(1500);
      r.defaultOff = await state();
      await shot(`${slug}-hood-default-off`, false);
      const hd = await page.evaluate(() => window.__interact.hoodScreen());
      if (!hd) fail(`${slug}: off-resting hood not on screen`);
      else {
        const ed = await page.evaluate(() => window.__interact.hoodEdges());
        const path = [];
        for (let i = 0; i <= 30; i++)
          path.push({
            x: hd.x + (ed.collar.x - hd.x) * (i / 30),
            y: hd.y + (ed.collar.y - hd.y) * (i / 30),
          });
        await mouseDrag(path);
        await page.waitForTimeout(800);
        await page.mouse.up();
        await waitClosed(20000).catch(() => undefined);
      }
      r.defaultOffBack = await state();
      r.hashAfterDefaultOff = await page.evaluate(() => window.__interact.shellHash());
      if (r.defaultOffBack.hood !== 'attached')
        fail(`${slug}: off-resting hood not zipped on by mouse (${r.defaultOffBack.hood})`);
      await page.evaluate(() => window.__interact.viewHood(false));
      await page.waitForTimeout(900);
    }
    // ---- gates
    for (const [name, s] of Object.entries({
      mouse: r.mouseStats,
      pinch: r.pinchStats,
      hoodMouse: r.hoodMouseStats,
      hoodPinch: r.hoodPinchStats,
    })) {
      if (!s) continue;
      if (s.fpsP50 < 0.9 * r.idleFps.p50)
        fail(
          `${slug} ${name}: fps p50 ${s.fpsP50.toFixed(0)} < 90 % of idle ${r.idleFps.p50.toFixed(0)}`,
        );
      if (s.latencySamples && s.latencyP95 > 100)
        fail(`${slug} ${name}: latency p95 ${s.latencyP95.toFixed(0)} ms > 100`);
    }
    log(
      `${slug}: idle fps ${r.idleFps.p50.toFixed(0)}; mouse zip fps ${r.mouseStats.fpsP50.toFixed(0)} latency p95 ${r.mouseStats.latencyP95.toFixed(0)} ms step p50 ${r.mouseStats.stepP50.toFixed(1)} ms; gap ${(r.mouseOpenStats.maxGapM * 100).toFixed(1)} cm`,
    );
  }
} catch (error) {
  exitCode = 1;
  report.fatal = String(error?.stack ?? error);
  log(`FATAL ${report.fatal}`);
  try {
    await page.screenshot({ path: join(root, '.cache/interact/fatal.png') });
  } catch {
    /* ignore */
  }
} finally {
  if (errors.length) exitCode = 1;
  if (nonLoopback.length) exitCode = 1;
  // The 8 interaction scenarios (per jacket and input), each pass/fail from the checks above.
  const checks = [];
  for (const j of report.jackets) {
    const same = (h) => h !== undefined && h === j.hashBefore;
    checks.push({
      name: `${j.slug} zip, mouse`,
      pass:
        j.mouseOpen?.zipOpen >= 1 && j.mouseOpenStats?.maxGapM > 0.01 && same(j.hashAfterMouseZip),
    });
    checks.push({
      name: `${j.slug} zip, pinch`,
      pass: j.pinchBegan === 'pull' && j.pinchOpen?.zipOpen >= 1 && same(j.hashAfterPinchZip),
    });
    if (j.hasHood) {
      checks.push({ name: `${j.slug} hood off, mouse`, pass: j.hoodOff?.hood === 'detached' });
      checks.push({
        name: `${j.slug} hood on, mouse`,
        pass: j.hoodBack?.hood === 'attached' && same(j.hashAfterMouseHood),
      });
      checks.push({ name: `${j.slug} hood off, pinch`, pass: j.pinchHoodOff?.hood === 'detached' });
      checks.push({
        name: `${j.slug} hood on, pinch`,
        pass: j.pinchHoodBack?.hood === 'attached' && same(j.hashAfterPinchHood),
      });
      checks.push({
        name: `${j.slug} hood default off-resting, attach by mouse`,
        pass:
          j.defaultOff?.hood === 'detached' &&
          j.defaultOff?.hooked === true &&
          j.defaultOffBack?.hood === 'attached' &&
          same(j.hashAfterDefaultOff),
      });
    }
  }
  report.scenarios = checks;
  report.scenariosPassed = `${checks.filter((c) => c.pass).length}/${checks.length}`;
  if (checks.some((c) => !c.pass)) exitCode = 1;
  log(
    `scenarios ${report.scenariosPassed}: ${checks.map((c) => `${c.name} ${c.pass ? 'PASS' : 'FAIL'}`).join('; ')}`,
  );
  report.finishedAt = new Date().toISOString();
  report.passed = exitCode === 0;
  writeFileSync(join(outDir, `${outName}.json`), JSON.stringify(report, null, 2));
  await context.close();
  server?.close();
  log(
    `${report.passed ? 'PASSED' : 'FAILED'}; errors ${errors.length}; report docs/validation/${outName}.json`,
  );
  process.exit(exitCode);
}
