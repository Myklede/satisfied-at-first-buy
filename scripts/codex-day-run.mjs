// Bounded local subprocess orchestration, for each assigned DAY worker.
import { spawn, execFileSync } from 'node:child_process';
import { resolve, relative, isAbsolute } from 'node:path';
import { acquireTimingSlot, acquireHeavySlot } from './codex-heavy-slot.mjs';
import { acquireWorkerBrowserSlot } from './codex-day-slot.mjs';
const args = process.argv.slice(2),
  split = args.indexOf('--');
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const worker = opt('--worker', 'CX-DAY');
const mode = opt('--kind', 'timing');
const minutes = Number(opt('--minutes', mode === 'heavy' ? '19' : '14'));
if (
  !['timing', 'heavy', 'browser'].includes(mode) ||
  !(minutes > 0 && minutes <= (mode === 'heavy' ? 19 : 14)) ||
  split < 0
)
  throw new Error(
    'Use --kind timing|heavy|browser --minutes <=14(or19 heavy) -- node|python <repo script> [args]',
  );
const [runtime, script, ...childArgs] = args.slice(split + 1);
if (!['node', 'python'].includes(runtime) || !script)
  throw new Error('Local Node/Python script required');
const root = resolve(import.meta.dirname, '..'),
  path = resolve(root, script);
const rel = relative(root, path);
if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Script outside repo');
const release = await (mode === 'timing'
  ? acquireTimingSlot(worker, 'bounded local job')
  : mode === 'heavy'
    ? acquireHeavySlot(worker, 'bounded local job')
    : acquireWorkerBrowserSlot(worker, 'bounded local job'));
let child, timer;
try {
  child = spawn(
    runtime === 'node' ? process.execPath : resolve(root, '.venv/Scripts/python.exe'),
    [path, ...childArgs],
    {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, npm_config_update_notifier: 'false', npm_config_offline: 'true' },
    },
  );
  timer = setTimeout(() => {
    if (child.exitCode === null)
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }, minutes * 60000);
  process.exitCode = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => done(code ?? 1));
  });
} finally {
  clearTimeout(timer);
  release();
}
