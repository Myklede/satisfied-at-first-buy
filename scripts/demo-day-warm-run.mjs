// Unattended warm-launch rehearsal: one waiter; launcher owns the actual lease.
// Close only this launcher's judge window via its local operator endpoint.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { waitForBrowserSlot, BROWSER_LOCK } from './lookdev/browser-slot.mjs';

const root = resolve(import.meta.dirname, '..');
const pause = () => new Promise((done) => setTimeout(done, 60000));
while (true) {
  await waitForBrowserSlot();
  if (existsSync(BROWSER_LOCK)) {
    console.log('CX-DAY warm waiting 60s: browser lock held');
    await pause();
    continue;
  }
  const at = new Date().toISOString();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  let output = '',
    ownWindow = false,
    quitStatus = null;
  const child = spawn(
    process.execPath,
    [
      'scripts/kiosk.mjs',
      '--warm',
      '--windowed',
      '--port',
      '5774',
      '--dist',
      `.cache/cx-day/demo-dist-${Date.now()}`,
    ],
    {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const observe = (bytes) => {
    const text = bytes.toString();
    process.stdout.write(text);
    output += text;
    if (!ownWindow && output.includes('[kiosk] opened Chrome (app window)')) {
      ownWindow = true;
      // This exact log comes only after this child bound 5774 and finished both warm passes.
      // Do not send quit for a pre-existing/foreign server or before our child opens its window.
      setTimeout(async () => {
        try {
          if (child.exitCode !== null) return;
          const owner = readFileSync(join(BROWSER_LOCK, 'owner.txt'), 'utf8');
          if (!owner.startsWith('CX-DAY ') || !owner.includes(`\nPID ${child.pid}\n`)) return;
          const r = await fetch('http://127.0.0.1:5774/kiosk/quit', {
            method: 'POST',
            headers: { Origin: 'http://127.0.0.1:5774' },
            signal: AbortSignal.timeout(5000),
          });
          quitStatus = r.status;
        } catch {
          quitStatus = 'failed; launcher keeps its own bounded lease';
        }
      }, 2000);
    }
  };
  child.stdout.on('data', observe);
  child.stderr.on('data', observe);
  const code = await new Promise((done, reject) => {
    child.once('exit', done);
    child.once('error', reject);
  });
  if (!ownWindow && /Browser slot unavailable|EEXIST.*browser/.test(output)) {
    // Another owner won the atomic mkdir after our readiness observation; requeue without killing it.
    console.log('CX-DAY warm lost the slot race; waiting 60s');
    await pause();
    continue;
  }
  let warm = null;
  try {
    const candidate = JSON.parse(readFileSync(join(root, '.cache/kiosk-warm.json'), 'utf8'));
    if (candidate.at >= at) warm = candidate;
  } catch {
    /* No new evidence is not success. */
  }
  const report = {
    at,
    head,
    finished: new Date().toISOString(),
    exitCode: code,
    ownWindow,
    quitStatus,
    scope: 'draft warm launcher; reopened judge green cue not inspected',
    warm,
    pass:
      code === 0 &&
      ownWindow &&
      quitStatus === 200 &&
      warm?.runs?.length === 2 &&
      warm.runs.every((r) => r.complete && r.deleted),
  };
  writeFileSync(
    join(root, 'docs/validation/demo-day-18-warm.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  if (!report.pass) process.exitCode = 1;
  break;
}
