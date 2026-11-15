// Five script times: real jacket (left) versus native AR over the no-jacket video (right).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { acquireBrowserSlot } from './lookdev/browser-slot.mjs';
import { syncWorker } from './codex-day-slot.mjs';

const ROOT = resolve(import.meta.dirname, '..'),
  output = join(ROOT, '.cache/cx-day/venue');
execFileSync('git', ['check-ignore', '-q', join(output, 'sheet.png')], { cwd: ROOT });
mkdirSync(output, { recursive: true });
const jobs = [
  ['FB7675-100', 'FB7675-100-parka-trang'],
  ['DQ4920-206', 'DQ4920-206-puffer-kem'],
].map(([style, folder]) => ({
  style,
  real: join(ROOT, `data/reference-photos/${folder}/video/venue-mac-ao.mp4`),
  bare: join(ROOT, `data/reference-photos/${folder}/video/venue-khong-ao.mp4`),
}));
const available = jobs.filter((j) => existsSync(j.real) && existsSync(j.bare));
const matchesPath = join(output, 'matches.json');
if (!existsSync(matchesPath))
  writeFileSync(
    matchesPath,
    JSON.stringify(
      {
        note: 'Lead intake approximations, not automatic motion alignment. Fill missing arms-up/cross-arms/turn matches after reviewing the actual long clips.',
        'FB7675-100': [
          { label: 'front-approx', realSeconds: 4, arSeconds: 4 },
          { label: 'back-approx', realSeconds: 113, arSeconds: 46 },
        ],
        'DQ4920-206': [],
      },
      null,
      2,
    ) + '\n',
  );
