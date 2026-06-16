import { defineConfig } from 'vitest/config';

// Standalone, intentionally NOT extending vite.config.ts: the admin Vite config
// loads mercurDashboardPlugin (which reads the Medusa config). These tests are
// pure functions, so we keep a minimal node-environment runner with no plugins.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
