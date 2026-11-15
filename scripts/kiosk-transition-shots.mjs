// B3 evidence: a short frame sequence of the Continue -> result transition (CDP screencast,
// so capturing does not stall the page). Frames are JPEGs in .cache/kiosk-transition/ (gitignored;
// they show only the synthetic fake-camera session, but stay local anyway).
//   node scripts/kiosk-transition-shots.mjs [--port 5720] [--api-port 8011] [--reduced]
// Hold .cache/locks/browser while it runs (machine-wide rule, prompt 09).
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const port = opt('--port', 5720);
const apiPort = opt('--api-port', 8011);
const reduced = args.includes('--reduced');
const out = join(root, '.cache/kiosk-transition', reduced ? 'reduced' : 'normal');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const kiosk = spawn(
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
const stopKiosk = () => {
  if (kiosk.pid && kiosk.exitCode === null)
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

const context = await chromium.launchPersistentContext(
  join(root, '.cache/playwright/kiosk-transition'),
  {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
    reducedMotion: reduced ? 'reduce' : 'no-preference',
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--force_high_performance_gpu',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--window-position=-2400,0',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
    ],
  },
);
try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${base}/?kiosk`);
  await page.bringToFront();
  await page.waitForSelector('[data-screen="attract"]', { timeout: 180000 });
  await page.keyboard.press('Space');
  await page.waitForSelector('[data-screen="you"]');
  await page.getByRole('button', { name: 'cm · kg' }).click();
  await page.getByLabel('Height centimetres').fill('175');
  await page.getByLabel('Weight kilograms').fill('60');
  await page.getByRole('button', { name: 'Male', exact: true }).click();
  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.waitForSelector('[data-screen="scan"]');
  await page.waitForTimeout(2500);
  const cdp = await context.newCDPSession(page);
  const frames = [];
  const t0 = Date.now();
  cdp.on('Page.screencastFrame', async (f) => {
    frames.push({ t: Date.now() - t0, data: f.data });
    await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, everyNthFrame: 1 });
  // Page-side rAF log of the dissolve covers (opacity per frame) so the fade is measured even
  // when the screencast skips frames: [ms since Skip, cover count, opacities].
  await page.evaluate(() => {
    const t0 = performance.now();
    const log = (window.__coverLog = []);
    let last = '';
    const tick = () => {
      const o = [...document.querySelectorAll('.k-dress-cover')].map((c) =>
        Number(getComputedStyle(c).opacity).toFixed(2),
      );
      const key = o.join(',');
      if (key !== last) {
        last = key;
        log.push([Math.round(performance.now() - t0), o.length, o]);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.getByRole('button', { name: /Skip scan|Continue without scan|Continue →/ }).click();
  await page.waitForSelector('[data-screen="result"]', { timeout: 240000 });
  const resultAt = Date.now() - t0;
  await page.waitForTimeout(3500);
  await cdp.send('Page.stopScreencast');
  const coverLog = await page.evaluate(() => window.__coverLog ?? []);
  // Keep ~every 250 ms around the result screen (frame times are compositor times).
  let last = -1e9;
  const kept = [];
  for (const f of frames) {
    const near = f.t >= resultAt - 1500;
    if (f.t - last >= (near ? 120 : 600)) {
      last = f.t;
      const name = `t${String(f.t).padStart(6, '0')}.jpg`;
      writeFileSync(join(out, name), Buffer.from(f.data, 'base64'));
      kept.push({ name, ms: f.t, afterResultMs: f.t - resultAt });
    }
  }
  writeFileSync(
    join(out, 'index.json'),
    JSON.stringify({ resultAt, reduced, coverLog, frames: kept }, null, 2),
  );
  console.log(
    `saved ${kept.length}/${frames.length} frames to ${out}; result screen at ${resultAt} ms; cover log ${JSON.stringify(coverLog)}`,
  );
} finally {
  await context.close();
  stopKiosk();
}
