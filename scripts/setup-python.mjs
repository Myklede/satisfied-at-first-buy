import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { localEnv } from './python.mjs';

mkdirSync('.cache/tmp', { recursive: true });
const env = { ...localEnv, TEMP: resolve('.cache/tmp'), TMP: resolve('.cache/tmp') };
const uv = resolve(process.platform === 'win32' ? '.cache/uv/bin/uv.exe' : '.cache/uv/bin/uv');
function step(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (!existsSync(uv)) {
  const command = process.platform === 'win32' ? 'py' : 'python3';
  const prefix = process.platform === 'win32' ? ['-3'] : [];
  step(command, [
    ...prefix,
    '-m',
    'pip',
    'install',
    '--index-url',
    'https://pypi.org/simple',
    '--target',
    '.cache/uv',
    'uv==0.13.7',
    '--disable-pip-version-check',
  ]);
}
step(uv, ['python', 'install', '3.12', '--no-bin', '--no-registry']);
step(uv, ['sync', '--locked']);
