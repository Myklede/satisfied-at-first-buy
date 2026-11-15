// P2 evidence: open /?motion&auto (public reference body, DQ4920-206, S vs M) in headed Chrome
// (user-authorised Playwright, local only), wait for each motion's bakes, hold the peak and save
// docs/validation/motion-fit-<motion>.png (S left, M right; front view, plus back view for the
// bend). Also records bake times as seen by the browser workers and the playback fps.
//   node scripts/motion-fit-shots.mjs [baseUrl=http://127.0.0.1:5710]
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const base = process.argv[2] ?? 'http://127.0.0.1:5710';
const only = process.argv[3]?.split(',');
const ALL = [
  'reach_up_both',
  'reach_up_one',
  'reach_forward',
  'sit',
  'bend_tie_shoes',
  'cross_arms',
];
const MOTIONS = only ?? ALL;
const context = await chromium.launchPersistentContext('.cache/playwright/motion', {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1600, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());
const log = [];
page.on('console', (m) => m.type() === 'error' && log.push(m.text()));
// Agent G's uncommitted garment work adds `render_material_v` to the cloth asset before the
// web API types know it (strict zod schema). The motion bake does not use it; drop only that
// field so the evidence run is not blocked. Remove this once api.ts includes the field.
await page.route('**/api/fit/*/*/cloth', async (route) => {
  const response = await route.fetch();
  const asset = await response.json();
  delete asset.render_material_v;
  await route.fulfill({ response, json: asset });
});
await page.goto(`${base}/?motion&auto`);
await page.waitForFunction(() => !!window.__satisfyMotion, null, { timeout: 120000 });
const results = [];
for (const motion of MOTIONS) {
  const started = Date.now();
  await page.evaluate((m) => window.__satisfyMotion.select(m), motion);
  await page.waitForFunction(
    (m) => {
      const s = window.__satisfyMotion.state();
      if (s.error) throw new Error(s.error);
      return s.ready && s.motion === m;
    },
    motion,
    { timeout: 15 * 60000, polling: 1000 },
  );
  const waitedS = (Date.now() - started) / 1000;
  // Playback fps over 3 s while playing.
  await page.evaluate(() => window.__satisfyMotion.play(true));
  const fps = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 0;
        const t0 = performance.now();
        const tick = () => {
          n++;
          if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
          else resolve((n * 1000) / (performance.now() - t0));
        };
        requestAnimationFrame(tick);
      }),
  );
  await page.evaluate(() => window.__satisfyMotion.seek('peak'));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `docs/validation/motion-fit-${motion}.png` });
  if (motion === 'bend_tie_shoes' || motion === 'reach_up_both') {
    await page.evaluate(() => window.__satisfyMotion.view('back'));
    await page.waitForTimeout(600);
    await page.screenshot({ path: `docs/validation/motion-fit-${motion}-back.png` });
    await page.evaluate(() => window.__satisfyMotion.view('front'));
  }
  const r = await page.evaluate(() => window.__satisfyMotion.results());
  results.push({
    motion,
    waitedS,
    playbackFps: fps,
    sizes: r.map((x) => ({
      size: x.size,
      timings: x.timings,
      exposureMid: x.summary.exposure.mid,
      wrist: x.summary.wrist,
      maxStrain: x.checks.maxStrain,
    })),
  });
  console.log(
    motion,
    `waited ${waitedS.toFixed(0)} s`,
    `fps ${fps.toFixed(0)}`,
    r.map((x) => `${x.size} ${(x.timings.totalMs / 1000).toFixed(1)} s`).join(' '),
  );
}
await writeFile(
  only ? '.cache/motion-fit/browser-partial.json' : 'docs/validation/motion-fit-browser.json',
  JSON.stringify({ results, consoleErrors: log }, null, 1) + '\n',
);
await context.close();
