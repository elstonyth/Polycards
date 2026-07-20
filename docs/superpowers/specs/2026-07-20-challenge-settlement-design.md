# Design spike — Weekly Challenge settlement engine (week-close snapshot + payout)

> **Status**: DESIGN SPIKE. No production code. Turns runbook §1.1 "build it"
> into an executable build plan with the money hazards decided up front. All
> line citations verified at commit `b5944e26` in the packs module. Companion
> to plan `plans/056-challenge-settlement-design-spike.md`.

## The problem in one paragraph

The Weekly Pulled Value Challenge ships a live community pool, a top-10 board,
milestone stage config, and future-tense prize copy — and **nothing settles
it**. At week rollover the shared anchor CTE recomputes the board for the NEW
week and last week's top-10 vanishes from every surface, with no snapshot and
no payout (`docs/ops/production-reset-and-golive-runbook.md:31-46`). Every data
prerequisite already exists: draw-time `recorded_value_usd` pinned per pull,
the DST-correct week-anchor CTE, admin stage config, the per-customer credit
lock, the append-only ledger, the reward-Pull fulfillment path, and the
notifications registry. What is missing is the engine that reads the closing
week, freezes it, and pays it out — once, safely, under operator review.

## Sources (every file read, one line each)

| File:line | Contributes |
|---|---|
| `backend/packages/api/src/api/store/challenge/route.ts:10-15` | **Decision record** — stages ARE the prize pool; top-3 → featured cards, ranks 4-10 → credits; NO flat payout; old settings payout fields retired. Still intact → STOP #1 does not fire. |
| `docs/ops/production-reset-and-golive-runbook.md:31-53` | §1.1 the BLOCKING contract: "a job at reset that ranks the closing week, writes an immutable standings snapshot, and grants the cumulative unlocked rewards, with an admin review surface before it pays." |
| `docs/ops/production-reset-and-golive-runbook.md:55-59` | §1.2 prod stage thresholds are demo-sized (top stage RM 100) — operator config, out of scope for this engine. |
| `backend/packages/api/src/modules/packs/service.ts:334-350` | `CHALLENGE_WEEK_ANCHOR_CTE` + `challengeWeekAnchorParams` — resolves the CURRENT week's UTC start from (timezone, resetDay, resetHour); `wkfix` steps back a week if before reset hour. The closing-week query must offset this window by exactly −7 days. |
| `backend/packages/api/src/modules/packs/service.ts:247-248,238` | `PULLED_VALUE_USD_SQL` = `COALESCE(pu.recorded_value_usd, LIVE_VALUE_USD_SQL)` — pinned snapshot with a live-price fallback for pre-backfill rows. The value-basis question at settlement. |
| `backend/packages/api/src/modules/packs/service.ts:4811-4831` | `challengeWeekPool` — SUM of pulled value, `source <> 'reward'`, `rolled_at >= start_utc`. The closing pool value to freeze. |
| `backend/packages/api/src/modules/packs/service.ts:4839-4873` | `challengeWeekTop` — top-N ranking, `ORDER BY volume_myr DESC NULLS LAST, pu.customer_id ASC`. The deterministic tiebreak the snapshot must reuse. |
| `backend/packages/api/src/modules/packs/service.ts:4935-4951` | `challengeSettings` — reads (timezone, reset_day, reset_hour) + the retired `payout_credits`/`payout_card_ids`. |
| `backend/packages/api/src/modules/packs/service.ts:4955-5041` | `editChallengeSettings` — audited singleton patch; `payout_card_ids` existence check (`:4964-4978`); `AdminActionAudit` write with before/after/reason (`:5022-5039`) — the audit pattern to reuse for the review gate. |
| `backend/packages/api/src/modules/packs/models/challenge-stage.ts:8-22` | `ChallengeStage` — `stage_number` (unique, contiguous), `threshold_myr`, `reward_credits` (MYR), `reward_card_ids` (json). The cumulative unlock ladder. |
| `backend/packages/api/src/modules/packs/service.ts:682-855` | `mutateCreditAtomic` — the credit writer: `pg_advisory_xact_lock('credit:<id>')` (`:698-700`), idempotent replay via `source_transaction_id` (`:708-737`), sign invariants (`:759-770`), auto-unfreeze on inflow (`:840-846`). |
| `backend/packages/api/src/modules/packs/models/credit-transaction.ts:16-28` | Ledger `reason` enum (11 values incl `daily_reward`). New reason must be added here first. |
| `backend/packages/api/src/modules/packs/migrations/Migration20260719010000.ts:46` | The live DB CHECK constraint mirroring the enum — must widen in lockstep. |
| `apps/storefront/src/lib/data/schemas.ts` (`CREDIT_REASONS`) + `__tests__/schemas.test.ts` + `plans/005-credit-reason-enum-drift-guard.md` | Storefront enum mirror + parity guard test. `parseList()` silently drops unknown reasons → drift = invisible data loss. |
| `backend/packages/api/src/modules/packs/service.ts:4232-4247` | Reward-Pull fulfillment: `createPulls({ source: 'reward', pack_id: 'reward-box-<tier>', card_id: handle })`. The card-grant path to reuse. |
| `backend/packages/api/src/modules/packs/service.ts:4261-4283` | Reward-credit path: `mutateCreditAtomic({ reason: 'reward_credit', idempotencyReference: 'reward:<cust>:<day>:<ord>' })` + `MAX_BOX_CREDIT_MYR` ceiling. Note: `settleRewardDraw` (grep-hit) is REWARD-BOX settlement — a **different** system; do not reconcile. |
| `backend/packages/api/src/jobs/mature-commissions.ts:20-58` | The closest existing engine shape: a scheduled job (`schedule: '0 * * * *'`, `:55-58`) that calls a per-beneficiary service method and fires one non-fatal `notifyFeed` per row with an idempotency key. |
| `backend/packages/api/src/modules/packs/service.ts:3786,3851` | `matureDueCommissions` / `matureDueCommissionsForBeneficiary` — per-beneficiary-transaction pattern the payout writer copies (one txn per winner). |
| `backend/packages/api/src/modules/packs/notify-feed.ts:3-33` | `notifyFeed(container, {receiverId, template, data, idempotencyKey})`; `FeedTemplate` union (`:3-9`) — must widen for a settlement template. |
| `docs/superpowers/specs/2026-07-20-notification-toasts-design.md:44-45,77` | Names `challenge_stage` as the natural future producer; the settlement notification joins that surface. |
| `backend/apps/admin/src/routes/challenge/page.tsx:378-383` | Admin tabs "Milestone Stages" / "Week & Reset" — where a "Settlements" review tab lives. |
| `backend/packages/api/src/modules/packs/service.ts:1058-1074,840-846` | Frozen-account posture: `CustomerAccountState.frozen` (sticky manual freeze); a positive credit inflow auto-unfreezes an AUTO freeze. |
| `backend/packages/api/src/modules/packs/models/pull.ts:65-73` | `IDX_pull_rolled_at` + `IDX_pull_customer_id_rolled_at` — cover the closing-week range scan. |
| `backend/packages/api/src/modules/packs/service.ts:408-410` | `applyPackMemberDiff` — precedent for a non-credit `pg_advisory_xact_lock('<scope>:<id>')`; a `challenge:<week-anchor>` lock serializes the close job against itself. |

