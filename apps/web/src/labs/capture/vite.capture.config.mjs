// Stable local capture server: stamps the actual git build without any runtime HTTP request.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import base from '../../../vite.config.ts';

const cwd = fileURLToPath(new URL('../../../../../', import.meta.url));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
const dirty =
  execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim().length > 0;
export default mergeConfig(base, {
  define: { __CAPTURE_BUILD__: JSON.stringify({ commit, dirty }) },
  server: {
    host: '127.0.0.1',
    port: 5781,
    strictPort: true,
    hmr: false,
    watch: { ignored: ['**/*'] },
  },
});
