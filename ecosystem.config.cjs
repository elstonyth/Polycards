// PM2 process file — keeps the Radmin-VPN preview stack running permanently
// (user request 2026-06-10: "always started until this project finishes").
// Start:   pm2 start ecosystem.config.cjs && pm2 save
// Status:  pm2 status | pm2 logs <name>
// All three bind 0.0.0.0 and are reachable at http://26.42.209.183:<port>.
//
// NOTES (from docs/research + session memory):
// - pokenic-store serves the PROD BUILD: after `npm run build`, run
//   `pm2 restart pokenic-store` to pick it up.
// - pokenic-backend MUST run `medusa develop` (dev mode), NOT `medusa start`:
//   production mode marks the admin session cookie Secure, which browsers
//   drop over plain http:// → admin login silently fails. develop is
//   transpile-only — `corepack yarn build` stays the backend type gate.
// - pokenic-admin serves the built dist (vite preview); the backend URL
//   (26.42.209.183:9000) is baked at build time in apps/admin/vite.config.ts.
module.exports = {
  apps: [
    {
      name: "pokenic-store",
      cwd: __dirname,
      script: "node_modules/next/dist/bin/next",
      args: "start -p 4000",
      interpreter: "C:/Program Files/nodejs/node.exe",
      windowsHide: true,
      max_restarts: 10,
      restart_delay: 3000,
    },
    {
      // LIVE-EDIT preview: hot-reloads on every source change, reachable at
      // http://26.42.209.183:4100. Known machine quirk: next dev serves
      // images slowly here — :4000 (prod build) stays the fidelity reference;
      // never verify clone work against this one.
      name: "pokenic-store-dev",
      cwd: __dirname,
      script: "node_modules/next/dist/bin/next",
      args: "dev -p 4100",
      interpreter: "C:/Program Files/nodejs/node.exe",
      windowsHide: true,
      max_restarts: 10,
      restart_delay: 3000,
    },
    {
      name: "pokenic-backend",
      cwd: `${__dirname}/backend/packages/api`,
      script: "node_modules/@medusajs/cli/cli.js",
      args: "develop",
      interpreter: "C:/Program Files/nodejs/node.exe",
      windowsHide: true,
      env: { NODE_ENV: "development" },
      max_restarts: 10,
      restart_delay: 5000,
    },
    {
      name: "pokenic-admin",
      cwd: `${__dirname}/backend/apps/admin`,
      script: "../../node_modules/vite/bin/vite.js",
      args: "preview --port 7000 --host",
      interpreter: "C:/Program Files/nodejs/node.exe",
      windowsHide: true,
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};
