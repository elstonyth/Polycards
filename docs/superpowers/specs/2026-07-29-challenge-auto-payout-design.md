# Weekly Challenge auto-payout

**Date:** 2026-07-29
**Status:** Approved (design)
**Scope:** Backend (`backend/packages/api`), plus one storefront notification
template entry in `src/lib/notifications/copy.ts` (see §Notifications). No
other storefront change.

## Problem

The Weekly Pulled Value Challenge is fully authored and fully read-only. Admins
configure stages (`challenge_stage.rank_rewards`: a sparse table of
`{ rank, card_id, credits }` for ranks 1-10) and the storefront renders
progress, but **nothing ever pays out**. `service.ts:5738` says it plainly:
"read-only, so the pool is REAL ledger data even while the reward settlement
engine is inert."

Build the settlement engine: at each week boundary, pay the just-ended week's
top-10 whatever the community pool unlocked.

## Settlement rules

1. The challenge week is anchored at `(timezone, reset_day, reset_hour)` from
   the `challenge_settings` singleton.
2. A week's **community pool** = Σ pulled value (MYR) across all customers
   inside that week's window, excluding `pull.source = 'reward'`.
3. A stage is **unlocked** when the final pool ≥ its `threshold_myr`. Unlocking
   is **cumulative**: stage 3 unlocked implies stages 1 and 2 are too (their
   thresholds are lower), and each carries its own prize table.
4. **Winners** = that week's top-10 by pulled value (`challengeWeekTop`), same
   exclusion, ties broken by `customer_id ASC` (already deterministic).
5. Rank *r* receives the **union across every unlocked stage** of
   `rank_rewards[r]`: credits **summed**, each non-null `card_id` granted
   separately. Ranks absent from a stage's table get nothing from that stage.
6. Ranks with no customer (fewer than 10 participants) pay nothing.

## Architecture

### Scheduling — hourly, not weekly

`config.schedule` is static at boot; Medusa cannot reschedule cron from a DB
row, so "the cadence admins configured" cannot drive the cron expression. The
job runs **hourly** (`0 * * * *`, same as `jobs/mature-commissions.ts`) and
self-gates: compute the most recently *ended* challenge week; if a payout row
for that `week_start` already exists, return immediately.

This also makes the job self-healing — a week missed to downtime settles on the
next hourly tick rather than being lost until the following reset.

New file: `backend/packages/api/src/jobs/settle-challenge-week.ts`.

### Windowed week aggregates

`challengeWeekPool` and `challengeWeekTop` share `CHALLENGE_WEEK_ANCHOR_CTE`
(`service.ts:366`), which resolves the **current** week's `start_utc` and
filters `pu.rolled_at >= start_utc` with **no upper bound**. Settlement needs a
closed, past window.

Extend the shared CTE rather than forking it — one week-boundary definition is
the whole point of the constant:

- `ChallengeWeekAnchor` gains `weeksBack?: number` (default `0`).
- The `anchor` CTE emits **both** `start_utc` and `end_utc`
  (`start_local - weeksBack × 7d` and `start_local - (weeksBack − 1) × 7d`,
  each `AT TIME ZONE ?`).
- `challengeWeekAnchorParams` grows to carry the offset.
- Both existing queries add `AND pu.rolled_at < (SELECT end_utc FROM anchor)`.
  With `weeksBack = 0` this is a no-op (no pull is in the future), so current
  behaviour is unchanged and existing tests keep passing.
- Settlement calls both with `weeksBack: 1`.

The job also needs the resolved `start_utc` itself as the payout key. Add a
small `challengeWeekBounds(anchor)` returning `{ startUtc, endUtc }` from the
same CTE, so the key and the aggregates can never disagree.

**Boundary-race note (why relative-to-now is safe here):** the CTE resolves
against `now()`, and the bounds query + two aggregates run milliseconds apart —
they could only disagree on which week is "last" if the reset boundary fell
*between* them. Cron fires at minute 0 (`0 * * * *`) and resets anchor at a
whole hour, so every query in a run executes strictly *after* the boundary,
never straddling it. No explicit-timestamp plumbing needed.

### Idempotency — a DB unique index, not app logic

New model `backend/packages/api/src/modules/packs/models/challenge-payout.ts`:

