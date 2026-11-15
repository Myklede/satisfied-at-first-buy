// Prompt 04 Part E soak test: N consecutive judge cycles in installed Chrome with Chrome's
// fake camera (synthetic pattern, no person → the scan never passes and is skipped).
//   node scripts/kiosk-soak.mjs [--cycles 20] [--port 5720] [--api-port 8011] [--screenshots]
//     [--watchdog [--kill-cycle N]] [--cycle-shots] [--out kiosk-<name>.json]
// Starts `scripts/kiosk.mjs --no-browser` itself unless --attach (kiosk already running).
// Asserts: no console errors, no non-loopback requests, JS heap / renderer.info / service RAM
// stable, both jackets on the bodies at the result ("dressed"), the service in kiosk privacy
// mode (Fit Agent: no stored profile). Writes docs/validation/kiosk-soak.json and, with
// --screenshots, kiosk-*.png. --cycle-shots: one result-screen JPEG per cycle in
// .cache/kiosk-soak-shots/ (gitignored) for visual inspection.
// --watchdog (prompt 06 D): in cycle --kill-cycle (default: the middle one) the service is
// killed while both jackets are dressing; the kiosk must show "Reconnecting…" with no result
// screen and no per-jacket error, the launcher must restart the service, the old asset
// workers must exit, and the kiosk must return to attract; the remaining cycles continue.
// --motion-cycles N [--dwell S] [--no-motion-queue] (agent E2): in the first N cycles, wait S
// seconds on the result screen (default 60), then open Try moves on the first jacket and click
// each motion button in turn (4 s of viewing between clicks), recording the ready-after-click
// time of every motion, whether its button already said "ready", and the background queue state.
// --no-motion-queue (kiosk URL ?nomotionqueue) disables the background queue: the "before"
// baseline (only the first motion of the first jacket is pre-baked, as before E2).
// Chrome runs with background/occlusion throttling disabled so a covered or unfocused soak
// window cannot slow timers, camera frames or morphs (prompt 06 D; seen during C).
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
// SATISFY_KIOSK_EXTRA_QUERY (e.g. '&aa=smaa'): extra kiosk URL flags for A/B runs; validated.
const extraQuery = process.env.SATISFY_KIOSK_EXTRA_QUERY ?? '';
if (!/^(&[a-z0-9_]+(=[a-z0-9_]+)?)*$/i.test(extraQuery))
  throw new Error('SATISFY_KIOSK_EXTRA_QUERY must look like &flag or &key=value');

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const cycles = opt('--cycles', 20);
const port = opt('--port', 5720);
const apiPort = opt('--api-port', 8011);
const shots = args.includes('--screenshots');
const cycleShots = args.includes('--cycle-shots');
const motionCycles = opt('--motion-cycles', 0);
const dwellS = opt('--dwell', 60);
// Contract motion ids in button order (apps/web/src/engine/motion/config.ts MOTION_IDS).
const MOTION_IDS = [
  'reach_up_both',
  'reach_up_one',
  'reach_forward',
  'sit',
  'bend_tie_shoes',
  'cross_arms',
];
const noMotionQueue = args.includes('--no-motion-queue');
const watchdogMode = args.includes('--watchdog') && process.platform === 'win32';
const killCycle = watchdogMode ? opt('--kill-cycle', Math.ceil(cycles / 2)) : 0;
const shotDir = join(root, '.cache/kiosk-soak-shots');
if (cycleShots) mkdirSync(shotDir, { recursive: true });
const outDir = join(root, 'docs/validation');
mkdirSync(outDir, { recursive: true });
const log = (m) => console.log(`[soak] ${m}`);

let kiosk;
if (!args.includes('--attach')) {
  kiosk = spawn(
    process.execPath,
    [
      join(root, 'scripts/kiosk.mjs'),
      '--no-browser',
      '--port',
      String(port),
      '--api-port',
      String(apiPort),
    ],
    { cwd: root, stdio: 'inherit', env: { ...process.env, SATISFY_KIOSK_DRY_OPEN: '1' } },
  );
}
const stopKiosk = () => {
  if (kiosk?.pid && kiosk.exitCode === null)
    spawnSync('taskkill', ['/pid', String(kiosk.pid), '/t', '/f'], { stdio: 'ignore' });
};
process.on('exit', stopKiosk);

