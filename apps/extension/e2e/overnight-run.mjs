// Fit Agent end-to-end: the unpacked extension in installed Chrome (Playwright, channel 'chrome').
//
//   node apps/extension/e2e/fit-agent-overnight.mjs
//
// Starts (and stops) its own processes on its own ports — never touches 8001 or 5711:
//   - page server 127.0.0.1:5799 (parser-structure fixtures; the user's saved pages if present),
//   - the standalone agent service 127.0.0.1:8013 with a throwaway store under .cache/amazon-demo,
//     and the claude CLI pointed at a name that does not exist (no LLM call can happen).
// Branded Chrome ignores --load-extension, so the extension is loaded through the DevTools
// protocol (Extensions.loadUnpacked, needs --enable-unsafe-extension-debugging).
// Every non-loopback request from the pages is blocked and counted.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const API_PORT = 8013;
const PAGE_PORT = 5799;
mkdirSync(join(root, '.cache/amazon-demo'), { recursive: true });
const work = mkdtempSync(join(root, '.cache/amazon-demo/e2e-'));
const store = join(work, 'store');
const shots = join(root, 'docs/validation');
const results = { started: new Date().toISOString(), steps: [], blocked_requests: [] };
results.source_sha256 = Object.fromEntries(
  [
    'apps/extension/build.mjs',
    'apps/extension/src/content.ts',
    'apps/extension/src/extract.ts',
    'apps/extension/src/comparison.ts',
    'apps/extension/src/background.ts',
    'apps/extension/src/profile.ts',
    'apps/extension/static/profile.html',
    'apps/extension/e2e/overnight-run.mjs',
    'scripts/amazon-demo.mjs',
  ].map((path) => [
    path,
    createHash('sha256')
      .update(readFileSync(join(root, path)))
      .digest('hex'),
  ]),
);
const step = (name, ok, detail = '') => {
  results.steps.push({ name, ok, detail });
  console.log(`[e2e] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`${name}: ${detail}`);
};

mkdirSync(store, { recursive: true });

// ---------- build the actual offline-demo extension ----------
const built = spawnSync(
  process.execPath,
  [
    join(root, 'apps/extension/build.mjs'),
    '--demo',
    '--api-port',
    String(API_PORT),
    '--page-port',
    String(PAGE_PORT),
    '--out',
    join(work, 'extension'),
  ],
  { stdio: 'inherit' },
);
if (built.status !== 0) throw new Error('extension build failed');
const extension = join(work, 'extension');

// ---------- page server ----------
const savedDir = join(root, 'data/amazon-pages');
const saved = ['01-garment.html', '02-body.html'].filter((name) =>
  existsSync(join(savedDir, name)),
);
if (saved.length !== 2)
  throw new Error(
    'Both real saved pages are required for overnight proof; fixtures alone cannot pass F6',
  );
const pages = {
  '/page/garment': join(here, 'fixtures/parser-structure-page.html'),
  '/page/body': join(root, 'services/body/tests/fixtures/fit_agent/parser-structure-body.html'),
  ...Object.fromEntries(
    saved.map((name) => [`/saved/${encodeURIComponent(name)}`, join(savedDir, name)]),
  ),
};
function indexAssets(folder, prefix = '/saved/') {
  for (const item of readdirSync(folder, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory())
      indexAssets(join(folder, item.name), prefix + encodeURIComponent(item.name) + '/');
    else pages[prefix + encodeURIComponent(item.name)] = join(folder, item.name);
  }
}
if (existsSync(savedDir)) indexAssets(savedDir);
const canonicalFiles = new Map(
  Object.entries(pages).map(([url, file]) => [decodeURIComponent(url), file]),
);
const server = createServer((request, response) => {
  let file;
  try {
    file = canonicalFiles.get(
      decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname),
    );
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (request.method !== 'GET' || !file) {
    response.writeHead(404).end();
    return;
  }
  const ext = file.endsWith('.js.download') ? 'js' : file.split('.').pop().toLowerCase();
  const mime = {
    html: 'text/html; charset=utf-8',
    css: 'text/css',
    js: 'text/javascript',
    png: 'image/png',
    jpg: 'image/jpeg',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  };
  response
    .writeHead(200, { 'Content-Type': mime[ext] ?? 'application/octet-stream' })
    .end(readFileSync(file));
});
await new Promise((ok) => server.listen(PAGE_PORT, '127.0.0.1', ok));

// ---------- agent service (standalone, own port, throwaway store) ----------
const env = { ...process.env };
for (const name of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'FIT_AGENT_ALLOW_PAID_LLM',
  'SATISFY_KIOSK_MODE',
])
  delete env[name];
Object.assign(env, {
  PYTHONPATH: join(root, 'services/body'),
  ANNY_CACHE_DIR: join(root, '.cache/anny'),
  XDG_CACHE_HOME: join(root, '.cache'),
  PYTHONUNBUFFERED: '1',
  FIT_AGENT_STORE_DIR: store,
  FIT_AGENT_REVIEWED_DIR: join(work, 'reviewed'),
  FIT_AGENT_CLAUDE_CLI: 'fit-agent-overnight-e2e-no-such-cli',
});
const python = join(
  root,
  process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python',
);
const service = spawn(
  python,
  [
    '-m',
    'uvicorn',
    'body_service.agent.standalone:app',
    '--host',
    '127.0.0.1',
    '--port',
    String(API_PORT),
    '--no-access-log',
  ],
  { env, cwd: root, stdio: ['ignore', 'inherit', 'inherit'] },
);
let context;
const lease = setTimeout(() => {
  void context?.close();
}, 13 * 60_000);
try {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const health = await fetch(`http://127.0.0.1:${API_PORT}/health`)
      .then((r) => r.json())
      .catch(() => null);
    if (health?.model_loaded) break;
    if (Date.now() > deadline) throw new Error('agent service did not start');
    await new Promise((ok) => setTimeout(ok, 500));
  }

  // ---------- Chrome with the unpacked extension ----------
  context = await chromium.launchPersistentContext(join(work, 'chrome-profile'), {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [
      '--enable-unsafe-extension-debugging',
      '--disable-background-networking',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
    ],
    ignoreDefaultArgs: ['--disable-extensions'], // Playwright disables extensions by default
  });
  results.non_loopback_completed = 0;
  context.on('requestfinished', (request) => {
    const u = new URL(request.url());
    if (
      ['http:', 'https:'].includes(u.protocol) &&
      !['127.0.0.1', 'localhost'].includes(u.hostname)
    )
      results.non_loopback_completed++;
  });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (
      url.hostname === '127.0.0.1' ||
      url.protocol === 'chrome-extension:' ||
      url.protocol === 'data:'
    )
      return route.continue();
    results.blocked_requests.push(url.origin);
    return route.abort();
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
  step('extension loaded', Boolean(id), `id ${id}`);
  await context.addInitScript(() => {
    if (
      window !== window.top ||
      location.origin !== 'http://127.0.0.1:5799' ||
      !location.pathname.startsWith('/saved/')
    )
      return;
    document.addEventListener('DOMContentLoaded', () => {
      const note = document.createElement('aside');
      note.textContent = 'Offline demo copy of a saved Amazon page';
      Object.assign(note.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        zIndex: '2147483647',
        background: '#fff8df',
        color: '#172a26',
        padding: '6px',
        font: '12px system-ui',
      });
      document.body.append(note);
    });
  });

  // 1. No profile yet → the panel asks for one.
  const shop = await context.newPage();
  shop.on('console', (m) => results.console?.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
  shop.on('pageerror', (e) => results.console?.push(`pageerror: ${e.message}`.slice(0, 300)));
  results.console = [];
  await shop.goto(`http://127.0.0.1:${PAGE_PORT}/page/garment`);
  await shop.getByTestId('needs-profile').waitFor({ timeout: 20_000 });
  step('panel asks for a profile first', true);

  // 2. Profile (opt-in, remembered) on the extension's own page.
  const profile = await context.newPage();
  await profile.goto(`chrome-extension://${id}/profile.html`);
  await profile.locator('#height').fill('70');
  await profile.locator('#weight').fill('160');
  await profile.locator('#sex').selectOption('male');
  step(
    'live body assumption summary',
    (await profile.locator('#assumptions').textContent()).includes('177.8 cm'),
  );
  await profile.locator('#units').selectOption('metric');
  step(
    'unit toggle preserves body height',
    Number(await profile.locator('#height').inputValue()) === 177.8,
  );
  await profile.locator('#units').selectOption('imperial');
  await profile.locator('#remember').check();
  await profile.getByTestId('save-profile').click();
  await profile
    .getByTestId('profile-status')
    .filter({ hasText: 'Saved on this computer' })
    .waitFor();
  const savedText = await profile.getByTestId('saved-profile').textContent();
  step(
    'profile saved locally',
    existsSync(join(store, 'profile.json')) && savedText.includes('177.8'),
    'height 70 in → 177.8 cm',
  );
  await profile.screenshot({ path: join(shots, 'fit-agent-overnight-profile.png') });

  // 3. Recommendation on the product page (chart only appears after clicking "Size Chart").
  await shop.reload();
  const size = shop.getByTestId('recommended-size');
  await size.waitFor({ timeout: 30_000 });
  const recommended = (await size.textContent()).trim();
  const trace = await shop.locator('[data-testid="trace"] li').allTextContents();
  const source = await shop.getByTestId('source-label').textContent();
  const zones = await shop.locator('[data-testid="zones"] tr').allTextContents();
  step('recommendation shown', /^(S|M|L|XL)$/.test(recommended), `size ${recommended}`);
  step(
    'agent trace has all five steps',
    trace.length === 5,
    trace.map((t) => t.split(':')[0]).join(' → '),
  );
  step('trace says the popover was opened', trace[0].includes('popover opened'), trace[0]);
  step('source label shown', source.includes('rules'), source);
  await shop.getByTestId('map-chest').focus();
  await shop.keyboard.press('Enter');
  const diagramText = await shop.getByTestId('body-map').locator('..').textContent();
  step('keyboard diagram zone exposes engine units', /cm.*in/.test(diagramText));
  step(
    'neighbour size strip rendered',
    (await shop.getByTestId('size-strip').locator('th').filter({ hasText: /^M$/ }).count()) === 1,
  );
  const strip = shop.getByRole('region', { name: 'Compare size measurements' });
  await shop.setViewportSize({ width: 360, height: 900 });
  await strip.focus();
  await shop.keyboard.press('ArrowRight');
  await shop.waitForFunction(() => {
    const host = document.getElementById('satisfy-fit-agent');
    return host?.shadowRoot?.querySelector('.size-strip')?.scrollLeft > 0;
  });
  step('size comparison scrolls with the keyboard', true);
  await shop.setViewportSize({ width: 1280, height: 900 });
  step(
    'chart-only product makes no3D geometry claim',
    (await shop.getByTestId('no-3d').count()) === 1,
  );
  step(
    'zones in cm and inches',
    zones.some((z) => z.includes(' cm (') && z.includes(' in)')),
    zones[2] ?? '',
  );
  await shop.screenshot({ path: join(shots, 'fit-agent-overnight-panel.png') });

  // 4. "Select size" sets the page's own selector.
  await shop.getByTestId('select-size').click();
  const selected = (await shop.locator('#selected-size').textContent()).trim();
  const canonical = { Small: 'S', Medium: 'M', Large: 'L', 'X-Large': 'XL' }[selected];
  step('select size on the page', canonical === recommended, `page now shows "${selected}"`);

  // 5. Compare two products.
  await shop.getByTestId('add-compare').click();
  const second = await context.newPage();
  await second.goto(`http://127.0.0.1:${PAGE_PORT}/page/body`);
  await second.getByTestId('recommended-size').waitFor({ timeout: 30_000 });
  const bodyChart = await second.getByTestId('source').textContent();
  step('body chart labelled estimated', bodyChart.includes('BODY chart'), bodyChart.slice(0, 80));
  await second.getByTestId('add-compare').click();
  await second.getByTestId('run-compare').click();
  await second.getByTestId('compare-table').waitFor({ timeout: 30_000 });
  step(
    'compare view',
    true,
    (await second.getByTestId('compare-table').textContent()).slice(0, 120),
  );
  await second.screenshot({ path: join(shots, 'fit-agent-overnight-compare.png') });

  // 6. Bought → "how did it fit?" → learned offset.
  await shop.getByTestId('bought').click();
  await shop.getByTestId('fb-chest-tight').click();
  await shop.getByTestId('fb-send').click();
  const learned = shop.getByTestId('learned').first();
  await learned.waitFor({ timeout: 30_000 });
  const learnedText = await learned.textContent();
  step('feedback learned', learnedText.includes('more room at chest'), learnedText);
  const offset = await shop.locator('[data-testid="zones"] tr[data-zone="chest"]').textContent();
  step('learned offset applied to the next recommendation', offset.includes('pref.'), offset);
  await shop.screenshot({ path: join(shots, 'fit-agent-overnight-feedback.png') });

  // 7. The user's saved Amazon pages, if any (served from disk; Amazon's CDN is blocked).
  for (const name of saved) {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PAGE_PORT}/saved/${encodeURIComponent(name)}`);
    step(
      `saved page visibly labelled offline ${name}`,
      await page.getByText('Offline demo copy of a saved Amazon page', { exact: true }).isVisible(),
    );
    const css = await page.evaluate(() =>
      Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
        .filter((el) => el.href?.includes('_files/'))
        .map((el) => ({ loaded: el.sheet !== null })),
    );
    step(
      `saved local stylesheet coverage ${name}`,
      css.length > 0 && css.every((s) => s.loaded),
      `${css.filter((s) => s.loaded).length}/${css.length} local sheets`,
    );
    const panel = page.getByTestId('fit-agent-panel');
    await panel.waitFor({ timeout: 30_000 });
    await page
      .locator('[data-testid="recommendation"], [data-testid="error"]')
      .first()
      .waitFor({ timeout: 30_000 });
    if (await page.getByTestId('select-size').isVisible()) {
      // Amazon's own scripts are blocked here, so this proves we FIND and click the real
      // selector element; the live page's reaction is checked on amazon.com by the user.
      await page.getByTestId('select-size').click();
    }
    const text = (await panel.textContent()) ?? '';
    // Evidence contains only the saved page and extension; mask account/shipping details.
    step(
      `saved recommendation ${name}`,
      (await page.getByTestId('recommended-size').count()) === 1,
      text.slice(0, 180),
    );
    for (const scheme of ['light', 'dark'])
      for (const zoom of [1, 1.5, 2]) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.bringToFront();
        const worker = context.serviceWorkers().find((w) => w.url().endsWith('/background.js'));
        if (!worker) throw new Error('Extension worker unavailable for real Chrome tab zoom');
        const actualZoom = await worker.evaluate(async (z) => {
          const [tab] = await globalThis.chrome.tabs.query({ active: true, currentWindow: true });
          await globalThis.chrome.tabs.setZoom(tab.id, z);
          return globalThis.chrome.tabs.getZoom(tab.id);
        }, zoom);
        step(`Chrome zoom ${name} ${scheme} ${zoom}`, actualZoom === zoom);
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        const bounds = await page.getByTestId('fit-agent-panel').evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, height: innerHeight };
        });
        step(
          `panel stays in viewport ${name} ${scheme} ${zoom}`,
          bounds.top >= 0 && bounds.bottom <= bounds.height + 1,
        );
        await page.screenshot({
          style:
            '#nav-global-location-popover-link, #nav-link-accountList { opacity: 0 !important; }',
          path: join(
            shots,
            `fit-agent-overnight-${name.replace(/[^A-Za-z0-9_-]+/g, '_')}-${scheme}-${zoom}.png`,
          ),
        });
      }
    const worker = context.serviceWorkers().find((w) => w.url().endsWith('/background.js'));
    await worker.evaluate(async () => {
      const [tab] = await globalThis.chrome.tabs.query({ active: true, currentWindow: true });
      await globalThis.chrome.tabs.setZoom(tab.id, 1);
    });
    await page.getByTestId('body-map').scrollIntoViewIfNeeded();
    const computedZone = page.getByTestId('body-map').locator('button[title*=" cm ("]').first();
    const computedDetail = await computedZone.getAttribute('title');
    await computedZone.click();
    const diagramDetail = page.getByTestId('body-map').locator('..').locator('[aria-live]');
    step(
      `saved diagram tap exposes units ${name}`,
      computedDetail === (await diagramDetail.textContent()) && /cm.*in/.test(computedDetail),
      computedDetail,
    );
    await page.getByTestId('map-collar').click();
    step(
      `missing collar stays unknown ${name}`,
      (await diagramDetail.textContent()).includes('Not measured / not in chart'),
    );
    await computedZone.click();
    await page.screenshot({
      style: '#nav-global-location-popover-link, #nav-link-accountList { opacity: 0 !important; }',
      path: join(shots, `fit-agent-overnight-${name.replace(/[^A-Za-z0-9_-]+/g, '_')}-diagram.png`),
    });
    await page.getByTestId('size-strip').scrollIntoViewIfNeeded();
    await page.screenshot({
      style: '#nav-global-location-popover-link, #nav-link-accountList { opacity: 0 !important; }',
      path: join(shots, `fit-agent-overnight-${name.replace(/[^A-Za-z0-9_-]+/g, '_')}-sizes.png`),
    });
    results.steps.push({ name: `saved page ${name}`, ok: true, detail: text.slice(0, 400) });
    console.log(`[e2e] saved page ${name}: ${text.slice(0, 200)}`);
    await page.close();
  }

  // 8. Undo is visible; then delete everything in one call.
  await profile.reload();
  await profile.getByTestId('undo').first().waitFor();
  step('learning visible with undo', true);
  await profile.getByTestId('delete-profile').click();
  await profile.getByTestId('profile-status').filter({ hasText: 'Deleted' }).waitFor();
  const gone =
    !existsSync(join(store, 'profile.json')) && !existsSync(join(store, 'learning.json'));
  step(
    'profile and learning deleted',
    gone,
    await profile.getByTestId('profile-status').textContent(),
  );
  await profile.getByTestId('saved-profile').filter({ hasText: 'No saved profile' }).waitFor();
  step(
    'delete clears profile inputs',
    (await profile.locator('#height').inputValue()) === '' &&
      (await profile.locator('#sex').inputValue()) === '',
  );
  const worker = context.serviceWorkers().find((w) => w.url().endsWith('/background.js'));
  if (!worker) throw new Error('Extension worker unavailable for deletion check');
  const storageCleared = await worker.evaluate(async () => {
    const local = await globalThis.chrome.storage.local.get(['choices', 'compare']);
    const session = await globalThis.chrome.storage.session.get('sessionBody');
    return Object.keys(local).length === 0 && !session.sessionBody;
  });
  step('delete clears extension choices, compare and session body', storageCleared);
  await profile.screenshot({ path: join(shots, 'fit-agent-overnight-deleted.png') });
  await shop.reload();
  await shop.getByTestId('needs-profile').waitFor({ timeout: 20_000 });
  step('panel asks again after deletion', true);

  step(
    'no non-loopback request left the pages',
    results.non_loopback_completed === 0,
    `${results.blocked_requests.length} blocked (saved Amazon pages reference Amazon's CDN; all blocked)`,
  );
  results.passed = true;
} catch (error) {
  results.passed = false;
  results.error = String(error?.message ?? error);
  for (const page of context?.pages() ?? []) {
    const html = await page
      .evaluate(() => {
        const host = document.getElementById('satisfy-fit-agent');
        return host ? (host.shadowRoot?.innerHTML ?? 'closed shadow root') : 'no panel host';
      })
      .catch((e) => `evaluate failed: ${e.message}`);
    console.error(`[e2e] ${page.url()}: ${html.slice(0, 1500)}`);
  }
  console.error(`[e2e] console: ${JSON.stringify(results.console ?? [])}`);
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(lease);
  results.finished = new Date().toISOString();
  results.saved_pages = saved.length;
  results.blocked_attempt_count = results.blocked_requests.length;
  results.blocked_requests = [...new Set(results.blocked_requests)];
  writeFileSync(
    join(shots, 'fit-agent-overnight-e2e.json'),
    JSON.stringify(results, null, 2) + '\n',
  );
  await context?.close().catch(() => {});
  // The Windows venv launcher owns a second python.exe: stop our own process tree only.
  if (process.platform === 'win32' && service.pid)
    spawnSync('taskkill', ['/pid', String(service.pid), '/T', '/F'], { stdio: 'ignore' });
  else service.kill();
  server.close();
}
