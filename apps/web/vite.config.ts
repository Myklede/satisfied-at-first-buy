import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { handleReferenceRequest } from '../../scripts/reference-photos.mjs';

// Node global; apps/web has no @types/node (vite.config runs in Node).
declare const process: { env: Record<string, string | undefined> };

// Ports default to 8001 (API) / 5710 (web); override with SATISFY_API_PORT / SATISFY_WEB_PORT.
const apiPort = Number(process.env.SATISFY_API_PORT ?? 8001);
const webPort = Number(process.env.SATISFY_WEB_PORT ?? 5710);

// Jacket sandbox (/?sandbox): read-only listing and files of data/reference-photos (loopback dev
// server only; see scripts/reference-photos.mjs for the path rules).
const sandboxReferences = (): Plugin => ({
  name: 'sandbox-reference-photos',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = new URL((req as { url?: string }).url ?? '/', 'http://127.0.0.1');
      if (!handleReferenceRequest(req, res, url)) next();
    });
  },
});

export default defineConfig({
  plugins: [react(), sandboxReferences()],
  // @decartai/sdk starts `new Worker(new URL('./frame-metadata-worker.js', import.meta.url))`.
  // Pre-bundled, that URL points into Vite's deps cache, where the file does not exist (404): the
  // worker dies, LiveKit's encoded-frame transform stalls, and no video packet is ever sent
  // (2026-11-15 trial: bytesSent 0, Decart never generated). Serve the SDK unbundled so the
  // worker resolves next to it; its ESM/CJS dependencies are still pre-bundled.
  optimizeDeps: {
    exclude: ['@decartai/sdk'],
    include: [
      '@decartai/sdk > livekit-client',
      '@decartai/sdk > mitt',
      '@decartai/sdk > p-retry',
      '@decartai/sdk > zod',
      '@decartai/sdk > jose',
    ],
  },
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