---

## 1. Data model — `challenge_week_snapshot` (+ per-rank rows)

An immutable, append-only pair of tables in the **packs** module (same module as
every seam above), written once per closed week.

**`challenge_week_snapshot`** (one row per settled week):

```
challenge_week_snapshot
  id                text pk
  week_anchor_utc   timestamptz  -- the CLOSING week's start_utc (unique idempotency key)
  timezone          text         -- frozen copy of challengeSettings at close
  reset_day         int
  reset_hour        int
  closing_pool_myr  numeric      -- challengeWeekPool over the closing window
  stages_unlocked   int          -- count of stages whose threshold_myr <= closing_pool_myr
  status            text CHECK (status IN ('pending_review','approved','paid','void'))
  created_at / updated_at / deleted_at
  UNIQUE (week_anchor_utc)  WHERE deleted_at IS NULL   -- one snapshot per week; re-run no-ops
```

**`challenge_week_standing`** (one row per ranked winner, FK → snapshot):

```
challenge_week_standing
  id                text pk
  snapshot_id       text  -- FK challenge_week_snapshot.id
  rank              int   -- 1..N, deterministic (matches challengeWeekTop ordering)
  customer_id       text
  pulled_value_myr  numeric   -- frozen volume at close (challengeWeekTop.volumeMyr)
  pulls             int
  reward_credits_myr numeric  -- credits owed at this rank given stages_unlocked (0 for ranks 1-3)
  reward_card_ids   jsonb     -- featured cards owed at this rank (empty for ranks 4-10)
  credit_txn_id     text null -- set when the credit grant commits
  card_pull_ids     jsonb     -- reward-Pull ids minted for the card grant
  payout_status     text CHECK (payout_status IN ('pending','paid','skipped'))
  UNIQUE (snapshot_id, rank)  WHERE deleted_at IS NULL
```