```ts
export const ChallengePayout = model
  .define('challenge_payout', {
    id: model.id().primaryKey(),
    week_start: model.dateTime(),          // resolved start_utc of the paid week
    customer_id: model.text(),
    rank: model.number(),
    kind: model.enum(['credits', 'card']),
    // NOT nullable — '' on credits rows. Postgres treats NULLs as DISTINCT in
    // a unique index, so a nullable card_id would let the credits row insert
    // twice and defeat the whole idempotency guarantee below.
    card_id: model.text().default(''),
    credits: model.bigNumber().default(0),
    // Audit links: the ledger row / the vault pull this payout produced.
    credit_transaction_id: model.text().nullable(),
    pull_id: model.text().nullable(),
    status: model.enum(['granted', 'skipped_no_stock']).default('granted'),
    // Which stages contributed, + the resolved pool, for the audit trail.
    snapshot: model.json(),
  })
  .indexes([
    {
      name: 'UQ_challenge_payout_week_customer_kind_card',
      on: ['week_start', 'customer_id', 'kind', 'card_id'],
      unique: true,
      where: 'deleted_at IS NULL',
    },
    { name: 'IDX_challenge_payout_week', on: ['week_start'], where: 'deleted_at IS NULL' },
  ]);
```

Insert via raw `INSERT … ON CONFLICT … DO NOTHING` matching the partial index —
the `grantLevelUpRewards` pattern (`service.ts:4665`), which exists precisely to
avoid a 23505 poisoning the transaction (Postgres 25P02). A re-run no-ops at the
DB layer, not in application code.

Credits and cards are **separate rows** so a card that fails its stock gate
cannot roll back the credits payout.

> **Migration trap:** `credits` is `model.bigNumber()`, which is **two**
> columns — `credits` numeric **and** `raw_credits` jsonb. A hand-written
> migration omitting `raw_credits` passes every mocked test and fails on the
> first real insert. Generate the migration with `db:generate`, don't
> hand-write it.

### Granting

**Credits** — `mutateCreditAtomic` (`service.ts`), which already holds the
per-customer advisory lock and does its own idempotent replay:

```ts
await this.mutateCreditAtomic({
  customerId,
  amount: totalCredits,           // summed across unlocked stages
  reason: 'reward_credit',
  idempotencyReference: `challenge:${weekStartIso}:${customerId}`,
}, sharedContext);
```

`reason` reuses the existing `reward_credit` enum value. Adding a
`challenge_payout` value would widen a model-owned CHECK constraint and the
storefront's transaction-label maps in lockstep (see the expand/contract note in
`plans/058`) — not worth it when the `challenge_payout` row already carries full
provenance and links the ledger row by id. Revisit if the operator wants
challenge wins broken out in the customer-facing history.

**Cards** — `createPulls` with `source: 'reward'`, the daily-box precedent
(`service.ts:5171`):

```ts
{ customer_id, pack_id: `challenge-${weekStartIso}`, card_id: handle,
  order_id: null, rolled_at: new Date(), source: 'reward' }
```

> **ID-vs-handle trap (verified):** `rank_rewards[].card_id` is a Card **id**
> (`challenge-validate.ts` calls it "a non-empty card id"; the store challenge
> route resolves it via `listCards({ id: cardIds })`), but `pull.card_id` holds
> the Card **handle** (`models/pull.ts:16` — "= Card.handle"). The settlement
> MUST resolve `id → handle` (one `listCards({ id: [...] })` batch up front)
> before creating pulls, and check stock **by handle**
> (`getCardStockByHandle`). Passing the id straight through would mint pulls
> that join to no card — invisible in the vault, wrong in the ledger feed. A
> card id that no longer resolves (deleted card) takes the `skipped_no_stock`
> path.

`source: 'reward'` is **already excluded** by both challenge aggregates
(`WHERE … pu.source <> 'reward'`), so a reward card cannot inflate the winner's
next-week pool contribution or ranking. No new exclusion logic needed.

**Stock gate** — same post-roll gate as the daily box (`service.ts:5155-5168`):
resolve the product, check `getCardStockByHandle`. Insufficient stock ⇒ record
the payout row with `status: 'skipped_no_stock'` and **no** pull, and log a
warning through the container logger. Do **not** silently substitute credits —
that would change the advertised prize. The row is the operator's record for
manual fulfillment, and the unique index means a later manual grant can't be
double-paid by a re-run.

### Transaction shape — claim first, then grant

Follow `matureDueCommissions` (`service.ts:4720-4760`) for the outer shape:

- The job's enumerator runs **outside** any transaction.
- **One short transaction per winner** — never forward a shared context across
  winners, or every `credit:` advisory lock accumulates in one transaction and
  blocks every money path until the batch commits.
- Notifications fire **after** each winner's transaction commits.

