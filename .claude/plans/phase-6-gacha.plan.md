# Plan: Phase 6 — Fully implement the gacha management system (NO payment)

**Branch**: `feat/backend-medusa-mercur` · **Created**: 2026-06-08 · **Status**: ready to build (awaiting fresh session)
**Scope (CONFIRMED by user 2026-06-08): FULL Phase 6 + FULL Phase 7.** Payment is explicitly OUT (dropped;
future custom gateway slots into the open-pack workflow's existing `PAYMENT SEAM`). The customer open-pack
loop is already done (Phase 5b, commit `1f689f2`). This plan builds everything else gacha:
- **Phase 6** = admin win-rate management (per-card, even-split) + secret-odds decoupling + admin pull-ledger.
- **Phase 7** = leaderboard (aggregate the Pull ledger) + a real live-pulls feed (the `pack.opened` event seam
  already exists; add a subscriber + push, or polling). Build 6 first, then 7.
- Both defaults CONFIRMED: persist `locked` on `PackOdds` (new migration); customer display stays HARDCODED static.

> Resume in a fresh session with: **"build the gacha system per .claude/plans/phase-6-gacha.plan.md"**
> Background state auto-loads via memory `medusa-mercur-backend-state`. Re-run the resume checklist
> (docker up? :9000 /health? :4000 prod build? admin :7000?). Verify backend specifics with the
> `building-with-medusa` skill + live probes, NOT memory.

---

## Requirements (confirmed with user 2026-06-08)

1. **Admin win-rate editor** (admin panel `:7000/dashboard`, NOT the customer storefront — two distinct
   identities: storefront emailpass *customers* vs the *admin/operator*). Per-pack, per-card win rate.
2. **Even-split behavior**: setting some cards' win % "locks" them; the remaining (unlocked) cards split
   the leftover (`100 − Σlocked`) **evenly**. e.g. lock card A=40% → other N split 60% evenly; lock A=40%,
   B=20% → others split 40% evenly.
3. **🔒 SECRET ODDS — the real win rates must NEVER be visible to customers.** What customers see is a
   **separate, hardcoded display** that does not reflect admin edits.
4. **Ignore payment** entirely.

## ★ CRITICAL finding (from iterative-retrieval, 2026-06-08) — decoupling is 2-LAYER, not UI-only
The real per-card `weight` currently LEAKS to customers in TWO places — both must be cut:
- **API layer**: `backend/.../api/store/packs/[slug]/route.ts:59` returns `weight: o.weight` per card →
  visible in the browser network tab with the publishable key. **Drop `weight` from this response.**
- **Storefront**: `src/lib/data/packs.ts:156,172,176` derives the displayed rarity % FROM those weights.
  **Stop deriving from weights; use the static display source.**

## 2 design decisions (CONFIRMED by user 2026-06-08)
1. **Persist lock state** → add `locked: boolean` (default false) to `PackOdds` (new migration). Locked rows
   keep admin %; unlocked recompute the even split on every save.
2. **Customer display source** → **hardcoded static** (reuse the existing static `ODDS` in
   `src/app/claw/packs-data.ts`). Fully decoupled, zero leak. (Later option: a separate admin-editable
   `display_odds` field on Pack — the "different panel" — deferred.)

---

## Context bundle (assembled via graphify + iterative-retrieval — files + their role)

| Relevance | File | Role |
|---|---|---|
| 0.95 | `backend/packages/api/src/api/store/packs/[slug]/route.ts` | **Decouple #1** — drop `weight` (L59); Top Hits keeps card display fields only |
| 0.95 | `backend/packages/api/src/modules/packs/models/pack-odds.ts` | add `locked: boolean` → migration |
| 0.95 | `src/lib/data/packs.ts` | **Decouple #2** — `getPackDetail` stops deriving `rarityOdds` from weights; drop `weight` from `BackendOddsEntry`/`PackDetail` |
| 0.90 | `src/app/claw/[slug]/PackDetailClient.tsx` | Pull Odds renders the static display (`ODDS`), not live weights |
| 0.90 | `src/app/claw/packs-data.ts` | static `ODDS` = the decoupled customer display source; `Rarity`/`PackCard` types |
| 0.85 | `backend/packages/api/src/workflows/steps/roll-pack.ts` | weight semantics ref for the new save-odds workflow |
| 0.80 | `backend/packages/api/src/modules/packs/service.ts` | confirm `updatePackOdds` method name — LIVE PROBE (pluralization footgun, like `createPackOdds`/`deletePulls` in 5a/5b) |
| 0.60 | `backend/packages/api/src/scripts/seed.ts`, `migrations/Migration20260608045250.ts` | weight format + migration reference |
| ref | `backend/apps/admin/src/routes/` (create), `backend/apps/admin/src/lib/client.ts` (typed `createClient<Routes>`), `@mercurjs/dashboard-shared` (`SingleColumnPage`/`_DataTable`/`useDataTable`/`Container`), `apps/admin/src/i18n/en.json` | admin SPA — load skills `medusa-ui-conformance` + `dashboard-page-ui` + `dashboard-form-ui` first |

Admin SPA facts (scouted): custom pages live in `apps/admin/src/routes/<x>/page.tsx` (+ `export const config: RouteConfig`),
NOT `src/pages`; `src/routes/` does NOT exist yet (create it); admin client is TYPED via `@acme/api/_generated`
(codegen) → new admin routes need codegen so the client sees them; `/admin/*` is auto-protected (no middleware);
`vite` not a declared dep → launch admin via hoisted `../../node_modules/.bin/vite --port 7000 --host`.

---

## Build slices (dependency-ordered)

### 6a — Secret-odds decoupling (PREREQUISITE — do first, ship green)
- Backend `[slug]/route.ts`: remove `weight` from the response (Top Hits = card display fields only).
- Storefront `getPackDetail`: drop `weight`; `rarityOdds` no longer computed from weights. Customer Pull Odds
  → static `ODDS`. Update `PackDetail`/`BackendOddsEntry` types + `PackDetailClient` Pull Odds render.
- **Verify**: after an admin weight change (manual SQL or via 6b), customer `/store/packs/:slug` response
  contains NO `weight`, and `/claw/[slug]` Pull Odds %s are unchanged (static). This is the no-leak gate.

### 6b — Win-rate editor (the core ask)
- Model: add `locked: boolean` to `PackOdds`; `corepack yarn medusa db:generate packs` → `db:migrate`.
- Workflow `save-pack-odds.ts` + steps: validate (Σlocked ≤ 100, weights ≥ 0, Σ > 0), compute even-split,
  persist `weight` (basis points = round(pct×100)) + `locked` per row. Compensated. (Probe `updatePackOdds`.)
- Admin routes: `GET /admin/packs` (selector list), `GET + POST /admin/packs/[slug]/odds` (load + save).
- Admin SPA: `routes/packs/page.tsx` (list), `routes/packs/[slug]/page.tsx` (per-card win-% form w/ lock
  toggle + live even-split + save). i18n strings. Run codegen.
- **Verify**: admin sets a card %, others split evenly, saved to DB; roll distribution shifts (probe many
  opens); customer odds STILL static (no-leak); backend + `apps/admin` build green.

### 6c — Admin pull-ledger visibility (follow-on)
- `GET /admin/pulls` (ledger + top-cards/rarities rollups, customer-email join) + `routes/pulls/page.tsx` DataTable.

### 6d / Phase 7 — leaderboard + live feed (IN SCOPE — confirmed)
- `pack.opened` already emits (no subscriber yet). Build:
  - **Leaderboard**: `GET /store/leaderboard?period=weekly|alltime` — aggregate the `Pull` ledger
    (single-module `listAndCount`/`query.graph`, read-only, no workflow) by customer (top pullers) and by
    card/rarity (rarest hits). Wire `src/app/leaderboard/page.tsx` + `LeaderboardSection` (currently static).
  - **Live feed**: a `pack.opened` subscriber + push to the storefront. Default = lightweight polling of the
    existing `GET /store/pulls/recent` (already built) on an interval, OR Socket.io via a Medusa loader if the
    user wants true realtime (heavier — confirm before adding the WS dependency). Wire `RecentPullsSection`.
  - Sequence AFTER Phase 6 (leaderboard needs a populated ledger; the editor doesn't block it).

---

## Verification gates (run in the MAIN LOOP against live services — NOT headless workflow agents)
- `corepack yarn medusa db:migrate` succeeds; `locked` column present.
- Live probe: confirm `updatePackOdds` (or actual name) before trusting the workflow.
- `npm run check` (storefront) green; backend dev-server hot-reload clean; `apps/admin` build green.
- **No-leak Playwright**: admin edits weights → customer `/claw/[slug]` Pull Odds unchanged + API response has no `weight`.
- Commit per slice (no Co-Authored-By line, per standing constraint).

## Orchestration note
This is a verification-heavy DEPENDENCY CHAIN with live-service checks (migrate/probe/build/Playwright),
NOT a blind parallel fan-out — and this repo's worktree isolation is fragile (CLAUDE.md: dispatch builder
sub-agents IN-PLACE, git root == repo). So drive it as a SEQUENCED build: the independent units (6a
storefront-decouple vs 6b backend-model) can start in parallel via in-place subagents, but migrations +
live probes + the no-leak Playwright gate run in the main loop. A Workflow can structure the
generate-then-integrate phases, but the operator (main loop) owns the live verification.

## Risks
| Risk | Mitigation |
|---|---|
| Odds leak missed on some surface | 6a first; no-leak gate explicitly asserts API + UI after an edit |
| `updatePackOdds` name wrong (pluralization) | live-probe before the workflow |
| Codegen for `@acme/api/_generated` (api pkg has only `build`) | determine generator first; fall back to client untyped fetch for reads |
| Even-split rounding (bps ≠ 10000) | roll uses relative weights — harmless; clamp display to 2 dp |
| Cross-module customer-email join (6c) | `query.graph` over customer module; else show `customer_id` |

## Acceptance
- [ ] **6** Admin sets per-card win %; unlocked split evenly; saved to real `PackOdds` via a compensated workflow
- [ ] **6** Customer-facing odds are static and unchanged by admin edits (no `weight` in the public API; no UI change)
- [ ] **6** Admin pull-ledger page lists recent pulls + top-cards/rarities rollups
- [ ] **7** `/store/leaderboard` aggregates the Pull ledger; `/leaderboard` + `LeaderboardSection` render real data
- [ ] **7** Live-pulls feed (`RecentPullsSection`) updates from the ledger (polling or Socket.io)
- [ ] backend + `apps/admin` + storefront builds green; no-leak Playwright passes
- [ ] Payment untouched (PAYMENT SEAM remains empty)
