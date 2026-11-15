import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
process.chdir(root);
execFileSync('git', ['check-ignore', '-q', '.cache/research/jacket-targets/probe.png']);
mkdirSync('.cache/research/jacket-targets', { recursive: true });
const helper = '.cache/research/jacket-targets/launch.py';
writeFileSync(
  helper,
  `#! ${root.replaceAll('\\', '/')}/.venv/Scripts/python.exe
import runpy,sys
sys.argv=['scripts/research/jacket-targets.py']+sys.argv[1:]
runpy.run_path('scripts/research/jacket-targets.py',run_name='__main__')
`,
);
const options = process.argv.slice(2);
let keys = ['venue-parka', 'venue-puffer'];
const clipAt = options.indexOf('--clip');
if (clipAt >= 0) {
  const key = options[clipAt + 1];
  if (!keys.includes(key)) throw new Error('Unknown fixed jacket key');
  keys = [key];
  options.splice(clipAt, 2);
}
if (options.some((x) => x !== '--samples-only')) throw new Error('Unknown jacket-target option');
for (const key of keys) {
  // Lead/user ruling: CPU-only OpenCV takes no browser/heavy lease.
  execFileSync('py', [helper, ...options, '--clip', key], { stdio: 'inherit' });
}