const base = `http://127.0.0.1:${port}`;
for (let i = 0; ; i++) {
  try {
    const r = await fetch(`${base}/api/health`);
    if (r.ok && (await r.json()).model_loaded) break;
  } catch {
    /* not up yet */
  }
  if (i > 600) throw new Error('kiosk did not become healthy');
  await new Promise((r) => setTimeout(r, 1000));
}

/** PID of the process listening on the soak's API port (Windows netstat). */
function apiPid() {
  const net = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout ?? '';
  const line = net
    .split('\n')
    .find((l) => l.includes(`127.0.0.1:${apiPort} `) && l.includes('LISTENING'));
  const pid = Number(line?.trim().split(/\s+/).pop());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}
/** Direct child PIDs (the service's asset workers). */
function childPids(pid) {
  const text = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${Number(pid)}' | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`,
    ],
    { encoding: 'utf8' },
  ).stdout.trim();
  const parsed = text ? JSON.parse(text) : [];
  return Array.isArray(parsed) ? parsed : [parsed];
}
function alivePids(pids) {
  if (!pids.length) return [];
  const out = spawnSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8' }).stdout ?? '';
  const alive = new Set(out.split('\n').map((l) => Number(l.split('","')[1])));
  return pids.filter((pid) => alive.has(pid));
}
/**
 * Prompt 06 F4: the kiosk's service runs with SATISFY_KIOSK_MODE=1, so the Fit Agent never
 * stores (or reads) a body profile. Node sends no Origin header, like the agent's local tests.
 */
