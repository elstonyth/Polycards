<!-- Generated: 2026-06-08 | Files scanned: backend/packages/api/src | Token estimate: ~850 -->

# Backend (Mercur v2 / Medusa v2 — `@acme/api`)

Yarn 4.5 + turbo monorepo under `backend/`. Custom code in `packages/api/src/`.
Architecture rule: **Module → Workflow → Route** — every mutation goes through a
workflow; routes stay thin; prices/values are decimals (never cents).

## Custom store routes (publishable-key scoped; bypass Mercur seller middleware)

```
GET  /store/packs                 → list active packs, ordered (category, rank)        [catalog]
GET  /store/packs/:slug           → pack + odds joined to Card (Top Hits, rarity %)    [5a]
POST /store/packs/:slug/open      → openPackWorkflow → { pull, card }                  [5b, AUTH]
GET  /store/pulls/recent          → 12 most-recent pulls joined to Card (no PII)       [5b feed]
GET  /store/custom, /admin/custom → starter stubs (200)
```
`src/api/middlewares.ts`: `authenticate("customer",["session","bearer"])` on matcher
`/store/packs/*/open` only (the public GETs stay anonymous). The open route uses
`AuthenticatedMedusaRequest` + `req.auth_context.actor_id` — customer id is NEVER from the body.

## Packs module (`src/modules/packs/`)

```
index.ts        Module(PACKS_MODULE, { service })   registered in medusa-config.ts as ./src/modules/packs
service.ts      class extends MedusaService({ Pack, Card, PackOdds, Pull })  → auto CRUD
models/         pack.ts · card.ts · pack-odds.ts · pull.ts   (see data.md)
migrations/     Migration20260608035226 (pack) · Migration20260608045250 (card/pack_odds/pull)
```
Verified service methods: `listPacks/createPacks`, `listCards/createCards`,
`listPackOdds/createPackOdds`, `listPulls/createPulls/deletePulls`.

## Workflows (`src/workflows/`)

```
open-pack.ts                composition (pure: transform-only, no async/conditionals/Date)
  steps/roll-pack.ts        read-only: validate active pack → Σweights → Math.random pick
                            → listCards → normalize won Card to plain JSON (market_value: Number)
  [PAYMENT SEAM]            empty; future charge step inserts here, before record
  steps/record-pull.ts      the ONLY mutation: createPulls(...);  compensation = deletePulls(id)
  emitEventStep             "pack.opened" (fires only on workflow commit; no subscriber yet)
```
Compensation proven: forced post-record failure deletes the Pull (no orphan).

## medusa-config.ts
- modules: `@medusajs/medusa/rbac`, **`./src/modules/packs`**, Mercur admin-ui (`/dashboard`→apps/admin), vendor-ui (`/seller`→apps/vendor)
- plugins: `@mercurjs/core`; featureFlags: `rbac`, `seller_registration`
- secrets `JWT_SECRET`/`COOKIE_SECRET` default `supersecret` (rotate for prod)

## Seed (`src/scripts/seed.ts`, idempotent)
House seller (handle `house`, status `open`) → owns 16 card **products** • 21 **packs**
• 16 gacha **Cards** • 336 **PackOdds** (21×16, rarity-weighted). Run: `corepack yarn seed`.

## Not built yet
No admin routes for packs/odds/pulls (gacha managed via seed only). No payment / inventory
reserve / buyback. No links (pack↔product, card↔product). No Socket.io / leaderboard.
