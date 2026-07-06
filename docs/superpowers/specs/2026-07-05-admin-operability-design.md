# Admin Operability Pass — Design

**Date:** 2026-07-05 · **Base commit:** `fc4e8e1` · **Status:** approved by operator

## Goal

Close the vetted operability gaps from the 2026-07-05 admin audit so an operator can
find records (pagination + search), trust what happened (toasts, FX audit trail), and
change business knobs (FX rate, rewards-settings) from the dashboard instead of raw
API calls. Scope = the 8 vetted findings + polish bundle. Direction items (customers
list page, commissions dashboard, EV/RTP readout), bulk/CSV ops, VIP overrides, and
env-gate toggles are explicitly **out of scope**.

## Provenance & corrections

Findings come from a three-agent audit vetted against code. Two corrections made
during design, verified in source:

1. **Shipped-without-tracking is NOT a backend bug.** `checkTransition` returns
   `tracking_required` (`backend/packages/api/src/modules/packs/delivery.ts:62`) and
   the workflow step rejects on it
   (`backend/packages/api/src/workflows/steps/update-delivery-order.ts:93`), counting
   tracking from the request *or* already on the order. Only the client pre-gate is
   missing → demoted to Phase 1 polish (disable Save + hint).
2. **FX rate has no UI at all.** `useSetFxRate`
   (`backend/apps/admin/src/lib/queries.ts:205`) has zero consumers — the rate is
   only settable via raw API, and changes are not audited (the
   `admin_action_audit` CHECK lists no fx entity/action). → Phase 3 builds the
   control surface + audit, not just a trail.

## Architecture principles

- **Reuse the proven in-repo patterns; add nothing new.** Pagination copies the
  customer-audit pattern (`?limit=&offset=` + page state + Prev/Next —
  `backend/apps/admin/src/lib/admin-rest.ts:225`,
  `query-keys.ts` `customerAudit(id, page)`). Toasts copy the box-save pattern
  (`queries.ts:433`). Confirm-before-discard copies the copy-from-tier confirm
  (`daily-rewards/page.tsx:601-616`). Audit-CHECK widening copies
  `Migration20260625060000.ts`.
- **Client-side search/sort only** — catalogs are fetched wholesale today and are
  small (hundreds). Server-side search is deferred until a list outgrows one fetch.
- **No new dependencies. One new migration** (audit CHECK widen for fx).
- All money display stays MYR (RM) via the existing `rm()` formatter; `market_value`
  stays raw USD server-side.

## Phase 1 — Quick wins

