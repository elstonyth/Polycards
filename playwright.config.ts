import { defineConfig } from '@playwright/test';

// E2E suite for the Pokenic gacha stack. Drives THREE live surfaces:
//   storefront (prod standalone, :4000) · admin dashboard (vite, :7000) · backend (:9000)
// Services are expected to already be running (see tests/e2e/README.md). There is
// no webServer block on purpose — the storefront must be the production
// standalone build, not `next dev` (CLAUDE.md), so we don't auto-spawn it here.
//
// State is shared (one Postgres): odds, stock, and credits mutate. Run serially
// with a single worker so flows don't race each other.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  // One retry in CI only: a 3-service full stack on a shared runner needs flake
  // tolerance; locally a retry just hides real breakage slower.
  retries: process.env.CI ? 1 : 0,
  // Reveal theater + multiple real opens are slow; give each test room.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'tests/e2e/.report', open: 'never' }],
  ],
  outputDir: 'tests/e2e/.artifacts',
  use: {
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  // 'setup' logs the operator in once and saves the session; 'e2e' reuses it via
  // storageState so admin /auth isn't hammered (it rate-limits sign-ins).
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'e2e',
      testIgnore: /auth\.setup\.ts/,
      dependencies: ['setup'],
      use: { storageState: 'tests/e2e/.auth/admin.json' },
    },
  ],
});