Rationale:
- **Two tables, not one JSON blob** — the standing rows are the per-winner
  idempotency + audit units the payout writer keys on (§3), mirroring how
  `reward_draw` carries `credit_txn_id` + `vault_pull_id` per draw
  (`service.ts:4293-4319`).
- **`week_anchor_utc` UNIQUE** is the double-snapshot guard: re-running the close
  job for an already-snapshotted week is a no-op insert conflict, not a second
  board. Same "the DB itself guarantees it" discipline as the ledger's UNIQUE
  `pull_id` (`credit-transaction.ts:33`).
- **Frozen config copy** (timezone/reset_day/reset_hour): §6 hazard — settings
  edited between close and payout must not move the window under a paid snapshot.
- **Per-rank reward split is materialized at close**, computed from
  `stages_unlocked` × the `ChallengeStage` ladder (`challenge-stage.ts:8-22`) and
  the rank-split rule from the decision record (top-3 cards, 4-10 credits,
  `route.ts:11-15`). The board route computes stages live; the snapshot pins them.

Migration: one Mikro-ORM migration in `modules/packs/migrations/` defining both
tables + both partial-unique indexes. DDL prose only in this spike.

## 2. The close job

**Trigger: a scheduled job, not lazy-on-read.** Recommend a job in `src/jobs/`
(`challenge-close.ts`) copying `mature-commissions.ts` (`:20-58`) —
`schedule` cron, resolve the packs service, call one service method. Justification:
- Lazy-on-first-read-after-rollover would put a money-writing settlement on the
  hot public GET path (`route.ts`, 30s-cached, unauthenticated) — wrong trust
  boundary and wrong latency budget.
- A scheduled job is the runbook's stated shape (§1.1 "a job at reset").
- **Cron cadence vs. reset cadence mismatch is expected and safe.** The reset is
  (timezone, reset_day, reset_hour); a fixed cron can't express a
  settings-driven local-time anchor. Run the job **hourly** (like commissions)
  and have it self-gate: compute the just-closed week's `week_anchor_utc` from
  `challengeWeekAnchorParams` and only snapshot if `now()` is past that anchor
  AND no snapshot for it exists yet. The UNIQUE key makes every extra hourly
  wake-up a cheap no-op. `// ponytail: hourly poll + idempotent no-op beats a
  bespoke timezone-aware scheduler — upgrade only if minute-accuracy at reset
  ever matters.`

**The closing-week window.** Reuse `CHALLENGE_WEEK_ANCHOR_CTE`
(`service.ts:334-345`) verbatim to get the CURRENT week's `start_utc`, then the
**closing** week is `[start_utc - interval '7 days', start_utc)`. The classic bug
is off-by-one-week: the existing aggregates filter `rolled_at >= start_utc` (open
upper bound = "this week so far"); settlement needs a **half-open bounded**
window `rolled_at >= prior_start AND rolled_at < start_utc`. Draft SQL (§3 / Step
3):

```sql
WITH <CHALLENGE_WEEK_ANCHOR_CTE>,                     -- yields anchor.start_utc
     prior AS (SELECT start_utc - interval '7 days' AS lo,
                      start_utc                     AS hi FROM anchor)
SELECT pu.customer_id, COUNT(*) AS pulls,
       ROUND(SUM(<PULLED_VALUE_USD_SQL>) * ? /*fx*/ * 100) / 100 AS volume_myr
  FROM pull pu
  LEFT JOIN card c ON c.handle = pu.card_id AND c.deleted_at IS NULL
 WHERE pu.deleted_at IS NULL AND pu.customer_id IS NOT NULL
   AND pu.source <> 'reward'
   AND pu.rolled_at >= (SELECT lo FROM prior)
   AND pu.rolled_at <  (SELECT hi FROM prior)
 GROUP BY pu.customer_id
 ORDER BY volume_myr DESC NULLS LAST, pu.customer_id ASC
 LIMIT ?;
```

