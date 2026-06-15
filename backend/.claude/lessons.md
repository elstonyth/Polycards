# Backend Lessons

### `medusa start` fails: "Could not find index.html in the admin build directory"

After editing a Pack model field + `medusa build` + restarting, `medusa start`
aborts with _"Could not find index.html in the admin build directory. Make sure
to run 'medusa build'…"_ — even though `.medusa/server/public/admin/index.html`
exists and is valid. The bundled Medusa `/app` admin loader
(`@medusajs/medusa/dist/loaders/admin.js`) computes
`outDir = path.join(rootDirectory, "./public/admin")`, and the `rootDirectory`
it resolves at `medusa start` time doesn't line up with where the build emits
the admin, so the check fails.

**Fix:** this project does NOT need the bundled `/app` admin. Mercur serves its
own **admin** (`/dashboard`) and **vendor** (`/seller`) dashboards via the
`@mercurjs/core/modules/{admin-ui,vendor-ui}` modules (and the standalone
apps/admin + apps/vendor dev servers, e.g. :7000 / :7001). Set
`admin: { disable: true }` at the top level of `defineConfig({...})` in
`medusa-config.ts` — the admin loader early-returns (`if (disable) return app`),
the server boots, and `/health`, `/dashboard`, `/seller`, and all `/store/*`
routes keep working. Only the redundant `/app` 404s.

Note: a config change only takes effect after a rebuild (`medusa start` runs the
compiled `.medusa/server/medusa-config.js`). For a quick restore without a full
rebuild you can also patch that built file, but always make the change in the
`medusa-config.ts` source too.

### Uploaded /static files are transient — a rebuild can wipe them while the DB keeps the URLs

The local file provider stores uploads in `<cwd>/static` and the DB keeps ABSOLUTE
`http://localhost:9000/static/<epoch>-<name>` URLs. After a backend rebuild the
static dir was gone → every referenced image 404'd (storefront showed broken
card/pack art) while the DB rows still looked fine. `reupload-images.ts` does NOT
self-heal this: it skips rows whose image is already an absolute URL.

**Fix:** `node scripts/restore-backend-static.mjs` (repo root) — queries the DB for
every referenced `/static/` URL, maps `<epoch>-<basename>` back to the source file
under the storefront's `public/`, and copies it into `backend/packages/api/static/`
(idempotent). The dir is gitignored (runtime data). Sanity probe:
`GET :9000/static/<file>` → 200, and the home page audit reports `broken=0`.

### Backend build + restart pattern

- Build from the **backend root**: `corepack yarn build` (turbo builds
  `packages/api` + `apps/*` together). The admin step finishes slightly after
  the main process exits 0, so wait a beat before starting.
- Restart: find the `:9000` listener PID and `Stop-Process` it, then
  `corepack yarn start` from `packages/api`.
- The pack seed (`src/scripts/seed.ts`) is **idempotent by slug** — a re-run only
  CREATES new slugs; it never updates existing rows. New model fields with
  defaults cover existing rows; only NEW packs pick up non-default seed values.

### Integration suites: run via the package scripts, never raw jest

Raw `TEST_TYPE=integration:http ... jest <spec>` HANGS after the tests pass —
the rate limiters' ioredis connections hold the process open ("Jest did not
exit one second after the test run"). The `package.json` scripts carry
`--forceExit --runInBand` for exactly this; use
`corepack yarn test:integration:http <spec>` from `packages/api`. Piping the
run through `tail` also buffers ALL output until exit, so a finished-but-hung
run looks identical to a stuck run (0 bytes of output) — check for the jest
process + its CPU before assuming the tests are slow.

### `medusa develop` watcher can wedge into a listener-less boot loop

PM2 says `online` and logs say "Server is ready on port: 9000" while NOTHING
listens on :9000. Cause: the dev watcher restarts on file change by taskkilling
its previous child; when that PID is already gone (e.g. after a `corepack yarn
build` storm of change events), taskkill exits 128, chokidar throws, and the
restart cycle never re-binds the port. Symptom set: `↺` count climbing,
repeated `ERROR: The process "<pid>" not found.` in logs, `curl :9000/health`
→ 000. Fix: `pm2 restart pokenic-backend` (fresh parent), then re-probe
health AND a real route — "online" in pm2 status proves nothing here.

### `medusa develop` restart flashes a terminal window on every save (PATCHED locally)

Root cause of both the window-popping and the boot loop above:
`@medusajs/medusa/dist/commands/develop.js` `restart()` runs
`execSync("taskkill /PID <pid> /F /T")` on win32 with no `windowsHide` and no
try/catch. Each file-change restart therefore (a) opens a visible Windows
Terminal window for the taskkill child (proven 2026-06-12: window class
`CASCADIA_HOSTING_WINDOW_CLASS` appeared the same second as the taskkill child
pid from the pm2 error object), and (b) throws into chokidar when the PID is
stale → the listener-less wedge.

**Local patch applied 2026-06-12** in
`packages/api/node_modules/@medusajs/medusa/dist/commands/develop.js` —
the win32 branch of `restart()` is now:

```js
try {
  (0, child_process_1.execSync)(
    `taskkill /PID ${this.childProcess.pid} /F /T`,
    { windowsHide: true, stdio: "ignore" },
  );
} catch {}
```

