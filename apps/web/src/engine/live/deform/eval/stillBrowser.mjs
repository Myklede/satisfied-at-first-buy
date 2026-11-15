// V6: the mirror jacket at rest on the kiosk-camera videos, stillness lock off/on, dynamics
// off/on (mirror lab; V2's AR and its own lock as the lab ships them). Per frame: RMS motion of
// the shown jacket's vertices (mm) inside the still window (video time), only while tracking.
// Numbers only, to .cache/v6/still-browser-*.json. Machine-wide browser lock, own no-HMR Vite on
// 5800, ≤ 12 min.   node apps/web/src/engine/live/deform/eval/stillBrowser.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../../../../../../..');
const OUT = join(ROOT, '.cache/v6');
const LEASE_MS = 12 * 60 * 1000;
const WINDOWS = [
  { video: 'cam-parka', from: 1.5, to: 3.0 },
  { video: 'cam-tshirt', from: 1.2, to: 3.0 },
];
const CONFIGS = [
  { still: '0', dyn: '0' },
  { still: '1', dyn: '0' },
  { still: '1', dyn: '1' },
];
if (freemem() / 1024 ** 3 < 2.5) throw new Error('Less than 2.5 GiB free RAM');
const { acquireBrowserSlot } = await import(
  pathToFileURL(join(ROOT, 'scripts/lookdev/browser-slot.mjs')).href
);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const release = await acquireBrowserSlot(`V6 stillness eval ${stamp}`);
let server, context, timer;
const results = [];
try {
  mkdirSync(OUT, { recursive: true });
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
    headless: true,
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
  for (const win of WINDOWS) {
    let ref = null;
    for (const f of refs.folders)
      for (const file of f.files)
        if (file.kind === 'video' && file.name.endsWith(`${win.video}.mp4`)) ref = `${f.name}|${file.name}`;
    for (const cfg of CONFIGS) {
      const params = new URLSearchParams({
        mirrorlab: '',
        source: 'reference',
        ref,
        t: '0',
        h: String(h),
        w: String(w),
        sex,
        jacket: 'FB7675',
        finish: '0',
        mirror: '0',
        ...cfg,
      });
      await page.goto(`${origin}/?${params}`, { timeout: 120000 });
      await page.waitForFunction(() => window.__mirrorlab, null, { timeout: 120000 });
      await page.getByRole('button', { name: /Start video/ }).click();
      await page.waitForFunction(
        () => {
          const e = window.__mirrorlab.engine;
          return e.posedScene?.hasJacket && e.currentState.phase === 'tracking';
        },
        null,
        { timeout: 240000 },
      );
      // Calibrated and tracking: replay the still window (a little before it, to settle).
      const samples = await page.evaluate(
        async ({ from, to }) => {
          const e = window.__mirrorlab.engine;
          const v = e.currentSource.video;
          v.pause();
          await new Promise((r) => {
            v.addEventListener('seeked', r, { once: true });
            v.currentTime = Math.max(0, from - 0.6);
          });
          const out = [];
          let version = -1;
          let prev = null;
          await v.play();
          await new Promise((done) => {
            const tick = () => {
              if (v.currentTime >= to || v.ended) return done();
              requestAnimationFrame(tick);
              const a = e.posedScene;
              if (!a || a.version === version) return;
              version = a.version;
              const p = a.jacketPositions();
              let s = 0;
              if (prev && prev.length === p.length)
                for (let i = 0; i < p.length; i++) s += (p[i] - prev[i]) ** 2;
              const rms = prev ? Math.sqrt(s / (p.length / 3)) * 1000 : null;
              prev = p.slice();
              out.push({
                video: v.currentTime,
                phase: e.currentState.phase,
                rmsMm: rms,
                locked: e.stats().stillLocked,
                deform: e.stats().deform.map((d) => `${d.name}:${d.active ? 'on' : 'off'}`),
              });
            };
            tick();
          });
          v.pause();
          return out;
        },
        { from: win.from, to: win.to },
      );
      const inWin = samples.filter((s) => s.video >= win.from && s.video <= win.to && s.phase === 'tracking' && s.rmsMm !== null);
      const rms = inWin.length ? Math.sqrt(inWin.reduce((a, s) => a + s.rmsMm ** 2, 0) / inWin.length) : null;
      const row = {
        video: win.video,
        window: [win.from, win.to],
        ...cfg,
        frames: inWin.length,
        vertexMotionRmsMm: rms === null ? null : Math.round(rms * 1000) / 1000,
        worstFrameMm: inWin.length ? Math.max(...inWin.map((s) => s.rmsMm)) : null,
        lockedShare: inWin.length ? inWin.filter((s) => s.locked.length >= 3).length / inWin.length : null,
        deform: inWin[0]?.deform ?? null,
      };
      results.push({ ...row, samples });
      console.log(JSON.stringify(row));
    }
  }
  writeFileSync(join(OUT, `still-browser-${stamp}.json`), JSON.stringify(results, null, 1));
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
