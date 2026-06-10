<!-- Generated: 2026-06-08 | Files scanned: package.json, backend/**, medusa-config.ts, .env* | Token estimate: ~650 -->

# Dependencies & Integrations

## Runtime services (local Docker)
```
Postgres 16   pokenic-postgres   :5432   postgres://medusa:medusa@localhost:5432/medusa   (primary store, ~180 tables)
Redis 7       pokenic-redis      :6379   event bus / cache / workflow engine (optional for dev)
```

## Processes & ports
```
:9000  Medusa+Mercur API (backend/packages/api, `corepack yarn dev`)
:4000  Storefront prod verify (`npm run build` + `npx next start -p 4000`)   ← verify here, NOT :3000
:7000  Admin SPA (apps/admin, `../../node_modules/.bin/vite --port 7000`)    ← vite not a declared dep; use hoisted bin
:7001  Vendor SPA (apps/vendor)                                              ← effectively unused (single-vendor=admin)
```

## Frameworks / libraries
| Where | Package | Note |
|---|---|---|
| Backend | `@medusajs/*` (Medusa v2) | commerce core (products/orders/customers/inventory/payment) |
| Backend | `@mercurjs/core` (Mercur v2) | multi-vendor marketplace layer (seller scoping, admin/vendor UI) |
| Storefront | `@medusajs/js-sdk` | the ONLY backend client (`sdk.store.*` + `sdk.client.fetch` for custom routes) |
| Storefront | Next.js 16, React 19, Tailwind v4, @base-ui, Lucide | the clone stack |
| Tooling | yarn 4.5 + turbo (backend) · npm (storefront) · Node 24.14.0 pinned | |

## Auth / keys
- Publishable key `pk_a23d…0132863c` (id `apk_01KTDZ…`) → `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY` (public by design)
- Customer JWT in httpOnly cookie `_pokenic_jwt`; CORS: STORE/AUTH include `:3000` (NOT `:4000` → server-side calls only); ADMIN `:7000`, VENDOR `:7001`
- Dev secrets `JWT_SECRET`/`COOKIE_SECRET` = `supersecret` → **rotate for prod**

## Payments
**None active.** Stripe was dropped (2026-06-08); open-pack ships free. A future **custom
payment gateway** slots into the open-pack workflow's `PAYMENT SEAM` (before `recordPull`).

## External integrations
None live. No analytics, email, realtime (Socket.io), or third-party APIs wired yet.
Reference specs: `docs/research/` · live code graph: `graphify-out/` (`graphify query "…"`).
