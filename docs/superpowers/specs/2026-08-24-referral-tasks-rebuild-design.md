claim is an explicit store endpoint,
  idempotent via the task_claim unique index, and grants through existing
  mechanics: credit via mutateCreditAtomic (idempotency reference per
  task+period), card via a source='reward' pull (vault entry, stock counter
  decremented, never gated). **Pack reward (decided at implementation): a free
  rip** — the claim rolls the pack's live odds server-side (rollOne, the same
  draw a paid open uses, customer's own odds set) and vaults the result as a
  source='reward' pull. No charge-seam change; reward pulls never move the
  boards.# Referral Rebuild + Task Page — Design

**Date:** 2026-08-24 · **Status:** approved in chat, **amended 2026-08-25** · **Depends on:** PR #482 (`chore/remove-referrals`), ADR 0007

## Amendment — 2026-08-25 (operator)

The sections below are the original design. These five changes supersede it; where they conflict,
the amendment wins.

1. **VIP rebate (个人回水) is REMOVED.** No `vip_level.rebate_bp`, no `vip_rebate` settlement-line
   kind, no `vip_rebate` credit reason, no `GET /store/vip-rebate`, no VIP tab on `/task`. A
   settlement line is now always a referral commission, so `weekly_settlement_line.kind` and
   `weekly_settlement.total_rebate_cents` are gone with it. VIP itself stays: the ladder is what
   the `reach_level` achievements are measured against.
2. **`/task` is two tabs**: *Weekly Tasks* and *Achievements*. Referral moved out to its own
   page, `/referral`, reached from the Me quick-access grid. VIP survives inside the Achievements
   tab as the ladder the `reach_level` achievements are measured against, not as a tab of its own.
3. **The weekly-task week resets Monday 00:00 MYT**, not Tuesday. The settlement week is unchanged
   (Tue close, Wed pay) — `referralWeekFor` stays Tuesday, `taskWeekFor` is the new Monday anchor.
4. **Task scheduling**: `task_definition` gained an optional `starts_at`/`ends_at` window, driven by
   the same `datetime-local` controls the Weekly Challenge schedule uses. Outside the window a task
   is neither listed nor claimable. (Deliberately *not* the `challenge_schedule` queue table — that
   pattern exists because the live challenge is a singleton; task definitions are already rows.)
5. **Admin pickers, not free text**: pack, card, VIP level and pixel Pokémon are all dropdowns, and
   `vault_pixel_count` gained an optional `pixel_pokemon_id` so an achievement can name one Pokémon.

## Purpose

Rebuild the referral programme from scratch on the clean slate left by the removal, add a VIP
personal-rebate (个人回水) on the same weekly cycle, and turn the `/task` placeholder into a real
weekly-task / achievement surface. Storefront first, then the admin dashboard; the admin must be
able to configure every knob (tiers, partner rates, rebate ladder, task definitions, rewards).

## Decisions (locked with the operator)

| Question | Decision |
| --- | --- |
| Commission basis | **Downline weekly pack-spend (turnover)**, Tue–Mon MYT week. Tier % applies to the whole amount, not marginal brackets: RM0–5,999 → 0.5%, RM6,000–14,999 → 1%, RM15,000–29,999 → 1.5%, RM30,000+ → 2%. Defaults only — admin-editable. |
| Depth | **Direct referrals only.** No generations, no team override. |
| Attribution | **Link/code at signup, permanent.** `/invite/[handle]` sets a cookie; binds when the account is created; never changes. Admin can set/fix one manually. Self-referral blocked. |
| VIP rebate | **Own weekly turnover × per-VIP-level %**, same Tue-check / Wed-pay cycle. Shown on `/task`. |
| Payout form | **Straight site credit.** No lock, no maturation, immediately withdrawable. |
| Payout flow | Cron closes the week Tuesday and computes every line as part of a **draft run**; admin reviews and **approves** in the dashboard; Wednesday cron pays approved runs. ("TUES CHECK, WED OUT.") |
| Partner accounts | Admin flags a customer with a manual rate that **replaces** the tier table for them. Default bounds 3–5%; the bounds themselves are configurable. |

## Architecture

Everything lands in the existing `packs` Medusa module (same pattern as the challenge system):
new models, service methods, two jobs, new store/admin routes, and additions to the storefront
`/task` route plus the admin dashboard.

No synchronous work in `settleOpen`. Weekly turnover is computed at close time straight from
`credit_transaction` `pack_open` debits inside the week window — the per-purchase fan-out that
made the old engine dangerous stays dead.

### New tables (one migration, additive only)

- **`referral_attribution`** — `customer_id` (unique), `referrer_id`, `created_at`. The referral
  code is the player handle; no separate code table.
- **`referral_settings`** — singleton (`id = 'global'`): `tiers` jsonb
  (`[{ min_cents, rate_bp }]`, sorted, whole-amount match), `partner_min_bp`, `partner_max_bp`.
- **`customer_account_state.partner_referral_bp`** — nullable int column. Non-null ⇒ partner.
- **`vip_level.rebate_bp`** — int, default 0. Own-turnover rebate per level. (Deliberately a new
  name — this is not the removed `direct_referral_pct`, which paid commission on downline spend.)
- **`weekly_settlement`** — `week_start` (date, unique), `status`
  `draft → approved → paid` (plus `void`), `approved_at/by`, `paid_at`, totals.
- **`weekly_settlement_line`** — `settlement_id`, `customer_id`, `kind`
  (`referral_commission` | `vip_rebate`), `basis_cents`, `rate_bp`, `amount_cents`, `status`
  (`pending` | `voided` | `paid`), `paid_transaction_id` nullable. Unique
  `(settlement_id, customer_id, kind)`.