async function agentProfile() {
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/agent/profile`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json();
    const result = {
      status: response.status,
      kioskMode: data.kiosk_mode === true,
      saved: data.saved === true,
      profileReturned: data.profile !== null && data.profile !== undefined,
    };
    const ok =
      result.status === 200 && result.kioskMode && !result.saved && !result.profileReturned;
    return { ...result, ok };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}
const profileChecks = [];
const checkProfile = async (when) => {
  const result = { when, ...(await agentProfile()) };
  profileChecks.push(result);
  log(`agent profile (${when}): ${JSON.stringify(result)}`);
};

/** Service RSS via the OS (Windows: tasklist for the python listening on apiPort). */
function serviceRssMb() {
  if (process.platform !== 'win32') return null;
  const pid = apiPid();
  if (!pid) return null;
  const out = spawnSync('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
  }).stdout;
  const kb = Number(out?.split('","')[4]?.replace(/[^0-9]/g, ''));
  return Number.isFinite(kb) ? Math.round(kb / 1024) : null;
}

/** Working set (MB) of every chrome.exe of this soak's own profile (renderer, GPU, workers live in them). */
function chromeRssMb() {
  if (process.platform !== 'win32') return null;
  const out = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*playwright*kiosk-soak*' } | Measure-Object -Property WorkingSetSize -Sum).Sum",
    ],
    { encoding: 'utf8' },
  ).stdout;
  const bytes = Number(out?.trim());
  return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1048576) : null;
}

const profile = join(root, '.cache/playwright/kiosk-soak');
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: 1,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--force_high_performance_gpu',
    '--enable-precise-memory-info',
    // A covered/unfocused soak window must not be throttled (1 Hz timers, slowed camera
    // frames and morphs were seen during prompt 06 C). Per-cycle visibility is recorded too.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    // Those flags keep the page "visible" but cannot give a minimized window frames: Windows
    // sends it no vsync and rAF/camera frames drop to ~1 Hz (the 06 C/D throttled samples were
    // a minimized soak window). By default the window sits off-screen, out of the operator's
    // way, and is restored if it is ever minimized; --onscreen shows it at the origin.
    ...(args.includes('--onscreen') ? [] : ['--window-position=-2400,0']),
    // Same loopback-only DNS rule as the kiosk window (scripts/kiosk.mjs).
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
  ],
});
// Every non-loopback request is aborted here AND recorded. The only known source is
// @mediapipe/tasks-vision's built-in usage logger (no opt-out); it is reported separately.
const MEDIAPIPE_LOG = 'https://odml.pa.googleapis.com/v1/log';
const external = [];
await context.route('**/*', (route) => {
  const url = new URL(route.request().url());
  if (
    ['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.protocol === 'data:' ||
    url.protocol === 'blob:'
  )
    return route.continue();
  external.push(url.href);
  return route.abort('blockedbyclient');
});
const page = context.pages()[0] ?? (await context.newPage());
const cdp = await context.newCDPSession(page);
const { windowId } = await cdp.send('Browser.getWindowForTarget');
/** The OS window state; a minimized window is restored (it is off-screen, nobody sees it). */
async function windowState() {
  const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
  if (bounds.windowState === 'minimized')
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  return bounds.windowState;
}
// Outage observations survive the kiosk's own reload (exposed binding, not page state).
const seenDuringOutage = [];
await page.exposeFunction('__soakSaw', (what) => {
  if (!seenDuringOutage.some((x) => x.what === what))
    seenDuringOutage.push({ what, at: performance.now() });
});
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

const screen = (name, timeout = 120000) =>
  page.waitForSelector(`[data-screen="${name}"]`, { timeout });
const snap = async (name) => {
  if (shots) await page.screenshot({ path: join(outDir, `kiosk-${name}.png`) });
};
const sample = async () => {
  const s = await page.evaluate(() => {
    const k = window.__kiosk;
    return k ? { ...k.stats(), diagnostics: k.diagnostics } : null;
  });
  return s;
};

/**
 * Prompt 06 D: kill the service while both jackets are dressing, then verify the reconnect
 * path (no result screen, no per-jacket error), worker cleanup, restart and recovery.
 * The service PID and its workers are looked up before the judge presses Skip, so nothing
 * slow sits between "body on screen, jackets dressing" and the kill.
 */
async function killMidCycle(pid, oldWorkers) {
  await page.evaluate(() => {
    const report = (what) => window.__soakSaw?.(what);
    const check = () => {
      if (document.querySelector('[data-screen="result"]')) report('result screen');
      if (/3D drape is unavailable/.test(document.body.textContent ?? ''))
        report('per-jacket drape error');
      if (document.querySelector('[role="alert"]')) report('reconnecting overlay');
    };
    new MutationObserver(check).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  // The judge's body is on screen and the jackets are being dressed. Interval polling: rAF
  // polling would add up to a frame interval of latency.
  await page.waitForFunction(
    () =>
      window.__kiosk?.diagnostics.bodyVisibleMs !== undefined ||
      window.__kiosk?.screen === 'result',
    null,
    { timeout: 120000, polling: 10 },
  );
  const firstOutageError = errors.length;
  const killedAt = performance.now();
  spawnSync('taskkill', ['/pid', String(pid), '/f'], { stdio: 'ignore' });
  const atKill = await page.evaluate(() => ({
    screen: window.__kiosk?.screen ?? null,
    jacketsOnScreen: (window.__kiosk?.stats().garmentVertices ?? []).filter((n) => n > 0).length,
  }));
  await page.getByText('Reconnecting…').waitFor({ timeout: 30000 });
  const reconnectingShownMs = Math.round(performance.now() - killedAt);
  // Let any failing jacket request land, then capture what the judge sees.
  await page.waitForTimeout(3000);
  const screenDuringOutage = await page.evaluate(() => window.__kiosk?.screen ?? null);
  await page.screenshot({ path: join(outDir, 'kiosk-watchdog-reconnecting.png') });
  await page.waitForFunction(() => !document.querySelector('[role="alert"]'), null, {
    timeout: 300000,
  });
  await screen('attract', 300000);
  const recoveredAt = performance.now();
  outages.push([firstOutageError, errors.length]);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(outDir, 'kiosk-watchdog-recovered.png') });
  await checkProfile('after watchdog restart');
  const newPid = apiPid();
  const stillAlive = alivePids(oldWorkers).length;
  const saw = seenDuringOutage
    .filter((x) => x.at >= killedAt && x.at <= recoveredAt)
    .map((x) => x.what);
  // Only a kill that lands before both jackets are on screen exercises the dressing path.
  const whileDressing = atKill.screen === 'fitting' && atKill.jacketsOnScreen < 2;
  const result = {
    screenAtKill: atKill.screen,
    jacketsOnScreenAtKill: atKill.jacketsOnScreen,
    whileDressing,
    screenDuringOutage,
    killedPid: pid,
    newApiPid: newPid,
    oldWorkers: oldWorkers.length,
    oldWorkersStillAlive: stillAlive,
    reconnectingShownMs,
    backAtAttractMs: Math.round(recoveredAt - killedAt),
    sawDuringOutage: saw,
    // Pass: the service died while dressing and the judge saw only "Reconnecting…".
    ok:
      whileDressing &&
      screenDuringOutage === 'fitting' &&
      !saw.includes('result screen') &&
      !saw.includes('per-jacket drape error') &&
      newPid !== null &&
      newPid !== pid &&
      stillAlive === 0,
  };
  log(`watchdog ${JSON.stringify(result)}`);
  return result;
}

const results = [];
const killAttempts = []; // a kill that lands after dressing finished is retried next cycle
let nextKill = killCycle;
const outages = []; // [first, last) error indices of each deliberate outage
const t0 = performance.now();
await checkProfile('start');
await page.goto(`${base}/?kiosk${noMotionQueue ? '&nomotionqueue' : ''}${extraQuery}`);
await page.bringToFront();
await screen('attract', 180000);
if (shots) {
  // The attract jacket while it is still settling: the arms must already be in the sleeves.
  await page
    .waitForFunction(() => document.querySelector('.k-canvas canvas'), null, { timeout: 30000 })
    .catch(() => undefined);
  await page.waitForTimeout(1500);
  await snap('attract-early');
}
const first = await sample();
log(`warm-up ${first?.diagnostics.warmupMs} ms, gpu ${first?.diagnostics.gpu}`);
if (shots) {
  // Wait for the attract jacket to settle (background), then let the turntable move a bit.
  await page
    .waitForFunction(() => window.__kiosk?.diagnostics.attractDressedMs !== undefined, null, {
      timeout: 180000,
    })
    .catch(() => log('attract jacket did not settle within 180 s'));
  await page.waitForTimeout(2000);
  await snap('attract');
}

for (let cycle = 1; cycle <= cycles; cycle++) {
  const started = performance.now();
  const windowAtStart = await windowState();
  await page.keyboard.press('Space');
  await screen('you');
  if (cycle % 2) {
    await page.getByRole('button', { name: 'ft · lb' }).click();
    await page.getByLabel('Height feet').fill('5');
    await page.getByLabel('Height inches').fill(String(5 + (cycle % 7)));
    await page.getByLabel('Weight pounds').fill(String(130 + cycle * 3));
  } else {
    await page.getByRole('button', { name: 'cm · kg' }).click();
    await page.getByLabel('Height centimetres').fill(String(160 + cycle));
    await page.getByLabel('Weight kilograms').fill(String(55 + cycle));
  }
  // Prompt 06 F1: no default body shape; Continue stays disabled until one is picked.
  const continueButton = page.getByRole('button', { name: 'Continue →' });
  const noDefaultSex = {
    continueDisabled: await continueButton.isDisabled(),
    hint: await page.getByText('Pick a body shape to continue.').isVisible(),
    pressed: await page.locator('[aria-label="Body shape"] [aria-pressed="true"]').count(),
  };
  if (!noDefaultSex.continueDisabled || !noDefaultSex.hint || noDefaultSex.pressed)
    throw new Error(`cycle ${cycle}: a body shape was preselected ${JSON.stringify(noDefaultSex)}`);
  if (shots && cycle === 1) await snap('you-no-sex');
  await page.getByRole('button', { name: cycle % 3 ? 'Male' : 'Female', exact: true }).click();
  if (await continueButton.isDisabled()) throw new Error(`cycle ${cycle}: Continue still disabled`);
  if (shots && cycle === 1) await snap('you');
  await page.getByRole('button', { name: 'Continue →' }).click();
  const youContinue = performance.now();
  await screen('scan');
  // Fake camera shows no person: wait a little for guidance, then skip (graceful path).
  await page.waitForTimeout(cycle === 1 ? 6000 : 2500);
  if (shots && cycle === 1) await snap('scan');
  const scanStats = await page.evaluate(() => window.__kiosk?.diagnostics.scan ?? null);
  // Watchdog cycle: look up the service and its workers before Skip, not between body and kill.
  const killPid = cycle === nextKill ? apiPid() : null;
  const killWorkers = killPid ? childPids(killPid) : [];
  if (cycle === nextKill && !killPid) throw new Error('watchdog: no service on the soak API port');
  await page.getByRole('button', { name: /Skip scan|Continue without scan|Continue →/ }).click();
  const fitClick = performance.now();
  await screen('fitting');
  if (cycle === nextKill) {
    const attempt = { cycle, ...(await killMidCycle(killPid, killWorkers)) };
    killAttempts.push(attempt);
    if (!attempt.whileDressing && killAttempts.length < 3) nextKill = cycle + 1;
    results.push({ cycle, interrupted: 'watchdog kill' });
    continue;
  }
  if (shots && cycle === 1) {
    await snap('fitting');
    await page.waitForSelector('.k-stage:not([hidden])', { timeout: 60000 });
    await page.waitForTimeout(1500);
    await snap('fitting-body');
  }
  await screen('result', 240000);
  const resultAt = performance.now();
  // Both jackets on the bodies, before the money-shot camera move (2.5 s after result).
  await page.waitForTimeout(1500);
  const dressedAt = await page.evaluate(() => ({
    vertices: window.__kiosk?.stats().garmentVertices ?? [],
    errors: (window.__kiosk?.jackets ?? []).map((j) => j.error ?? null),
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    fps: window.__kiosk?.stats().fps ?? [],
  }));
  const windowAtResult = await windowState();
  const dressed =
    dressedAt.vertices.length === 2 &&
    dressedAt.vertices.every((n) => n > 0) &&
    dressedAt.errors.every((e) => e === null);
  if (cycleShots)
    await page.screenshot({
      path: join(shotDir, `cycle-${String(cycle).padStart(2, '0')}.jpg`),
      type: 'jpeg',
      quality: 70,
      clip: { x: 0, y: 0, width: 1600, height: 450 },
    });
  await page.waitForTimeout(2000); // money shot camera move
  if (shots && cycle === 1) await snap('result-xray');
  // Size switch on the first jacket: to the contrast size and back (cached after precompute).
  const sizeButtons = page.locator('.k-card').first().locator('.k-sizes button');
  const count = await sizeButtons.count();
  if (count > 1) {
    const pressed = await sizeButtons.evaluateAll((b) =>
      b.findIndex((x) => x.getAttribute('aria-pressed') === 'true'),
    );
    const other = pressed === 0 ? 1 : pressed - 1;
    await sizeButtons.nth(other).click();
    await page.waitForFunction(
      () => !document.querySelector('.k-card .k-sizes button:disabled'),
      null,
      { timeout: 60000 },
    );
    // Back to the recommended size: its settled cloth is in the engine cache (cached switch).
    await sizeButtons.nth(pressed).click();
    await page.waitForFunction(
      () => !document.querySelector('.k-card .k-sizes button:disabled'),
      null,
      { timeout: 60000 },
    );
  }
  if (cycle === 1) {
    await page.locator('.k-shop').first().click();
    await page.waitForTimeout(500);
  }
  // Fit in motion from the result (cycle 1): judge's body, recommended vs contrast size.
  let motion = null;
  let motionSweep = null;
  if (cycle <= motionCycles) {
    // The judge reads the result for a while, then tries every motion in button order.
    const queueBefore = await page.evaluate(() => window.__kiosk?.motion() ?? null);
    const chromeMbBefore = chromeRssMb();
    // The judge is present (the kiosk resets itself after 90 s without input): small mouse moves.
    for (let waited = 0; waited < dwellS; waited += 20) {
      await page.mouse.move(700 + (waited % 40), 300);
      await page.waitForTimeout(Math.min(20, dwellS - waited) * 1000);
    }
    const queueAtOpen = await page.evaluate(() => window.__kiosk?.motion() ?? null);
    const fpsAtOpen = await page.evaluate(() => window.__kiosk?.stats().fps ?? []);
    await page.locator('.k-moves').first().click();
    await page.waitForSelector('.motion-actions button');
    const labels = await page.locator('.motion-actions button').count();
    motionSweep = {
      dwellS,
      chromeMbBefore,
      chromeMbAtOpen: chromeRssMb(),
      queueBefore,
      queueAtOpen,
      fpsAtOpen,
      motions: [],
    };
    for (let i = 0; i < labels; i++) {
      const button = page.locator('.motion-actions button').nth(i);
      const wasReady = (await button.getAttribute('data-ready')) === 'true';
      const name = (await button.innerText()).replace(/\s*ready\s*$/i, '').trim();
      const clicked = performance.now();
      await button.click();
      const id = MOTION_IDS[i];
      const ok = await page
        .waitForFunction(
          (m) => {
            const st = window.__satisfyMotion?.state();
            return st?.motion === m && st.ready === true;
          },
          id,
          { timeout: 240000, polling: 20 },
        )
        .then(() => true)
        .catch(() => false);
      const readyMs = Math.round(performance.now() - clicked);
      const queue = await page.evaluate(() => window.__kiosk?.motion() ?? null);
      motionSweep.motions.push({
        index: i,
        id,
        name,
        wasReadyAtClick: wasReady,
        ok,
        readyAfterClickMs: readyMs,
        queuePending: queue?.pending,
        queueRunning: queue?.running,
      });
      log(
        `motion ${name}: ${wasReady ? 'ready at click' : 'baked on click'}, ${readyMs} ms${ok ? '' : ' (TIMEOUT)'}`,
      );
      await page.waitForTimeout(4000);
    }
    motionSweep.chromeMbAfter = chromeRssMb();
    motionSweep.queueAfter = await page.evaluate(() => window.__kiosk?.motion() ?? null);
    await page.getByRole('button', { name: 'Close' }).click();
  } else if (cycle === 1) {
    const clicked = performance.now();
    await page.locator('.k-moves').first().click();
    await page
      .waitForFunction(() => window.__satisfyMotion?.state().ready === true, null, {
        timeout: 180000,
      })
      .catch(() => log('fit in motion not ready within 180 s'));
    const state = await page.evaluate(() => window.__satisfyMotion?.state() ?? null);
    motion = {
      readyAfterClickMs: Math.round(performance.now() - clicked),
      state,
      indicativeNote: await page.evaluate(() =>
        /indicative/.test(document.querySelector('.motion-studio')?.textContent ?? ''),
      ),
    };
    log(`fit in motion ${JSON.stringify(motion)}`);
    await page.waitForTimeout(1500);
    await snap('motion');
    await page.getByRole('button', { name: 'Close' }).click();
  }
  await page.getByRole('button', { name: /Try it on/ }).click();
  await screen('tryon');
  if (shots && cycle === 1) await snap('tryon');
  await page.keyboard.press('Control+Shift+B');
  await screen('board');
  if (shots && cycle === 1) await snap('board');
  if (shots && cycle === 1) {
    await page.keyboard.press('Control+Shift+D');
    await page.waitForTimeout(800);
    await snap('diagnostics');
    await page.keyboard.press('Control+Shift+D');
  }
  const stats = await sample();
  const settledAtBoard = await page.evaluate(() =>
    (window.__kiosk?.jackets ?? []).map((j) => j.settled),
  );
  // Reset via the operator key (cycles alternate with the Start over button).
  if (cycle % 2) await page.keyboard.press('Control+Shift+R');
  else await page.getByRole('button', { name: 'Start over' }).click();
  await screen('attract', 180000);
  const after = await sample();
  const record = {
    cycle,
    cycleMs: Math.round(performance.now() - started),
    // Scan "Skip" → result screen; "Continue" on the You screen → result (includes the scan).
    continueToResultMs: Math.round(resultAt - fitClick),
    youContinueToResultMs: Math.round(resultAt - youContinue),
    resultAfterFitStartMs: stats?.diagnostics.resultMs,
    visibleAfterBodyMs: stats?.diagnostics.visibleMs,
    scanInferenceHz: scanStats?.inferenceHz ?? null,
    scanDelegate: scanStats?.delegate ?? null,
    scanCameraFps: scanStats?.cameraFps ?? null,
    scanVisible: scanStats ? scanStats.visibility === 'visible' && scanStats.focused : null,
    dressed,
    garmentVertices: dressedAt.vertices,
    jacketErrors: dressedAt.errors.filter(Boolean),
    resultVisible: dressedAt.visibility === 'visible' && dressedAt.focused,
    windowStates: [windowAtStart, windowAtResult],
    fpsAtResult: dressedAt.fps,
    settledAtBoard,
    fitWallMs: stats?.diagnostics.fitWallMs,
    bodyVisibleMs: stats?.diagnostics.bodyVisibleMs,
    settleAfterBodyMs: stats?.diagnostics.settleMs,
    // Prompt 09 B4: phases of the recommended dress (asset / geometry / morph / shown) per jacket,
    // and the opt-in request timings (SATISFY_TIMINGS=1 service + &timings kiosk URL).
    recommendedDressPhases: stats?.diagnostics.recommendedDressPhases,
    requestTimings: await page.evaluate(() => window.__SATISFY_TIMINGS__ ?? null),
    sizeSwitchMs: stats?.diagnostics.sizeSwitchMs,
    heapMbInSession: stats?.heapBytes ? +(stats.heapBytes / 1e6).toFixed(1) : null,
    heapMbAfterReset: after?.heapBytes ? +(after.heapBytes / 1e6).toFixed(1) : null,
    renderInSession: stats?.views,
    renderAfterReset: after?.views,
    fpsInSession: stats?.fps,
    fpsAfterReset: after?.fps,
    visibilityAfterReset: await page.evaluate(() => ({
      state: document.visibilityState,
      focused: document.hasFocus(),
    })),
    warmupAfterResetMs: after?.diagnostics.warmupMs,
    serviceRssMb: serviceRssMb(),
    errors: errors.length,
    ...(motion ? { motion } : {}),
    ...(motionSweep ? { motionSweep } : {}),
    motionQueueAtBoard: stats ? await page.evaluate(() => window.__kiosk?.motion() ?? null) : null,
  };
  results.push(record);
  log(JSON.stringify(record));
}

const watchdog = watchdogMode
  ? { killCycle, attempts: killAttempts, ok: killAttempts.some((a) => a.ok) }
  : null;
const fpsSample = await page.evaluate(async () => {
  // Attract screen render rate over 3 s, read from the viewer's own counter.
  await new Promise((r) => setTimeout(r, 4500));
  return window.__kiosk?.stats().fps ?? [];
});
await checkProfile('end');
await context.close();
stopKiosk();

const otherExternal = external.filter((u) => u !== MEDIAPIPE_LOG);
const blockedNoise = /Failed to load resource: net::ERR_BLOCKED_BY_CLIENT/;
// During the deliberate --watchdog outage, the proxy's 502/503 answers (dead service) and 404s
// (the restarted service no longer knows the judge's body) are expected.
const outageNoise = /status of (502|503|404) |net::ERR_(CONNECTION|EMPTY_RESPONSE)|Failed to fetch/;
const inOutage = (i) => outages.some(([a, b]) => i >= a && i < b);
const otherErrors = errors.filter(
  (e, i) => !blockedNoise.test(e) && !(inOutage(i) && outageNoise.test(e)),
);
const completed = results.filter((r) => !r.interrupted);
const first3 = completed.slice(0, 3);
const last3 = completed.slice(-3);
const quantiles = (values) => {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const at = (q) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
  return v.length ? { min: v[0], median: at(0.5), max: v[v.length - 1] } : null;
};
const mean = (rows, key) => rows.reduce((s, r) => s + (r[key] ?? 0), 0) / Math.max(1, rows.length);
const summary = {
  date: new Date().toISOString().slice(0, 10),
  cycles: results.length,
  totalMinutes: +((performance.now() - t0) / 60000).toFixed(1),
  gpu: first?.diagnostics.gpu,
  initialWarmupMs: first?.diagnostics.warmupMs,
  attractFps: fpsSample,
  chromeThrottlingDisabled: true,
  dressedCycles: completed.filter((r) => r.dressed).length,
  completedCycles: completed.length,
  notDressed: completed.filter((r) => !r.dressed).map((r) => r.cycle),
  unthrottled: {
    resultVisibleAndFocused: completed.filter((r) => r.resultVisible).length,
    windowNeverMinimized: completed.filter((r) => !r.windowStates.includes('minimized')).length,
    fpsAtResult: quantiles(completed.flatMap((r) => r.fpsAtResult)),
    scanVisibleAndFocused: completed.filter((r) => r.scanVisible).length,
    scanCameraFps: quantiles(completed.map((r) => r.scanCameraFps)),
  },
  agentProfileChecks: profileChecks,
  watchdog,
  // A blocked request also logs one "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT".
  consoleErrors: errors,
  consoleErrorsOtherThanBlockedRequests: otherErrors,
  nonLoopbackRequestsAttemptedAndBlocked: external.length,
  mediapipeUsageLogAttemptsBlocked: external.filter((u) => u === MEDIAPIPE_LOG).length,
  otherNonLoopbackRequests: otherExternal,
  heapMbAfterReset: {
    first3: +mean(first3, 'heapMbAfterReset').toFixed(1),
    last3: +mean(last3, 'heapMbAfterReset').toFixed(1),
  },
  heapMbInSession: {
    first3: +mean(first3, 'heapMbInSession').toFixed(1),
    last3: +mean(last3, 'heapMbInSession').toFixed(1),
  },
  serviceRssMb: {
    first3: +mean(first3, 'serviceRssMb').toFixed(0),
    last3: +mean(last3, 'serviceRssMb').toFixed(0),
  },
  continueToResultMs: quantiles(completed.map((r) => r.continueToResultMs)),
  youContinueToResultMs: quantiles(completed.map((r) => r.youContinueToResultMs)),
  results,
};
const outName = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'kiosk-soak.json';
if (!/^kiosk-[a-z0-9-]+\.json$/.test(outName)) throw new Error('--out must be kiosk-<name>.json');
writeFileSync(join(outDir, outName), JSON.stringify(summary, null, 1));
log(
  `done: ${results.length} cycles; console errors ${otherErrors.length} (+${errors.length - otherErrors.length} from blocked requests); ` +
    `non-loopback attempts ${external.length} (all blocked; MediaPipe usage log ${external.length - otherExternal.length}, other ${otherExternal.length})`,
);
log(
  `heap after reset ${summary.heapMbAfterReset.first3} → ${summary.heapMbAfterReset.last3} MB; service RSS ${summary.serviceRssMb.first3} → ${summary.serviceRssMb.last3} MB`,
);
// Fail on any real console error or any non-loopback request other than the known,
// blocked MediaPipe usage log (reported in the JSON either way).
const profileOk = profileChecks.every((c) => c.ok);
log(
  `dressed ${summary.dressedCycles}/${summary.completedCycles}; agent profile ${profileOk ? 'ok' : 'FAILED'}` +
    (watchdog ? `; watchdog ${watchdog.ok ? 'ok' : 'FAILED'}` : ''),
);
if (
  otherErrors.length ||
  otherExternal.length ||
  summary.dressedCycles !== summary.completedCycles ||
  !profileOk ||
  (watchdogMode && !watchdog?.ok)
)
  process.exitCode = 1;
