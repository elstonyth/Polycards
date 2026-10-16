# Lossless Mode schedule — design

Date: 2026-10-17. Status: approved in chat by the operator.

## Why

"Lossless Mode" is a marketing promo (weekend poster: "100% BUYBACK"): while it
runs, selling a card **on the spot during the 30s reveal** pays 100% of its
value instead of the pack's normal instant rate (90 today). Today the only way
to run it is to hand-edit every pack's `buyback_percent` in admin at midnight
and remember to put each one back afterwards. On 2026-10-16 that was done by
hand at 23:47 for all 7 active packs (all were 90 before).

The operator wants to schedule it instead: pick a start and end time, pick
**all packs or specific packs**, and have every pack return to **its own
previous (normal) rate** automatically when the window ends.

## Goals

- Admin can create a Lossless schedule: start, end (Malaysia time), All packs
  or a chosen set of packs, plus the house-rule reason.
- During the window, the chosen packs' **instant** rate is 100%.
- After the window, each pack is back on its normal rate with no action.
- Admin sees each schedule as Upcoming / Live / Ended / Cancelled and can
  cancel one (a live one ends immediately).
- Storefront shows the effective rate (e.g. "100% Instant Buyback") during the
  window with no storefront code change.

## Non-goals

- No change to the **vault / flat rate**: always `FLAT_PERCENT` (90), promo or
  not. The operator explicitly asked for this.
- No adjustable promo percentage — Lossless means 100.
- No recurring rules ("every weekend"); one row per window.
- No editing a schedule in place; cancel and create a new one.
- No promo for task-reward pulls (`reward_box`) or the free welcome pack.

## Anti-goals (would be a failure even if it "works")

- A quote and the credit disagreeing at a window boundary (reveal says 100%,
  sell credits 90%). `buyback-rate.ts` header forbids this.
- Losing or clobbering a pack's normal rate. The design never writes
  `pack.buyback_percent`.
- The vault paying more than 90%.

## Design

### Overlay, not flip

The schedule never touches `pack.buyback_percent`. It is an overlay consulted
at pricing time: the effective instant percent for a pull is

```
lossless(pack, pull.rolled_at) ? 100 : pack.buyback_percent
```

and that value is handed to the existing pure `resolveBuybackRate`, which keeps
all of its window logic (30s from reveal, 5-min grace, `instant_closed_at`,
floor at FLAT, vault = FLAT). "Back to the previous rate" is therefore exact by
construction: there is nothing to restore. An admin who edits a pack's normal
rate mid-window changes what applies after the window.

### Judged by when the card was pulled

A pull is in the promo iff `starts_at <= pull.rolled_at < effective_end`, where
`effective_end = min(ends_at, cancelled_at)`. `rolled_at` is immutable, so the
open-time quote, the reveal quote, the vault quote and the credit all reach the
same answer whenever they run. A card pulled at Sun 23:59:50 and sold at Mon
00:00:10 is paid the 100% it was quoted. Storefront display (no pull) uses
"now".

### Which packs

- `pack_slugs = null` → **All packs** = every pack whose category is not
  `free_welcome` (`FREE_WELCOME_CATEGORY`) and not `reward_box`. Evaluated at
  pricing time, so a pack created mid-window is included.
- `pack_slugs = [..]` → exactly those slugs. Validated on create: non-empty,
  every slug exists, none is free_welcome / reward_box.
- Pulls with `source = 'reward'` never get the overlay (guard; reward pools are
  `reward_box` anyway). Admin-gifted and bonus-funded pulls on a paid pack DO
  get it — same as the 2026-10-16 hand flip paid them (builder's call, checked
  by the operator).
- Overlapping schedules are allowed; a pack is lossless if any live schedule
  covers it.

### Data

New table `lossless_schedule` in the packs module:

| column       | type             | notes                 |
| ------------ | ---------------- | --------------------- |
| id           | id pk            |                       |
| starts_at    | timestamptz      |                       |
| ends_at      | timestamptz      | > starts_at           |
| pack_slugs   | jsonb null       | null = all paid packs |
| cancelled_at | timestamptz null | set by cancel         |
| created_by   | text             | admin actor id        |