Reuse the SAME `PULLED_VALUE_USD_SQL` and the SAME `ORDER BY … , customer_id ASC`
tiebreak as `challengeWeekTop` (`:4859`) so the snapshot rank order is identical
to what the board showed. The pool value is the same query without GROUP/LIMIT
(mirror `challengeWeekPool`, `:4818-4829`) over the bounded window.

**Idempotency**: the snapshot insert keys on `week_anchor_utc` (UNIQUE). Wrap the
close in a `pg_advisory_xact_lock('challenge:<week_anchor_utc>')`
(`applyPackMemberDiff` precedent, `:408-410`) so two overlapping job runs can't
both compute-then-insert; the UNIQUE is the backstop, the lock avoids the wasted
work + a 23505 in the logs.

## 3. Payout writer

Runs AFTER a snapshot reaches `approved` (§4). Copies `matureDueCommissions`'s
per-row shape (`service.ts:3786,3851`): iterate the `challenge_week_standing`
rows, **one transaction per winner**, each independently idempotent.

Per winner:
1. **Credits** (ranks 4-10, or any rank whose `reward_credits_myr > 0`): call
   `mutateCreditAtomic` (`:682-855`) under the existing `credit:<customer>` lock —
   do NOT invent a new credit writer.
   - **Idempotency key shape**: `challenge:<week_anchor_utc>:<customer_id>:<rank>`
     passed as `idempotencyReference`. `mutateCreditAtomic`'s replay guard
     (`:708-737`) makes a resumed/re-approved payout a no-op, not a double-credit
     — the same mechanism `reward_credit` uses (`reward:<cust>:<day>:<ord>`,
     `:4277`).
   - **New ledger reason `challenge_payout`.** Decision: add a new reason rather
     than reuse `reward_credit` (which means reward-BOX and would corrupt that
     audit trail) or `adjustment` (which is operator-manual and sign-agnostic —
     a challenge payout must read as an automated, reason-typed inflow). Adding a
     reason requires a **lockstep update of four mirror surfaces** (plan 005):
     1. backend model enum — `models/credit-transaction.ts:16-28`
     2. DB CHECK constraint — new migration mirroring `Migration20260719010000.ts:46`
     3. storefront `CREDIT_REASONS` + `CreditTransactionSchema` — `apps/storefront/src/lib/data/schemas.ts`
     4. the parity guard test — `apps/storefront/src/lib/data/__tests__/schemas.test.ts` (plan 005)

     `parseList()` silently drops rows with an unknown reason, so a missed
     storefront update = a winner's payout invisible in their transaction list.
   - **Sign invariant**: a payout is a credit (`amount > 0`). `mutateCreditAtomic`
     only enforces sign for `topup`/`pack_open` (`:759-770`); `challenge_payout`
     is not sign-checked there, so the writer must assert `amount > 0` before the
     call (fail loud, never write a negative "payout").
2. **Featured cards** (ranks 1-3): reuse the reward-Pull path — `createPulls({
   customer_id, pack_id: 'challenge-<week>', card_id: handle, source: 'reward',
   rolled_at: now, order_id: null })` (mirror `:4232-4247`). `source: 'reward'`
   keeps the granted cards OUT of next week's pool/ranking (both aggregates filter
   `source <> 'reward'`, `:4826`/`:4856`) — so a prize can't inflate the winner's
   next-week standing. Record the minted pull ids in
   `challenge_week_standing.card_pull_ids`; on resume, skip a rank whose
   `card_pull_ids` is already populated (Pull has no natural idempotency key for
   this, so the standing row is the guard — see §6).
3. Stamp `payout_status='paid'` + `credit_txn_id` on the standing row in the SAME
   winner transaction.
4. Fire one `notifyFeed` per winner (§5), non-fatal try/catch exactly like
   `mature-commissions.ts:33-50`.

**Plan-044 cap interaction**: the credit amount comes from
`challenge_week_standing.reward_credits_myr`, which was materialized at close from
`ChallengeStage.reward_credits` — a value the stage authoring validator already
caps at write time (assume plan 044 lands). The payout writer therefore adds NO
new cap; it pays exactly the frozen, already-capped stage reward. (A defense-in-
depth ceiling like `MAX_BOX_CREDIT_MYR` at `:4266` is cheap insurance and
recommended.)

