# Pokenic E2E (Playwright)

End-to-end coverage of the **admin management** and **customer** workflows across
all three live surfaces: storefront `:4000`, admin dashboard `:7000`, backend `:9000`.

## What it covers

| Spec                       | Flow                                                                                                                                                                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customer.spec.ts`         | signup → top-up → open pack (slot reel on `/slots/<slug>/spin`) → keep in vault → sell-back; backend credit ledger asserted via API. Plus: anonymous demo spin (`?demo=1`) writes NO backend pull.                                                                                       |
| `admin.spec.ts`            | admin login → cards & packs catalogs render with management actions → **create a pack** + manage its prize pool → **adjust a customer's credits** (support) → economy report.                                                                                                            |
| `odds-reflection.spec.ts`  | **Headline.** Set one card to **100% win rate** (pack A via admin UI, pack B via odds API) → open the pack 3× → every pull is that exact card. Asserts the hardcoded published "Pull Odds" table never moves — the adjustment lands on real pull _behavior_, not the decorative display. |
| `bulk-sell.spec.ts`        | Funded customer opens two packs → vault "Select" mode → selects both cards → "Sell 2" in the bulk action bar → both leave the vault and the credit ledger gains two `buyback` rows (server truth). Covers the bulk path (single-card sell-back is in `customer.spec`).                   |
| `card-management.spec.ts`  | Admin registers an inventory product as a gacha card → edits its facts (FMV + marketplace toggle) → the FMV edit surfaces in the storefront pack-detail "Top Hits" (`GET /store/packs/{slug}`). Needs one eligible un-registered product.                                                |
| `delivery-request.spec.ts` | Funded customer opens a pack → vault "Select" mode → "Deliver 1" → add-address form → the order shows on `/orders` as `Requested`. Customer side only; admin fulfilment is `ship-orders`.                                                                                                |
| `rewards.spec.ts`          | Customer rewards after the `/daily` ⇄ `/vip` split: claim a VIP voucher grant on `/vip`, then open the daily box on `/daily`. **Skips** (does not fail) when reward redemption is disabled on the backend.                                                                               |
| `ship-orders.spec.ts`      | Admin advances a delivery order `requested → packing → shipped` via the Deliveries dashboard (shipping requires a tracking number). Asserted in the UI (modal closes) and server-side (admin delivery-orders API reports `shipped`).                                                     |
| `slot-vault-room.spec.ts`  | Vault Room slot machine end to end: spin → reel settles → face-down slab → flip → "Sell for RM…" → confirm sell-back → credit ledger gains a `buyback` row. Plus: an unsold flipped card auto-vaults after the shared 30s window expires.                                                |

## Why the 100% test instead of asserting the odds panel

The storefront's visible "Pull Odds (by rarity)" panel renders the
admin-PUBLISHED `pack.published_odds` (a display-only setting) — intentionally
decoupled from the admin-tuned secret weights. So a frontend assertion on that
panel can't prove an adjustment took effect. Forcing a card to 100% and
confirming every real open returns it proves the adjustment reaches the actual
pull engine; the spec also snapshots the panel before/after to prove win-rate
writes never leak into the published display.

## Prerequisites (services must already be up)

This suite does **not** spawn servers (the storefront must be the production
standalone build, not `next dev` — see the root `README.md`, "Quick Start
(storefront)").

```powershell
# infra
docker start pokenic-postgres pokenic-redis

# backend  (backend/packages/api)
corepack yarn dev                       # :9000  /health

# admin dashboard  (backend/apps/admin)
node ../../node_modules/vite/bin/vite.js --port 7000   # :7000/dashboard

# storefront  (repo root)
npm run build
pwsh scripts/serve-standalone.ps1 -Port 4000           # :4000
```

Seeded admin: email `admin@pokenic.local`, created by `create-admin.ts` via
`deploy:migrate-user`. The admin **password is required** — export it as
`PW_ADMIN_PASSWORD` to match your stack's seeded admin; the suite ships no
fallback and fails fast without it (`helpers/constants.ts`). Set `PW_ADMIN_EMAIL`
too if your seed used a different email. Test customers are created fresh per run.

## Run

```powershell
npx playwright test                        # all
npx playwright test odds-reflection        # just the headline
npx playwright test --headed --project=e2e # watch it
npx playwright show-report tests/e2e/.report
```

> **Re-authored (2026-07-12, plan 023):** `customer`, `bulk-sell`,
> `delivery-request`, and the `odds-reflection` headline were rewritten against
> the redesigned slots/vault UI — no `test.fixme` remains. If a future redesign
> breaks them, update the selectors in the same PR; do not re-`fixme` them.

Endpoints/creds are overridable via `PW_BASE`, `PW_ADMIN`, `PW_BACKEND`, `PW_PK`,
`PW_ADMIN_EMAIL`, `PW_ADMIN_PASSWORD` (see `helpers/constants.ts`).

## Targeting a staging env

The mutating suite can point at any **non-prod** seeded backend via the env vars
above. Use the runner so you don't export them by hand:

```powershell
copy tests\e2e\staging.env.example tests\e2e\.env.e2e   # then edit
pwsh scripts/run-e2e.ps1 -EnvFile tests/e2e/.env.e2e     # full suite vs staging
pwsh scripts/run-e2e.ps1 -Grep "odds"                    # subset
pwsh scripts/run-e2e.ps1 -Smoke                          # read-only PROD smoke
```

`staging.env.example` documents a throwaway-DB recipe (isolated `pokenic_staging`
DB + a second backend port) so a run can't dirty your dev data. **Never** point
the mutating suite at prod — `run-e2e.ps1` refuses if `PW_BACKEND` looks like the
prod host; use `-Smoke` (→ `playwright.prod-smoke.config.ts`, read-only) for prod.

## Notes

- Serial, single worker: flows mutate shared backend state (odds, stock, credits).
- The odds specs snapshot and **restore** each pack's odds in a `finally`, so the
  operator's configuration is left untouched. Stock consumed by the opens is not
  restored (it's a dev database).
