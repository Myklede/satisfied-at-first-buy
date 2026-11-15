// npm run sandbox: the jacket look-dev sandbox in one command (a simpler cousin of scripts/kiosk.mjs).
//   1. production build of the web app into .cache/sandbox-dist (never touches apps/web/dist)
//   2. body service on loopback: reuses a healthy one of THIS checkout's engine version, else starts
//      its own (SATISFY_KIOSK_MODE=1: the Fit Agent never reads or writes a stored body profile)
//   3. static server + /api proxy + read-only /sandbox/refs for data/reference-photos, loopback only
//   4. installed Chrome, windowed (--app), at /?sandbox, own profile .cache/sandbox-chrome
// Closing the window stops everything this script started.
//
// Flags (env in brackets):
//   --api-port N   [SATISFY_API_PORT]      body service port to reuse or start from, default 8001
//   --port N       [SATISFY_SANDBOX_PORT]  web port, default 5740
//   --no-browser   do not open Chrome (print the URL)
//   --no-build     reuse the existing .cache/sandbox-dist
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { handleReferenceRequest } from './reference-photos.mjs';
import { startKioskServer } from './kiosk-server.mjs';
import { localEnv, python } from './python.mjs';

const root = resolve(import.meta.dirname, '..');
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
const port = option('--port', 'SATISFY_SANDBOX_PORT', 5740);
const log = (message) => console.log(`[sandbox] ${message}`);
const LOOPBACK_ONLY = 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost';

const dist = join(root, '.cache/sandbox-dist');
if (!flag('--no-build')) {
  log('building the web app (production) into .cache/sandbox-dist …');
  const build = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules/vite/bin/vite.js'),
      'build',
      join(root, 'apps/web'),
      '--outDir',
      dist,
      '--emptyOutDir',
    ],
    { stdio: 'inherit', cwd: root },
  );
  if (build.status !== 0) throw new Error('Web build failed');
}
if (!existsSync(join(dist, 'index.html')))
  throw new Error('.cache/sandbox-dist is missing; run without --no-build');

// ---------- body service: reuse or start ----------
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
async function health(p) {
  try {
    const response = await fetch(`http://127.0.0.1:${p}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
let service;
let chrome;
let closing = false;
let reused = false;
if (await portBusy(apiPort)) {
  const found = await health(apiPort);
  if (found?.model_loaded === true && found.engine_version === localEngineVersion()) {
    reused = true;
    log(`reusing the body service on 127.0.0.1:${apiPort} (engine ${found.engine_version})`);
  } else {
    const busy = apiPort;
    while (await portBusy(++apiPort)) if (apiPort > busy + 20) throw new Error('No free API port');
    log(`port ${busy} is busy with another service; starting our own on ${apiPort}`);
  }
}
if (!reused) {
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
    log(`body service exited (${code}); stopping`);
    shutdown(1);
  });
}

function shutdown(code = 0) {
  if (closing) return;
  closing = true;
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
  status: () => ({ service: 'up', restarts: 0 }),
  quit: () => shutdown(),
  extraRoute: (req, res, url) => handleReferenceRequest(req, res, url),
});
server.on('error', (error) => log(`server error: ${error.message}`));

const started = performance.now();
for (let i = 0; !(await health(apiPort))?.model_loaded; i++) {
  if (i % 10 === 0) log('waiting for the body model to load …');
  await new Promise((r) => setTimeout(r, 1000));
}
log(`service healthy after ${((performance.now() - started) / 1000).toFixed(1)} s`);

const url = `http://127.0.0.1:${port}/?sandbox`;
log(`serving ${url} (API proxy -> 127.0.0.1:${apiPort}; reference photos: data/reference-photos)`);
if (flag('--no-browser')) log(`--no-browser: open ${url}`);
else {
  const executable = [
    process.env.CHROME_PATH,
    process.env.PROGRAMFILES &&
      join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] &&
      join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA &&
      join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ].find((path) => path && existsSync(path));
  if (!executable) log(`Chrome not found (set CHROME_PATH). Open ${url} manually.`);
  else {
    const profile = join(root, '.cache/sandbox-chrome');
    mkdirSync(profile, { recursive: true });
    chrome = spawn(
      executable,
      [
        `--user-data-dir=${profile}`,
        `--app=${url}`,
        '--window-size=1600,950',
        // Loopback only: nothing but this machine resolves.
        `--host-resolver-rules=${LOOPBACK_ONLY}`,
        '--force_high_performance_gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate',
      ],
      { stdio: 'ignore' },
    );
    chrome.on('exit', () => {
      log('browser window closed');
      shutdown();
    });
    log('opened Chrome (windowed); close the window or press Ctrl+C to stop');
  }
}
