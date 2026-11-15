import { run, python } from './python.mjs';
run(python, ['-m', 'body_service.garment.validation']).on('exit', (code) => {
  process.exitCode = code ?? 1;
});
