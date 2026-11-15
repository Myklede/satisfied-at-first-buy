// Prompt 16b permits --draft before freeze. Final evidence still requires an explicit note.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, buildHash, waitForBrowserLock, judgePath } from './demo-day-warm.mjs';
import { startKioskServer } from './kiosk-server.mjs';

const draft = process.argv.includes('--draft');
const labelIndex = process.argv.indexOf('--label');
const label = labelIndex < 0 ? (draft ? 'draft16b' : 'final') : process.argv[labelIndex + 1];
if (!/^[a-z0-9-]{1,50}$/.test(label)) throw new Error('Invalid label');
const note = readFileSync(join(ROOT, 'docs/requests/lead-to-CX-DAY.md'), 'utf8');
// A source-control freeze must be explicit, not inferred from a quiet interval.
if (
  !draft &&
  (!process.argv.includes('--freeze-confirmed') ||
    !/^\s*(?:[-*]\s*)?(?:AR|try.on)\s+(?:is\s+)?(?:now\s+)?frozen\b/im.test(note))
)
  throw new Error('Final rehearsal requires explicit lead AR freeze note and --freeze-confirmed');
const distIndex = process.argv.indexOf('--dist');
const distArg = distIndex < 0 ? 'apps/web/dist' : process.argv[distIndex + 1];
if (distArg !== 'apps/web/dist' && !/^\.cache\/cx-day\/[a-z0-9-]{1,48}$/.test(distArg))
  throw new Error('Expected CX-DAY dist path');
const dist = join(ROOT, distArg);

const out = join(ROOT, 'docs/validation');
mkdirSync(out, { recursive: true });
const report = {
  at: new Date().toISOString(),
  buildHash: buildHash(dist),
  camera: 'Chrome fake colour bars, no person',
  scope: 'flow/start/stop only, no AR grading or real-person physics claim',
  draft,
  finalGo: false,
  scan: null,
  live: null,
  console: [],
  nativeInfo: [],
  external: [],
};
let context, server, timer;
const release = await waitForBrowserLock();
try {
  timer = setTimeout(() => void context?.close(), 14 * 60e3);
  server = await startKioskServer({
    dist,
    port: 5770,
    apiPort: 8001,
    status: () => ({ service: 'up' }),
    quit: () => {},
  });
  context = await chromium.launchPersistentContext(
    join(ROOT, '.cache/cxday-tryon/rehearsal-profile'),
    {
      channel: 'chrome',
      headless: false,
      viewport: { width: 1280, height: 720 },
      permissions: ['camera'],
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--disable-background-networking',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      ],
    },
  );
  await context.route('**/*', (r) => {
    const u = new URL(r.request().url());
    if (['127.0.0.1', 'localhost'].includes(u.hostname) || ['blob:', 'data:'].includes(u.protocol))
      return r.continue();
    report.external.push(u.origin + u.pathname);
    return r.abort();
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__dayStreams = [];
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const s = await original(constraints);
      window.__dayStreams.push(s);
      return s;
    };
  });
  page.on('pageerror', (e) => report.console.push(e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (m.text() === 'INFO: Created TensorFlow Lite XNNPACK delegate for CPU.')
      report.nativeInfo.push(m.text());
    else report.console.push(m.text());
  });
  const started = Date.now();
  const capture = async (phase) => {
    if (phase === 'attract') {
      await page.waitForFunction(() => document.documentElement.dataset.kioskWarm === '1', null, {
        timeout: 180000,
      });
      report.actualWindowWarm = true;
    }
    if (phase === 'scan') {
      await page.waitForFunction(() => window.__kiosk?.diagnostics.scan?.inferenceCalls > 0, null, {
        timeout: 60000,
      });
      report.scan = await page.evaluate(() => ({ ...window.__kiosk.diagnostics.scan }));
      if (report.scan.delegate !== 'CPU') throw new Error('Scanner did not report CPU');
    }
    if (phase === 'xray') {
      const t = Date.now();
      await page.getByRole('button', { name: 'Try it on you', exact: true }).first().click();
      const live = page.locator('[data-screen="live-tryon"]');
      await live.waitFor();
      await page.waitForFunction(
        () =>
          window.__dayStreams.some((s) => s.getVideoTracks().some((t) => t.readyState === 'live')),
        null,
        { timeout: 60000 },
      );
      await page.waitForTimeout(5000);
      report.live = {
        startedMs: Date.now() - t,
        phase: await live.getAttribute('data-phase'),
        bodyBasis: await live.getByTestId('live-body-basis').textContent(),
        noPersonExpected: true,
      };
      await page.screenshot({ path: join(out, `demo-day-tryon-${label}-live.png`) });
      await live.getByRole('button', { name: /Done/ }).click();
      await page.locator('[data-screen="result"]').waitFor();
      await page.waitForFunction(
        () =>
          window.__dayStreams.every((s) => s.getTracks().every((t) => t.readyState === 'ended')),
        null,
        { timeout: 30000 },
      );
      report.live.stoppedCleanly = true;
    }
    // Screenshots contain synthetic camera pixels and mannequin renders only.
    if (['attract', 'result', 'feel', 'failure'].includes(phase))
      await page.screenshot({ path: join(out, `demo-day-tryon-${label}-${phase}.png`) });
  };
  report.run = await judgePath(page, capture, 'http://127.0.0.1:5770');
  report.fullPathMs = Date.now() - started;
  report.twoMinuteHumanDemoProven = false;
  report.pass = Boolean(
    report.run.complete &&
      report.run.deleted &&
      report.scan?.delegate === 'CPU' &&
      report.live?.stoppedCleanly &&
      report.console.length === 0,
  );
} catch (e) {
  report.error = String(e);
  report.pass = false;
} finally {
  clearTimeout(timer);
  try {
    await context?.close();
  } finally {
    try {
      if (server) await new Promise((done) => server.close(done));
    } finally {
      release();
    }
  }
  report.finished = new Date().toISOString();
  writeFileSync(
    join(out, `demo-day-tryon-${label}-rehearsal.json`),
    JSON.stringify(report, null, 2) + '\n',
  );
}
console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exitCode = 1;
