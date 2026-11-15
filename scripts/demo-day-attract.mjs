// Final-build follow-up: inspect real attract overlays and S's actual linked-program cue.
// No remote-debugging port; this job owns its Chrome and holds the shared browser lease.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, buildHash, waitForBrowserLock, judgePath } from './demo-day-warm.mjs';
import { startKioskServer } from './kiosk-server.mjs';

const labelIndex = process.argv.indexOf('--label');
const outputLabel = labelIndex < 0 ? 'attract-final' : process.argv[labelIndex + 1];
if (!/^[a-z0-9-]{1,50}$/.test(outputLabel ?? '')) throw new Error('Invalid evidence label');

const distIndex = process.argv.indexOf('--dist');
const distArg = distIndex < 0 ? 'apps/web/dist' : process.argv[distIndex + 1];
if (distArg !== 'apps/web/dist' && !/^\.cache\/cx-day\/[a-z0-9-]{1,48}$/.test(distArg))
  throw new Error('Expected CX-DAY dist path');
const dist = join(ROOT, distArg);
const report = {
  at: new Date().toISOString(),
  buildHash: buildHash(dist),
  runs: [],
};
const release = await waitForBrowserLock();
let server, context, timer;
try {
  timer = setTimeout(() => void context?.close(), 14 * 60000);
  server = await startKioskServer({
    dist,
    port: 5770,
    apiPort: 8001,
    status: () => ({ service: 'up' }),
    quit: () => {},
  });
  for (const deviceScaleFactor of [1, 1.25]) {
    const run = { deviceScaleFactor, screenshots: [], external: [] };
    report.runs.push(run);
    context = await chromium.launchPersistentContext(
      join(ROOT, '.cache/demo-day-attract', String(deviceScaleFactor)),
      {
        channel: 'chrome',
        headless: false,
        viewport: { width: 1536, height: 864 },
        deviceScaleFactor,
        args: [
          '--use-fake-device-for-media-stream',
          '--use-fake-ui-for-media-stream',
          '--force_high_performance_gpu',
          '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
        ],
      },
    );
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (
        ['127.0.0.1', 'localhost'].includes(url.hostname) ||
        ['data:', 'blob:'].includes(url.protocol)
      )
        return route.continue();
      run.external.push(url.origin + url.pathname);
      return route.abort();
    });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:5770/?kiosk');
    await page.waitForSelector('[data-screen="attract"]', { timeout: 180000 });
    const capture = async (label) => {
      const state = await page.evaluate(() => {
        const rect = (e) => {
          const r = e.getBoundingClientRect();
          return {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            right: r.right,
            bottom: r.bottom,
            zIndex: getComputedStyle(e).zIndex,
            opacity: getComputedStyle(e).opacity,
            isolation: getComputedStyle(e).isolation,
          };
        };
        return {
          pageMs: performance.now(),
          warm: document.documentElement.dataset.kioskWarm,
          stage: rect(document.querySelector('.k-stage')),
          card: rect(document.querySelector('.k-attract')),
          covers: [...document.querySelectorAll('.k-dress-cover')].map(rect),
          text: [...document.querySelectorAll('.k-attract h1,.k-attract p,.k-exit-hint')].map(
            (e) => ({ text: e.textContent, ...rect(e) }),
          ),
        };
      });
      const path = `demo-day-${outputLabel}-${label}-${deviceScaleFactor}.png`;
      await page.screenshot({ path: join(ROOT, 'docs/validation', path) });
      run.screenshots.push({ path, ...state });
      console.log(`CX-DAY attract ${label} @${deviceScaleFactor}, warm=${state.warm}`);
    };
    await page.waitForTimeout(2000);
    await capture('early');
    await page.waitForFunction(() => document.documentElement.dataset.kioskWarm === '1', null, {
      timeout: 180000,
    });
    for (const [width, height] of [
      [1920, 1080],
      [1600, 900],
      [1536, 864],
      [1366, 768],
      [1280, 720],
    ]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(600);
      await capture(`${width}x${height}`);
    }
    // Recheck the matrix's narrow-screen zip-panel/hint defect on the new source.
    run.judgePath = await judgePath(
      page,
      async (phase) => {
        if (phase !== 'feel') return;
        run.feel = await page.evaluate(() => {
          const a = document.querySelector('.k-feel-hint').getBoundingClientRect();
          const b = document.querySelector('.k-feel-zip').getBoundingClientRect();
          return {
            width: innerWidth,
            height: innerHeight,
            overlapPx2:
              Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
              Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)),
          };
        });
        run.feel.path = `demo-day-${outputLabel}-feel-1280-${deviceScaleFactor}.png`;
        await page.screenshot({ path: join(ROOT, 'docs/validation', run.feel.path) });
      },
      'http://127.0.0.1:5770',
    );
    await context.close();
    context = undefined;
  }
  report.complete =
    report.runs.length === 2 &&
    report.runs.every(
      (r) =>
        r.screenshots.length === 6 &&
        !r.external.length &&
        r.judgePath.complete &&
        r.judgePath.deleted,
    );
  report.layoutPass = report.runs.every((r) => r.feel?.overlapPx2 === 0);
  if (!report.complete || !report.layoutPass) process.exitCode = 1;
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  try {
    await context?.close();
  } finally {
    try {
      await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    } finally {
      release();
    }
  }
  writeFileSync(
    join(ROOT, `docs/validation/demo-day-${outputLabel}.json`),
    JSON.stringify(report, null, 2),
  );
}
