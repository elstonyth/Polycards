import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { mercurDashboardPlugin } from '@mercurjs/dashboard-sdk/vite';

// @acme/odds-math is consumed from SOURCE here, not from its CJS `dist`.
//
// The package's exports map points runtime at ./dist/index.js for the Medusa
// backend (which requires it at runtime), so `dist` has to stay. But the admin
// previously pulled that same CJS build in via `optimizeDeps.include`, and
// Vite's dep-optimizer cache keys on the lockfile and config — NOT on a
// workspace package's rebuilt output. So editing odds-math and rebuilding it
// left node_modules/.vite/deps/@acme_odds-math.js frozen at whatever the dev
// server first bundled: the admin silently imported the OLD module and any
// newly added export came through `undefined`, crashing the page at render
// with no clue pointing back at the cache.
//
// Aliasing to the TypeScript source removes the whole class of failure — no
// prebundle to go stale, no `yarn build` prerequisite for the admin, and HMR
// on odds-math edits. tsc already resolves this package's types from src (see
// its exports map), so source is what typechecking has always described.
const ODDS_MATH_SRC = fileURLToPath(
  new URL('../../packages/odds-math/src/index.ts', import.meta.url),
);

// Backend origin baked into the admin bundle. It must be a VALID ABSOLUTE URL
// — @mercurjs/client does `new URL(baseUrl)` with no fallback, so an
// empty/relative value throws "Invalid URL". Env-driven: the prod build (DO
// App Platform sets MERCUR_BACKEND_URL) targets the deployed backend; dev
// falls back to localhost. A hardcoded localhost ships an admin bundle that
// calls localhost from the user's browser → blank/black dashboard.
const BACKEND_URL = process.env.MERCUR_BACKEND_URL || 'http://localhost:9000';

// mercurDashboardPlugin bakes the SPA's React Router basename into `__BASE__`,
// derived from medusa-config's admin_ui.options.path. Its loader
// (loadMedusaConfig) SILENTLY catches a failure in the prod Docker build and
// returns no base, so `__BASE__` falls back to "/" → the SPA renders its own
// 404 ("There is no page at this address") when served at /dashboard/ (assets
// still resolve via `base` below). Force `__BASE__` to the real mount path,
// independent of that loader. Must run AFTER mercurDashboardPlugin so this
// `define` wins the config merge. See docs/pokenic-do-deploy-handoff.md.
const forceBasename = (basename: string) => ({
  name: 'polycards:force-dashboard-basename',
  config: () => ({ define: { __BASE__: JSON.stringify(basename) } }),
});

// https://vite.dev/config/
export default defineConfig(() => ({
  // Served under /dashboard by the admin-ui module, so assets must resolve to
  // /dashboard/assets/* — without this, vite emits /assets/* (root) and the
  // SPA's JS/CSS 404 (blank dashboard). The mercurDashboardPlugin is supposed
  // to derive this from medusa-config but its loader fails in the prod build,
  // so set it explicitly.
  base: '/dashboard/',
  // Prod storefront origin baked into the bundle so the admin resolves
  // storefront-relative asset paths (/cdn, /home, /images) against the real
  // storefront domain instead of the admin host on :4000 (which 404s in prod).
  // Empty in local dev -> image-url.ts falls back to host:4000. See image-url.ts.
  define: {
    __STOREFRONT_URL__: JSON.stringify(process.env.MERCUR_STOREFRONT_URL || ''),
  },
  // Source, not the CJS dist — see ODDS_MATH_SRC above. This also retires the
  // old `optimizeDeps.include` / `commonjsOptions` pair that existed only to
  // drag that CJS build through Rollup's node_modules-scoped CJS plugin.
  //
  // dedupe react-query: @mercurjs/admin (the prebuilt dashboard that renders
  // OUR routes and owns the QueryClientProvider) pins 5.64.2 and gets its own
  // nested copy, while this app's package.json pins 5.101.4. Two module
  // instances = two React contexts, so every custom page threw "No QueryClient
  // set, use QueryClientProvider to set one" and rendered the dashboard's
  // "An error occurred" card — every page in src/routes at once, including
  // ones nobody had touched. dedupe collapses both imports onto this app's
  // copy so the provider the dashboard mounts is the one our useQuery reads.
  resolve: {
    alias: { '@acme/odds-math': ODDS_MATH_SRC },
    dedupe: ['@tanstack/react-query'],
  },
  server: { port: 7000 },
  plugins: [
    react(),
    mercurDashboardPlugin({
      medusaConfigPath: '../../packages/api/medusa-config.ts',
      backendUrl: BACKEND_URL,
    }),
    forceBasename('/dashboard'),
  ],
}));