node_modules edits are wiped by any `yarn install` — RE-APPLY this patch after
reinstalling, or every backend save pops a terminal again. (Upstream fix would
belong in medusa core's `develop.ts`.)

### New rate limiter ⇒ park it in .env.test

Every `createEnvRateLimit`-style limiter added to `src/api/middlewares.ts`
needs an effectively-unlimited `<NAME>_RATE_*` block in `.env.test` (existing
pattern: AUTH / STORE_READ / CREDIT_TOPUP). Otherwise production-default
budgets 429 unrelated integration tests — rapid same-customer/same-IP calls
are normal inside a suite, and Redis `rl:*` state persists across the
per-test DB resets.

### `medusa start` breaks the admin SPA login (no session cookie)
The admin dashboard (:7000 vite, or :9000/dashboard) authenticates via
POST /auth/session and expects a `connect.sid` cookie. Under `medusa start`
(production mode) that endpoint returns 200 but sets NO cookie, so every
subsequent /admin/* request 401s and the dashboard renders empty lists.
Under `corepack yarn dev` (`medusa develop`) the cookie is issued and the
dashboard works. Always run the backend with `yarn dev` for local admin work
(bearer-token API clients are unaffected either way). NOTE: this is an http
artifact (secure cookie won't set over http://localhost). PROD is https, so the
cookie sets and login works there — the empty-dashboard-on-login symptom is
local-only.

### Prod dashboards 404 — SPA router basename baked "/" not "/dashboard"
mercurDashboardPlugin bakes the React Router basename into `__BASE__` from
medusa-config's `admin_ui.options.path`, via `loadMedusaConfig()` which
`require()`s medusa-config.ts. Its `try/catch` SILENTLY swallows a load failure
in the prod build → `__BASE__` falls back to "/" → the admin/vendor SPA serves
its own 404 ("There is no page at this address") at /dashboard/ even though
assets load. Two causes + fixes (2026-06-14):
1. `medusa-config.ts` registered the packs module with a RELATIVE
   `resolve: './src/modules/packs'`. Medusa resolves it against process.cwd(), so
   it broke when the config was require()d from the apps/* vite build cwd → the
   silent throw (which also drops pluginExtensions). Fix: `resolve:
   path.join(__dirname, 'src/modules/packs')` (absolute, cwd-independent).
2. This project's `modules` is an ARRAY with `resolve:'@mercurjs/core/modules/
   admin-ui'`, but the plugin expects an OBJECT keyed `admin_ui`/`vendor_ui` → base
   never derives even on a clean load. Fix: a `forceBasename` vite plugin AFTER
   mercurDashboardPlugin in apps/{admin,vendor}/vite.config.ts:
   `config:()=>({ define:{ __BASE__: JSON.stringify('/dashboard'|'/seller') } })`
   (later-plugin define wins the merge). VERIFY WITH A BROWSER, not HTTP 200 — the
   SPA returns 200 while client-rendering its 404 (scripts/check-dashboard-render.mjs).

### Don't slim the backend image with `yarn workspaces focus --production`
`medusa start` runs from packages/api and loads the medusa-config.ts SOURCE via
@medusajs/utils dynamic-import (plain `require` + a TS hook from DEV deps). Focus
--production removes that hook → boot dies: "Error in loading config: Cannot find
module '/app/packages/api/medusa-config'". (Running from compiled .medusa/server
avoids it but breaks appDir -> apps/*/dist.) So dev deps must stay. Also:
`workspace-tools` is BUILT INTO Yarn 4 — `yarn plugin import workspace-tools`
errors YN0051. The SAFE runtime slim (2.56GB->1.86GB) = `rm -rf
apps/{admin,vendor}/node_modules` after build (dashboards serve from the static
apps/*/dist; their node_modules are build-only). See backend/Dockerfile.

### Prod admin card images 404 — storefront-relative URLs across a two-app deploy
Card/pack art is bundled STOREFRONT assets, seeded as site-relative paths
(/cdn/cards/<file>.webp; also /home, /images). The storefront serves them (200);
the backend (where the admin runs) does not. In prod the storefront is a SEPARATE
domain, so anything rendering the raw relative URL on the backend origin 404s.
Two surfaces, two fixes (2026-06-14):
1. CUSTOM admin pages (cards/packs/pulls/support) use apps/admin/src/lib/
   image-url.ts `resolveImageUrl`, which rewrote relative paths to `${host}:4000`
   (local-dev assumption). Fix: bake the storefront origin into the admin bundle
   (`MERCUR_STOREFRONT_URL` -> vite define `__STOREFRONT_URL__`) and resolve
   against it (fallback host:4000 local). **MUST add MERCUR_STOREFRONT_URL to
   turbo.json `build.env`** or turbo strips it before vite → define bakes empty.
2. MEDUSA-CORE pages (built-in /products, order line items) render the raw URL and
   DON'T use resolveImageUrl. Fix: GET /cdn/cards/[file] route that 302-redirects
   to `${MERCUR_STOREFRONT_URL}/cdn/cards/<file>` (runtime env, hardcoded fallback).
NOT a media-persistence issue — the files exist + serve 200 on the storefront;
it was purely cross-origin URL resolution. Verified prod: /products 0 console
errors, /cdn/cards/* -> 302 -> storefront -> 200.

### Adding an index to a large packs-module table ⇒ build it out-of-band, not in a migration
Medusa runs every migration inside a transaction, so `CREATE INDEX CONCURRENTLY`
is impossible in a normal migration (`Migration20260615093006.ts` adds the first
real indexes via `CREATE INDEX ... WHERE deleted_at IS NULL`). A plain
`CREATE INDEX` takes a write-blocking lock for the build duration — invisible at
the current ~150-row scale, but on the append-heavy `pull` / `credit_transaction`
ledgers it would stall opens/buybacks once they reach ~100k+ rows. When that day
comes, add the index OUT-OF-BAND against prod (`CREATE INDEX CONCURRENTLY` via a
manual psql/`doctl` session, outside the Medusa migration runner, in a low-write
window) and declare it in the model `.indexes()` with the SAME name so a later
`db:generate` sees no drift and won't try to recreate it.
