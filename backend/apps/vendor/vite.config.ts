import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { mercurDashboardPlugin } from '@mercurjs/dashboard-sdk/vite';

// Backend origin baked into the vendor bundle. It must be a VALID ABSOLUTE URL
// — @mercurjs/client does `new URL(baseUrl)` with no fallback, so an
// empty/relative value throws "Invalid URL". Env-driven: the prod build (DO
// App Platform sets MERCUR_BACKEND_URL) targets the deployed backend; dev
// falls back to localhost. A hardcoded localhost ships a vendor bundle that
// calls localhost from the user's browser → blank/black dashboard.
const BACKEND_URL = process.env.MERCUR_BACKEND_URL || 'http://localhost:9000';

// mercurDashboardPlugin bakes the SPA's React Router basename into `__BASE__`,
// derived from medusa-config's vendor_ui.options.path. Its loader
// (loadMedusaConfig) SILENTLY catches a failure in the prod Docker build and
// returns no base, so `__BASE__` falls back to "/" → the SPA renders its own
// 404 ("There is no page at this address") when served at /seller/ (assets
// still resolve via `base` below). Force `__BASE__` to the real mount path,
// independent of that loader. Must run AFTER mercurDashboardPlugin so this
// `define` wins the config merge. See docs/pokenic-do-deploy-handoff.md.
const forceBasename = (basename: string) => ({
  name: 'polycards:force-dashboard-basename',
  config: () => ({ define: { __BASE__: JSON.stringify(basename) } }),
});

// https://vite.dev/config/
export default defineConfig(() => ({
  // Served under /seller by the vendor-ui module, so assets must resolve to
  // /seller/assets/* — without this, vite emits /assets/* (root) and the SPA's
  // JS/CSS 404 (blank dashboard). The mercurDashboardPlugin is supposed to
  // derive this from medusa-config but its loader fails in the prod build, so
  // set it explicitly.
  base: '/seller/',
  server: { port: 7001 },
  plugins: [
    react(),
    mercurDashboardPlugin({
      medusaConfigPath: '../../packages/api/medusa-config.ts',
      backendUrl: BACKEND_URL,
    }),
    forceBasename('/seller'),
  ],
}));
