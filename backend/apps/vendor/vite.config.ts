import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { mercurDashboardPlugin } from '@mercurjs/dashboard-sdk'

// Backend origin baked into the vendor bundle. It must be a VALID ABSOLUTE URL
// reachable by every browser that loads this dashboard — @mercurjs/client does
// `new URL(baseUrl)` with no fallback, so an empty/relative value throws
// "Invalid URL". Point it at the Radmin VPN IP so the host AND other machines
// on the VPN both reach the Medusa API (CORS for these origins is set in
// packages/api/.env). For local-only dev, set this to 'http://localhost:9000'.
const BACKEND_URL = 'http://26.42.209.183:9000'

// https://vite.dev/config/
export default defineConfig(() => ({
  // host:true binds 0.0.0.0 so the vendor dashboard is reachable over the LAN/VPN.
  server: { host: true, port: 7001 },
  plugins: [
    react(),
    mercurDashboardPlugin({
      medusaConfigPath: '../../packages/api/medusa-config.ts',
      backendUrl: BACKEND_URL,
    }),
  ],
}))
