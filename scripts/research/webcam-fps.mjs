import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
process.chdir(root);
// User stopped ALL camera probes when moving the live camera to Camo.
// Only an explicit later user instruction may lift this guard.
const probingAuthorized = false;
if (!probingAuthorized)
  throw new Error('Camera probing stopped by the user; use offline files only');
const args = process.argv.slice(2);
if (!args.includes('--camera-idle')) throw new Error('Confirm camera idle with the user first');
if (freemem() < 2 * 2 ** 30) throw new Error('Lead rule: CPU analysis requires >=2 GiB free RAM');
const options = args.filter((s) => s !== '--camera-idle');
if (!/^--backend (MSMF|DSHOW) --batch (formats|exposure) --index \d+$/.test(options.join(' ')))
  throw new Error(
    'Use --backend MSMF|DSHOW --batch formats|exposure --index <verified device index>',
  );
const syncPath = 'docs/requests/codex-sync.md';
const sync = readFileSync(syncPath, 'utf8').split('\n');
const active = new Set();
for (const line of sync) {
  const m = line.match(/^\d{4}-\d\d-\d\d \d\d:\d\d (F2|CX-TRY): CAMERA PROBE (start|end)/);
  if (m) {
    if (m[2] === 'start') active.add(m[1]);
    else active.delete(m[1]);
  }
}
if (active.size) throw new Error('Another camera probe is open: ' + [...active].join(', '));
const stamp = () =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/New_York',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date());
execFileSync('git', ['check-ignore', '-q', '.cache/research/webcam/probe.json']);
mkdirSync('.cache/research/webcam', { recursive: true });
const helper = '.cache/research/webcam/launch.py';
writeFileSync(
  helper,
  `#! ${root.replaceAll('\\', '/')}/.venv/Scripts/python.exe\nimport runpy,sys\nsys.argv=['scripts/research/webcam-fps.py']+sys.argv[1:]\nrunpy.run_path('scripts/research/webcam-fps.py',run_name='__main__')\n`,
);
appendFileSync(
  syncPath,
  `\n${stamp()} CX-TRY: CAMERA PROBE start (P27 OpenCV ${options.join(' ')}, <=175 s; no pixels saved).\n`,
);
try {
  execFileSync('py', [helper, ...options], { stdio: 'inherit', timeout: 175000 });
} finally {
  appendFileSync(
    syncPath,
    `${stamp()} CX-TRY: CAMERA PROBE end (P27 child exited; camera released by finally or process teardown).\n`,
  );
}
