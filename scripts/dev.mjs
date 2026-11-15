import { run, python } from './python.mjs';
import { spawn } from 'node:child_process';

// Defaults 8001 / 5710; override with SATISFY_API_PORT / SATISFY_WEB_PORT
// (apps/web/vite.config.ts reads the same variables for its /api proxy).
const apiPort = process.env.SATISFY_API_PORT ?? '8001';
const webPort = process.env.SATISFY_WEB_PORT ?? '5710';

const children = [
  run(python, [
    '-m',
    'uvicorn',
    'body_service.app:app',
    '--host',
    '127.0.0.1',
    '--port',
    apiPort,
    '--no-access-log',
  ]),
  run(process.execPath, [
    'node_modules/vite/bin/vite.js',
    '--config',
    'apps/web/vite.config.ts',
    'apps/web',
    '--host',
    '127.0.0.1',
    '--port',
    webPort,
    '--strictPort',
  ]),
];
let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) {
    if (process.platform === 'win32' && child.pid && child.exitCode === null) {
      // The Windows venv launcher can own a second Python process. Stop only our
      // spawned process trees so the API cannot remain orphaned on port 8001.
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    } else child.kill();
  }
  process.exitCode = code;
}
for (const child of children) {
  child.on('exit', (code) => shutdown(code ?? 1));
  child.on('error', () => shutdown(1));
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
