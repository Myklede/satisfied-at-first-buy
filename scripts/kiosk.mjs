// npm run kiosk — one command, one window (prompt 04 Part A).
//   1. vision assets (fetch if missing) → apps/web/public/vision
//   2. production build of the web app
//   3. body service on loopback (watchdog restarts it if it dies)
//   4. kiosk static server + /api proxy on loopback
//   5. wait for /health model_loaded, then open installed Chrome at /?kiosk
// The service runs with SATISFY_KIOSK_MODE=1: the Fit Agent never reads or writes a stored
// body profile while judges use the kiosk (prompt 06 F4). A reused service must report it too.
//
// Flags (env in brackets):
//   --api-port N   [SATISFY_API_PORT]   body service port, default 8001. If a healthy body
//                  service of THIS checkout's engine version already answers there (e.g.
//                  `npm run dev` is running), the kiosk reuses it instead of crash-looping on
//                  the busy port. A busy port with anything else → the kiosk starts its own
//                  service on the next free port (apiPort+1 …).
//   --port N       [SATISFY_KIOSK_PORT] kiosk web port, default 5730
//   --windowed     Chrome --app window (maximized). Default: Chrome --kiosk (true fullscreen;
//                  Esc on the attract screen exits, as its on-screen hint says).
//                  --fullscreen is accepted as the old spelling of the default.
//   --no-browser   do not open Chrome (soak tests, remote operator)
//   --no-build     reuse the existing apps/web/dist
// Camera: --use-fake-ui-for-media-stream auto-accepts the permission prompt in this
// dedicated Chrome profile (.cache/kiosk-chrome) only; real devices are still used.
// Web security is never disabled.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { ensureVisionAssets } from './kiosk-assets.mjs';
import { startKioskServer } from './kiosk-server.mjs';
import { localEnv, python } from './python.mjs';
import { takeBrowserLock, warmKiosk } from './demo-day-warm.mjs';

const root = resolve(import.meta.dirname, '..');
export const LOOPBACK_ONLY = 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost';
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
function option(name, env, fallback) {
  const index = args.indexOf(name);
  const raw = index >= 0 ? args[index + 1] : process.env[env];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1024 || value > 65535)
    throw new Error(`${name} must be a port 1024-65535`);
  return value;
}
let apiPort = option('--api-port', 'SATISFY_API_PORT', 8001);
const port = option('--port', 'SATISFY_KIOSK_PORT', 5730);
const log = (message) => console.log(`[kiosk] ${message}`);
const started = performance.now();
// The slot is checked before this launcher binds 5730. Default launch stays unchanged.
let releaseBrowser;
let browserLeaseTimer;
let browserDeadline;
if (flag('--warm')) {
  if (![5730, 5774].includes(port) || flag('--no-browser'))
    throw new Error('--warm requires port5730 or CX-DAY5774 and a browser');
  // CX-DAY must reuse the shared API, never create a fallback on another agent's port.
  const response = await fetch(`http://127.0.0.1:${apiPort}/agent/profile`, {
    signal: AbortSignal.timeout(5000),
  });
  const privacy = await response.json();
  if (
    !response.ok ||
    privacy.kiosk_mode !== true ||
    privacy.saved !== false ||
    privacy.profile !== null
  )
    throw new Error(
      'Warm-up requires a privacy-mode API; ask its owner to prepare it. No service was changed.',
    );
  releaseBrowser = await takeBrowserLock();
  browserDeadline = performance.now() + 14 * 60000;
  browserLeaseTimer = setTimeout(() => shutdown(1), 14 * 60000);
  process.on('exit', () => releaseBrowser?.());
}

const distArgIndex = args.indexOf('--dist');
const distArg = distArgIndex < 0 ? null : args[distArgIndex + 1];
if (distArg && !/^\.cache\/cx-day\/[a-z0-9-]{1,48}$/.test(distArg))
  throw new Error('Expected private CX-DAY dist path');
const dist = distArg ? join(root, distArg) : join(root, 'apps/web/dist');
if (distArg && !flag('--no-build') && existsSync(dist))
  throw new Error('Preserve existing custom dist; choose a fresh slug');
ensureVisionAssets({ log });
if (!flag('--no-build')) {
  log('building the web app (production)…');
  const build = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules/vite/bin/vite.js'),
      'build',
      join(root, 'apps/web'),
      ...(distArg ? ['--outDir', dist] : []),
    ],
    { stdio: 'inherit', cwd: root },
  );
  if (build.status !== 0) throw new Error('Web build failed');
}
if (!existsSync(join(dist, 'index.html'))) throw new Error('apps/web/dist is missing; build first');

// ---------- reuse a running service of the same version, or pick a free port ----------
/** The engine version this checkout reports on /health (services/body config.MODEL_VERSION). */
function localEngineVersion() {
  const config = readFileSync(join(root, 'services/body/body_service/config.py'), 'utf8');
  return /^MODEL_VERSION\s*=\s*"([^"]+)"/m.exec(config)?.[1] ?? null;
}
function portBusy(p) {
  return new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port: p });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}
