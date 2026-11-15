// One lock window per viewport. No application state is changed through diagnostic hooks.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, waitForBrowserLock, judgePath, buildHash } from './demo-day-warm.mjs';
import { startKioskServer } from './kiosk-server.mjs';

const report = { at: new Date().toISOString(), scenarios: [], complete: false };
const out = join(ROOT, 'docs/validation');
const thumbnails = [];
const deadline = Date.now() + 3 * 60 * 60000;
report.buildHash = buildHash(join(ROOT, 'apps/web/dist'));
try {
  for (const [width, height] of [
    [1920, 1080],
    [1600, 900],
    [1536, 864],
    [1366, 768],
    [1280, 720],
  ]) {
    for (const deviceScaleFactor of [1, 1.25]) {
      const release = await waitForBrowserLock(deadline);
      let context, server, timer;
      const scenario = { width, height, deviceScaleFactor, screens: [] };
      console.log(`CX-DAY matrix ${width}x${height} @${deviceScaleFactor}`);
      report.scenarios.push(scenario);
      try {
        server = await startKioskServer({
          dist: join(ROOT, 'apps/web/dist'),
          port: 5791,
          apiPort: 8001,
          status: () => ({ service: 'up' }),
          quit: () => {},
        });
        context = await chromium.launchPersistentContext(
          join(ROOT, '.cache/demo-day-matrix', `${width}-${deviceScaleFactor}`),
          {
            channel: 'chrome',
            headless: false,
            viewport: { width, height },
            deviceScaleFactor,
            args: [
              '--use-fake-device-for-media-stream',
              '--use-fake-ui-for-media-stream',
              '--force_high_performance_gpu',
              '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
            ],
          },
        );
        timer = setTimeout(() => void context.close(), 14 * 60000);
        await context.route('**/*', (route) => {
          const u = new URL(route.request().url());
          return ['127.0.0.1', 'localhost'].includes(u.hostname) ||
            ['data:', 'blob:'].includes(u.protocol)
            ? route.continue()
            : route.abort();
        });
        const page = await context.newPage();
        scenario.path = await judgePath(
          page,
          async (phase) => {
            const path = `demo-day-${width}-${deviceScaleFactor}-${phase}.png`;
            const problems = await page.evaluate(() => {
              const modal = document.querySelector('.motion-studio');
              const visible = (e) =>
                (!modal || modal.contains(e)) &&
                e.getBoundingClientRect().width > 0 &&
                e.getBoundingClientRect().height > 0 &&
                getComputedStyle(e).visibility !== 'hidden';
              const findings = [];
              for (const e of [
                ...document.querySelectorAll(
                  'button.k-primary, .k-moves, .motion-actions button, .motion-close, .motion-controls button, .motion-toggles button',
                ),
              ].filter(visible)) {
                const r = e.getBoundingClientRect();
                if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight)
                  findings.push({ type: 'button-outside', text: e.textContent });
                const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                if (top !== e && !e.contains(top))
                  findings.push({ type: 'button-covered', text: e.textContent });
              }
              for (const e of [...document.querySelectorAll('h1,h2,h3,p,button,label')].filter(
                visible,
              ))
                if (e.scrollWidth > e.clientWidth + 1)
                  findings.push({ type: 'text-overflow', text: e.textContent });
              const panels = [
                ...document.querySelectorAll(
                  '.k-card,.k-feel-compare,.k-feel-zip,.k-feel-hint,.k-footer',
                ),
              ].filter(visible);
              for (let i = 0; i < panels.length; i++)
                for (let j = i + 1; j < panels.length; j++) {
                  const a = panels[i].getBoundingClientRect(),
                    b = panels[j].getBoundingClientRect();
                  if (
                    Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1 &&
                    Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1
                  )
                    findings.push({
                      type: 'panel-overlap',
                      a: panels[i].className,
                      b: panels[j].className,
                    });
                }
              return findings;
            });
            await page.screenshot({ path: join(out, path) });
            scenario.screens.push({ phase, path, problems });
            thumbnails.push({
              label: `${width}x${height} @${deviceScaleFactor} ${phase}`,
              data: readFileSync(join(out, path)).toString('base64'),
            });
          },
          'http://127.0.0.1:5791',
        );
        // A kiosk-render-only contact sheet, assembled locally in the same browser.
        const sheet = await context.newPage();
        await sheet.setViewportSize({
          width: 1200,
          height: Math.ceil(thumbnails.length / 4) * 200,
        });
        await sheet.setContent(
          '<body style="margin:0;background:#222;color:white;display:grid;grid-template-columns:repeat(4,300px)">' +
            thumbnails
              .map(
                (t) =>
                  `<div style="height:200px;font:12px sans-serif">${t.label}<img style="width:300px;height:175px;object-fit:contain" src="data:image/png;base64,${t.data}"></div>`,
              )
              .join(''),
        );
        await sheet.locator('img').evaluateAll((imgs) => Promise.all(imgs.map((i) => i.decode())));
        await sheet.screenshot({ path: join(out, 'demo-day-matrix.png'), fullPage: true });
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
      }
      writeFileSync(join(out, 'demo-day-matrix.json'), JSON.stringify(report, null, 2));
    }
  }
  report.complete =
    report.scenarios.length === 10 &&
    report.scenarios.every((s) => s.path?.complete && s.path?.deleted && s.screens.length === 7);
  if (!report.complete) process.exitCode = 1;
} catch (e) {
  report.error = String(e);
  process.exitCode = 1;
} finally {
  writeFileSync(join(out, 'demo-day-matrix.json'), JSON.stringify(report, null, 2));
}
