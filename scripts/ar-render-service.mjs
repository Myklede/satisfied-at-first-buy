// F6 warm render service (AR team, 2026-11-14): ONE Vite dev server + ONE persistent Chrome that
// serve short AR lab render jobs from a file queue, so agents stop paying a cold start per job.
//   node --max-old-space-size=6144 scripts/ar-render-service.mjs [--look-parallel 1|2] [--headed]
// Client: scripts/ar-job.mjs. How-to: docs/requests/render-service.md.
// - Holds .cache/locks/browser (owner "F6 render service") for its whole life, so legacy scripts
//   still serialise against it; `ar-job.mjs timing-begin` makes it close Chrome, release the lock
//   and pause until `timing-end` (or the pause expires), for exclusive timing runs elsewhere.
// - look lane: short visual jobs (window <= 12 s), never takes heavy, may run beside CPU analysis.
//   timing lane: runs alone (look lane drained) and also holds .cache/locks/heavy. Only timing-lane
//   numbers are timing evidence; every result.json says which lane produced it.
// - Freshness: Vite watches the working tree (HMR off, so no page reloads under a job) and the
//   service also invalidates the whole module graph whenever HEAD / the dirty set / dirty mtimes
//   change, so every navigation serves the current source. result.json records HEAD and dirt.
// Loopback only; all outputs under .cache/lead/service (gitignored). Pixels never leave .cache.
import { execFileSync, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer as netServer } from 'node:net';
import { freemem, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireBrowserSlot } from './lookdev/browser-slot.mjs';
import { installRestProbe } from './ar-eval-rest.mjs';
import { validateJob, clipPath, SERVICE_DIR, LOOK_MAX_WINDOW_S } from './ar-job.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SVC = SERVICE_DIR(ROOT);
const D = {
  jobs: join(SVC, 'jobs'),
  running: join(SVC, 'running'),
  done: join(SVC, 'done'),
  out: join(SVC, 'out'),
  control: join(SVC, 'control'),
};
for (const d of Object.values(D)) mkdirSync(d, { recursive: true });
const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(n);
  return i < 0 ? d : args[i + 1];
};
const has = (n) => args.includes(n);
const OWNER = 'F6 render service';
const LOCKS = join(ROOT, '.cache/locks');
let lookParallel = Math.min(2, Math.max(1, Number(arg('--look-parallel', '1'))));
const RESTART_EVERY = Number(arg('--restart-every', '30'));
const LOOK_TIMEOUT_MS = 4 * 60e3;
const TIMING_TIMEOUT_MS = 10 * 60e3;
const MIN_FREE_GIB_SECOND = 2.5; // a 2nd parallel look job starts only with this much free RAM
const VIEWPORT = { width: 1500, height: 900 }; // same as ar-eval / F3 / F3X harnesses

const log = (...a) =>
  console.log(new Date().toLocaleTimeString('en-GB', { hour12: false }), 'F6:', ...a);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// ---------- state ----------
const state = {
  phase: 'starting', // starting | waiting-lock | serving | draining-timing | paused-timing | stopping
  port: null,
  chromeGen: 0,
  jobsServed: 0,
  jobsSinceRestart: 0,
  running: new Map(), // id -> {spec, lane, startedAt}
  lastServed: new Map(), // requester -> ms
  timing: null, // {requester, expiresAt}
  startedAt: new Date().toISOString(),
  sourceEpoch: 0,
  fingerprint: null,
  idlePages: new Map(), // reuse key -> {page, key}
};
let releaseBrowser = null;
let server = null;
let context = null;
let stopping = false;

