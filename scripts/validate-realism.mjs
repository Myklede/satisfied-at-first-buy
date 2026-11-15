import { spawn } from 'node:child_process';
import { python, localEnv } from './python.mjs';

async function command(binary, args) {
  const child = spawn(binary, args, {
    env: { ...localEnv, OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1' },
    stdio: 'inherit',
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) throw new Error(`${args.join(' ')} failed (${code})`);
}
await command(python, ['scripts/export_realism.py']);
await command(process.execPath, ['scripts/settle-realism.mjs']);
await command(process.execPath, ['scripts/check-cloth-determinism.mjs']);
await command(python, ['scripts/check_realism.py']);
