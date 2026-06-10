<!-- Generated: 2026-06-08 | Files scanned: ~210 (storefront src + backend/packages/api/src) | Token estimate: ~750 -->

# Architecture

Pixel-perfect clone of **phygitals.com** (a physical/digital trading-card gacha
marketplace) wired to a self-built **Mercur v2 / Medusa v2** backend.

## Two processes (local-first, no cloud host)

```
Browser ──HTTP──▶ Storefront (Next.js 16, repo root)         :4000 (prod verify) / :3000 (dev*)
                     │  server components + server actions
                     │  (SDK calls run server-side; AUTH/STORE CORS exclude :4000)
                     ▼
                  Medusa+Mercur API (backend/packages/api)    :9000
                     ├─ Postgres 16  (pokenic-postgres)       :5432
                     └─ Redis 7      (pokenic-redis)          :6379

  Admin SPA (apps/admin, Vite)   :7000 ─┐ cross-origin → :9000 (ADMIN_CORS/VENDOR_CORS)
  Vendor SPA (apps/vendor, Vite) :7001 ─┘ (mounted at :9000/dashboard & /seller as "not built" stubs)
```
\* `:3000` is occupied by an unrelated container; verify the storefront on `:4000`.

## Boundaries

| Layer | Owns | Path |
|---|---|---|
| Storefront | UI, the clone, server-side data seam, customer auth (cookie JWT) | `src/` |
| Data seam | `lib/data/*` getters + `lib/actions/*` server actions; the ONLY backend touchpoint | `src/lib/` |
| API | custom store routes, gacha module, open-pack workflow | `backend/packages/api/src/` |
| Marketplace engine | products/orders/customers/inventory/sellers (out of the box) | Mercur/Medusa core |

## Data flow — opening a pack (the core loop)

```
/claw/[slug] (Open Pack) → openPack() server action (Bearer from httpOnly cookie)
  → POST /store/packs/:slug/open  (authenticate customer)
    → openPackWorkflow: rollPackStep (validate + weighted draw over PackOdds)
        → [PAYMENT SEAM — empty; future custom gateway]
        → recordPullStep (createPulls, compensated by delete)
        → emitEventStep("pack.opened")
  → returns won Card → roulette reveal + optimistic Recent Pulls prepend
```

## Status (branch `feat/backend-medusa-mercur`)
Phases 0–4 done (boot, seam, catalog, auth, packs catalog); Phase 5 = **5a** gacha
depth + **5b** open-pack workflow/ledger done (no payment). Next: payment endpoint,
admin gacha UI (Phase 6), realtime/leaderboard (Phase 7). Stripe **dropped**.

See: `backend.md`, `frontend.md`, `data.md`, `dependencies.md`. Live graph: `graphify-out/`.