function heartbeat() {
  const queued = listQueued();
  const doc = {
    pid: process.pid,
    owner: OWNER,
    phase: state.phase,
    port: state.port,
    lookParallel,
    chromeGen: state.chromeGen,
    jobsServed: state.jobsServed,
    running: [...state.running.entries()].map(([id, r]) => ({
      id,
      requester: r.spec.requester,
      lane: r.spec.lane,
      startedAt: new Date(r.startedAt).toISOString(),
    })),
    queued: queued.map((q) => ({ id: q.id, requester: q.requester, lane: q.lane })),
    timing: state.timing,
    freeGiB: +(freemem() / 1024 ** 3).toFixed(2),
    startedAt: state.startedAt,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(join(SVC, 'alive.json.tmp'), JSON.stringify(doc, null, 1));
  renameSync(join(SVC, 'alive.json.tmp'), join(SVC, 'alive.json'));
}

function listQueued() {
  const out = [];
  for (const f of readdirSync(D.jobs)) {
    if (!f.endsWith('.json')) continue;
    try {
      const spec = JSON.parse(readFileSync(join(D.jobs, f), 'utf8'));
      out.push(spec);
    } catch {
      /* half-written by a client: next poll */
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

// Fair pick: among requesters with queued jobs, the one served longest ago (never = first);
// FIFO within a requester.
function pickNext() {
  const q = listQueued();
  if (!q.length) return null;
  const byReq = new Map();
  for (const j of q) if (!byReq.has(j.requester)) byReq.set(j.requester, j);
  // Lead's priority list (control/priority.json {"requesters": [...]}, ar-job set-priority):
  // those requesters are served first, round-robin among themselves.
  let heads = [...byReq.values()];
  try {
    const pri = JSON.parse(readFileSync(join(D.control, 'priority.json'), 'utf8')).requesters ?? [];
    const first = heads.filter((j) => pri.includes(j.requester));
    if (first.length) heads = first;
  } catch {
    /* no priority file */
  }
  return heads.sort(
    (a, b) =>
      (state.lastServed.get(a.requester) ?? 0) - (state.lastServed.get(b.requester) ?? 0) ||
      a.createdAt - b.createdAt,
  )[0];
}

function claim(spec) {
  try {
    renameSync(join(D.jobs, `${spec.id}.json`), join(D.running, `${spec.id}.json`));
    return true;
  } catch {
    return false;
  }
}

function finish(spec, result) {
  const dir = join(D.out, spec.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 1));
  try {
    renameSync(join(D.running, `${spec.id}.json`), join(D.done, `${spec.id}.json`));
  } catch {
    /* already moved */
  }
}

// ---------- freshness ----------
function sourceFingerprint() {
  const head = git('rev-parse', 'HEAD');
  const status = git('status', '--porcelain', '--', 'apps/web', 'packages');
  const dirty = status
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, ''));
  const mt = dirty.map((p) => {
    try {
      return statSync(join(ROOT, p)).mtimeMs;
    } catch {
      return 0;
    }
  });
  return {
    head,
    dirty: dirty.length > 0,
    dirtyFiles: dirty.length,
    key: `${head}|${status}|${mt.join(',')}`,
  };
}
function refreshSource() {
  const fp = sourceFingerprint();
  if (state.fingerprint && state.fingerprint.key !== fp.key && server) {
    for (const env of Object.values(server.environments ?? {})) env.moduleGraph?.invalidateAll?.();
    server.moduleGraph?.invalidateAll?.();
    state.sourceEpoch++;
    for (const { page } of state.idlePages.values()) page.close().catch(() => {});
    state.idlePages.clear();
    log('source changed: module graph invalidated, epoch', state.sourceEpoch);
  }
  state.fingerprint = fp;
  return fp;
}

// ---------- locks ----------
function reclaimOwnStale(name) {
  const f = join(LOCKS, name, 'owner.txt');
  if (!existsSync(f)) return;
  const t = readFileSync(f, 'utf8');
  const pid = Number(/PID (\d+)/.exec(t)?.[1]);
  if (t.startsWith(OWNER) && pid && !pidAlive(pid)) {
    rmSync(f);
    rmdirSync(join(LOCKS, name));
    log(`reclaimed own stale ${name} lock (PID ${pid} dead)`);
  }
}
async function takeBrowserLock() {
  reclaimOwnStale('browser');
  state.phase = 'waiting-lock';
  let n = 0;
  releaseBrowser = await acquireBrowserSlot(OWNER, {
    pause: () => (stopRequested() ? shutdown('stop file') : pause(5000)),
    report: (m) => {
      if (n++ % 12 === 0) log(m.replace('Waiting 60s', 'waiting'));
    },
  });
  log('browser lock held');
}
function dropBrowserLock() {
  try {
    releaseBrowser?.();
  } catch (e) {
    log('browser lock release refused:', e.message);
  }
  releaseBrowser = null;
}
let heavyToken = null;
async function takeHeavy(maxMs) {
  reclaimOwnStale('heavy');
  const dir = join(LOCKS, 'heavy');
  const t0 = Date.now();
  for (let i = 0; ; i++) {
    try {
      mkdirSync(dir);
      heavyToken = `${OWNER} timing\nPID ${process.pid}\n${new Date().toISOString()}\n${randomUUID()}\n`;
      writeFileSync(join(dir, 'owner.txt'), heavyToken, { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - t0 > maxMs) return false;
      if (i % 12 === 0) log('timing job waiting for heavy');
      await pause(5000);
    }
  }
}
function dropHeavy() {
  if (!heavyToken) return;
  const f = join(LOCKS, 'heavy', 'owner.txt');
  try {
    if (readFileSync(f, 'utf8') === heavyToken) {
      rmSync(f);
      rmdirSync(join(LOCKS, 'heavy'));
    }
  } catch {
    /* gone */
  }
  heavyToken = null;
}

// ---------- vite + chrome ----------
async function freePort() {
  for (let p = 5810; p <= 5819; p++) {
    const ok = await new Promise((done) => {
      const s = netServer();
      s.once('error', () => done(false));
      s.listen(p, '127.0.0.1', () => s.close(() => done(true)));
    });
    if (ok) return p;
  }
  throw new Error('No free port in 5810..5819');
}
async function startVite() {
  const { createServer } = await import('vite');
  state.port = await freePort();
  server = await createServer({
    root: join(ROOT, 'apps/web'),
    configFile: join(ROOT, 'apps/web/vite.config.ts'),
    cacheDir: join(SVC, 'vite'),
    logLevel: 'error',
    // HMR off: a save never reloads a page under a running job. Watching ON: changed modules
    // are invalidated, so the next navigation gets the current source.
    server: { host: '127.0.0.1', port: state.port, strictPort: true, hmr: false },
  });
  await server.listen();
  server.watcher.on('change', () => state.sourceEpoch++);
  log('vite on', state.port);
}
const saves = new Map(); // token -> out dir
async function startChrome() {
  const { chromium } = await import('playwright');
  context = await chromium.launchPersistentContext(join(SVC, 'chrome'), {
    channel: 'chrome',
    headless: !has('--headed'),
    serviceWorkers: 'block',
    viewport: VIEWPORT,
    args: [
      '--disable-background-networking',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      '--autoplay-policy=no-user-gesture-required',
      // Second parallel tab must not be throttled as a background page.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (['127.0.0.1', 'localhost'].includes(u.hostname) || ['data:', 'blob:'].includes(u.protocol))
      return route.continue();
    return route.abort();
  });
  await context.addInitScript(installRestProbe);
  await context.exposeBinding('__svcSave', (_src, token, name, b64) => {
    const dir = saves.get(token);
    if (!dir || !['ar', 'raw'].includes(name)) throw new Error('bad save');
    writeFileSync(join(dir, `${name}.webm`), Buffer.from(b64, 'base64'));
  });
  for (const p of context.pages()) await p.close().catch(() => {});
  state.chromeGen++;
  state.jobsSinceRestart = 0;
  state.idlePages.clear();
  const mine = context;
  mine.on('close', () => {
    if (!stopping && context === mine) {
      log('Chrome context closed unexpectedly; will restart');
      context = null;
    }
  });
  log('chrome up, gen', state.chromeGen);
}
async function stopChrome() {
  state.idlePages.clear();
  const c = context;
  context = null;
  try {
    await Promise.race([c?.close(), pause(15000)]);
  } catch {
    /* already gone */
  }
}

// ---------- the job ----------
function urlFor(spec) {
  const params = new URLSearchParams({
    arlab: '',
    jacket: spec.style,
    still: String(spec.still ?? 0),
    size: 'S',
    // Testset REFERENCE body (KioskApp default fallback, same as ar-eval testset / F3 / F4).
    h: '172',
    w: '65',
    sex: 'male',
    source: 'file',
    t: '0',
    nomirror: '',
    mirror: '0',
    finish: '1',
  });
  for (const [k, v] of new URLSearchParams(spec.flags ?? '')) params.set(k, v);
  return `http://127.0.0.1:${state.port}/?${params}`;
}

async function loadPage(spec, errors) {
  const page = await context.newPage();
  if (spec.dpr && spec.dpr !== 1) {
    // Per-job device pixel ratio (F4 edge work): CDP metrics override on this page only.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      ...VIEWPORT,
      deviceScaleFactor: spec.dpr,
      mobile: false,
    });
    page.__svcCdp = cdp; // snapshots at device pixels need this session
  }
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.length < 50 && errors.push(m.text()));
  await page.goto(urlFor(spec), { timeout: 120000 });
  await page.waitForFunction(() => window.__arlab, null, { timeout: 120000 });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.arlab select')].some((s) => /^[a-f0-9]{64}$/.test(s.value)),
    null,
    { timeout: 60000 },
  );
  const selected = await page.evaluate(async (expected) => {
    const sel = [...document.querySelectorAll('.arlab select')].find((s) =>
      /^[a-f0-9]{64}$/.test(s.value),
    );
    const products = await fetch('/api/products').then((r) => r.json());
    const p = products.find((x) => x.product_id === sel?.value);
    if (p?.style !== expected)
      throw new Error(`Selected style mismatch: ${p?.style} != ${expected}`);
    return { style: p.style, productId: p.product_id };
  }, spec.style);
  await page.locator('input[type=file]').setInputFiles(clipPath(ROOT, spec.clip));
  await page.getByRole('button', { name: /^(Start|Restart)$/ }).click();
  await page.waitForFunction(
    () =>
      window.__arlab.engine.currentSource?.video?.readyState >= 2 &&
      window.__arlab.engine.posedScene,
    null,
    { timeout: 120000 },
  );
  await page.waitForFunction(
    () => {
      const s = window.__arlab.sample();
      return s.phase === 'tracking' && s.status === 'drawn';
    },
    null,
    { timeout: 90000 },
  );
  return { page, selected };
}

