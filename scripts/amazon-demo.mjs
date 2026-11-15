// Offline saved-page demo. Only our own temporary resources are stopped.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { chromium } from 'playwright';
import { withBrowserSlot } from './lookdev/browser-slot.mjs';
import { studioMiddleware } from './amazon-demo-web.mjs';
import { runJudgeScript } from './amazon-demo-rehearse.mjs';
import { cataloguePage } from './amazon-demo-catalogue.mjs';

const root = resolve(import.meta.dirname, '..');
const smoke = process.argv.includes('--smoke');
const rehearse = process.argv.includes('--rehearse');
mkdirSync(join(root, '.cache/amazon-demo'), { recursive: true });
const work = mkdtempSync(join(root, '.cache/amazon-demo/run-'));
const extension = join(work, 'extension');
const saved = join(root, 'data/amazon-pages');
const files = new Map();
function inventory(folder, prefix = '') {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const key = prefix + entry.name,
      file = join(folder, entry.name);
    if (entry.isDirectory()) inventory(file, key + '/');
    else files.set('/' + key, file);
  }
}
inventory(saved);
for (const page of ['/01-garment.html', '/02-body.html'])
  if (!files.has(page)) throw new Error(`Missing saved Amazon page ${page}`);
const built = spawnSync(
  process.execPath,
  [
    join(root, 'apps/extension/build.mjs'),
    '--demo',
    '--api-port',
    '8013',
    '--page-port',
    '5799',
    '--web-port',
    '5799',
    '--out',
    extension,
  ],
  { stdio: 'inherit', cwd: root },
);
if (built.status !== 0) throw new Error('Extension build failed');
const waitDeadline = Date.now() + 10 * 60_000;
await withBrowserSlot(
  'Codex Amazon demo',
  async () => {
    let context, service, server, studio;
    const blocked = [];
    let externalCompleted = 0;
    let interrupted = false;
    const stop = () => {
      interrupted = true;
      void context?.close();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const lease = setTimeout(() => {
      void context?.close();
    }, 14 * 60_000);
    try {
      studio = await studioMiddleware(root, work);
      const mime = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'text/javascript',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2',
        '.webp': 'image/webp',
      };
      server = createServer((req, res) => {
        let key;
        try {
          key = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
        } catch {
          res.writeHead(400).end();
          return;
        }
        const file = files.get(key);
        if (key === '/catalogue') {
          void cataloguePage()
            .then((html) =>
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html),
            )
            .catch(() => res.writeHead(503).end('Local catalogue unavailable'));
          return;
        }
        if (!file) {
          studio.middlewares(req, res, () => res.writeHead(404).end());
          return;
        }
        if (req.method !== 'GET' || !file) {
          res.writeHead(404).end();
          return;
        }
        res
          .writeHead(200, {
            'Content-Type':
              mime[file.endsWith('.js.download') ? '.js' : extname(file)] ??
              'application/octet-stream',
          })
          .end(readFileSync(file));
      });
      await new Promise((ok, fail) => {
        server.once('error', fail);
        server.listen(5799, '127.0.0.1', ok);
      });
      const env = {
        ...process.env,
        PYTHONPATH: join(root, 'services/body'),
        ANNY_CACHE_DIR: join(root, '.cache/anny'),
        XDG_CACHE_HOME: join(root, '.cache'),
        FIT_AGENT_STORE_DIR: join(work, 'store'),
        FIT_AGENT_CLAUDE_CLI: 'overnight-disabled-claude',
        FIT_AGENT_STUDIO: '1',
        PYTHONUNBUFFERED: '1',
      };
      for (const name of [
        'PIP_NO_INDEX',
        'FIT_AGENT_ALLOW_PAID_LLM',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'SATISFY_KIOSK_MODE',
      ])
        delete env[name];
      service = spawn(
        join(root, '.venv/Scripts/python.exe'),
        [
          '-m',
          'uvicorn',
          'body_service.agent.standalone:app',
          '--host',
          '127.0.0.1',
          '--port',
          '8013',
          '--no-access-log',
        ],
        { env, cwd: root, stdio: 'inherit' },
      );
      let loaded = false;
      for (let i = 0; i < 180 && service.exitCode === null && !interrupted; i++) {
        loaded = await fetch('http://127.0.0.1:8013/health')
          .then((r) => r.json())
          .then((r) => r.model_loaded)
          .catch(() => false);
        if (loaded) break;
        await new Promise((ok) => setTimeout(ok, 1000));
      }
      if (!loaded || interrupted) throw new Error('Own agent service stopped or failed to warm up');
      context = await chromium.launchPersistentContext(join(work, 'chrome'), {
        channel: 'chrome',
        headless: false,
        ignoreDefaultArgs: ['--disable-extensions'],
        args: [
          '--enable-unsafe-extension-debugging',
          '--disable-background-networking',
          '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
        ],
      });
      context.on('requestfinished', (request) => {
        const url = new URL(request.url());
        if (
          ['http:', 'https:'].includes(url.protocol) &&
          !['127.0.0.1', 'localhost'].includes(url.hostname)
        )
          externalCompleted++;
      });
      if (interrupted) throw new Error('Demo stopped');
      await context.route('**/*', (route) => {
        const u = new URL(route.request().url());
        if (
          u.hostname === '127.0.0.1' ||
          ['chrome-extension:', 'data:', 'blob:'].includes(u.protocol)
        )
          return route.continue();
        blocked.push(u.origin);
        return route.abort();
      });
      const cdp = await context.browser().newBrowserCDPSession();
      const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
      await context.addInitScript(() => {
        if (
          window !== window.top ||
          location.origin !== 'http://127.0.0.1:5799' ||
          !['/01-garment.html', '/02-body.html'].includes(location.pathname)
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
      const page = await context.newPage();
      await page.goto('http://127.0.0.1:5799/01-garment.html');
      console.log(`Offline demo ready. Profile: chrome-extension://${id}/profile.html`);
      console.log('Second saved page: http://127.0.0.1:5799/02-body.html');
      console.log('Measured local catalogue hand-off: http://127.0.0.1:5799/catalogue');
      if (rehearse) {
        await runJudgeScript(context, page, root);
      } else if (smoke) {
        for (const name of ['01-garment.html', '02-body.html']) {
          await page.goto(`http://127.0.0.1:5799/${name}`);
          await page.getByTestId('needs-profile').waitFor({ timeout: 30_000 });
          await page
            .getByText('Offline demo copy of a saved Amazon page', { exact: true })
            .waitFor();
          const sheets = await page.evaluate(() =>
            Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
              .filter((el) => el.href?.includes('_files/'))
              .map((el) => el.sheet !== null),
          );
          if (!sheets.length || sheets.some((loaded) => !loaded))
            throw new Error(`Saved stylesheets failed on ${name}`);
          console.log(`[smoke] ${name}: panel, offline note, ${sheets.length} local stylesheets`);
        }
        await page.goto(`chrome-extension://${id}/profile.html`);
        await page.locator('#height').waitFor();
        if ((await page.locator('#height').inputValue()) !== '')
          throw new Error('Throwaway profile unexpectedly contains a body');
        console.log('[smoke] Fresh profile is empty; demo startup passed');
      } else await new Promise((ok) => context.once('close', ok));
    } finally {
      clearTimeout(lease);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      await context?.close().catch(() => {});
      if (service?.pid && service.exitCode === null && process.platform === 'win32')
        spawnSync('taskkill', ['/PID', String(service.pid), '/T', '/F'], { stdio: 'ignore' });
      else service?.kill();
      await new Promise((ok) => (server?.listening ? server.close(ok) : ok()));
      await studio?.close();
      console.log(
        `Observed non-loopback requests completed: ${externalCompleted}. Blocked attempts: ${blocked.length}.`,
      );
      if (externalCompleted) process.exitCode = 1;
    }
  },
  {
    inspect: async () => {
      if (Date.now() > waitDeadline)
        throw new Error(
          'Browser resources unavailable after ten minutes; no foreign process touched',
        );
      const { browserReadiness } = await import('./lookdev/browser-slot.mjs');
      const state = await browserReadiness();
      // Extra own ports must also be free: never send test requests to a foreign service.
      const { createServer: probeServer } = await import('node:net');
      for (const port of [8013, 5799]) {
        const probe = probeServer();
        await new Promise((ok) => {
          probe.once('error', () => {
            state.busyPorts.push(port);
            ok();
          });
          probe.listen(port, '127.0.0.1', () => probe.close(ok));
        });
      }
      return state;
    },
  },
);
