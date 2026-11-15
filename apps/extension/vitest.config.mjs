import { defineConfig } from 'vitest/config';

// Same build-time constants as build.mjs (test values).
export default defineConfig({
  define: {
    __FIT_AGENT_API__: JSON.stringify('http://127.0.0.1:8001'),
    __FIT_AGENT_WEB__: JSON.stringify('http://127.0.0.1:5710'),
    __FIT_AGENT_DEV__: 'true',
  },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