// In page: warm the kiosk look (play from 0 until ArKioskJacket is ready + sleeves layered).
async function warmInPage({ maxMs }) {
  const h = window.__arlab,
    ar = h.ar,
    video = h.engine.currentSource.video;
  const t0 = performance.now();
  let kioskAt = null;
  if (!(ar.kioskLook && ar.layeredLast)) {
    video.currentTime = 0;
    await video.play();
    while (performance.now() - t0 < maxMs) {
      if (ar.kioskLook && kioskAt == null) kioskAt = performance.now() - t0;
      if (ar.kioskLook && ar.layeredLast) break;
      // layering can depend on the pose: accept kiosk look + 8 s without layering
      if (kioskAt != null && performance.now() - t0 - kioskAt > 8000) break;
      if (video.ended) {
        video.currentTime = 0;
        await video.play();
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    video.pause();
  }
  return {
    ms: Math.round(performance.now() - t0),
    kioskAtMs: kioskAt == null ? null : Math.round(kioskAt),
    kioskLook: !!ar.kioskLook,
    layered: !!ar.layeredLast,
  };
}

// In page: record [t0, t1] of the AR canvas (+ raw), with compact per-frame numbers.
async function recordInPage({ t0, t1, raw, stats, token, replay }) {
  const h = window.__arlab,
    ar = h.ar,
    engine = h.engine,
    video = engine.currentSource.video;
  video.pause();
  video.loop = false;
  const lead = replay ? 0 : Math.max(0, t0 - 1.2);
  await new Promise((done) => {
    video.addEventListener('seeked', done, { once: true });
    video.currentTime = lead;
    if (!video.seeking) done();
  });
  ar.tracker.resetSmoothing();
  await video.play();
  while (video.currentTime < t0 && !video.ended) await new Promise((r) => setTimeout(r, 15));
  const recs = [];
  if (!replay)
    for (const [name, el] of [['ar', ar.renderer.domElement], ...(raw ? [['raw', video]] : [])]) {
      const stream = new MediaStream(el.captureStream(30).getVideoTracks());
      const rec = new MediaRecorder(stream, {
        mimeType: 'video/webm;codecs=vp8',
        videoBitsPerSecond: 4000000,
      });
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const stopped = new Promise((r) => (rec.onstop = r));
      rec.start();
      recs.push({ name, rec, chunks, stopped, stream });
    }
  const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : (v ?? null));
  const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : (v ?? null));
  const camOf = new WeakMap();
  const off = engine.currentSource.onFrame?.((f) =>
    camOf.set(f, video.__arCameraFrame ? { ...video.__arCameraFrame } : null),
  );
  const frames = [];
  let last = null;
  const begin = performance.now();
  await new Promise((resolveDone) => {
    const tick = () => {
      if (video.ended || video.currentTime >= t1) return resolveDone();
      const f = engine.lastFrame;
      if (f && f !== last && (stats || replay)) {
        last = f;
        const cam = camOf.get(f);
        const row = {
          t: f.t,
          videoMs:
            cam?.mediaMs != null ? Math.round(cam.mediaMs) : Math.round(video.currentTime * 1000),
          wallVideoMs: Math.round(video.currentTime * 1000),
        };
        if (replay) {
          row.lm = f.landmarks2d
            ? f.landmarks2d.map((p) => [
                r1(p.x),
                r1(p.y),
                Math.round((p.visibility ?? 0) * 100) / 100,
              ])
            : null;
          row.world = f.world
            ? f.world.map((p) => [
                r3(p.x),
                r3(p.y),
                r3(p.z),
                Math.round((p.visibility ?? 0) * 100) / 100,
              ])
            : null;
        } else {
          const s = h.sample();
          const d = ar.debugState?.() ?? {};
          const e = s.engine ?? {};
          Object.assign(row, {
            status: s.status,
            phase: s.phase,
            fade: r3(d.fade),
            backView: d.backView ?? null,
            // F1 request 21:33 (sleeve-lag question): glue pull and residual, arm fit, focal, stillness.
            glue: d.glue
              ? {
                  maxControlDisplacementPx: r1(d.glue.maxControlDisplacementPx),
                  residualPx: Object.fromEntries(
                    Object.entries(d.glue.residualPx ?? {}).map(([k, v]) => [k, r1(v)]),
                  ),
                  layered: d.glue.layeredSleeves ?? null,
                }
              : null,
            armFit: d.armFit
              ? {
                  sides: d.armFit.sides,
                  beforePx: d.armFit.beforePx,
                  afterPx: d.armFit.afterPx,
                  afterJointPx: d.armFit.afterJointPx,
                }
              : null,
            focalPx: r1(d.focalPx),
            focalSource: d.focalSource ?? null,
            stillEngaged: d.stillness?.engaged ?? null,
            yawDeg: r1(s.yawDeg),
            depthM: r3(s.depthM),
            alignment: s.alignment
              ? { score: r3(s.alignment.score), rmsPx: r1(s.alignment.rmsPx) }
              : null,
            rawRmsPx: r1(s.rawRmsPx),
            kioskLook: !!ar.kioskLook,
            layered: !!ar.layeredLast,
            fps: {
              source: r1(e.sourceFps),
              render: r1(e.renderFps),
              arTotalMs: r1(e.arTotalMs),
              totalMs: r1(e.totalMs),
            },
            lm: [11, 12, 13, 14, 15, 16, 23, 24].map((i) =>
              f.landmarks2d?.[i]
                ? [
                    r1(f.landmarks2d[i].x),
                    r1(f.landmarks2d[i].y),
                    Math.round(f.landmarks2d[i].visibility * 100) / 100,
                  ]
                : null,
            ),
          });
        }
        frames.push(row);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  video.pause();
  off?.();
  const wallMs = performance.now() - begin;
  for (const r of recs) r.rec.stop();
  await Promise.all(recs.map((r) => r.stopped));
  for (const r of recs) for (const t of r.stream.getTracks()) t.stop();
  for (const r of recs) {
    const blob = new Blob(r.chunks, { type: 'video/webm' });
    const b64 = await new Promise((done) => {
      const fr = new FileReader();
      fr.onload = () => done(String(fr.result).split(',')[1]);
      fr.readAsDataURL(blob);
    });
    await window.__svcSave(token, r.name, b64);
  }
  return {
    frames,
    wallMs: Math.round(wallMs),
    canvas: [ar.renderer.domElement.width, ar.renderer.domElement.height],
    video: [video.videoWidth, video.videoHeight],
    duration: video.duration,
    engineStats: engine.stats?.() ?? null,
  };
}

async function snapshotInPage(page, T, dir) {
  await page.evaluate(async (T) => {
    const v = window.__arlab.engine.currentSource.video;
    if (v.currentTime > T + 0.3 || v.currentTime < T - 3) {
      await new Promise((done) => {
        v.addEventListener('seeked', done, { once: true });
        v.currentTime = Math.max(0, T - 1.5);
        if (!v.seeking) done();
      });
    }
    if (v.paused) await v.play();
    await new Promise((done) => {
      const tick = () => (v.currentTime >= T || v.ended ? done() : setTimeout(tick, 5));
      tick();
    });
    v.pause();
  }, T);
  await page.waitForTimeout(1200); // same settle as F4 snap
  const meta = await page.evaluate(() => {
    const { ar, engine } = window.__arlab;
    const c = ar.renderer.domElement;
    c.id = 'svcar';
    for (const o of c.parentElement.querySelectorAll('canvas'))
      if (o !== c) o.style.display = 'none';
    return { t: engine.currentSource.video.currentTime, canvas: [c.width, c.height] };
  });
  const name = `t${T.toFixed(2)}.png`;
  if (page.__svcCdp) {
    // Playwright does not know the CDP-overridden DPR: capture through CDP at device pixels.
    const box = await page.locator('#svcar').boundingBox();
    const shot = await page.__svcCdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
    });
    writeFileSync(join(dir, name), Buffer.from(shot.data, 'base64'));
  } else await page.locator('#svcar').screenshot({ path: join(dir, name) });
  return { file: name, ...meta };
}

function runStrip(dir, spec, rec) {
  const s = spec.outputs.strip;
  if (!s) return null;
  const [x, y, w, h, zoom, max] = s.crop;
  // The webm starts at the window start: strip times are window-relative.
  const a = Math.max(0, (s.from ?? spec.window[0]) - spec.window[0]);
  const b = Math.max(a + 0.05, (s.to ?? spec.window[1]) - spec.window[0]);
  return new Promise((done) =>
    execFile(
      'py',
      [
        join(ROOT, '.cache/lead/atlas/strip.py'),
        join(dir, 'ar.webm'),
        join(dir, 'strip.jpg'),
        String(a),
        String(b),
        String(x),
        String(y),
        String(w),
        String(h),
        String(zoom),
        String(max),
      ],
      { cwd: ROOT, timeout: 120000 },
      (err, stdout, stderr) =>
        done(
          err
            ? { error: String(stderr || err.message).slice(0, 400) }
            : { file: 'strip.jpg', note: stdout.trim(), canvas: rec?.canvas },
        ),
    ),
  );
}

function reuseKey(spec) {
  return `${state.chromeGen}|${state.sourceEpoch}|${spec.style}|${spec.still ?? 0}|${spec.clip}|${spec.flags ?? ''}|${spec.dpr ?? 1}`;
}

async function runJob(spec) {
  const started = Date.now();
  const dir = join(D.out, spec.id);
  mkdirSync(dir, { recursive: true });
  const token = randomUUID();
  saves.set(token, dir);
  const errors = [];
  const peers = state.running.size - 1;
  const fp = refreshSource();
  const result = {
    id: spec.id,
    requester: spec.requester,
    lane: spec.lane,
    timingValid: spec.lane === 'timing',
    status: 'running',
    spec,
    head: fp.head,
    dirty: fp.dirty,
    dirtyFiles: fp.dirtyFiles,
    sourceEpoch: state.sourceEpoch,
    url: urlFor(spec).replace(/^http:\/\/127\.0\.0\.1:\d+/, ''),
    parallelPeersAtStart: peers,
    freeGiBAtStart: +(freemem() / 1024 ** 3).toFixed(2),
    service: { pid: process.pid, chromeGen: state.chromeGen, port: state.port },
    queuedMs: started - spec.createdAt,
    startedAt: new Date(started).toISOString(),
    timings: {},
    files: {},
  };
  let page = null;
  let keep = false;
  const key = reuseKey(spec);
  try {
    const t0 = Date.now();
    const idle = !spec.replay && state.idlePages.get(key);
    if (idle) {
      state.idlePages.delete(key);
      page = idle.page;
      result.selectedProduct = idle.selected;
      result.reusedPage = true;
    } else {
      const loaded = await loadPage(spec, errors);
      page = loaded.page;
      result.selectedProduct = loaded.selected;
      result.reusedPage = false;
    }
    result.timings.loadMs = Date.now() - t0;
    if (result.selectedProduct?.style !== spec.style) throw new Error('product not verified');
    const t1 = Date.now();
    result.warm = spec.replay ? null : await page.evaluate(warmInPage, { maxMs: 75000 });
    result.timings.warmMs = Date.now() - t1;
    const t2 = Date.now();
    const rec = await page.evaluate(recordInPage, {
      t0: spec.window[0],
      t1: spec.window[1],
      raw: !!spec.outputs.raw,
      stats: spec.outputs.stats !== false,
      token,
      replay: !!spec.replay,
    });
    result.timings.recordMs = Date.now() - t2;
    result.canvas = rec.canvas;
    result.video = rec.video;
    result.frames = rec.frames.length;
    result.recordWallMs = rec.wallMs;
    result.engineStats = rec.engineStats;
    if (spec.replay) {
      writeFileSync(
        join(dir, 'replay.json'),
        JSON.stringify({
          clip: spec.clip,
          style: spec.style,
          head: fp.head,
          dirty: fp.dirty,
          window: spec.window,
          duration: rec.duration,
          video: rec.video,
          frames: rec.frames,
        }),
      );
      result.files.replay = 'replay.json';
    } else {
      writeFileSync(
        join(dir, 'frames.json'),
        JSON.stringify({ window: spec.window, frames: rec.frames }),
      );
      result.files.frames = 'frames.json';
      if (existsSync(join(dir, 'ar.webm'))) result.files.ar = 'ar.webm';
      if (existsSync(join(dir, 'raw.webm'))) result.files.raw = 'raw.webm';
    }
    const t3 = Date.now();
    result.snapshots = [];
    for (const T of spec.outputs.snapshots ?? [])
      result.snapshots.push(await snapshotInPage(page, T, dir));
    result.timings.snapMs = Date.now() - t3;
    const t4 = Date.now();
    if (!spec.replay && spec.outputs.strip) result.strip = await runStrip(dir, spec, rec);
    result.timings.stripMs = Date.now() - t4;
    result.status = 'ok';
    // Page reuse is OFF (23:5x): a kept idle page keeps its engine loop and pose worker alive in
    // the background and halved the next different-flag job's cadence (F5 arm G vs I, 9-11 vs
    // 16-23 fps). Every job now has the browser to itself. --reuse-pages turns it back on.
    keep = has('--reuse-pages') && !spec.replay && !spec.outputs.snapshots?.length;
  } catch (e) {
    result.status = 'error';
    result.error = String(e?.message ?? e).slice(0, 1000);
  } finally {
    saves.delete(token);
    result.errors = errors.slice(0, 20);
    result.timings.totalMs = Date.now() - started;
    result.finishedAt = new Date().toISOString();
    // A warm page is kept for an identical next job (same chrome gen, source epoch, style,
    // still, clip, flags); snapshots hide canvases, so those pages are not kept.
    if (page && keep && context && state.idlePages.size < lookParallel) {
      state.idlePages.set(key, { page, selected: result.selectedProduct });
    } else if (page) await Promise.race([page.close().catch(() => {}), pause(10000)]);
  }
  return result;
}

async function execute(spec) {
  state.running.set(spec.id, { spec, startedAt: Date.now() });
  state.lastServed.set(spec.requester, Date.now());
  heartbeat();
  log(
    `start ${spec.id} (${spec.lane}) ${spec.requester} ${spec.style} ${spec.clip} ${spec.window}`,
  );
  let result;
  const timeout = spec.lane === 'timing' ? TIMING_TIMEOUT_MS : LOOK_TIMEOUT_MS;
  try {
    result = await Promise.race([
      runJob(spec),
      pause(timeout).then(() => ({
        id: spec.id,
        requester: spec.requester,
        lane: spec.lane,
        status: 'timeout',
        error: `job exceeded ${timeout / 1000} s; Chrome restarted`,
        spec,
      })),
    ]);
  } catch (e) {
    result = {
      id: spec.id,
      lane: spec.lane,
      status: 'error',
      error: String(e?.message ?? e),
      spec,
    };
  }
  finish(spec, result);
  state.running.delete(spec.id);
  state.jobsServed++;
  state.jobsSinceRestart++;
  log(
    `done ${spec.id} ${result.status} ${result.timings?.totalMs ?? '-'} ms ${result.error ?? ''}`,
  );
  if (result.status === 'timeout') {
    // The page may be wedged: restart Chrome once nothing else runs.
    while (state.running.size) await pause(1000);
    await stopChrome();
  }
  heartbeat();
}

// ---------- control ----------
// `ar-job.mjs service-stop` writes control/stop.json: finish running jobs, then a clean shutdown.
function stopRequested() {
  const f = join(D.control, 'stop.json');
  if (!existsSync(f)) return false;
  return true;
}

// One file per requester (control/timing-<name>.json; legacy control/timing.json too): the
// service stays paused while ANY of them is active and not expired.
function readTimingControl() {
  let first = null;
  for (const name of readdirSync(D.control)) {
    if (!/^timing(-[A-Za-z0-9-]{1,16})?.json$/.test(name)) continue;
    const f = join(D.control, name);
    try {
      const c = JSON.parse(readFileSync(f, 'utf8'));
      if (!(c.expiresAt > Date.now())) {
        rmSync(f);
        log('timing pause expired for', c.requester);
        continue;
      }
      if (!first || c.requestedAt < first.requestedAt) first = c;
    } catch {
      /* half-written: next poll */
    }
  }
  return first;
}

async function main() {
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (e) => {
    log('uncaught', e?.stack ?? e);
    shutdown('crash');
  });
  process.on('exit', () => {
    dropHeavy();
    dropBrowserLock();
  });
  const hb = setInterval(() => {
    try {
      heartbeat();
    } catch {
      /* best effort */
    }
  }, 5000);
  hb.unref();
  rmSync(join(D.control, 'stop.json'), { force: true });
  // Requeue jobs left in running/ by a previous crashed service instance.
  for (const f of readdirSync(D.running)) renameSync(join(D.running, f), join(D.jobs, f));
  heartbeat();
  await startVite();
  const pending = readTimingControl();
  if (pending) {
    // A timing pause is in force: start paused, without the lock (the loop resumes later).
    state.phase = 'paused-timing';
    state.timing = pending;
    log(`starting paused for exclusive timing (${pending.requester})`);
  } else {
    await takeBrowserLock();
    await startChrome();
    state.phase = 'serving';
  }
  refreshSource();
  heartbeat();
  log(`READY: look lane x${lookParallel}, port ${state.port}`);
  while (!stopping) {
    if (stopRequested()) {
      if (state.running.size) {
        await pause(500);
        continue;
      }
      await shutdown('stop file');
      break;
    }
    const timing = readTimingControl();
    if (timing && state.phase !== 'paused-timing') {
      state.phase = 'draining-timing';
      state.timing = timing;
      heartbeat();
      if (state.running.size) {
        await pause(500);
        continue;
      }
      // Keep Chrome alive but EMPTY (no pages: no rendering, no timers) so the next drain starts
      // warm (a restart costs 20-30 s of cold kiosk look per product). Closed when RAM is short.
      for (const { page } of state.idlePages.values()) await page.close().catch(() => {});
      state.idlePages.clear();
      for (const pg of context?.pages() ?? []) await pg.close().catch(() => {});
      if (has('--close-chrome-on-pause') || freemem() / 1024 ** 3 < MIN_FREE_GIB_SECOND)
        await stopChrome();
      else log('Chrome kept alive with no pages during the pause');
      dropBrowserLock();
      state.phase = 'paused-timing';
      heartbeat();
      log(`paused for exclusive timing (${timing.requester}); browser lock released`);
      continue;
    }
    if (state.phase === 'paused-timing') {
      if (timing) {
        state.timing = timing;
        await pause(2000);
        continue;
      }
      state.timing = null;
      log('timing pause over: retaking the browser lock');
      await takeBrowserLock();
      if (!context) await startChrome();
      state.phase = 'serving';
      heartbeat();
      continue;
    }
    if (!context) {
      if (state.running.size) {
        await pause(500);
        continue;
      }
      await stopChrome();
      await startChrome();
    }
    if (state.jobsSinceRestart >= RESTART_EVERY && !state.running.size) {
      log('periodic Chrome restart');
      await stopChrome();
      await startChrome();
    }
    const next = pickNext();
    if (!next) {
      await pause(700);
      continue;
    }
    const v = validateJob(ROOT, next);
    if (v) {
      if (claim(next))
        finish(next, {
          id: next.id,
          requester: next.requester,
          lane: next.lane,
          status: 'rejected',
          error: v,
          spec: next,
        });
      continue;
    }
    if (next.lane === 'timing') {
      if (state.running.size) {
        await pause(500);
        continue;
      }
      if (!claim(next)) continue;
      state.phase = 'timing-job';
      for (const { page } of state.idlePages.values()) await page.close().catch(() => {});
      state.idlePages.clear();
      heartbeat();
      if (!(await takeHeavy(15 * 60e3))) {
        finish(next, {
          id: next.id,
          lane: 'timing',
          status: 'error',
          error: 'heavy lock not free within 15 min',
          spec: next,
        });
      } else {
        try {
          await execute(next);
        } finally {
          dropHeavy();
        }
      }
      state.phase = 'serving';
      continue;
    }
    // Dispatcher switch: control/parallel.json {"look": 1|2} (ar-job.mjs set-parallel N).
    try {
      const n = JSON.parse(readFileSync(join(D.control, 'parallel.json'), 'utf8')).look;
      if ((n === 1 || n === 2) && n !== lookParallel) {
        lookParallel = n;
        log('look lane parallelism ->', n);
      }
    } catch {
      /* no switch file: keep the start-up value */
    }
    const busy = [...state.running.values()];
    if (busy.length >= lookParallel || busy.some((r) => r.spec.lane === 'timing')) {
      await pause(400);
      continue;
    }
    if (busy.length >= 1 && freemem() / 1024 ** 3 < MIN_FREE_GIB_SECOND) {
      await pause(1000);
      continue;
    }
    if (!claim(next)) continue;
    execute(next); // not awaited: look lane may run lookParallel jobs
    await pause(300);
  }
}

let shuttingDown = false;
async function shutdown(why) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopping = true;
  state.phase = 'stopping';
  log('shutdown:', why);
  try {
    heartbeat();
  } catch {
    /* ignore */
  }
  await stopChrome();
  try {
    await Promise.race([server?.close(), pause(10000)]);
  } catch {
    /* ignore */
  }
  // Jobs that were running go back to the queue for the next service instance.
  for (const f of readdirSync(D.running)) {
    try {
      renameSync(join(D.running, f), join(D.jobs, f));
    } catch {
      /* ignore */
    }
  }
  dropHeavy();
  dropBrowserLock();
  try {
    const a = JSON.parse(readFileSync(join(SVC, 'alive.json'), 'utf8'));
    writeFileSync(
      join(SVC, 'alive.json'),
      JSON.stringify({ ...a, phase: 'stopped', updatedAt: new Date().toISOString() }, null, 1),
    );
  } catch {
    /* ignore */
  }
  process.exit(why === 'crash' ? 1 : 0);
}

log(
  `starting; RAM free ${(freemem() / 1024 ** 3).toFixed(1)} / ${(totalmem() / 1024 ** 3).toFixed(1)} GiB; look window <= ${LOOK_MAX_WINDOW_S} s`,
);
main().catch((e) => {
  log('fatal', e?.stack ?? e);
  shutdown('crash');
});
