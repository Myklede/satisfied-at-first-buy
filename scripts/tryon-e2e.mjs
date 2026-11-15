// CX-TRY: one guarded Chrome lease, fake camera only, no user images or recordings.
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { withBrowserSlot, browserReadiness } from './lookdev/browser-slot.mjs';
import { startKioskServer } from './kiosk-server.mjs';
const root = resolve(import.meta.dirname, '..');
const runnerSha256 = createHash('sha256')
  .update(readFileSync(import.meta.filename))
  .digest('hex');
const real = process.argv.includes('--real');
const captureOnly = process.argv.includes('--capture-only');
const withCapture = captureOnly || process.argv.includes('--capture');
const mode = captureOnly ? 'capture' : real ? 'real' : 'mock';
const port = 5780;
mkdirSync(join(root, '.cache/tryon'), { recursive: true });
const work = mkdtempSync(join(root, '.cache/tryon/e2e-'));
const output = join(root, 'docs/validation');
const result = {
  mode,
  started: new Date().toISOString(),
  checks: [],
  console: [],
  native_info: [],
  external_attempts: 0,
  external_completed: 0,
  passed: false,
  screenshots: [],
  layouts: [],
};
const check = (name, ok, detail = '') => {
  result.checks.push({ name, ok, detail });
  console.log(`[tryon] ${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) throw Error(name);
};
const waitDeadline = Date.now() + 60 * 60_000;
try {
  await withBrowserSlot(
    `CX-TRY item0 ${new Date().toISOString().replace(/[:.]/g, '-')}`,
    async () => {
      let context, server;
      const lease = setTimeout(() => void context?.close(), 14 * 60_000);
      try {
        if (process.argv.includes('--gates')) {
          for (const [script, args] of [
            ['node_modules/typescript/bin/tsc', ['-p', 'apps/web/tsconfig.json', '--noEmit']],
            [
              'node_modules/vitest/vitest.mjs', // Serial CPU fixtures: two workers exceeded the unchanged 5s engine test on this laptop.
              ['run', '--root', 'apps/web', '--maxWorkers=1'],
            ],
          ]) {
            const gate = spawnSync(process.execPath, [join(root, script), ...args], {
              cwd: root,
              stdio: 'inherit',
            });
            if (gate.status !== 0) throw Error(`Gate failed: ${script}`);
          }
        }
        if (process.argv.includes('--gates') || process.argv.includes('--agent-tests')) {
          const agentTests = readdirSync(join(root, 'services/body/tests'))
            .filter((name) => /^test_(agent_.*|fit_agent.*)\.py$/.test(name))
            .map((name) => `tests/${name}`);
          const python = spawnSync(
            join(root, '.venv/Scripts/python.exe'),
            ['-m', 'pytest', '-q', '--basetemp', join(work, 'pytest'), ...agentTests],
            { cwd: join(root, 'services/body'), stdio: 'inherit' },
          );
          if (python.status !== 0) throw Error('Gate failed: Python agent tests');
        }
        const build = spawnSync(
          process.execPath,
          [
            join(root, 'node_modules/vite/bin/vite.js'),
            'build',
            join(root, 'apps/web'),
            ...(withCapture
              ? ['--config', join(root, 'apps/web/src/labs/capture/vite.capture.config.mjs')]
              : []),
            '--outDir',
            join(work, 'dist'),
          ],
          { cwd: root, stdio: 'inherit' },
        );
        if (build.status !== 0) throw Error('Web build failed');
        const files = [
          'apps/web/src/kiosk/tryon/TryOnScreen.tsx',
          'apps/web/src/kiosk/tryon/session.ts',
          'apps/web/src/kiosk/tryon/mockLiveTryOn.ts',
          'apps/web/src/kiosk/tryon/presentation.ts',
          'apps/web/src/kiosk/tryon/playback.ts',
          'apps/web/src/kiosk/tryon/selection.ts',
          'apps/web/src/kiosk/tryon/coach.ts',
          'apps/web/src/kiosk/tryon/viewMode.ts',
          'scripts/tryon-e2e.mjs',
          'apps/web/src/kiosk/tryon/tryon.css',
          'apps/web/src/kiosk/KioskApp.tsx',
          'apps/web/src/kiosk/ScanScreen.tsx',
          'apps/web/src/kiosk/FeelScreen.tsx',
          'apps/web/src/kiosk/kiosk.css',
          'apps/web/src/kiosk/backgroundMotion.ts',
          'apps/web/src/kiosk/tryon/bodyBasis.ts',
          'packages/vision/src/scan.ts',
          'apps/web/src/engine/live/contract.ts',
        ];
        if (withCapture)
          files.push(
            'apps/web/src/main.tsx',
            ...readdirSync(join(root, 'apps/web/src/labs/capture'))
              .filter((name) => /\.(ts|tsx|css|mjs)$/.test(name))
              .map((name) => `apps/web/src/labs/capture/${name}`),
          );
        result.source_sha256 = Object.fromEntries(
          files.map((p) => [
            p,
            p === 'scripts/tryon-e2e.mjs'
              ? runnerSha256
              : createHash('sha256')
                  .update(readFileSync(join(root, p)))
                  .digest('hex'),
          ]),
        );
        server = await startKioskServer({
          dist: join(work, 'dist'),
          port,
          apiPort: 8001,
          log: console.log,
          status: () => ({ service: 'up', restarts: 0 }),
          quit: () => undefined,
        });
        context = await chromium.launchPersistentContext(join(work, 'chrome'), {
          channel: 'chrome',
          headless: false,
          viewport: { width: 1920, height: 1080 },
          colorScheme: 'light',
          acceptDownloads: true,
          downloadsPath: join(work, 'downloads'),
          permissions: ['camera'],
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--disable-background-networking',
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
          ],
        });
        context.on('requestfinished', (req) => {
          const u = new URL(req.url());
          if (
            ['http:', 'https:'].includes(u.protocol) &&
            !['127.0.0.1', 'localhost'].includes(u.hostname)
          )
            result.external_completed++;
        });
        await context.route('**/*', (route) => {
          const u = new URL(route.request().url());
          if (
            ['127.0.0.1', 'localhost'].includes(u.hostname) ||
            ['data:', 'blob:'].includes(u.protocol)
          )
            return route.continue();
          result.external_attempts++;
          return route.abort();
        });
        await context.addInitScript(() => {
          globalThis.__tryonStreams = [];
          const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
          navigator.mediaDevices.getUserMedia = async (...args) => {
            const hold = globalThis.__tryonHoldCamera === true;
            const stream = await original(...args);
            globalThis.__tryonStreams.push(stream);
            if (hold)
              await new Promise((resolve) => {
                globalThis.__tryonReleaseCamera = resolve;
              });
            return stream;
          };
        });
        const page = context.pages()[0] ?? (await context.newPage());
        page.setDefaultTimeout(45000);
        page.on('pageerror', (error) => result.console.push(error.stack || error.message));
        page.on('console', (message) => {
          if (message.type() !== 'error') return;
          const line = message.text();
          // MediaPipe writes this native INFO line to stderr/console.error on CPU startup.
          // Preserve it separately; actual errors (including all other native lines) still fail.
          if (line === 'INFO: Created TensorFlow Lite XNNPACK delegate for CPU.')
            result.native_info.push(line);
          else result.console.push(line);
        });
        const screen = page.locator('[data-screen="live-tryon"]');
        const phase = async (name) => {
          await page.locator(`[data-screen="live-tryon"][data-phase="${name}"]`).waitFor();
          check(`phase ${name}`, true);
        };
        const capture = async (name, cdp, scale = 1) => {
          const file = `tryon-screen-${mode}-${name}.png`;
          let png;
          let clipScale = 1;
          if (cdp) {
            const viewport = await page.evaluate(() => ({
              width: innerWidth,
              height: innerHeight,
            }));
            const take = async (factor) =>
              Buffer.from(
                (
                  await cdp.send('Page.captureScreenshot', {
                    format: 'png',
                    fromSurface: true,
                    captureBeyondViewport: true,
                    clip: { x: 0, y: 0, ...viewport, scale: factor },
                  })
                ).data,
                'base64',
              );
            png = await take(1);
            // CDP surface scale differs from the Playwright context's launch-time DPR.
            // Request the desired device raster directly from Chrome; no image postprocessing.
            const surfaceRatio = png.readUInt32BE(16) / viewport.width;
            if (Math.abs(surfaceRatio - scale) > 1e-6) {
              clipScale = scale / surfaceRatio;
              png = await take(clipScale);
            }
            writeFileSync(join(output, file), png);
          } else png = await page.screenshot({ path: join(output, file) });
          result.screenshots.push(file);
          return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), clipScale };
        };
        const verifyCapture = async () => {
          const { runCaptureCheck } = await import('../apps/web/src/labs/capture/e2e.mjs');
          await runCaptureCheck({ page, context, port, work, result, check, capture });
        };
        if (captureOnly) {
          await verifyCapture();
          check(
            'no own console errors',
            result.console.length === 0,
            JSON.stringify(result.console),
          );
          check(
            'no non-loopback traffic',
            result.external_attempts === 0 && result.external_completed === 0,
          );
          result.passed = true;
          return;
        }
        await page.goto(`http://127.0.0.1:${port}/?kiosk${real ? '' : '&tryonmock'}`);
        await page.locator('[data-screen="attract"]').waitFor({ timeout: 180000 });
        const enterScan = async (holdCamera = false) => {
          await page.locator('[data-screen="attract"]').click();
          await page.getByRole('button', { name: 'cm · kg', exact: true }).click();
          await page.getByLabel('Height centimetres').fill('172');
          await page.getByLabel('Weight kilograms').fill('65');
          await page.getByRole('button', { name: 'Male', exact: true }).click();
          await page.evaluate((hold) => {
            globalThis.__tryonHoldCamera = hold;
          }, holdCamera);
          await page.getByRole('button', { name: 'Continue →', exact: true }).click();
          await page.locator('[data-screen="scan"]').waitFor();
        };
        await enterScan();
        await page.waitForFunction(
          () => (window.__kiosk?.diagnostics.scan?.inferenceCalls ?? 0) > 0,
          null,
          { timeout: 45000 },
        );
        const samples = [];
        for (let i = 0; i < 8; i++) {
          await page.waitForTimeout(500);
          samples.push(
            await page.evaluate(() => ({
              ...window.__kiosk.diagnostics.scan,
              guidance: document.querySelector('.k-guidance')?.textContent?.trim(),
            })),
          );
        }
        const lastScan = samples.at(-1);
        result.scan_cpu = {
          input: 'Chrome fake colour-bar camera, no person',
          load: 'Shared machine, normal kiosk prefit runs during scan; not isolated timing.',
          samples,
          rollingMeanFrameMs: lastScan.inferMs + lastScan.analysisMs,
        };
        check(
          'scan initialises heavy CPU',
          samples.every((s) => s.delegate === 'CPU' && s.model === 'heavy'),
        );
        check(
          'scan CPU processes frames',
          lastScan.framesProcessed > 0 &&
            lastScan.inferMs > 0 &&
            Number.isFinite(result.scan_cpu.rollingMeanFrameMs),
        );
        await page
          .getByRole('button', { name: /Skip scan|Continue without scan/ })
          .first()
          .click();
        await page.locator('[data-screen="result"]').waitFor({ timeout: 180000 });
        await page.getByRole('button', { name: 'Try it on you', exact: true }).first().click();
        await screen.waitFor();
        check('default split view', (await screen.getAttribute('data-layout')) === 'split');
        check(
          'skipped scan body basis is honest',
          (await screen.getByTestId('live-body-basis').textContent()) ===
            'Body estimated from height & weight',
        );
        check(
          'mock guard',
          real
            ? (await screen.getByText('MOCK DATA', { exact: true }).count()) === 0
            : await screen.getByText('MOCK DATA', { exact: true }).isVisible(),
        );
        if (real) {
          await page.waitForFunction(
            () => {
              const p = document
                .querySelector('[data-screen="live-tryon"]')
                ?.getAttribute('data-phase');
              return p && p !== 'starting';
            },
            {},
            { timeout: 120000 },
          );
          result.real_phase = await screen.getAttribute('data-phase');
          result.real_message = await screen.locator('.live-state').innerText();
          await screen.getByText('Camera on', { exact: true }).waitFor();
          await capture('camera');
          check(
            'real engine opens camera',
            await screen.getByText('Camera on', { exact: true }).isVisible(),
            result.real_message,
          );
          check(
            'fake camera cannot prove live human physics',
            true,
            'Fake colour-bar video has no person; calibration/recording accuracy is not claimed.',
          );
        } else {
          await phase('tracking');
          for (const name of ['starting', 'calibrating', 'lost', 'error', 'tracking']) {
            await page.getByLabel('Mock phase').selectOption(name);
            await phase(name);
            if (name === 'calibrating')
              await page
                .getByTestId('ar-coach')
                .getByText('Hold still a moment', { exact: true })
                .waitFor();
            else if (name === 'lost') {
              await page
                .getByTestId('ar-coach')
                .getByText('Step back until your head-to-hips is in view', { exact: true })
                .waitFor();
              await page.waitForFunction(
                () =>
                  Number(
                    getComputedStyle(document.querySelector('[data-testid="live-ar"]')).opacity,
                  ) <= 0.21,
              );
              check(
                'out-of-range AR fades while mirror remains visible',
                await page
                  .getByTestId('live-mirror')
                  .evaluate(
                    (el) => getComputedStyle(el).opacity === '1' && el.childElementCount > 0,
                  ),
              );
            } else await page.getByTestId('ar-coach').waitFor({ state: 'hidden' });
            await capture(name);
          }
          for (const [message, cue] of [
            ['Face the camera', 'Face the camera'],
            ['More light needed', 'More light on you helps'],
            ['Out of range', 'Step back until your head-to-hips is in view'],
          ]) {
            await page.getByLabel('Mock guidance').selectOption(message);
            await page.getByTestId('ar-coach').getByText(cue, { exact: true }).waitFor();
            check(`stable coach cue ${message}`, true);
          }
          await page.getByLabel('Mock guidance').selectOption('');
          await page.getByTestId('ar-coach').waitFor({ state: 'hidden' });
          await page.waitForFunction(
            () =>
              Number(getComputedStyle(document.querySelector('[data-testid="live-ar"]')).opacity) >=
              0.99,
          );
          check('coach clears after stable tracking recovery', true);
          await page.getByRole('button', { name: 'Record a move', exact: true }).click();
          await page.getByText('Ready in 3', { exact: true }).waitFor();
          check('three second countdown', true);
          await phase('recording');
          await capture('recording');
          await phase('baking');
          await capture('baking');
          await phase('playback');
          await capture('playback');
          check(
            'physics readouts labelled',
            await page
              .getByTestId('physics-readouts')
              .getByText('Physics', { exact: true })
              .isVisible(),
          );
          check(
            'recorded physics view label',
            (await screen.locator('.live-ar-panel figcaption').textContent()).includes(
              'Physics (recorded move)',
            ),
          );
          await page.getByRole('button', { name: 'Pause', exact: true }).click();
          await page.getByRole('button', { name: 'Play', exact: true }).waitFor();
          await page.getByLabel('Playback position').fill('0.6');
          check(
            'mock scrub forwarded',
            (await page.getByTestId('live-mirror').getAttribute('data-position')) === '0.6',
          );
          await page.getByRole('button', { name: 'Replay', exact: true }).click();
          await page.getByRole('button', { name: 'Back to live', exact: true }).click();
          await phase('tracking');
          const other = screen
            .getByRole('group', { name: 'Live size' })
            .locator('button[aria-pressed="false"]')
            .first();
          if (await other.count()) {
            const wanted = await other.textContent();
            await other.click();
            check(
              'size switch',
              (await screen
                .getByRole('group', { name: 'Live size' })
                .getByRole('button', { name: wanted, exact: true })
                .getAttribute('aria-pressed')) === 'true',
            );
          }
          await page.getByLabel('Live jacket').selectOption('1');
          check('jacket switch', (await page.getByLabel('Live jacket').inputValue()) === '1');
          const streamsBeforeViews = await page.evaluate(() => globalThis.__tryonStreams.length);
          for (const [layout, button] of [
            ['split', 'Split view'],
            ['ar-focus', 'AR focus'],
            ['ar-full', 'Full-screen AR'],
          ]) {
            await screen.getByRole('button', { name: button, exact: true }).click();
            for (const [width, height] of [
              [1920, 1080],
              [1600, 900],
              [1366, 768],
              [1280, 720],
            ])
              for (const scale of [1, 1.25]) {
                // Browser-style layout scale: CSS viewport / scale, raster DPR = scale. Counts are explicit.
                await page.setViewportSize({
                  width: Math.round(width / scale),
                  height: Math.round(height / scale),
                });
                const cdp = await context.newCDPSession(page);
                await cdp.send('Emulation.setDeviceMetricsOverride', {
                  width: Math.round(width / scale),
                  height: Math.round(height / scale),
                  deviceScaleFactor: scale,
                  mobile: false,
                });
                const actualDpr = await page.evaluate(() => devicePixelRatio);
                const layoutInfo = await screen.evaluate((el, mode) => {
                  const selectors = [
                    '.live-header',
                    '.live-view-controls',
                    '.live-indicators',
                    '.live-footer',
                    '.live-state',
                    '.live-scenes',
                    '.live-ar-panel',
                    '.live-mirror-panel',
                  ];
                  if (mode !== 'ar-full') selectors.push('.live-readouts');
                  const within = selectors.every((s) => {
                    const r = el.querySelector(s).getBoundingClientRect();
                    return (
                      r.width > 0 &&
                      r.height > 0 &&
                      r.top >= 0 &&
                      r.bottom <= innerHeight + 1 &&
                      r.left >= 0 &&
                      r.right <= innerWidth + 1
                    );
                  });
                  const rect = (selector) => el.querySelector(selector).getBoundingClientRect();
                  const ar = rect('.live-ar-panel'),
                    mirror = rect('.live-mirror-panel'),
                    scenes = rect('.live-scenes');
                  const header = el.querySelector('.live-header');
                  const title = header.children[0].getBoundingClientRect(),
                    controls = rect('.live-view-controls'),
                    indicators = rect('.live-indicators');
                  const headerClear =
                    title.right <= controls.left + 1 && controls.right <= indicators.left + 1;
                  const panelClear =
                    mode === 'ar-full'
                      ? Math.abs(ar.width - scenes.width) <= 1 &&
                        mirror.left >= ar.left &&
                        mirror.right <= ar.right &&
                        mirror.bottom <= ar.bottom &&
                        mirror.width <= ar.width * 0.35 &&
                        getComputedStyle(el.querySelector('.live-readouts')).display === 'none'
                      : ar.right <= mirror.left + 1 &&
                        rect('.live-readouts').left >= scenes.right - 1;
                  const ratio = ar.width / mirror.width;
                  return {
                    within,
                    headerClear,
                    panelClear,
                    ratio,
                    focusRatio: mode !== 'ar-focus' || (ratio >= 1.95 && ratio <= 2.05),
                  };
                }, layout);
                check(
                  `${layout} layout ${width}x${height} scale ${scale}`,
                  layoutInfo.within &&
                    layoutInfo.headerClear &&
                    layoutInfo.panelClear &&
                    layoutInfo.focusRatio &&
                    Math.abs(actualDpr - scale) < 1e-6,
                  JSON.stringify({ ...layoutInfo, DPR: actualDpr }),
                );
                const raster = await capture(
                  `${layout === 'split' ? '' : layout + '-'}${width}x${height}-${scale}`,
                  cdp,
                  scale,
                );
                check(
                  `${layout} raster ${width}x${height} scale ${scale}`,
                  Math.abs(raster.width - width) <= 1 && Math.abs(raster.height - height) <= 1,
                  JSON.stringify(raster),
                );
                result.layouts.push({
                  layout,
                  width,
                  height,
                  scale,
                  devicePixelRatio: actualDpr,
                  ...layoutInfo,
                  raster,
                });
                await cdp.detach();
              }
            // Worst CSS viewport (1024x576): guidance stays clear of captions and mirror inset.
            await page.getByLabel('Mock guidance').selectOption('Out of range');
            await page.getByTestId('ar-coach').waitFor();
            check(
              `${layout} small-screen coach clear`,
              await screen.evaluate((el) => {
                const coach = el.querySelector('.live-coach').getBoundingClientRect();
                const panel = el.querySelector('.live-ar-panel').getBoundingClientRect();
                const caption = el
                  .querySelector('.live-ar-panel figcaption')
                  .getBoundingClientRect();
                const mirror = el.querySelector('.live-mirror-panel').getBoundingClientRect();
                const noMirrorOverlap =
                  coach.right <= mirror.left + 1 ||
                  coach.left >= mirror.right - 1 ||
                  coach.bottom <= mirror.top + 1 ||
                  coach.top >= mirror.bottom - 1;
                return (
                  coach.top >= caption.bottom &&
                  coach.bottom <= panel.bottom &&
                  coach.left >= panel.left &&
                  coach.right <= panel.right &&
                  noMirrorOverlap
                );
              }),
            );
            await page.getByLabel('Mock guidance').selectOption('');
            await page.getByTestId('ar-coach').waitFor({ state: 'hidden' });
            await page.waitForFunction(
              () =>
                Number(
                  getComputedStyle(document.querySelector('[data-testid="live-ar"]')).opacity,
                ) >= 0.99,
            );
          }
          check(
            'view toggles reuse the camera',
            (await page.evaluate(() => globalThis.__tryonStreams.length)) === streamsBeforeViews,
          );
          await screen.getByRole('button', { name: 'Split view', exact: true }).click();
        }
        await page.getByRole('button', { name: 'Done', exact: true }).click();
        await page.locator('[data-screen="result"]').waitFor();
        await page.waitForFunction(
          () =>
            globalThis.__tryonStreams.every((s) =>
              s.getTracks().every((t) => t.readyState === 'ended'),
            ),
          null,
          { timeout: 5000 },
        );
        check(
          'Done stops camera',
          await page.evaluate(() =>
            globalThis.__tryonStreams.every((s) =>
              s.getTracks().every((t) => t.readyState === 'ended'),
            ),
          ),
        );
        if (process.argv.includes('--feel')) {
          const feelButton = page.getByRole('button', { name: /Feel the fabric/ });
          await page.waitForFunction(
            () =>
              [...document.querySelectorAll('button')].some(
                (button) => button.textContent.includes('Feel the fabric') && !button.disabled,
              ),
            null,
            { timeout: 120000 },
          );
          await feelButton.click();
          await page.locator('[data-screen="feel"]').waitFor();
          await page.waitForFunction(() => !!window.__handpull);
          await page.evaluate(() => window.__handpull.holdOpen(true));
          await page.locator('.k-feel-preview').waitFor({ state: 'visible' });
          result.feel_layouts = [];
          for (const [width, height] of [
            [1920, 1080],
            [1280, 720],
          ])
            for (const scale of [1, 1.25]) {
              await page.setViewportSize({
                width: Math.round(width / scale),
                height: Math.round(height / scale),
              });
              const cdp = await context.newCDPSession(page);
              await cdp.send('Emulation.setDeviceMetricsOverride', {
                width: Math.round(width / scale),
                height: Math.round(height / scale),
                deviceScaleFactor: scale,
                mobile: false,
              });
              await page.waitForTimeout(500);
              const layout = await page.evaluate(() => {
                const header = document.querySelector('.k-feel-top').getBoundingClientRect();
                const stage = document.querySelector('.k-stage').getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(document.querySelector('.k-feel-top h2'));
                const title = range.getBoundingClientRect();
                const within = [
                  '.k-feel-top',
                  '.k-feel-hint',
                  '.k-feel-preview',
                  '.k-feel-compare',
                  '.k-feel-zip',
                  '.k-feel .k-footer',
                ].every((selector) => {
                  const element = document.querySelector(selector);
                  if (!element) return false;
                  const r = element.getBoundingClientRect();
                  return (
                    r.width > 0 &&
                    r.height > 0 &&
                    r.left >= 0 &&
                    r.top >= 0 &&
                    r.right <= innerWidth + 1 &&
                    r.bottom <= innerHeight + 1
                  );
                });
                return {
                  within,
                  headerBottom: header.bottom,
                  stageTop: stage.top,
                  clear:
                    stage.top > 0
                      ? header.bottom <= stage.top
                      : title.right < stage.left + stage.width * 0.4,
                  devicePixelRatio,
                };
              });
              check(
                `Feel header clear ${width}x${height} scale ${scale}`,
                layout.clear && layout.within && Math.abs(layout.devicePixelRatio - scale) < 1e-6,
                JSON.stringify(layout),
              );
              const raster = await capture(`feel-${width}x${height}-${scale}`, cdp, scale);
              check(
                `Feel raster ${width}x${height} scale ${scale}`,
                Math.abs(raster.width - width) <= 1 && Math.abs(raster.height - height) <= 1,
                JSON.stringify(raster),
              );
              result.feel_layouts.push({ width, height, scale, ...layout, raster });
              await cdp.detach();
            }
          check(
            'Feel has no startup errors',
            (await page.locator('[data-screen="feel"] [role="alert"]').count()) === 0,
          );
          await page.getByRole('button', { name: /← Done/ }).click();
          await page.locator('[data-screen="result"]').waitFor();
          await page.waitForFunction(() =>
            globalThis.__tryonStreams.every((stream) =>
              stream.getTracks().every((track) => track.readyState === 'ended'),
            ),
          );
          check('Feel Done stops camera', true);
        }
        await page.getByRole('button', { name: 'Start over', exact: true }).click();
        await page.locator('[data-screen="attract"]').waitFor({ timeout: 180000 });
        check('reset returns to attract', true);
        // Force the real camera promise to resolve after a fast Skip; no scanner wait here.
        await enterScan(true);
        await page
          .getByRole('button', { name: /Skip scan|Continue without scan/ })
          .first()
          .click();
        await page.locator('[data-screen="scan"]').waitFor({ state: 'hidden' });
        await page.waitForFunction(() => typeof globalThis.__tryonReleaseCamera === 'function');
        await page.evaluate(() => {
          globalThis.__tryonHoldCamera = false;
          globalThis.__tryonReleaseCamera();
        });
        await page.locator('[data-screen="result"]').waitFor({ timeout: 180000 });
        await page.waitForFunction(
          () =>
            globalThis.__tryonStreams.length > 0 &&
            globalThis.__tryonStreams.every((stream) =>
              stream.getTracks().every((track) => track.readyState === 'ended'),
            ),
          null,
          { timeout: 10000 },
        );
        check('fast Skip closes late camera', true);
        await page.getByRole('button', { name: 'Start over', exact: true }).click();
        await page.locator('[data-screen="attract"]').waitFor({ timeout: 180000 });
        check('fast Skip session resets', true);
        if (withCapture) await verifyCapture();
        check('no own console errors', result.console.length === 0, JSON.stringify(result.console));
        check(
          'no non-loopback traffic',
          result.external_attempts === 0 && result.external_completed === 0,
        );
        result.passed = true;
      } finally {
        clearTimeout(lease);
        await context?.close();
        await server?.close();
      }
    },
    {
      inspect: async () => {
        if (Date.now() > waitDeadline) throw Error('Browser resource wait exceeded 60 minutes');
        readFileSync(join(root, 'docs/requests/codex-sync.md'), 'utf8');
        const state = await browserReadiness();
        const probe = createServer();
        await new Promise((resolve) => {
          probe.once('error', () => {
            state.busyPorts.push(port);
            resolve();
          });
          probe.listen(port, '127.0.0.1', () => probe.close(resolve));
        });
        return state;
      },
    },
  );
} catch (error) {
  result.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  result.finished = new Date().toISOString();
  writeFileSync(join(output, `tryon-screen-${mode}.json`), JSON.stringify(result, null, 2) + '\n');
}