## 4. Admin review gate

A new **"Settlements"** tab beside "Milestone Stages" / "Week & Reset"
(`backend/apps/admin/src/routes/challenge/page.tsx:378-383`).

- **What the operator sees**: for a `pending_review` snapshot — the frozen closing
  standings (rank, handle, pulled value, credits owed, cards owed) side by side
  with the CURRENT live board (`GET /store/challenge`), so a wildly-off snapshot
  (e.g. a bad FX or a config edit mid-week) is visible before money moves.
- **Actions**: `Approve` (→ `approved`, enqueues the payout writer) and `Void`
  (→ `void`, never pays; for a snapshot taken against corrupt config). Both write
  an `AdminActionAudit` row reusing the exact pattern at `service.ts:5022-5039`
  (`entity_type: 'challenge_week_snapshot'`, `action: 'approve'|'void'`, before/
  after status, operator `reason`).
- **Auto-pay without review**: recommend **never, initially**. The runbook
  mandates "an admin review surface before it pays" (§1.1). Auto-pay would need,
  at minimum: a settled-value sanity bound (pool within X% of a rolling median),
  a per-week payout ceiling, and a proven manual week-1 run first. Out of scope
  here; note as a future hardening.

## 5. Storefront surface + notifications

- **Last week's settled standings**: the runbook's "vanishes from every surface"
  complaint (§1.1) is fixed by exposing the newest `paid` snapshot. Add a
  read-only `GET /store/challenge/history` (or a `last_week` block on the existing
  challenge route) returning the top `challenge_week_standing` rows for the most
  recent paid snapshot, with the same public PII rules the board already uses
  (`route.ts:16-18`, first-name-or-"Collector ####" + avatar seed). Read-only,
  cacheable — no new module.
- **Notifications**: widen `FeedTemplate` (`notify-feed.ts:3-9`) with a
  settlement template. The toasts spec already earmarks `challenge_stage` as the
  natural challenge producer (`2026-07-20-notification-toasts-design.md:44-45`);
  a settlement is the concrete instance. Recommend one template
  `challenge_settled` with primitives-only data `{ week_anchor, rank,
  credits_myr, card_count }`, idempotency key
  `challenge:<week_anchor>:<customer>:<rank>:settled` (one per winner per week).
  Fired from the payout writer, non-fatal, per `mature-commissions.ts:26-32`.

## 6. Failure modes

| Mode | Posture |
|---|---|
| **Reset-time config edit** (settings changed mid-close) | The snapshot freezes timezone/reset_day/reset_hour at close (§1); the payout window is bound to the stored `week_anchor_utc`, never re-read from live `challengeSettings`. An edit after snapshot can't move a paid window. |
| **Ties at rank N** (equal pulled value at the cut line) | Deterministic tiebreak `volume_myr DESC NULLS LAST, customer_id ASC` (reused from `challengeWeekTop:4859`) — no coin-flip, snapshot order == board order. If two customers tie at rank 10 the lower `customer_id` wins the slot; note as an operator-visible rule. |
| **Winner frozen at payout time** | A challenge payout is a positive inflow → `mutateCreditAtomic` auto-unfreezes an AUTO freeze (`:840-846`), which is correct (the credit repays the debt). A **manual** freeze is sticky (`:1073`) and the inflow still lands (the freeze gates withdrawal, not receipt) — matching the frozen-gate posture: credit in is always allowed, cash-out is gated. No special-casing needed; payout proceeds. |
| **Crash mid-payout** | Per-winner transactions + per-`(week,customer,rank)` idempotency (`mutateCreditAtomic` replay guard `:708-737` for credits; `card_pull_ids` populated-check for cards). Re-running the payout writer resumes: already-paid winners replay to no-ops, unpaid winners pay. Nothing double-pays because the idempotency key is stable across runs. |
| **`recorded_value_usd` NULL fallback** | `PULLED_VALUE_USD_SQL` COALESCEs to live price for un-pinned rows (`:247-248`). At settlement the recorded backfill has already run on prod (per memory: 153/153 stamped 2026-07-19), so in practice all closing-week rows are pinned. **Open question for the operator** (§9): should settlement REFUSE to pay on any non-pinned row (hard-fail the snapshot) rather than silently price it live at close? Recommend: warn-and-proceed for week 1 (fallback is observation-neutral at run time per `:4877`), harden to refuse once the pin is guaranteed at draw time. |