/** Fit Agent privacy flag of a running service: true only if it reports kiosk mode. */
async function kioskModeOf(p) {
  try {
    const response = await fetch(`http://127.0.0.1:${p}/agent/profile`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok && (await response.json()).kiosk_mode === true;
  } catch {
    return false;
  }
}
async function runningService(p) {
  try {
    const response = await fetch(`http://127.0.0.1:${p}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
const expectedVersion = localEngineVersion();
let reused = false;
if (await portBusy(apiPort)) {
  const found = await runningService(apiPort);
  if (
    found?.model_loaded === true &&
    found.engine_version === expectedVersion &&
    (await kioskModeOf(apiPort))
  ) {
    reused = true;
    log(
      `reusing the body service already running on 127.0.0.1:${apiPort} (engine ${found.engine_version}); ` +
        'it is not restarted by this watchdog. Stop it (e.g. npm run dev) to let the kiosk own one.',
    );
  } else {
    if (flag('--warm'))
      throw new Error(
        'Warm-up requires the shared ready API of this engine version; coordinate with its owner',
      );
    const busy = apiPort;
    while (await portBusy(++apiPort)) if (apiPort > busy + 20) throw new Error('No free API port');
    log(
      `port ${busy} is busy (${found ? `engine ${found.engine_version ?? '?'}, expected ${expectedVersion}, or not in kiosk privacy mode` : 'not a healthy body service'}); ` +
        `starting the kiosk's own body service on ${apiPort}`,
    );
  }
}

// ---------- body service + watchdog ----------
let service;
let serviceState = 'starting';
let restarts = 0;
let closing = false;
function startService() {
  serviceState = restarts ? 'restarting' : 'starting';
  service = spawn(
    python,
    [
      '-m',
      'uvicorn',
      'body_service.app:app',
      '--host',
      '127.0.0.1',
      '--port',
      String(apiPort),
      '--no-access-log',
    ],
    {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...localEnv, SATISFY_KIOSK_MODE: '1' },
      cwd: root,
    },
  );
  service.on('exit', (code) => {
    if (closing) return;
    restarts++;
    serviceState = 'restarting';
    log(`body service exited (${code}); restarting (#${restarts})`);
    setTimeout(startService, Math.min(5000, 500 * restarts));
  });
  service.on('error', (error) => log(`body service failed to start: ${error.message}`));
}
if (!reused && flag('--warm'))
  throw new Error('Warm-up lost the shared API; coordinate with its owner before retrying');
if (!reused) startService();
else serviceState = 'up';

async function health() {
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/health`);
    return response.ok && (await response.json()).model_loaded === true;
  } catch {
    return false;
  }
}
setInterval(async () => {
  if (closing) return;
  const up = await health();
  if (up) serviceState = 'up';
  else if (serviceState === 'up') serviceState = 'restarting';
}, 1000).unref();

// ---------- browser ----------
let chrome;
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PROGRAMFILES &&
      join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] &&
      join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA &&
      join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ];
  return candidates.find((path) => path && existsSync(path));
}

function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  clearTimeout(browserLeaseTimer);
  log('shutting down');
  for (const child of [chrome, service]) {
    if (!child?.pid || child.exitCode !== null) continue;
    // The Windows venv launcher can own a second Python process: stop our own tree only.
    if (process.platform === 'win32')
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    else child.kill();
  }
  setTimeout(() => process.exit(code), 100);
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

const server = await startKioskServer({
  dist,
  port,
  apiPort,
  log,
  status: () => ({ service: serviceState, restarts }),
  quit: () => shutdown(),
});
server.on('error', (error) => log(`server error: ${error.message}`));
log(`serving http://127.0.0.1:${port}/?kiosk (API proxy → 127.0.0.1:${apiPort})`);

for (let i = 0; !(await health()); i++) {
  if (i % 10 === 0) log('waiting for the body model to load…');
  await new Promise((r) => setTimeout(r, 1000));
}
serviceState = 'up';
log(`service healthy after ${((performance.now() - started) / 1000).toFixed(1)} s`);

const url = `http://127.0.0.1:${port}/?kiosk`;
const windowed = flag('--windowed');
if (!flag('--no-browser')) {
  const executable = findChrome();
  if (!executable) log(`Chrome not found (set CHROME_PATH). Open ${url} manually.`);
  else {
    const profile = join(root, '.cache/kiosk-chrome');
    mkdirSync(profile, { recursive: true });
    if (flag('--warm')) {
      const warm = await warmKiosk({
        dist,
        executablePath: executable,
        origin: `http://127.0.0.1:${port}`,
        profile,
        log,
        timeoutMs: Math.max(1, browserDeadline - performance.now()),
      });
      // Keep the same lease through the reopened judge window. Every Chrome job owns the lock.
      if (!warm.proven)
        log('WARNING: warm-up is not proven; inspect .cache/kiosk-warm.json before judging');
    }
    chrome = spawn(
      executable,
      [
        `--user-data-dir=${profile}`,
        windowed ? '--start-maximized' : '--kiosk',
        windowed ? `--app=${url}` : url,
        '--use-fake-ui-for-media-stream', // auto-accept camera for this profile only
        // Loopback only: @mediapipe/tasks-vision 1.2.2 posts usage logs to
        // odml.pa.googleapis.com and has no opt-out. No host but loopback resolves here.
        `--host-resolver-rules=${LOOPBACK_ONLY}`,
        '--force_high_performance_gpu', // prefer the discrete GPU (RTX 3050)
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-session-crashed-bubble',
        '--disable-features=Translate',
      ],
      { stdio: 'ignore' },
    );
    chrome.on('exit', () => {
      log('browser window closed');
      shutdown();
    });
    log(`opened Chrome (${windowed ? 'app window' : 'fullscreen kiosk; Esc on attract exits'})`);
  }
} else log(`--no-browser: open ${url}`);