### 1.1 Daily-rewards tier-switch guard
`backend/apps/admin/src/routes/daily-rewards/page.tsx` — `handleTierChange` (:518)
unconditionally clears rows/name/enabled/drawsPerDay/reason. Fix: snapshot the
loaded state (JSON of normalized `{rows, name, enabled, drawsPerDay}`) whenever a
box loads or saves; a `hasUnsavedEdits()` helper compares current state to the
snapshot; `handleTierChange` calls `window.confirm` ("Discard unsaved changes to
this tier?") when dirty. Replace the coarse `isDirty = seededFrom !== undefined`
(:516) with the same real comparison for the copy-from-tier confirm. Same guard on
the Boxes/Vouchers tab switch if the boxes buffer is dirty.

### 1.2 Success toasts on customer-360 money/account actions
`backend/apps/admin/src/lib/queries.ts` — add `toast.success('…')` to `onSuccess`
of `useFreezeCustomer` (:301), `useUnfreezeCustomer` (:315), `useReverseCommission`
(:329), `useSuspendCommission` (:347), `useUnsuspendCommission` (:365), and the
360-page credit-adjust hook. Fire-and-forget `.mutate()` flow in
`customers/[id]/page.tsx` stays as-is (invalidation already refreshes the view);
the toast adds explicit confirmation. Copy: "Customer frozen", "Commission
reversed", etc.

### 1.3 Deliveries client pre-gate for shipped
`backend/apps/admin/src/routes/deliveries/page.tsx` — disable the modal Save button
when the selected next status is `shipped` and `tracking.trim()` is empty AND the
order has no existing `tracking_number`; show a one-line hint ("Tracking number
required to mark shipped"). Mirrors the backend rule exactly; no backend change.

## Phase 2 — List infrastructure

### 2.1 Pulls ledger: pagination + names + links
Backend `backend/packages/api/src/api/admin/pulls/route.ts`:
- Accept `?offset=&limit=` (defaults 0/50, limit clamped ≤100). Ledger rows come
  from `listAndCountPulls` with `skip/take` — replacing the `slice(0, LEDGER_LIMIT)`
  of the rollup window. Response `total` becomes the true count from
  `listAndCount` (fixes the silent 5000 cap). Rollups (`topCards`, `topRarities`,
  window 5000) unchanged.
- Join pack titles for the ledger page's `pack_id`s (one `listPacks` call), add
  `pack_title: string | null` to each ledger row.

Frontend: `admin-rest.ts` `getPulls(page)` adds the params; `query-keys.ts` gains
`pulls(page)`; `pulls/page.tsx` gets page state + Prev/Next (audit-timeline
pattern), renders `pack_title` (fallback truncated id), and makes the customer
email a link/button navigating to `/customers/{customer_id}`. No card link (no
per-card page exists). Rarity column unchanged.

### 2.2 Delivery orders: pagination
Backend `backend/packages/api/src/api/admin/delivery-orders/route.ts`: accept
`?offset=&limit=` (defaults 0/50, clamp ≤100), use `listAndCountDeliveryOrders`,
return `{ orders, total, offset, limit }`. Status filter unchanged.
Frontend: `useDeliveryOrders(status, page)`; Prev/Next + "X–Y of Z" in
`deliveries/page.tsx`.

### 2.3 Customer 360 history: two new paginated endpoints
Clone the audit-timeline route shape for:
- `GET /admin/customers/[id]/transactions?limit=&offset=` — credit ledger rows,
  newest first, `{ items, total }`.
- `GET /admin/customers/[id]/pulls?limit=&offset=` — pull rows (with card
  name/rarity like the gacha view), `{ items, total }`.
The compound `customers/[id]/gacha` route keeps its `RECENT` caps and stays the
360 first paint. The 360 Transactions and Pulls sections switch to the new
endpoints with Prev/Next (page size 25). Support page reuses the same hooks.

### 2.4 Cards & packs: find things
`cards/page.tsx`: client-side text filter (matches name + handle,
case-insensitive) + clickable sort headers for Name / Value / Stock (client-side,
stable by handle). `packs/page.tsx`: client-side text filter (title) + status
filter (all/draft/active); **no sort** (would fight the manual rank-reorder
arrows). Both lists + deliveries get a row-count label ("N cards" / "N of M
shown" when filtered).

## Phase 3 — Control surfaces

### 3.1 FX rate card (economy page) + audit
- **Migration** (pattern: `Migration20260625060000.ts`): widen
  `admin_action_audit` CHECKs — entity_type += `'fx'`, action += `'edit_fx_rate'`.
  Down-migration refuses if fx rows exist (same refuse-guard pattern).
- **Backend** `backend/packages/api/src/api/admin/pricing/fx/route.ts`: POST writes
  an `admin_action_audit` row in the same transaction as the rate write —
  `entity_type:'fx'`, `entity_id:'global'`, `action:'edit_fx_rate'`,
  before/after `{rate}`, `admin_id` from the authenticated actor (same source as
  the adjust-credits audit write). New `GET /admin/pricing/fx/history` returns the
  last 10 fx audit rows `{ changes: [{at, admin_id, before, after}] }`.
- **Frontend** `economy/page.tsx`: new "Exchange rate" card — current rate
  (`useFxRate`), set-rate input + Save wiring the existing `useSetFxRate`, a
  `window.confirm` warning ("This reprices every card on the storefront
  immediately."), and the history list below (new `useFxHistory` hook).

### 3.2 Rewards-settings tab
`daily-rewards/page.tsx` gains a third tab "Engine settings": a plain form over
the existing `GET/POST /admin/rewards-settings` (new `admin-rest.ts` wrappers +
`useRewardsSettings`/`useSaveRewardsSettings` hooks). Render exactly the fields
the GET returns; save posts the full object; success toast. Backend already
validates, clamps, and audits `edit_rewards_settings` — **no backend change**.

## Phase 4 — Polish bundle

- Pool picker (`packs/[slug]/page.tsx`): "Select all" / "Clear all" buttons +
  "N / M selected" counter.
- Pack list (`packs/page.tsx`): "Odds published" / "Odds not set" badge —
  `published_odds` is already in the list response (`admin/packs/route.ts:35`).
- Economy page: `title` tooltip on the RTP badge ("RTP > 100% = players receive
  more value than the pack price on average"). Cards page: legend/tooltip for
  stock colors (red = units owed, orange = buyback-only).
- Delivery modal: show customer email (already in the row data / [id] response).
- `MAX_BOX_CREDIT_MYR`: include `max_box_credit_myr` in the boxes GET response
  (from `daily-box.ts:7`); admin form uses it with fallback 10000; delete the
  mirrored constant + "keep in sync" comment in `daily-rewards/page.tsx:43`.

## Testing

- **Backend (TDD, jest run per-file — known OOM):** new/changed routes get specs —
  pulls pagination (offset/limit/clamp/total + pack_title), delivery-orders
  pagination, customers transactions/pulls endpoints (shape + paging + 404),
  fx POST audit row written atomically + history GET, boxes GET carries
  `max_box_credit_myr`.
- **Admin app (vitest):** unit test the dirty-compare helper; the rest of the UI
  changes are covered by the typecheck hooks + a manual smoke pass per phase.
- **No storefront changes**, so no Playwright work.

## Risks / notes

- One migration; DigitalOcean auto-deploy runs migrations — no manual step.
- Pagination changes alter admin API response shapes (`total`/`offset`/`limit`
  fields added; pulls `total` semantics corrected). The admin SPA is the only
  consumer; update its types in the same commit.
- FX audit write must be same-transaction with the rate write (mirror the
  adjust-credits atomic pattern) — a rate change without an audit row is a silent
  compliance gap.
- `rewards-settings` form renders server-returned fields only; if the GET shape
  surprises (extra nested config), STOP and re-scope rather than invent UI.
