import { python, run } from './python.mjs';
run(python, ['scripts/check_realism_images.py']).on('exit', (code) => {
  if (code !== 0) process.exitCode = code ?? 1;
  else
    run(python, ['scripts/report_realism.py']).on('exit', (reportCode) => {
      process.exitCode = reportCode ?? 1;
    });
});
