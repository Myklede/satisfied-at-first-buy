// The real studio, served inside the demo's existing port; no extra web/API listener.
import { join } from 'node:path';
import { createServer } from 'vite';
export function studioMiddleware(root, work) {
  return createServer({
    root: join(root, 'apps/web'),
    configFile: join(root, 'apps/web/vite.config.ts'),
    cacheDir: join(work, 'vite-cache'),
    server: {
      middlewareMode: true,
      hmr: false,
      proxy: {
        '/api': { target: 'http://127.0.0.1:8013', rewrite: (path) => path.replace(/^\/api/, '') },
      },
    },
  });
}