**Inside each winner's transaction the ORDER is load-bearing.** `createPulls`
has no idempotency of its own, so "grant, then record" is racy: two concurrent
runs could both create the reward pull, then both hit
`ON CONFLICT DO NOTHING` on the payout row — the loser commits an orphan
duplicate pull. Instead the payout row is the **claim**:

1. `INSERT` the payout row(s) `ON CONFLICT DO NOTHING`, check the affected-row
   count. Zero rows = another run (or a previous tick) already claimed this
   payout → **skip granting entirely**.
2. Only after a successful claim: `mutateCreditAtomic` / `createPulls`.
3. `UPDATE` the claimed row with `credit_transaction_id` / `pull_id`.

All three in the one transaction — a grant failure rolls back the claim too, so
the next tick retries cleanly. A concurrent loser blocks on the uncommitted
unique-index conflict until the winner commits, then reads 0 affected rows and
skips. This is why the claim-row insert must be a raw `INSERT … ON CONFLICT`
(the `grantLevelUpRewards` pattern) and not `createChallengePayouts`.

> Per the VIP backfill lesson: never call a grant inside an uncommitted ledger
> transaction — a context-less `creditSummary` read inside one sees stale data.

### Notifications

`notifyFeed` per winner after commit, best-effort inside try/catch (a failed
notify must not abort the remaining winners, and the grant is already
committed). New template in `modules/packs/notify-feed` + storefront copy:

```
challenge_payout — "Weekly Challenge payout"
data: { week_start, rank, credits, card_count }
idempotencyKey: `challenge:${weekStartIso}:${customerId}`
```

Storefront `href`: `/leaderboard` (the challenge lives there). Note the Spec A
suspension removes `/vip` links — this template must not use one.

## Failure handling

| Failure | Behaviour |
| --- | --- |
| No stages configured | No stage can unlock ⇒ nothing to pay. Insert nothing; the next tick re-checks cheaply. |
| Pool below every threshold | Same — no unlocked stage, no payout rows, no re-settlement churn. Guarded by an early return so the "already settled" check stays meaningful. |
| Zero participants | `challengeWeekTop` returns `[]`; nothing to pay. |
| Card handle missing / out of stock | Row recorded `skipped_no_stock`, no pull, warning logged. |
| Job crashes mid-batch | Committed winners stay paid (unique index); the next hourly tick retries the rest. |
| Job runs twice concurrently | Claim-first ordering (§Transaction shape): the loser's claim insert affects 0 rows and it skips granting. |
| Outage spanning >1 full week | **Accepted limitation:** the job only ever settles the most recently ended week (`weeksBack: 1`). Weeks older than that are never auto-settled — an outage that long is an incident; the operator settles manually (the payout table + `medusa exec` make that scriptable). |

**Open decision, defaulted:** the "no stages configured / pool below threshold"
case records nothing at all, so the job re-evaluates that week every hour
forever (cheap — two aggregates behind the same guard). If that read cost
matters later, record a zero-payout sentinel row instead.

## Testing

Unit (`__tests__/*.unit.spec.ts`, mocked):
- Stage unlocking: pool exactly at, just below, and above a threshold.
- Reward union across stages: credits summed, multiple `card_id`s collected,
  sparse ranks paying nothing.
- Rank/winner mapping when fewer than 10 participants.

Integration (`integration:modules`) — **note:** modules-type specs generate
their schema from the spec file's `moduleModels` array, never from migrations.
`ChallengePayout` **must** be added to that array or the suite fails with
`relation "challenge_payout" does not exist`, and `db:migrate` can never fix it.
- Windowed aggregate: pulls in the prior week counted, pulls in the current week
  and `source='reward'` pulls excluded.
- Double-run: the job called twice pays once (row count and balance both).
- `skipped_no_stock` path records a row and creates no pull.

## Verification

```
cd backend/packages/api && corepack yarn db:generate && corepack yarn db:migrate
```

Then seed a prior-week scenario (`scripts/seed-challenge.ts` is the starting
point), run the job handler directly via `medusa exec`, and assert: payout rows
present, credit balance moved once, vault pull created with `source='reward'`,
the winner's next-week pool contribution unchanged, and a second run changes
nothing.

## Sequencing

Ship **after** Spec A and Spec B. This is the only one of the three that moves
money; keeping it on its own branch and its own PR keeps the revert cheap.

**Conflict warning:** Spec A edits `src/lib/notifications/copy.ts` (stripping
`href: '/vip'` from the VIP templates) and this spec adds a
`challenge_payout` template to the same file. Branch C off post-A `master`, or
resolve by hand.
