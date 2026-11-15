// Pinned local-only checks, one fair bounded lease. No npm/npx updater or package install.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireCodexDaySlot } from './codex-day-slot.mjs';
const root = resolve(import.meta.dirname, '..');
const scripts = [
  'scripts/ar-eval.mjs',
  'scripts/ar-eval-lib.mjs',
  'scripts/ar-eval-sampler.mjs',
  'scripts/ar-eval-rest.mjs',
  'scripts/ar-eval-steps.mjs',
  'scripts/ar-eval.test.mjs',
  'scripts/ar-eval-rest.test.mjs',
  'scripts/codex-day-slot.mjs',
  'scripts/codex-day-slot.test.mjs',
  'scripts/codex-day-check.mjs',
];
const release = await acquireCodexDaySlot('baseline checks');
const report = {
  at: new Date().toISOString(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  checks: [],
};
mkdirSync(join(root, '.cache/cx-day'), { recursive: true });
const fd = openSync(join(root, '.cache/cx-day/baseline-checks.log'), 'w');
let child, timer;
try {
  timer = setTimeout(() => {
    report.timeout = true;
    if (child?.exitCode === null)
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }, 13 * 60000);
  const jobs = [
    ['typecheck', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/web']],
    [
      'node tests',
      [
        '--test',
        'scripts/ar-eval.test.mjs',
        'scripts/ar-eval-rest.test.mjs',
        'scripts/codex-day-slot.test.mjs',
      ],
    ],
    ['eslint', ['node_modules/eslint/bin/eslint.js', ...scripts]],
    ['prettier', ['node_modules/prettier/bin/prettier.cjs', '--check', ...scripts]],
  ];
  for (const [name, args] of jobs) {
    child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env: {
        ...process.env,
        npm_config_update_notifier: 'false',
        npm_config_offline: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
      },
    });
    const code = await new Promise((done, reject) => {
      child.once('exit', done);
      child.once('error', reject);
    });
    report.checks.push({ name, exitCode: code });
    if (report.timeout) break;
  }
  report.pass =
    !report.timeout &&
    report.checks.length === jobs.length &&
    report.checks.every((c) => c.exitCode === 0);
} finally {
  clearTimeout(timer);
  closeSync(fd);
  report.finished = new Date().toISOString();
  try {
    writeFileSync(
      join(root, 'docs/validation/demo-day-17-baseline-checks.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
  } finally {
    release();
  }
}
console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exitCode = 1;