const matches = JSON.parse(readFileSync(matchesPath, 'utf8'));
const report = {
  generatedUtc: new Date().toISOString(),
  status: available.length ? 'PENDING' : 'NO COMPLETE VENUE JACKET PAIRS',
  sheets: [],
};
let release, server, context, timer;
try {
  if (available.length) {
    syncWorker('CX-DAY', 'SLOT REQUEST P22 venue real versus AR sheets');
    readFileSync(join(ROOT, 'docs/requests/codex-sync.md'), 'utf8');
    release = await acquireBrowserSlot('CX-DAY P22 venue sheets');
    const { createServer } = await import('vite');
    server = await createServer({
      root: join(ROOT, 'apps/web'),
      configFile: join(ROOT, 'apps/web/vite.config.ts'),
      cacheDir: join(output, 'vite'),
      logLevel: 'error',
      server: {
        host: '127.0.0.1',
        port: 5771,
        strictPort: true,
        hmr: false,
        watch: { ignored: ['**/*'] },
      },
    });
    await server.listen();
    const { chromium } = await import('playwright');
    context = await chromium.launchPersistentContext(join(output, 'chrome-sheet'), {
      channel: 'chrome',
      headless: false,
      args: [
        '--disable-background-networking',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    timer = setTimeout(() => void context.close(), 9 * 60000);
    await context.route('**/*', (route) => {
      const u = new URL(route.request().url());
      return ['127.0.0.1', 'localhost'].includes(u.hostname) ||
        ['data:', 'blob:'].includes(u.protocol)
        ? route.continue()
        : route.abort();
    });
    for (const job of available) {
      const page = await context.newPage();
      page.setDefaultTimeout(45000);
      try {
        await page.goto(
          `http://127.0.0.1:5771/?arlab&source=file&jacket=${job.style}&size=S&h=172&w=65&sex=male&still=0&finish=1`,
        );
        await page.waitForFunction(() =>
          [...document.querySelectorAll('.arlab select')].some((s) =>
            /^[a-f0-9]{64}$/.test(s.value),
          ),
        );
        const selected = await page.evaluate(async () => {
          const select = [...document.querySelectorAll('.arlab select')].find((s) =>
            /^[a-f0-9]{64}$/.test(s.value),
          );
          return (await fetch('/api/products').then((r) => r.json())).find(
            (p) => p.product_id === select.value,
          )?.style;
        });
        if (selected !== job.style) throw new Error('Venue selected style mismatch');
        await page.locator('input[type=file]').setInputFiles(job.bare);
        await page.getByRole('button', { name: /^(Start|Restart)$/ }).click();
        await page.waitForFunction(() => window.__arlab?.sample().phase === 'tracking');
        await page.evaluate(() => {
          const input = document.createElement('input');
          input.type = 'file';
          input.id = 'venue-real';
          document.body.append(input);
        });
        await page.locator('#venue-real').setInputFiles(job.real);
        const samples = [];
        for (const match of matches[job.style] ?? []) {
          const { label, realSeconds, arSeconds } = match;
          if (
            typeof label !== 'string' ||
            ![realSeconds, arSeconds].every((v) => Number.isFinite(v) && v >= 0)
          )
            throw new Error('Invalid local venue time match');
          const raw = await page.evaluate(
            async ({ realSeconds, arSeconds }) => {
              if (!window.__venueReal) {
                const v = document.createElement('video');
                v.muted = true;
                v.src = URL.createObjectURL(document.querySelector('#venue-real').files[0]);
                await new Promise((ok, bad) => {
                  v.onloadeddata = ok;
                  v.onerror = bad;
                });
                window.__venueReal = v;
              }
              const real = window.__venueReal,
                source = window.__arlab.engine.currentSource.video;
              if (realSeconds >= real.duration || arSeconds >= source.duration)
                throw new Error('Venue clip shorter than labelled script time');
              for (const [v, time] of [
                [real, realSeconds],
                [source, arSeconds],
              ]) {
                v.pause();
                await new Promise((ok) => {
                  v.addEventListener('seeked', ok, { once: true });
                  v.currentTime = time;
                  if (!v.seeking) ok();
                });
              }
              await new Promise((ok) => setTimeout(ok, 900));
              const canvas = document.createElement('canvas');
              canvas.width = real.videoWidth;
              canvas.height = real.videoHeight;
              canvas.getContext('2d').drawImage(real, 0, 0);
              window.__arlab.ar.renderer.domElement.id = 'venue-ar';
              return canvas.toDataURL();
            },
            { realSeconds, arSeconds },
          );
          const ar = await page.locator('#venue-ar').screenshot();
          samples.push({
            label,
            realSeconds,
            arSeconds,
            raw,
            ar: `data:image/png;base64,${ar.toString('base64')}`,
          });
        }
        const sheet = await context.newPage();
        try {
          await sheet.setContent(
            '<body style="background:#222;color:white;font:16px sans-serif;margin:0"><main id="sheet"></main>',
          );
          await sheet.evaluate(async (samples) => {
            const main = document.getElementById('sheet');
            for (const s of samples) {
              const label = document.createElement('p');
              label.textContent = `${s.label}: real ${s.realSeconds}s | AR ${s.arSeconds}s (approximate action match)`;
              main.append(label);
              const row = document.createElement('div');
              for (const src of [s.raw, s.ar]) {
                const img = document.createElement('img');
                img.width = 560;
                img.height = 320;
                img.style.objectFit = 'contain';
                img.src = src;
                row.append(img);
              }
              main.append(row);
            }
            await Promise.all([...document.images].map((i) => i.decode()));
          }, samples);
          const path = join(output, `${job.style}-real-versus-ar.png`);
          await sheet.locator('#sheet').screenshot({ path });
          report.sheets.push({
            style: job.style,
            matchedPoses: samples.map((s) => s.label),
            completeFivePoses: samples.length >= 5,
            path: path.slice(ROOT.length + 1).replaceAll('\\', '/'),
          });
        } finally {
          await sheet.close();
        }
      } finally {
        await page.close();
      }
    }
    report.status =
      'SHEETS CREATED; approximate action matches from private matches.json; missing poses remain unverified';
  }
} catch (error) {
  report.error = error.message;
  if (/Access is denied/i.test(error.message))
    syncWorker(
      'CX-DAY',
      'LEAD RUN REQUEST: node scripts/ar-venue-sheet.mjs ; Vite/esbuild Access is denied; no retry.',
    );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  try {
    await context?.close();
  } finally {
    try {
      await server?.close();
    } finally {
      if (release) {
        release();
        syncWorker('CX-DAY', 'SLOT RELEASE P22 venue sheets');
      }
    }
  }
  writeFileSync(join(output, 'sheets.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
