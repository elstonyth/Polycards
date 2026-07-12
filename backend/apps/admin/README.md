# Admin dashboard (`@acme/admin`)

The operator dashboard for the Medusa v2 + Mercur backend (`backend/packages/api`).
A Vite + React SPA that mounts `@mercurjs/admin` and layers this project's own
routes on top (`src/routes`, `src/components`); entry point is `src/main.tsx`. It
talks to the backend on `:9000` and is served at `http://localhost:7000/dashboard`.

## Run (from `backend/apps/admin`)

```bash
corepack yarn dev     # Vite dev server on :7000 (alias: node ../../node_modules/vite/bin/vite.js --port 7000)
```

The backend API must already be running on `:9000` (see the root `README.md`,
"Running the backend").

## Commands

```bash
corepack yarn dev      # dev server (:7000)
corepack yarn build    # tsc -b && vite build
corepack yarn preview  # serve the production build (:7000)
corepack yarn lint     # eslint .
corepack yarn test     # vitest run
```

## Credentials

Sign in with the seeded super-admin, created by `create-admin.ts` (run via the
backend's `deploy:migrate-user` script) from the backend's `ADMIN_EMAIL` /
`ADMIN_PASSWORD` env. The values live in your backend env, not here — never
commit them.
