import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
process.chdir(root);
if (freemem() < 2 * 2 ** 30) throw new Error('Lead rule: CPU analysis requires >=2 GiB free RAM');
execFileSync('git', ['check-ignore', '-q', '.cache/research/live1/probe.jpg']);
mkdirSync('.cache/research/live1', { recursive: true });
const helper = '.cache/research/live1/launch.py';
writeFileSync(
  helper,
  `#! ${root.replaceAll('\\', '/')}/.venv/Scripts/python.exe\nimport runpy,sys\nsys.argv=['scripts/research/live-recordings.py']+sys.argv[1:]\nrunpy.run_path('scripts/research/live-recordings.py',run_name='__main__')\n`,
);
const args = process.argv.slice(2);
if (!/^--clip (live-(parka|puffer)|camo-1)( --align-only)?$/.test(args.join(' ')))
  throw new Error('Expected --clip live-parka|live-puffer|camo-1 [--align-only]');
execFileSync('py', [helper, ...args], { stdio: 'inherit' });
