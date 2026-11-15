// Typecheck + unit tests for the extension with the repo's installed tools.
//   node apps/extension/check.mjs            (tsc --noEmit, then vitest run)
// Lint/format are covered by the root `npm run lint` (eslint apps, prettier --check apps).
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const steps = [
  [join(root, 'node_modules/typescript/bin/tsc'), ['-p', join(here, 'tsconfig.json')]],
  [join(root, 'node_modules/vitest/vitest.mjs'), ['run', '--root', here]],
];
for (const [script, args] of steps) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', cwd: root });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
