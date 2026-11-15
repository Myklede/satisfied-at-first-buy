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
import { studioMiddleware } from '../../../scripts/amazon-demo-web.mjs';
import { cataloguePage } from '../../../scripts/amazon-demo-catalogue.mjs';
import { runProductFlow } from './product-flow.mjs';

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
    'apps/extension/e2e/product-run.mjs',
    'apps/extension/e2e/product-flow.mjs',
    'apps/extension/src/bodyDiagram.ts',
    'apps/extension/src/fitPresentation.ts',
    'apps/extension/src/entryDraft.ts',
    'apps/extension/src/handoff.ts',
    'apps/web/src/handoff.ts',
    'apps/web/src/App.tsx',
    'apps/web/src/FitStudio.tsx',
    'scripts/amazon-demo.mjs',
    'scripts/amazon-demo-catalogue.mjs',
    'scripts/amazon-demo-web.mjs',
    'services/body/body_service/agent/explanation.py',
    'services/body/body_service/agent/recommend.py',
    'services/body/body_service/agent/convert.py',
    'services/body/body_service/agent/router.py',
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
    '--web-port',
    '5799',
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
const studio = await studioMiddleware(root, work);
const server = createServer((request, response) => {
  if (new URL(request.url, 'http://127.0.0.1').pathname === '/catalogue') {
    void cataloguePage()
      .then((html) =>
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html),
      )
      .catch(() => response.writeHead(503).end('Catalogue unavailable'));
    return;
  }
  let file;
  try {
    file = canonicalFiles.get(
      decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname),
    );
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (!file) {
    studio.middlewares(request, response, () => response.writeHead(404).end());
    return;
  }
  if (request.method !== 'GET') {
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
  FIT_AGENT_STUDIO: '1',
  FIT_AGENT_STORE_DIR: store,
  FIT_AGENT_REVIEWED_DIR: join(work, 'reviewed'),
  FIT_AGENT_CLAUDE_CLI: 'fit-agent-r2-e2e-no-such-cli',
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
  results.console = [];
  results.retailer_console = [];
  // Attach before loading the extension, including initial background errors.
  context.on('console', (message) => {
    if (message.type() === 'error' && !message.page()) results.console.push(message.text());
  });
  context.on('weberror', (error) => {
    if (!error.page()) results.console.push(error.error().stack || error.error().message);
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

  await runProductFlow(context, id, root, work, shots, step, results);
  step(
    'no external request completed',
    results.non_loopback_completed === 0,
    `${results.blocked_requests.length} blocked attempts`,
  );
  results.functional_passed = true;
  results.raw_console_empty = results.console.length === 0 && results.retailer_console.length === 0;
  results.retailer_console_count = results.retailer_console.length;
  results.own_console_error_count = results.console.length;
  results.passed = results.own_console_error_count === 0;
} catch (error) {
  results.passed = false;
  results.error = String(error?.message ?? error);
  for (const page of context?.pages() ?? []) {
    const html = await page
      .evaluate(() => {
        const host = document.getElementById('satisfy-fit-agent');
        return host ? (host.shadowRoot?.textContent ?? 'closed shadow root') : 'no panel host';
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
  writeFileSync(join(shots, 'fit-agent-r2-e2e.json'), JSON.stringify(results, null, 2) + '\n');
  await context?.close().catch(() => {});
  // The Windows venv launcher owns a second python.exe: stop our own process tree only.
  if (process.platform === 'win32' && service.pid)
    spawnSync('taskkill', ['/pid', String(service.pid), '/T', '/F'], { stdio: 'ignore' });
  else service.kill();
  server.close();
  await studio.close();
}