Plus Medusa's created/updated/deleted columns. Index on `(starts_at, ends_at)`
where `deleted_at IS NULL`. Migration proved in an integration spec (local
`db:migrate` is gated, see memory).

Constant `LOSSLESS_PERCENT = 100` next to `FLAT_PERCENT` in `buyback-rate.ts`.

### Where the overlay applies

One service helper on `PacksModuleService` that, given a pack row and an
instant, returns the pack with `buyback_percent` replaced by 100 when lossless
(else unchanged). Every place that prices a sell-back or shows a pack's rate
goes through it:

- `workflows/steps/buyback-pull.ts` (the credit) — at `pull.rolled_at`
- `service.quoteBuyback` (open, open-batch, task-claim spin quotes) — at
  `pull.rolled_at`. Task spins draw from `reward_box` packs, so they stay
  unaffected by the category rule.
- `api/store/vault/route.ts` (vault quote) — at `rolled_at`
- `api/admin/customers/[id]/pulls/route.ts` (admin display) — at `rolled_at`
- `api/store/packs/route.ts` and `api/store/packs/[slug]/route.ts` (the
  storefront badge) — at now

Telegram / growth pull-card already hard-code `FLAT_PERCENT`; untouched.

**Admin pack routes keep the STORED rate.** `GET /admin/packs` and the pack
edit form must show `buyback_percent` as stored; overlaying there would make a
plain save write 100 into the pack's normal rate.

### Admin API

Rate-limited like the other admin money surfaces (`adminActionRateLimit`).
`reason` required (`reqReason`), `admin_id` from `auth_context`.

- `GET /admin/lossless-schedules` → all rows, newest start first, each with a
  server-computed `status`: `upcoming | live | ended | cancelled`
  (cancelled = cancelled before it started; a live row cancelled early shows
  `ended`), plus `effective_end`.
- `POST /admin/lossless-schedules` `{ starts_at, ends_at, pack_slugs | null,
reason }`. Rules: ISO strings; `ends_at > starts_at`; `ends_at` in the
  future; `starts_at` no more than 5 minutes in the past (allows "start now",
  blocks backdating).
- `POST /admin/lossless-schedules/:id/cancel` `{ reason }` → sets
  `cancelled_at = now` under a row lock. Refused if already ended or
  cancelled.

Audit: one `admin_action_audit` row per create/cancel in the same transaction,
`entity_type 'pack'`, `entity_id` = schedule id, actions `create` / `disable`,
payload carrying `kind: 'lossless_schedule'` and the window. (Reuses existing
CHECK values — no audit-enum migration, same trade the challenge schedule
made.)

### Admin UI

Packs page gets a third tab, **Lossless Mode**, beside Packs / Free pack:

- Table: Start, End (MYT), Packs ("All packs" or titles), Status badge,
  Cancel action (confirm + reason) on upcoming/live rows.
- "Schedule Lossless Mode" form: Start and End as `datetime-local` read as
  Asia/Kuala_Lumpur (reuse `zoneOffsetMs` from `lib/challenge-schedule.ts`),
  "All packs" switch (default on) or checkboxes of the paid packs, reason.
- Copy states that vault sells stay at 90%.

## Rollout (this weekend)

The 7 packs currently carry a hand-set 100. After deploy:

1. Create a schedule: start = now minus 5 minutes (the API allows up to 5
   minutes back), end = Mon 19 Oct 00:00 MYT, All packs. Backdating covers any
   pull made under the hand-set 100 that is still inside its sell window, so
   step 3 cannot turn its 100% quote into a 90% credit.
2. Verify `store/packs` still shows 100 for all 7.
3. Set each pack's normal rate back to 90 in admin; verify still 100
   (overlay) on the public API.
4. Monday after 00:00: verify all 7 read 90.

If the deploy is not live by Sun 23:30 MYT, fall back to the manual revert at
Mon 00:06 MYT or later.

## Left to the builder

File layout inside the packs module, exact service method names, i18n keys,
test split (pure eligibility function unit-tested; route validation unit
spec; one integration spec proving the migration and create/cancel/audit).
