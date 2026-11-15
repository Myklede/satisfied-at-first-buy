// V6 browser evaluation of the live dynamics on the real main thread (mirror lab, kiosk-camera
// video). Numbers to .cache/v6/browser-*.json; frames (they show the user) ONLY to
// .cache/v6/frames/ (gitignored, checked first). Takes the machine-wide browser lock, runs its own
// no-HMR Vite on port 5800, at most 12 minutes.
//   node apps/web/src/engine/live/deform/eval/browserEval.mjs [--video cam-parka] [--seconds 40]
//        [--headed] [--ab 4]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../../../../../../..');
const OUT = join(ROOT, '.cache/v6');
const FRAMES = join(OUT, 'frames');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(name);
const video = arg('--video', 'cam-parka');
const seconds = Number(arg('--seconds', '40'));
const abShots = Number(arg('--ab', '4'));
const dyn = arg('--dyn', '1');
const LEASE_MS = 12 * 60 * 1000;

// Privacy: frames show the user; they must land in an ignored folder.
for (const p of [join(OUT, 'x.png'), join(FRAMES, 'x.png')])
  execFileSync('git', ['check-ignore', '-q', p], { cwd: ROOT });
if (freemem() / 1024 ** 3 < 2.5) throw new Error('Less than 2.5 GiB free RAM: not starting Chrome');

