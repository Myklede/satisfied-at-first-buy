// Standing smoke test "kiosk-live" (F2, lead 17:05): the REAL kiosk route with getUserMedia itself
// (Chrome's fake camera device fed an MJPEG made locally from a reference clip, so no physical
// webcam is needed), attract -> body -> scan -> skip -> result -> try-on.
// PASS per config when: every getUserMedia call succeeded, the AR drew on try-on, no console
// error / page error, and with rec=1 REC -> STOP produced its 3 files. Also reports a settled
// fps window (kiosk look on, 4 s settle, 6 s count). Exit 1 if any config fails.
// Privacy: the fixture and REC files stay under .cache/kiosk-live (gitignored); only numbers print.
// Usage (browser THEN heavy lock, <= --deadline-min; with F6's service use --timing):
//   node --max-old-space-size=6144 scripts/kiosk-live-smoke.mjs --configs "rc1|rec=1&<flags>;none|"
//        [--timing] [--port 5792] [--fixture <mjpeg>] [--headed] [--deadline-min 10]
//        [--probe-box x0,y0,x1,y1 --probe-secs N --probe-tags camo]
// --probe-box (lead 19:35, the free Camo tier's corner logo): for N s after the fps window, per
// pose frame, numbers only: person-mask values inside the box (source-normalised 0..1) and in its
// mirror box on the left (control, plain wall), landmarks (visibility >= 0.5) inside the box, and
// whether the class-mask crop (?f4mask) reaches the box. Only configs whose tag is listed.
import { mkdirSync, writeFileSync, readFileSync, rmSync, rmdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { freemem } from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const flag = (n) => argv.includes(n);
const port = Number(arg('--port', '5792'));
const OUT = join(ROOT, '.cache/kiosk-live');
mkdirSync(OUT, { recursive: true });
const mjpeg = resolve(ROOT, arg('--fixture', join(OUT, 'venue-960x540.mjpeg')));
if (!existsSync(mjpeg)) {
  // 20 s of the local venue clip at 960x540 (the kiosk's LIVE_CAMERA size), JPEG frames.
  const clip = join(ROOT, 'data/reference-photos/FB7675-100-parka-trang/video/venue-khong-ao.mp4');
  const py = `import cv2,sys
c=cv2.VideoCapture(sys.argv[1]); c.set(cv2.CAP_PROP_POS_MSEC,2000)
o=open(sys.argv[2],'wb'); n=0
while n<600:
  ok,f=c.read()
  if not ok: break
  ok,j=cv2.imencode('.jpg',cv2.resize(f,(960,540),interpolation=cv2.INTER_AREA),[cv2.IMWRITE_JPEG_QUALITY,90]); o.write(j.tobytes()); n+=1
o.close()`;
  const r = spawnSync('py', ['-I', '-c', py, clip, mjpeg], { stdio: 'inherit' });
  if (r.status !== 0 || !existsSync(mjpeg))
    throw new Error('could not build the fake-camera fixture');
}
const probeBox = arg('--probe-box', '').split(',').filter(Boolean).map(Number);
const probeSecs = Number(arg('--probe-secs', '0'));
const probeTags = arg('--probe-tags', '').split(',').filter(Boolean);
if (probeBox.length && (probeBox.length !== 4 || probeBox.some((v) => !(v >= 0 && v <= 1))))
  throw new Error('--probe-box wants x0,y0,x1,y1 in 0..1');
const configs = arg('--configs', 'none|')
  .split(';')
  .filter(Boolean)
  .map((c) => ({ tag: c.split('|')[0], flags: c.split('|')[1] ?? '' }));

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** In-page: mask / landmark / class-crop numbers inside a source-normalised box (see header). */
async function regionProbe({ box, secs }) {
  const e = window.__f2Engine;
  const [x0, y0, x1, y1] = box;
  const ctrl = [1 - x1, y0, 1 - x0, y1];
  const acc = () => ({ px: 0, over50: 0, sum: 0, max: 0 });
  // torso: positive control (the mask must be high between the shoulders and hips), whole frame.
  const r = {
    frames: 0,
    person: 0,
    masks: 0,
    box: acc(),
    control: acc(),
    torso: acc(),
    frame: acc(),
    framesOver50: 0,
  };
  const lmIn = {};
  let lmFrames = 0,
    classFrames = 0,
    classInBox = 0;
  // Class masks (packed RGBA, A = any person class, R = clothes/others) whose crop reaches the
  // box: their pixels inside the box, each mask counted once.
  const cls = { masks: 0, px: 0, personOver50: 0, coverOver50: 0, maxPerson: 0 };
  let lastClassId = null;
  const sample = (m, b, a) => {
    const mx0 = Math.floor(b[0] * m.width),
      mx1 = Math.ceil(b[2] * m.width),
      my0 = Math.floor(b[1] * m.height),
      my1 = Math.ceil(b[3] * m.height);
    let over = 0;
    for (let y = my0; y < my1; y++)
      for (let x = mx0; x < mx1; x++) {
        const v = m.data[y * m.width + x];
        a.px++;
        a.sum += v;
        if (v > a.max) a.max = v;
        if (v > 0.5) over++;
      }
    a.over50 += over;
    return over;
  };
  const onFrame = e.onFrame;
  e.onFrame = function (...args) {
    const f = args[0];
    try {
      r.frames++;
      if (f?.landmarks2d) {
        r.person++;
        let any = false;
        f.landmarks2d.forEach((l, i) => {
          const u = l.x / f.width,
            v = l.y / f.height;
          if (l.visibility >= 0.5 && u >= x0 && u <= x1 && v >= y0 && v <= y1) {
            lmIn[i] = (lmIn[i] ?? 0) + 1;
            any = true;
          }
        });
        if (any) lmFrames++;
      }
      if (f?.mask) {
        r.masks++;
        if (sample(f.mask, box, r.box) > 0) r.framesOver50++;
        sample(f.mask, ctrl, r.control);
        if (r.masks % 10 === 1) sample(f.mask, [0, 0, 1, 1], r.frame);
        const L = f.landmarks2d;
        if (L && [11, 12, 23, 24].every((i) => L[i].visibility >= 0.5)) {
          const xs = [11, 12, 23, 24].map((i) => L[i].x / f.width),
            ys = [11, 12, 23, 24].map((i) => L[i].y / f.height);
          const [a0, a1] = [Math.min(...xs), Math.max(...xs)],
            [b0, b1] = [Math.min(...ys), Math.max(...ys)];
          // The middle half of the shoulder-hip box (inside the body), clamped to the frame.
          const cl = (v) => Math.min(1, Math.max(0, v));
          const qx = (a1 - a0) / 4,
            qy = (b1 - b0) / 4;
          if (a1 - a0 > 0.02 && b1 - b0 > 0.02)
            sample(f.mask, [cl(a0 + qx), cl(b0 + qy), cl(a1 - qx), cl(b1 - qy)], r.torso);
        }
      }
      const c = e.arRenderer?.finisher?.classResult;
      if (c?.rect && f?.width) {
        classFrames++;
        // The crop is in LiveFrame pixels (ArFinish lastRect).
        const q = c.rect,
          W = f.width,
          H = f.height;
        if (q.x + q.w > x0 * W && q.x < x1 * W && q.y + q.h > y0 * H && q.y < y1 * H) {
          classInBox++;
          const pk = c.packed;
          if (pk?.data && c.id !== lastClassId) {
            lastClassId = c.id;
            cls.masks++;
            const u0 = Math.max(0, Math.floor(((x0 * W - q.x) / q.w) * pk.width)),
              u1 = Math.min(pk.width, Math.ceil(((x1 * W - q.x) / q.w) * pk.width)),
              v0 = Math.max(0, Math.floor(((y0 * H - q.y) / q.h) * pk.height)),
              v1 = Math.min(pk.height, Math.ceil(((y1 * H - q.y) / q.h) * pk.height));
            for (let y = v0; y < v1; y++)
              for (let x = u0; x < u1; x++) {
                const k = (y * pk.width + x) * 4;
                cls.px++;
                if (pk.data[k + 3] > 127) cls.personOver50++;
                if (pk.data[k] > 127) cls.coverOver50++;
                if (pk.data[k + 3] > cls.maxPerson) cls.maxPerson = pk.data[k + 3];
              }
          }
        }
      }
    } catch {
      // numbers only; a probe error must not break the engine
    }
    return onFrame.apply(this, args);
  };
  await new Promise((res) => setTimeout(res, secs * 1000));
  e.onFrame = onFrame;
  const fin = (a) => ({
    px: a.px,
    meanMask: a.px ? +(a.sum / a.px).toPrecision(3) : null,
    maxMask: +a.max.toPrecision(3),
    over50Frac: a.px ? +(a.over50 / a.px).toFixed(5) : null,
  });
  return {
    secs,
    frames: r.frames,
    personFrames: r.person,
    maskFrames: r.masks,
    box: fin(r.box),
    control: fin(r.control),
    torsoControl: fin(r.torso),
    wholeFrameEvery10th: fin(r.frame),
    framesWithMaskOver50InBox: r.framesOver50,
    landmarkFramesInBox: lmFrames,
    landmarksInBox: lmIn,
    classCropFrames: classFrames,
    classCropReachesBox: classInBox,
    classMaskPixelsInBox: cls,
  };
}

async function lock(name) {
  const dir = join(ROOT, '.cache/locks', name);
  for (;;) {
    if (freemem() / 1024 ** 3 >= 2.5) {
      try {
        mkdirSync(dir);
        const token = `kiosk-live smoke (${arg('--requester', 'F2')})
PID ${process.pid}
${randomUUID()}
`;
        writeFileSync(join(dir, 'owner.txt'), token, { flag: 'wx' });
        return () => {
          try {
            if (readFileSync(join(dir, 'owner.txt'), 'utf8') !== token) return;
            rmSync(join(dir, 'owner.txt'));
            rmdirSync(dir);
          } catch {
            // best effort cleanup
          }
        };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    await pause(3000);
  }
}

let releaseBrowser = () => {},
  releaseHeavy = () => {};
const job = (...a) =>
  spawnSync(process.execPath, [join(ROOT, 'scripts/ar-job.mjs'), ...a], { stdio: 'inherit' });
if (flag('--timing'))
  job(
    'timing-begin',
    '--requester',
    'kiosk-live',
    '--minutes',
    String(Number(arg('--deadline-min', '10')) + 2),
  );
if (!flag('--no-lock')) {
  for (;;) {
    releaseBrowser = await lock('browser');
    const heavy = await Promise.race([lock('heavy'), pause(2000).then(() => null)]);
    if (heavy) {
      releaseHeavy = heavy;
      break;
    }
    releaseBrowser();
    await pause(15000);
  }
  console.log('F2: locks acquired', new Date().toISOString());
}
let server, context;
const killer = setTimeout(
  async () => {
    console.error('F2: deadline');
    try {
      await context?.close();
    } catch {
      // best effort cleanup
    }
    try {
      await server?.close();
    } catch {
      // best effort cleanup
    }
    releaseHeavy();
    releaseBrowser();
    process.exit(2);
  },
  Number(arg('--deadline-min', '10')) * 60e3,
);
const results = [];
try {
  const { createServer } = await import('vite');
  server = await createServer({
    root: join(ROOT, 'apps/web'),
    configFile: join(ROOT, 'apps/web/src/engine/live/ar/finish/eval/vite.v4.config.ts'),
    logLevel: 'error',
    cacheDir: join(ROOT, '.cache/kiosk-live/vite'),
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: { ignored: ['**/*'] } },
  });
  await server.listen();
  const { chromium } = await import('playwright');
  context = await chromium.launchPersistentContext(join(ROOT, '.cache/kiosk-live/chrome'), {
    channel: 'chrome',
    headless: !flag('--headed'),
    serviceWorkers: 'block',
    viewport: { width: 1500, height: 900 },
    acceptDownloads: true,
    args: [
      '--disable-background-networking',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${mjpeg}`,
    ],
  });
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (['127.0.0.1', 'localhost'].includes(u.hostname) || ['data:', 'blob:'].includes(u.protocol))
      return route.continue();
    return route.abort();
  });
  for (const { tag, flags } of configs) {
    const page = await context.newPage();
    const logs = [];
    page.on('console', (m) => {
      if (['error', 'warning'].includes(m.type()))
        logs.push(`${m.type()}: ${m.text()}`.slice(0, 300));
    });
    page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`.slice(0, 300)));
    const downloads = [];
    page.on('download', async (d) => {
      const name = d.suggestedFilename();
      const path = join(OUT, `${tag}-${name}`);
      try {
        await d.saveAs(path);
        downloads.push(name);
      } catch (e) {
        logs.push(`download failed ${name}: ${e.message}`);
      }
    });
    page.setDefaultTimeout(45000);
    const r = { tag, flags, steps: [] };
    const step = (s) => {
      r.steps.push(`${((performance.now() - t0) / 1000).toFixed(1)}s ${s}`);
      console.log(`[${tag}] ${s}`);
    };
    const t0 = performance.now();
    try {
      await page.addInitScript(() => {
        // Observe (never replace) getUserMedia: every call and its outcome.
        window.__gum = [];
        // Camera ownership between screens (one opener per real webcam on Windows): every track
        // getUserMedia handed out, how many stop() calls happened, and how many earlier tracks
        // were still live when a later screen opened the camera (must be 0).
        window.__tracks = [];
        window.__trackStops = 0;
        const stop = MediaStreamTrack.prototype.stop;
        MediaStreamTrack.prototype.stop = function () {
          window.__trackStops++;
          return stop.call(this);
        };
        const md = navigator.mediaDevices;
        if (!md?.getUserMedia) return;
        const orig = md.getUserMedia.bind(md);
        md.getUserMedia = async (c) => {
          const e = {
            at: performance.now(),
            constraints: JSON.stringify(c),
            liveBefore: window.__tracks.filter((t) => t.readyState === 'live').length,
          };
          window.__gum.push(e);
          try {
            const s = await orig(c);
            window.__tracks.push(...s.getTracks());
            const t = s.getVideoTracks()[0];
            e.ok = true;
            e.settings = t ? JSON.stringify(t.getSettings()) : null;
            return s;
          } catch (err) {
            e.ok = false;
            e.error = `${err?.name}: ${err?.message}`;
            throw err;
          }
        };
      });
      await page.goto(`http://127.0.0.1:${port}/?kiosk${flags ? '&' + flags : ''}`);
      await page.locator('[data-screen="attract"]').waitFor({ timeout: 180000 });
      await page.evaluate(async () => {
        const { LiveTryOnEngine } = await import('/src/engine/live/LiveTryOnEngine.ts');
        const start = LiveTryOnEngine.prototype.start;
        LiveTryOnEngine.prototype.start = function (...args) {
          window.__f2Engine = this;
          return start.apply(this, args);
        };
      });
      step('attract');
      await page.locator('[data-screen="attract"]').click();
      await page.getByRole('button', { name: 'cm · kg', exact: true }).click();
      await page.getByLabel('Height centimetres').fill('172');
      await page.getByLabel('Weight kilograms').fill('65');
      await page.getByRole('button', { name: 'Male', exact: true }).click();
      await page.getByRole('button', { name: 'Continue →', exact: true }).click();
      await page.locator('[data-screen="scan"]').waitFor();
      step('scan screen');
      await page.waitForTimeout(3000);
      r.scanVideo = await page.evaluate(() => {
        const v = document.querySelector('[data-screen="scan"] video');
        return v ? { w: v.videoWidth, h: v.videoHeight, ready: v.readyState } : null;
      });
      step(`scan video ${JSON.stringify(r.scanVideo)}`);
      await page
        .getByRole('button', { name: /Skip scan|Continue without scan/ })
        .first()
        .click();
      await page.locator('[data-screen="result"]').waitFor({ timeout: 180000 });
      step('result');
      await page.getByRole('button', { name: 'Try it on you', exact: true }).first().click();
      step('try-on clicked');
      const drawn = await page
        .waitForFunction(() => window.__f2Engine?.arRenderer?.status === 'drawn', null, {
          timeout: 150000,
        })
        .then(() => true)
        .catch(() => false);
      step(`AR drawn: ${drawn}`);
      if (drawn) {
        // Measure the settled state: the kiosk look (layered sleeves) first, then 4 s settle and a
        // 6 s window counting AR renders, drawn frames and pose deliveries.
        await page
          .waitForFunction(() => window.__f2Engine?.arRenderer?.kioskLook === true, null, {
            timeout: 90000,
          })
          .catch(() => step('kioskLook never true'));
        await page.waitForTimeout(4000);
        r.window = await page.evaluate(async () => {
          const e = window.__f2Engine,
            ar = e.arRenderer;
          let drawnN = 0,
            layered = 0;
          const times = [];
          const tot = [];
          // Main-thread cost per pose: the AR render and the engine's whole per-pose handler.
          const cost = { render: [], onFrame: [] };
          const onFrame = e.onFrame;
          e.onFrame = function (...args) {
            const t = performance.now();
            try {
              return onFrame.apply(this, args);
            } finally {
              cost.onFrame.push(performance.now() - t);
            }
          };
          const render = ar.render;
          ar.render = function (...args) {
            const t = performance.now();
            const out = render.apply(this, args);
            cost.render.push(performance.now() - t);
            if (ar.status === 'drawn') {
              drawnN++;
              times.push(performance.now());
              if (ar.layeredLast) layered++;
            }
            const s = e.stats();
            if (s.arTotalMs != null) tot.push(s.arTotalMs);
            return out;
          };
          const p0 = e.currentSource?.stats?.().framesProcessed ?? 0;
          const t0 = performance.now();
          await new Promise((r) => setTimeout(r, 6000));
          ar.render = render;
          e.onFrame = onFrame;
          const secs = (performance.now() - t0) / 1000;
          const avg = (v) =>
            v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : null;
          const p1 = e.currentSource?.stats?.().framesProcessed ?? 0;
          const g = times
            .slice(1)
            .map((t, i) => t - times[i])
            .sort((a, b) => a - b);
          const q = (p) =>
            g.length ? Math.round(g[Math.min(g.length - 1, Math.floor(p * g.length))]) : null;
          return {
            arFps: +(drawnN / secs).toFixed(1),
            poseHz: +((p1 - p0) / secs).toFixed(1),
            layered: `${layered}/${drawnN}`,
            gapP50: q(0.5),
            gapP95: q(0.95),
            arTotalMs: tot.length ? Math.round(tot.reduce((a, b) => a + b, 0) / tot.length) : null,
            arRenderMs: avg(cost.render),
            onFrameMs: avg(cost.onFrame),
          };
        });
        step(`window ${JSON.stringify(r.window)}`);
        if (probeBox.length && probeSecs > 0 && probeTags.includes(tag)) {
          r.probe = await page.evaluate(regionProbe, { box: probeBox, secs: probeSecs });
          step(`probe ${JSON.stringify(r.probe)}`);
        }
      }
      r.state = await page.evaluate(() => {
        const e = window.__f2Engine;
        const s = e?.currentSource;
        return {
          phase: e?.currentState?.phase ?? null,
          message: e?.currentState?.message ?? null,
          arStatus: e?.arRenderer?.status ?? null,
          arFps: e?.arRenderer?.stats?.fps ?? null,
          camera: s?.cameraInfo?.() ?? null,
          tracker: s?.stats?.() ?? null,
          workerFallback: s?.workerFallback ?? null,
          arCanvas: (() => {
            const c = e?.arRenderer?.renderer?.domElement;
            return c
              ? { w: c.width, h: c.height, cssW: c.clientWidth, cssH: c.clientHeight }
              : null;
          })(),
          lastFrameSize: e?.lastFrame ? { w: e.lastFrame.width, h: e.lastFrame.height } : null,
          // F5 17:44: sampler coverage needs engine.lastFrame.mask and the glue renderer.
          lastFrameMask: (() => {
            const m = e?.lastFrame?.mask;
            return m ? { w: m.width, h: m.height, len: m.data?.length ?? null } : null;
          })(),
          glue: { on: !!e?.arRenderer?.glue, renderer: !!e?.arRenderer?.glueRenderer },
          engineStats: (() => {
            const st = e?.stats?.();
            if (!st) return null;
            const k = [
              'trackerMs',
              'poseMs',
              'displayMs',
              'totalMs',
              'arDisplayMs',
              'arTotalMs',
              'sourceFps',
              'renderFps',
            ];
            return Object.fromEntries(k.map((x) => [x, st[x] ?? null]));
          })(),
          // F4: class-mask timing on the live path (finisher stats, numbers only).
          finisher: (() => {
            const f = e?.arRenderer?.finisher?.stats;
            if (!f) return null;
            const pick = [
              'classCapture',
              'classFrameLagMs',
              'classAgeMs',
              'classLatencyMs',
              'classUseDelayMs',
              'classMasks',
              'classTiming',
              'usedClasses',
            ];
            return Object.fromEntries(pick.map((k) => [k, f[k] ?? null]));
          })(),
          poseRenderer: s?.tracker?.renderer ?? null,
          gum: window.__gum,
          tracks: {
            opened: window.__tracks.length,
            stops: window.__trackStops,
            live: window.__tracks.filter((t) => t.readyState === 'live').length,
          },
          screenText: document.body.innerText.slice(0, 400),
        };
      });
      if (flags.includes('rec=1') && drawn) {
        const btn = page.locator('.live-rec-btn');
        r.recButton = await btn.count();
        if (r.recButton) {
          await btn.click();
          step('REC started');
          await page.waitForTimeout(5000);
          await btn.click();
          step('REC stopped');
          await page.waitForTimeout(6000);
          r.recError = await page.locator('.live-rec-error').allInnerTexts();
        }
      }
    } catch (e) {
      r.error = String(e).slice(0, 400);
      step(`ERROR ${r.error}`);
      r.state ??= await page
        .evaluate(() => ({ gum: window.__gum, screenText: document.body.innerText.slice(0, 400) }))
        .catch(() => null);
    }
    r.downloads = downloads;
    const gum = r.state?.gum ?? [];
    // MediaPipe's wasm prints its glog INFO/W lines through console.error ('INFO: Created
    // TensorFlow Lite XNNPACK delegate for CPU.'): logging, not failures.
    const benign = /^error: (INFO: |[IW]\d{4} )/;
    const errors = logs.filter(
      (l) => (l.startsWith('error') && !benign.test(l)) || l.startsWith('pageerror'),
    );
    r.pass =
      !r.error &&
      gum.length >= 1 &&
      gum.every((g) => g.ok) &&
      // Each screen released the camera before the next opened it; only try-on's track is live.
      gum.every((g) => g.liveBefore === 0) &&
      (r.state?.tracks?.live ?? 0) <= 1 &&
      r.state?.arStatus === 'drawn' &&
      errors.length === 0 &&
      (!flags.split('&').includes('rec=1') || downloads.length === 3);
    r.consoleErrors = errors;
    r.logs = logs.filter(
      (l) => !/X4122|OpenGL error checking|XNNPACK|Feedback manager|NORM_RECT|toNonIndexed/.test(l),
    );
    results.push(r);
    console.log(
      JSON.stringify({
        tag,
        pass: r.pass,
        window: r.window ?? null,
        drawn: r.state?.arStatus,
        phase: r.state?.phase,
        msg: r.state?.message,
        gum: (r.state?.gum ?? []).map((g) => (g.ok ? 'ok' : g.error)),
        workerFallback: r.state?.workerFallback,
        tracker: r.state?.tracker && {
          hz: r.state.tracker.inferenceHz,
          err: r.state.tracker.lastError,
          delegate: r.state.tracker.delegate,
        },
        arFps: r.state?.arFps,
        downloads: r.downloads,
        errors: r.logs.slice(0, 8),
        error: r.error ?? null,
      }),
    );
    await page.close().catch(() => {});
  }
} finally {
  clearTimeout(killer);
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  try {
    await context?.close();
  } catch {
    // best effort cleanup
  }
  try {
    await server?.close();
  } catch {
    // best effort cleanup
  }
  releaseHeavy();
  releaseBrowser();
  if (flag('--timing')) job('timing-end', '--requester', 'kiosk-live');
}
const failed = results.filter((r) => !r.pass).map((r) => r.tag);
console.log(
  failed.length
    ? `KIOSK-LIVE FAIL: ${failed.join(', ')}`
    : `KIOSK-LIVE PASS (${results.length} configs)`,
);
process.exitCode = failed.length ? 1 : 0;
