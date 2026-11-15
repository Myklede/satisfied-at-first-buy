import { spawnSync } from 'node:child_process';
import { python, localEnv } from './python.mjs';
for (const [command, args] of [
  [python, ['scripts/export_schemas.py']],
  [python, ['scripts/export_openapi.py']],
  [
    process.execPath,
    [
      'node_modules/openapi-typescript/bin/cli.js',
      'packages/api-types/openapi.json',
      '-o',
      'packages/api-types/index.d.ts',
    ],
  ],
]) {
  const result = spawnSync(command, args, { env: localEnv, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
