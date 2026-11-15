import { run, python } from './python.mjs';
run(python, ['scripts/prepare_garments.py']).on('exit', (code) => {
  process.exitCode = code ?? 1;
});
