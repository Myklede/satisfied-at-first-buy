// Heavy gates respect the same shared resource lease as browser benchmarks.
// Output logs remain private cache files; committed JSON contains results/provenance only.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireTimingSlot } from './codex-heavy-slot.mjs';

const root = resolve(import.meta.dirname, '..');
const name = process.argv[2];
if (!['typecheck', 'lint', 'test'].includes(name))
  throw new Error('Choose typecheck, lint or test');
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
git('check-ignore', '-q', '.cache/demo-day-16b/gate.log');
const dir = join(root, '.cache/demo-day-16b');
mkdirSync(dir, { recursive: true });
const release = await acquireTimingSlot('CX-DAY', `gates ${name}`);
const report = {
  gate: name,
  at: new Date().toISOString(),
  head: git('rev-parse', 'HEAD'),
  dirty: git('status', '--porcelain') !== '',
  scope: 'draft shared-tree gates; not final frozen-build GO',
};
const fd = openSync(join(dir, `${name}.txt`), 'w');
let child, timer;
try {
  const npmCli = join(
    process.env.ProgramFiles ?? 'C:/Program Files',
    'nodejs/node_modules/npm/bin/npm-cli.js',
  );
  // Same three suites as root npm test, serially, with one Vitest worker. The
  // shared laptop's 2.5 GiB launch floor cannot support a worker per CPU core.
  const jobs =
    name === 'test'
      ? [
          {
            label: 'web',
            cwd: join(root, 'apps/web'),
            args: [
              join(root, 'node_modules/vitest/vitest.mjs'),
              'run',
              '--maxWorkers=1',
              '--no-file-parallelism',
            ],
          },
          {
            label: 'reference-photos',
            cwd: root,
            args: ['--test', 'scripts/reference-photos.test.mjs'],
          },
          { label: 'python', cwd: root, args: ['scripts/check-python.mjs', 'test'] },
        ]
      : [{ label: name, cwd: root, args: [npmCli, 'run', name] }];
  report.suites = [];
  timer = setTimeout(() => {
    report.timedOut = true;
    if (process.platform === 'win32')
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }, 13 * 60e3);
  for (const job of jobs) {
    const start = Date.now();
    child = spawn(process.execPath, job.args, {
      cwd: job.cwd,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env: {
        ...process.env,
        npm_config_update_notifier: 'false',
        npm_config_offline: 'true',
        npm_config_audit: 'false',
      },
    });
    const exitCode = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', done);
    });
    report.suites.push({ name: job.label, exitCode, ms: Date.now() - start });
    if (report.timedOut) break;
  }
  report.exitCode = report.suites.every((s) => s.exitCode === 0) ? 0 : 1;
  report.pass = report.exitCode === 0 && !report.timedOut;
} catch (error) {
  report.pass = false;
  report.error = error.code ?? error.name;
} finally {
  clearTimeout(timer);
  closeSync(fd);
  report.finished = new Date().toISOString();
  report.headAtEnd = git('rev-parse', 'HEAD');
  try {
    writeFileSync(
      join(root, `docs/validation/demo-day-18-${name}.json`),
      JSON.stringify(report, null, 2) + '\n',
    );
  } finally {
    release();
  }
}
console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exitCode = 1;