## 7. Column fate — `payout_credits` / `payout_card_ids`

These `challenge_settings` columns (`service.ts:4948-4949`, existence-checked at
`:4964-4978`) are the **retired flat-payout model** the decision record explicitly
disowns ("the old settings payout fields are retired", `route.ts:14-15`). Plan
047 stops writes to them. Recommendation: **drop them in a migration once the
snapshot tables land** — the snapshot + `ChallengeStage` ladder fully replace
them. Sequence: (a) confirm plan 047 has stopped all writes, (b) drop the
`payout_card_ids` existence-check code in `editChallengeSettings`, (c) drop the
columns. Not part of the settlement engine's own PR — a follow-up cleanup once
the engine proves the columns are dead.

## 8. Build plan sketch (→ plans 057+)

| Chunk | Effort | Scope | Test strategy |
|---|---|---|---|
| **057 — snapshot model + close job** | M | Both tables + migration; `challenge-close.ts` job (hourly, self-gating, advisory-locked); `snapshotClosingWeek()` service method (bounded prior-week window). | Module-tier specs: window math (closing week = prior 7 days, DST boundary, before/after reset hour); idempotency (re-run → no second snapshot); tie ordering matches `challengeWeekTop`. |
| **058 — payout writer + `challenge_payout` reason** | M (MONEY, own PR) | New reason across all 4 mirror surfaces; `settleApprovedSnapshot()` per-winner writer (credits via `mutateCreditAtomic`, cards via reward-Pull); standing-row stamping. | Module-tier: per-winner idempotency (resume after crash pays each winner once); sign guard; cap respected. Smoke-tier: **ledger conservation** — Σ ledger delta across a settled week == Σ frozen standings credits. |
| **059 — admin review gate** | S-M | "Settlements" tab; approve/void actions + `AdminActionAudit` rows; standings-vs-live diff view. | Integration-http: approve transitions `pending_review→approved` and enqueues payout; void never pays; audit row written. |
| **060 — storefront history + notifications** | S | `GET /store/challenge/history` (last paid snapshot, public PII rules); `FeedTemplate` widen + `challenge_settled` producer. | Route spec: history returns only `paid` snapshots with public fields; producer idempotency key is one-per-winner-per-week. |

## 9. Open questions for the operator

1. **Value-basis fallback at settlement** — if a closing-week pull row has a NULL
   `recorded_value_usd` (never stamped), should settlement (a) refuse to pay and
   flag the snapshot for manual review, or (b) price it live at close via the
   existing COALESCE fallback and proceed? (Design default: warn-and-proceed week
   1, harden to refuse later.)
2. **Review-gate SLA** — if a `pending_review` snapshot is NOT approved before the
   NEXT week closes, does it block the next snapshot? Recommend **no**: snapshots
   queue independently (each keyed on its own `week_anchor_utc`), and an unapproved
   week simply stays `pending_review` until an operator acts. Confirm this is the
   desired posture.
3. **Prize-card sourcing / stock** — a featured card owed to ranks 1-3 may be out
   of stock (the reward-box path degrades a product prize to "nothing" when
   `!inStock`, `:4227-4230`). At settlement, should an out-of-stock featured card
   (a) still mint the reward-Pull (cards are catalog entries, delivery is
   separate), (b) substitute credits at the card's FMV, or (c) block the payout
   pending restock? Needs an operator ruling — the snapshot should record whatever
   is decided per standing row.
4. **Week-1 launch mode** — does the launch use the runbook's manual-settlement
   interim (§1.1 second option: operate manually week 1, prize copy stays
   future-tense) while the engine bakes, then cut over to the automated job? Or
   does the engine ship before go-live? This decides whether plan 057 is a
   launch blocker or a fast-follow.

## Appendix — Step 3 (EXPLAIN)

Not run — no local DB configured in this worktree. Static read of the index set:
the closing-week query filters `pu.rolled_at >= lo AND pu.rolled_at < hi` and
GROUPs by `customer_id`; `IDX_pull_rolled_at` (`models/pull.ts:72-73`) covers the
bounded range scan, and `IDX_pull_customer_id_rolled_at` (`:65-66`) is available
for the grouping. Same access shape the existing weekly aggregates already run in
production, so no new index is anticipated; confirm with an `EXPLAIN` against a
seeded DB before the 057 build lands.
