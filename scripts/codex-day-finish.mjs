// V4 measurement only: own Vite5773, both leases, bounded child; never edits finisher code.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireTimingSlot } from './codex-heavy-slot.mjs';
import { buildHash } from './demo-day-warm.mjs';
const root = resolve(import.meta.dirname, '..');
const dir = join(root, '.cache/cx-day/finish');
mkdirSync(dir, { recursive: true });
const release = await acquireTimingSlot('CX-DAY', 'V4 measurement');
let server, child, timer, fd;
const meta = {
  started: new Date().toISOString(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
};
try {
  const { createServer } = await import('vite');
  meta.sourceStartHash = buildHash(join(root, 'apps/web/src'));
  server = await createServer({
    root: join(root, 'apps/web'),
    configFile: join(root, 'apps/web/src/engine/live/ar/finish/eval/vite.v4.config.ts'),
    logLevel: 'error',
    cacheDir: join(dir, 'vite'),
    server: {
      host: '127.0.0.1',
      port: 5773,
      strictPort: true,
      hmr: false,
      watch: { ignored: ['**/*'] },
    },
  });
  await server.listen();
  const out = `.cache/cx-day/finish/run-${Date.now()}.json`;
  meta.output = out;
  fd = openSync(join(dir, 'eval.log'), 'w');
  child = spawn(
    process.execPath,
    [
      '--import',
      './scripts/codex-day-finish-input.mjs',
      'apps/web/src/engine/live/ar/finish/eval/run-finish-eval.mjs',
      '--port',
      '5773',
      '--no-lock',
      '--out',
      out,
      '--videos',
      'cam-tshirt,cam-parka',
      '--step',
      '1',
      '--viewport',
      '2000x1150',
      '--stale',
      '1.5,2.5,3.5',
      '--stale-lag',
      '0.1',
      '--still',
      'cam-tshirt:1.2-3,cam-parka:1.5-3',
    ],
    { cwd: root, stdio: ['ignore', fd, fd], windowsHide: true },
  );
  timer = setTimeout(() => {
    meta.timeout = true;
    if (child.exitCode === null)
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }, 13 * 60000);
  meta.exitCode = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', done);
  });
  meta.sourceEndHash = buildHash(join(root, 'apps/web/src'));
  meta.sourceStable = meta.sourceStartHash === meta.sourceEndHash;
  if (meta.exitCode === 0) {
    const report = JSON.parse(readFileSync(join(root, out), 'utf8'));
    meta.complete =
      !report.error &&
      ['cam-tshirt', 'cam-parka'].every(
        (k) => report.videos[k] && !report.videos[k].error && !report.videos[k].skipped,
      );
  }
} finally {
  clearTimeout(timer);
  if (fd !== undefined) closeSync(fd);
  try {
    await server?.close();
  } finally {
    meta.finished = new Date().toISOString();
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
    release();
  }
}
console.log(JSON.stringify(meta, null, 2));
if (!meta.complete) process.exitCode = 1;
