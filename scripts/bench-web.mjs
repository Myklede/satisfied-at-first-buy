import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('.cache/playwright', { recursive: true });
const context = await chromium.launchPersistentContext('.cache/playwright/chrome', {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 1000 },
  deviceScaleFactor: 1,
  serviceWorkers: 'block',
});
const browser = context.browser();
if (!browser) throw new Error('Chrome browser handle unavailable');
await context.route('**/*', (route) => {
  const url = new URL(route.request().url());
  return ['127.0.0.1', 'localhost'].includes(url.hostname)
    ? route.continue()
    : route.abort('blockedbyclient');
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
const results = [];
try {
  await page.goto('http://127.0.0.1:5710/?bench=1');
  await page.waitForFunction(() => window.__satisfyBench?.ready, { timeout: 30000 });
  const requests = [['reference', { height_cm: 172, weight_kg: 65, sex: 'male' }]];
  if (process.argv.includes('--full')) {
    const person = JSON.parse(await readFile('data/ground-truth/me.json', 'utf8'));
    const { person_id, notes, ...request } = person;
    void person_id;
    void notes;
    requests.push(['personal', request]);
  }
  for (const [label, request] of requests)
    for (const style of ['FB7675-100', 'DQ4920-206']) {
      const initial = await page.evaluate(
        async ({ request, style }) => window.__satisfyBench.load(request, style, 'S'),
        { request, style },
      );
      const qualities = [];
      for (const quality of ['High', 'Medium'])
        qualities.push(await page.evaluate((q) => window.__satisfyBench.fps(q), quality));
      const interactive = [];
      for (const quality of ['High', 'Medium'])
        interactive.push(await page.evaluate((q) => window.__satisfyBench.interactive(q), quality));
      const next = await page.evaluate(() => window.__satisfyBench.size('M'));
      const cached = await page.evaluate(() => window.__satisfyBench.size('S'));
      const dump = await page.evaluate(() => window.__satisfyBench.dump());
      await writeFile(`.cache/realism/browser-${label}-${style}.json`, JSON.stringify(dump));
      const captures = process.argv.includes('--full')
        ? ['front', 'back', 'side', 'shoulder', 'cuff', 'hood', 'quilting']
        : ['front'];
      const modes = process.argv.includes('--full') ? ['normal', 'xray', 'tension'] : ['normal'];
      await page.evaluate(() => window.__satisfyBench.quality('High'));
      for (const mode of modes) {
        await page.evaluate((mode) => window.__satisfyBench.mode(mode), mode);
        for (const view of captures) {
          await page.evaluate((view) => window.__satisfyBench.view(view), view);
          await page.screenshot({
            path: `docs/validation/realism-${label}-${style}-${mode}-${view}.png`,
          });
        }
      }
      results.push({ label, style, initial, next, cached, qualities, interactive });
      console.log(JSON.stringify(results.at(-1)));
    }
  const report = {
    browser: browser.version(),
    renderer: await page.evaluate(() => window.__satisfyBench.renderer),
    headless: false,
    viewport: { width: 1280, height: 1000 },
    results,
    errors,
  };
  await writeFile(
    'docs/validation/realism-browser-bench.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
} finally {
  await context.close();
}
