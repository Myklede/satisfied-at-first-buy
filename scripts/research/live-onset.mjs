import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
process.chdir(root);
if (freemem() < 2 * 2 ** 30) throw new Error('Lead rule: >=2 GiB free RAM');
writeFileSync(
  '.cache/research/live1/onset-run.py',
  `#! ${root.replaceAll('\\', '/')}/.venv/Scripts/python.exe
import runpy,sys
from pathlib import Path
sys.path[0]=str(Path.cwd())
runpy.run_path('scripts/research/live-onset.py',run_name='__main__')
`,
);
execFileSync('py', ['.cache/research/live1/onset-run.py'], { stdio: 'inherit' });
