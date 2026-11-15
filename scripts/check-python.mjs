import { run, python } from './python.mjs';
const tasks = {
  lint: ['-m', 'ruff', 'check', 'services', 'scripts'],
  format: ['-m', 'ruff', 'format', '--check', 'services', 'scripts'],
  test: ['-m', 'pytest', '-q'],
};
const task = process.argv[2];
if (!(task in tasks)) throw new Error('Unknown Python check');
run(python, tasks[task]).on('exit', (code) => {
  process.exitCode = code ?? 1;
});