const { acquireBrowserSlot } = await import(
  pathToFileURL(join(ROOT, 'scripts/lookdev/browser-slot.mjs')).href
);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const release = await acquireBrowserSlot(`V6 live-dynamics eval ${stamp}`);
let server, context, timer;
try {
  mkdirSync(FRAMES, { recursive: true });
  const text = readFileSync(join(ROOT, 'data/reference-photos/toi.txt'), 'utf8');
  const h = Number(/height_cm:\s*([\d.]+)/.exec(text)?.[1]);
  const w = Number(/weight_kg:\s*([\d.]+)/.exec(text)?.[1]);
  const sex = /sex:\s*(male|female)/.exec(text)?.[1] ?? 'male';
  const { createServer } = await import('vite');
  server = await createServer({
    root: join(ROOT, 'apps/web'),
    configFile: join(ROOT, 'apps/web/src/engine/live/deform/eval/vite.v6.config.ts'),
    cacheDir: join(OUT, 'vite'),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 5800, strictPort: true, hmr: false, watch: { ignored: ['**/*'] } },
  });
  await server.listen();
  const origin = 'http://127.0.0.1:5800';
  const { chromium } = await import('playwright');
  context = await chromium.launchPersistentContext(join(OUT, 'chrome'), {
    channel: 'chrome',
    headless: !flag('--headed'),
    serviceWorkers: 'block',
    viewport: { width: 1600, height: 900 },
    args: [
      '--disable-background-networking',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  timer = setTimeout(() => void context?.close(), LEASE_MS);
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (['127.0.0.1', 'localhost'].includes(u.hostname) || ['data:', 'blob:'].includes(u.protocol))
      return route.continue();
    return route.abort();
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const refs = await (await fetch(`${origin}/sandbox/refs`)).json();
  // --phone a-b: frames of the user's phone video of the real parka (the turn, docs/look/
  // video-index.md 30-42 s) every 0.2 s, to .cache/v6/phone/ only, for a rough sway comparison.
  const phone = arg('--phone', null);
  if (phone) {
    const [a, b] = phone.split('-').map(Number);
    const dir = join(OUT, 'phone');
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['check-ignore', '-q', join(dir, 'x.png')], { cwd: ROOT });
    let name = null;
    for (const f of refs.folders)
      for (const file of f.files)
        if (file.kind === 'video' && file.name.endsWith('video-parka.mp4')) name = [f.name, file.name];
    if (!name) throw new Error('No video-parka.mp4 reference');
    await page.goto(`${origin}/`, { timeout: 120000 });
    const url = `/sandbox/ref?folder=${encodeURIComponent(name[0])}&name=${encodeURIComponent(name[1])}`;
    for (let t = a; t <= b + 1e-6; t += 0.2) {
      const png = await page.evaluate(
        async ({ url, t }) => {
          let v = document.getElementById('v6phone');
          if (!v) {
            v = document.createElement('video');
            v.id = 'v6phone';
            v.muted = true;
            v.src = url;
            document.body.append(v);
            await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
          }
          await new Promise((r) => {
            v.addEventListener('seeked', r, { once: true });
            v.currentTime = t;
          });
          const c = document.createElement('canvas');
          c.width = v.videoWidth / 2;
          c.height = v.videoHeight / 2;
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
          return c.toDataURL('image/png');
        },
        { url, t },
      );
      writeFileSync(join(dir, `parka-${t.toFixed(1).padStart(5, '0')}.png`), Buffer.from(png.split(',')[1], 'base64'));
    }
    console.log(`phone frames ${a}-${b} s written to ${dir}`);
  }
  if (!flag('--phone-only')) {
  let ref = null;
  for (const f of refs.folders)
    for (const file of f.files)
      if (file.kind === 'video' && file.name.endsWith(`${video}.mp4`)) ref = `${f.name}|${file.name}`;
  if (!ref) throw new Error(`No reference video ${video}`);
  const params = new URLSearchParams({
    mirrorlab: '',
    source: 'reference',
    ref,
    t: '0',
    h: String(h),
    w: String(w),
    sex,
    jacket: 'FB7675',
    dyn,
    dynyaw: arg('--dynyaw', '0'),
    finish: '0',
    mirror: '0',
  });
  await page.goto(`${origin}/?${params}`, { timeout: 120000 });
  await page.waitForFunction(() => window.__mirrorlab, null, { timeout: 120000 });
  await page.getByRole('button', { name: /Start video/ }).click();
  await page.waitForFunction(
    () => {
      const e = window.__mirrorlab.engine;
      return e.posedScene?.hasJacket && ['tracking', 'lost'].includes(e.currentState.phase);
    },
    null,
    { timeout: 240000 },
  );
  // In-page recorder: one sample per changed avatar version.
  await page.evaluate(() => {
    const engine = window.__mirrorlab.engine;
    const samples = [];
    window.__v6 = { samples, events: [] };
    let version = -1;
    const tick = () => {
      window.__v6.raf = requestAnimationFrame(tick);
      const a = engine.posedScene;
      if (!a || a.version === version) return;
      version = a.version;
      const d = a.deformers.get('dynamics');
      const disp = a.jacketPositions(),
        skin = a.skinnedJacketPositions();
      const hem = a.jacketAsset?.paths?.hem ?? [];
      let hemSum = 0,
        hemMax = 0;
      for (const i of hem) {
        const v = Math.hypot(disp[i * 3] - skin[i * 3], disp[i * 3 + 1] - skin[i * 3 + 1], disp[i * 3 + 2] - skin[i * 3 + 2]);
        hemSum += v;
        hemMax = Math.max(hemMax, v);
      }
      let held = 0;
      const md = d?.binding?.map.maxDist;
      if (md)
        for (let i = 0; i < md.length; i++)
          if (md[i] === 0)
            held = Math.max(held, Math.abs(disp[i * 3] - skin[i * 3]), Math.abs(disp[i * 3 + 1] - skin[i * 3 + 1]), Math.abs(disp[i * 3 + 2] - skin[i * 3 + 2]));
      const st = engine.stats();
      samples.push({
        t: performance.now(),
        video: engine.currentSource?.video?.currentTime ?? null,
        phase: engine.currentState.phase,
        applyMs: d?.status().lastApplyMs ?? null,
        simMs: d?.lastFrame.simMs ?? null,
        fineMs: d?.lastFrame.fineMs ?? null,
        substeps: d?.lastFrame.substeps ?? null,
        teleported: d?.lastFrame.teleported ?? null,
        reason: d?.lastFrame.reason ?? '',
        hemMeanMm: hem.length ? (hemSum / hem.length) * 1000 : null,
        hemMaxMm: hemMax * 1000,
        heldDevMm: held * 1000,
        poseMs: st.poseMs,
        sourceFps: st.sourceFps,
        renderFps: st.renderFps,
        yaw: st.rootYawDeg,
      });
    };
    tick();
  });
  const t0 = Date.now();
  let shots = 0,
    lastShot = 0;
  const abLog = [];
  while (Date.now() - t0 < seconds * 1000) {
    await page.waitForTimeout(400);
    const now = await page.evaluate(() => {
      const s = window.__v6.samples;
      const v = window.__mirrorlab.engine.currentSource?.video;
      return { hem: s.length ? s[s.length - 1].hemMeanMm : 0, ended: !v || v.ended, time: v?.currentTime };
    });
    if (now.ended) break;
    // A/B frames at moments of visible sway: pause, shot with dynamics, shot without, resume.
    if (shots < abShots && now.hem > 8 && Date.now() - lastShot > 5000) {
      lastShot = Date.now();
      const tag = `${video}-${String(Math.round(now.time * 10)).padStart(4, '0')}`;
      await page.evaluate(() => window.__mirrorlab.engine.currentSource.video.pause());
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(FRAMES, `${stamp}-${tag}-dyn-on.png`) });
      const off = await page.evaluate(() => {
        const e = window.__mirrorlab.engine;
        const a = e.posedScene;
        const before = Array.from(a.jacketPositions());
        e.setDynamics(false);
        a.setDrivers(a.last.drivers, a.last.world);
        e.arRenderer?.render(e.lastFrame, a);
        const after = a.jacketPositions();
        let max = 0;
        for (let i = 0; i < after.length; i++) max = Math.max(max, Math.abs(after[i] - before[i]));
        return { maxDiffMm: max * 1000 };
      });
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(FRAMES, `${stamp}-${tag}-dyn-off.png`) });
      await page.evaluate(() => {
        const e = window.__mirrorlab.engine;
        e.setDynamics(true);
        window.__v6.events.push({ t: performance.now(), kind: 'ab-toggle' });
        return e.currentSource.video.play();
      });
      abLog.push({ tag, videoTime: now.time, hemMeanMm: now.hem, displayVsSkinnedMaxMm: off.maxDiffMm });
      shots++;
    }
  }
  const data = await page.evaluate(() => {
    cancelAnimationFrame(window.__v6.raf);
    return { samples: window.__v6.samples, events: window.__v6.events, deform: window.__mirrorlab.engine.stats().deform };
  });
  const s = data.samples.filter((x) => x.applyMs !== null && !x.teleported && x.phase === 'tracking');
  const q = (v, p) => {
    const a = [...v].sort((x, y) => x - y);
    return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null;
  };
  const m = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
  const pick = (k) => s.map((x) => x[k]).filter((x) => Number.isFinite(x));
  const summary = {
    video,
    dyn,
    commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    frames: data.samples.length,
    trackedFrames: s.length,
    applyMs: { mean: m(pick('applyMs')), p95: q(pick('applyMs'), 0.95), max: Math.max(...pick('applyMs')) },
    simMs: { mean: m(pick('simMs')), p95: q(pick('simMs'), 0.95) },
    fineMs: { mean: m(pick('fineMs')), p95: q(pick('fineMs'), 0.95) },
    poseMsWithDeform: { mean: m(pick('poseMs')), p95: q(pick('poseMs'), 0.95) },
    substeps: { mean: m(pick('substeps')), max: Math.max(...pick('substeps')) },
    hemMeanMm: { mean: m(pick('hemMeanMm')), p95: q(pick('hemMeanMm'), 0.95), max: Math.max(...pick('hemMeanMm')) },
    heldDeviationMaxMm: Math.max(0, ...data.samples.map((x) => x.heldDevMm)),
    sourceFps: m(pick('sourceFps')),
    renderFps: m(pick('renderFps')),
    teleports: data.samples.filter((x) => x.teleported).map((x) => x.reason),
    yawRange: [Math.min(...pick('yaw')), Math.max(...pick('yaw'))],
    ab: abLog,
    deform: data.deform,
  };
  writeFileSync(join(OUT, `browser-${stamp}-${video}-dyn${dyn}.json`), JSON.stringify({ summary, samples: data.samples }, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  }
} finally {
  clearTimeout(timer);
  try {
    await context?.close();
  } finally {
    try {
      await server?.close();
    } finally {
      release();
    }
  }
}
