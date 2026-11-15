// Screenshots of the running jacket sandbox (installed Chrome, headed, local only).
//   node scripts/sandbox-shots.mjs [--url http://127.0.0.1:5740/?sandbox] [--out docs/validation]
//                                  [--empty-photos] [--prefix sandbox] [--shots name:style:size:view[:debug,debug[:lighting]]]...
// Start the sandbox first: npm run sandbox -- --no-browser. Default shots: each product, front view,
// then a seam-line close-up, written as <out>/sandbox-<name>.png (whole page, so the empty photo
// panel is visible). Uses the page's window.__satisfySandbox hook; nothing is faked.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const url = value('--url', 'http://127.0.0.1:5740/?sandbox');
const prefix = value('--prefix', 'sandbox');
const emptyPhotos = args.includes('--empty-photos');
const out = resolve(value('--out', 'docs/validation'));
const shots = args.filter((a, i) => a.split(':').length >= 4 && args[i - 1] !== '--url');
const plan = (
  shots.length
    ? shots
    : [
        'parka-front:FB7675-100:M:front',
        'puffer-front:DQ4920-206:M:front',
        'parka-collar-seams:FB7675-100:M:collar-back:seams',
        'puffer-sleeve-seams:DQ4920-206:M:sleeve:seams',
      ]
).map((spec) => {
  const [name, style, size, view, debug = '', lighting = 'kiosk'] = spec.split(':');
  return { name, style, size, view, lighting, debug: debug.split(',').filter(Boolean) };
});

mkdirSync(out, { recursive: true });
const context = await chromium.launchPersistentContext('.cache/playwright/sandbox-chrome', {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1600, height: 900 },
  args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'],
});
try {
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => m.type() === 'error' && console.log('[console]', m.text()));
  // --empty-photos shows the empty state without touching the user's local photo folders.
  if (emptyPhotos)
    await page.route('**/sandbox/refs', (route) =>
      route.fulfill({
        json: {
          folders: [
            { name: 'FB7675-100-parka-trang', files: [] },
            { name: 'DQ4920-206-puffer-kem', files: [] },
          ],
        },
      }),
    );
  await page.goto(url);
  await page.waitForFunction(() => window.__satisfySandbox?.ready === true, null, {
    timeout: 180_000,
  });
  for (const shot of plan) {
    await page.evaluate(async (s) => {
      const debug = { wireframe: false, seams: false, normals: false };
      for (const key of s.debug) debug[key] = true;
      await window.__satisfySandbox.apply({
        style: s.style,
        size: s.size,
        view: s.view,
        lighting: s.lighting,
        debug,
      });
    }, shot);
    await page.waitForTimeout(800);
    console.log(
      shot.name,
      JSON.stringify(await page.evaluate(() => window.__satisfySandbox.state().seams)),
    );
    const file = join(out, `${prefix}-${shot.name}.png`);
    await page.screenshot({ path: file });
    console.log('wrote', file);
  }
} finally {
  await context.close();
}
