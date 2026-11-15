import { defineConfig } from 'vitest/config';

// Unit tests for pure logic (pinch, filters, scan geometry). Browser pipelines are
// exercised separately in headed Chrome via scripts/*.mjs smoke benches.
export default defineConfig({
  test: { root: '.', include: ['src/**/*.test.ts'], environment: 'node' },
});
