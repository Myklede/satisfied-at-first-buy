import { python, run } from './python.mjs';
run(python, ['-m', 'body_service.validation', ...process.argv.slice(2)]).on('exit', (code) => {
  process.exitCode = code ?? 1;
});
