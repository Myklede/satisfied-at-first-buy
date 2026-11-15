import { defineConfig } from 'vite';

// Lab page for developing the webcam module in isolation from the main app.
// Loopback only, like the rest of the project (AGENTS.md §3).
export default defineConfig({
  root: 'lab',
  publicDir: '../public',
  server: { host: '127.0.0.1', port: 5711, strictPort: true },
});
