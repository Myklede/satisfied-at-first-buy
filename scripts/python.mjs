import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

// All entry points use the repository interpreter, never a global Python.
export const python = resolve(
  process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python',
);
export const localEnv = {
  ...process.env,
  ANNY_CACHE_DIR: resolve('.cache/anny'),
  XDG_CACHE_HOME: resolve('.cache'),
  UV_CACHE_DIR: resolve('.cache/uv-cache'),
  UV_PYTHON_INSTALL_DIR: resolve('.cache/python'),
  PYTHONPATH: resolve('services/body'),
  PYTHONUNBUFFERED: '1',
};
delete localEnv.PIP_NO_INDEX;

export function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: 'inherit', env: localEnv, ...options });
  child.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  return child;
}