- **Ledger CHECK widened** with two new reasons: `referral_commission`, `vip_rebate`.

Rates are stored in basis points everywhere (0.5% = 50 bp); amounts in cents. Rounding: floor to
the cent.

### Weekly engine

- Week = Tuesday 00:00 MYT to Monday 24:00 MYT. MYT is fixed UTC+8 (no DST); reuse the offset
  arithmetic pattern from `globepay-settlement.ts`.
- **Tuesday job (`close-referral-week`)**: for the just-ended week, one grouped query over
  `pack_open` debits per customer → own turnover. Join `referral_attribution` to roll up each
  referrer's downline turnover. Resolve rate (partner bp if set, else tier table), emit
  `referral_commission` lines; resolve each spender's VIP level `rebate_bp`, emit `vip_rebate`
  lines. Lines with `amount_cents = 0` are skipped. Insert one `weekly_settlement` (status
  `draft`) + lines; the unique `week_start` makes a re-run a no-op.
- **Admin approve**: `draft → approved`, records who/when. Individual lines can be voided while
  the run is a draft or approved-but-unpaid.
- **Wednesday job (`pay-referral-week`)**: pays every `pending` line of `approved` runs — one
  credit transaction per line (idempotent: line row records `paid_transaction_id`; the ledger
  write and the line update commit in one transaction, same discipline as `settleChallengeWeek`).
  Run flips to `paid` when no pending lines remain. Deleted accounts are skipped and their lines
  voided with a log line.

### Attribution flow

- `/invite/[handle]` (storefront route): validates the handle exists, sets a 30-day cookie,
  redirects to `/`. The signup server action reads the cookie and calls a backend endpoint that
  inserts `referral_attribution` (rejecting self-referral and already-attributed customers).
- Store routes: `GET /store/referral` (my link, downline count, this-week downline turnover so
  far, current tier + rate, projected commission, past settlement lines) and
  `GET /store/vip-rebate` (level, rate, own turnover this week, projection, history) — or one
  combined `GET /store/task-hub` payload; decided at implementation by what the page needs.

### Tasks & achievements (Phase B)

- **`task_definition`** — `kind` (`weekly` | `achievement`), `title`, `requirement` jsonb
  (discriminated union: `checkin_days {days}`, `rip_count {count, pack_id?}`,
  `reach_level {level}`, `vault_count {count}`, `vault_pixel_count {count}`), `reward` jsonb
  (`credit {cents}` | `pack {pack_id}` | `card {card_id}`), `active`, `sort`.
- **`task_progress`** — `customer_id`, `task_id`, `period_key` (week-start ISO for weekly, `''`
  for achievements), `progress`, `completed_at`, `claimed_at`, claimed reward snapshot. Unique
  `(customer_id, task_id, period_key)`.
- **`daily_checkin`** — `customer_id`, `checkin_date` (MYT date, unique per customer). Explicit
  check-in button on `/task`.
- Progress is **computed on read** where cheap (vault counts, level) and **event-bumped** where
  not (rip counts bump in the open-settlement path via the existing event/subscriber pattern —
  small and non-blocking; check-ins write their own row). Claim is an explicit store endpoint,
  idempotent via `claimed_at`, and grants through the same mechanics as the challenge payout
  path (credit + card granting already exist; pack reward = a zero-cost open entitlement,
  mechanic confirmed during implementation against the current spin flow).

### Storefront `/task`

Three tabs (client component under a server `page.tsx`, existing pill/tab primitives, mobile-first
per DESIGN.md):

1. **Tasks** — weekly list + achievements list, progress bars, Claim buttons, check-in tile.
2. **Referral** — invite link with copy button, downline count, live this-week downline turnover,
   current tier %, projected Wednesday payout, past payouts.
3. **VIP** — current level, rebate %, own turnover this week, projected rebate, past rebates.

The placeholder page, its `robots: noindex`, and the tab-bar link all get replaced.

### Admin dashboard

- **Referrals** section: settings editor (tier table + partner bounds), settlement-run list
  (review lines, void, Approve, per-run totals), and a "Pay now" that runs the Wednesday step
  early if wanted.
- **Customer-360**: referral panel (who referred them, their downline, their lines) + partner
  rate setter (validated against bounds; audited via `admin_action_audit` — new action values,
  additive).
- **Tasks** section: task-definition CRUD with a reward picker (credit amount / pack select /
  card select), active toggle, sort.

### Testing

- Unit: tier resolution (boundaries 5,999/6,000 etc., partner override, bounds), MYT week-window
  math, settlement close idempotency, pay idempotency, claim idempotency, requirement evaluation
  per type.
- Integration (`integration:modules` / `integration:http`): close→approve→pay happy path, void,
  attribution endpoint (self-referral, double-bind), store payloads, admin CRUD.
- Storefront: vitest for schemas/actions; Playwright capture for the `/task` page states.

## Build order

1. **PR #482 merges first** (this branch is stacked on it).
2. **Phase A — referral + VIP rebate**: migration, attribution, settings, weekly engine, jobs,
   store routes, `/task` Referral + VIP tabs, admin Referrals section + Customer-360 panel.
3. **Phase B — tasks**: task tables, progress, check-in, claim, `/task` Tasks tab, admin Tasks
   CRUD.

Each phase is its own PR with the full verification suite (backend unit + integration, storefront
vitest + tsc + build, admin vitest + `tsc -b`).

## Out of scope

Multi-level commissions, wagering locks/maturation, retroactive attribution of pre-existing
accounts, anti-fraud automation beyond the human approve gate, and any change to withdrawal
gating.
