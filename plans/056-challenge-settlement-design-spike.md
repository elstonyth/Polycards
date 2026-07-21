# Plan 056: Design spike — the Weekly Challenge settlement engine (week-close snapshot + payout)

> **Executor instructions**: This is a DESIGN SPIKE, not a build plan. The
> deliverable is a design document + open-questions list, produced by reading
> the named code. Write NO production code. If anything in "STOP conditions"
> occurs, stop and report. When done, update the status row in
> `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat b5944e26..HEAD -- backend/packages/api/src/modules/packs backend/packages/api/src/api/store/challenge docs/ops/production-reset-and-golive-runbook.md`
> Drift is expected (plans 044/047/054 touch neighbors); re-locate symbols by name.

## Status

- **Priority**: P2 (the go-live runbook marks the missing engine BLOCKING)
- **Effort**: M (the spike; the build it specifies is L)
- **Risk**: LOW (spike itself writes only a doc; the engine it designs is MED-HIGH — money)
- **Depends on**: none to start; the DESIGN must assume plans 044 (reward caps) and 047 (payout-field retirement) land; 054's extraction is the preferred code home
- **Category**: direction (design/spike)
- **Planned at**: commit `b5944e26`, 2026-07-20

## Why this matters

The operator's own go-live runbook (`docs/ops/production-reset-and-golive-runbook.md` §1.1) marks this BLOCKING: the Weekly Pulled Value Challenge ships a live board, community pool, stage config, and prize copy — and **nothing settles it**. At week rollover the board recomputes for the new week; last week's top-10 vanishes from every surface with no snapshot and no payout. Every data prerequisite exists (draw-time `recorded_value_usd` pinned per pull, the week-anchor CTE, admin stage config, the credit-lock discipline, the notifications registry). This spike turns "build it" into an executable build plan with the money hazards decided up front instead of discovered mid-build.

## Current state (the seams the design must read)

- **Decision record** — `backend/packages/api/src/api/store/challenge/route.ts:9-15`: "every eligible pack draw feeds BOTH the community pool and the personal Weekly Pull Value ranking; community milestones unlock CUMULATIVE reward stages (top 3 → featured cards, ranks 4-10 → credits); the week's top-10 receive everything unlocked. There is NO separate flat payout — stages ARE the prize pool (the old settings payout fields are retired…)". **Design against the rank-split model; the `payout_credits`/`payout_card_ids` columns are dead** (plan 047 stops writes; this spike decides whether the columns drop).
- **Runbook contract** — runbook §1.1: "a job at reset that ranks the closing week, writes an immutable standings snapshot, and grants the cumulative unlocked rewards, with an admin review surface before it pays. Touches money → own PR, own tests." §1.2: prod stage thresholds are demo-sized (operator config item the design should note as a launch dependency).
- **Aggregates** — `service.ts` (or `challenge.ts` after plan 054): `challengeWeekPool` (:4811), `challengeWeekTop` (:4839), shared `CHALLENGE_WEEK_ANCHOR_CTE` + `challengeWeekAnchorParams` (:348) — DST-correct `AT TIME ZONE` window math anchored at (timezone, reset_day, reset_hour) from `challengeSettings` (:4935). The settlement must rank the CLOSING week with the same window math (off-by-one-week is the classic bug).
- **Value basis** — `PULLED_VALUE_USD_SQL` (:247): pinned `recorded_value_usd` with a live-pricing COALESCE fallback for pre-snapshot rows. Question for the design: at settlement time, is the fallback acceptable or must settlement refuse to pay on non-pinned rows?
- **Money discipline to reuse** (do not invent new): per-customer `pg_advisory_xact_lock('credit:<id>')` via `mutateCreditAtomic`; append-only ledger with idempotency keys; grant-then-claim pattern in the rewards economy (`rewards-gate.ts`, `store/rewards/claim/[grantId]`, `drawDailyBox`'s voucher payout at :4321 "AFTER the draw row exists so source_open_id can..."). Read `jobs/mature-commissions.ts` — the per-beneficiary-transaction job pattern (plan 021) is the closest existing engine shape.
- **Notifications** — `notify-feed.ts` (live symbol today: `notifyFeed`; `notifyFeedNonfatal` is the PENDING output of plan 052 — if your grep finds no such symbol, 052 hasn't run yet, that's not drift); the toasts spec (`docs/superpowers/specs/2026-07-20-notification-toasts-design.md`) names `challenge_stage` as the natural future producer.
- **Jobs infra** — `src/jobs/` has `mature-commissions.ts` + `sync-market-prices.ts` (hourly patterns to copy for a scheduled job).
- **Card prizes** — "featured cards to ranks 1-3": read how reward-box product wins mint/deliver — the symbol is `drawDailyBox` in `service.ts` (:4127) (there is NO `draw-reward-box.ts` file; the models are `models/reward-box.ts` + `models/reward-box-prize.ts`), producing Pulls with `source='reward'` (:4241) — the design should reuse that path for card grants rather than inventing a new fulfillment. The older `settleRewardDraw` was DELETED by Task 7 (see the note at `service.ts:3902`); it survives only in comments, so a grep hit on that name is not live code. Note the spike's grep-for-existing-settlement STOP will hit `drawDailyBox`: that is REWARD-BOX settlement, a different system — distinguish, don't reconcile.
- **Admin surface** — `backend/apps/admin/src/routes/challenge/page.tsx` (Stages + Week & Reset tabs) is where a "review & approve settlement" surface would live.

## Commands you will need

Read-only spike: `grep`/read commands only. If a local DB is available, `EXPLAIN` the closing-week ranking query shape to sanity-check cost (optional).

## Scope

**In scope** (deliverables — files to CREATE):

- `docs/superpowers/specs/2026-07-20-challenge-settlement-design.md` — the design doc (structure below)
- An updated open-questions section INSIDE that doc (not scattered)

**Out of scope**:

- Any production code, migration, or admin UI change.
- Deciding prod stage thresholds (operator config, runbook §1.2).
- The `REWARDS_REDEMPTION_ENABLED` redemption economy — a DIFFERENT system; the settlement engine must state its relationship (likely: independent of that flag) but not redesign it.

## Git workflow

- Branch: `advisor/056-settlement-spike`
- Commit: `docs(challenge): settlement engine design spike`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Read every seam above; confirm the decision record

**Verify**: the doc's "Sources" section lists each file read with one line on what it contributes.

### Step 2: Write the design doc

Required sections:

1. **Data model**: the immutable `challenge_week_snapshot` (proposed) — week window, closing pool value, per-rank rows (customer, pulled value, rank, unlocked stages at close), settlement status (`pending_review` → `approved` → `paid` / `void`). Decide: new table(s) in the packs module + migration sketch (DDL prose, not code).
2. **The close job**: trigger (scheduled job at reset in the settings timezone vs. lazy-on-first-read-after-rollover — recommend one, justify), the closing-week ranking query (reusing the anchor CTE with an explicit prior-week window), idempotency (a unique key on the week anchor so a re-run can't double-snapshot).
3. **Payout writer**: per-winner credit grants under the `credit:` lock, one transaction per winner (mature-commissions pattern), a NEW ledger `reason` (decide: reuse an existing reason vs. add `challenge_payout` — enumerate the enum-mirror surfaces that must update in lockstep: backend enum, DB CHECK, storefront `CREDIT_REASONS`, plan-005 parity spec), idempotency key shape (`week-anchor:customer:rank`), card prizes via the existing reward-Pull path (`source='reward'`), and the plan-044 cap interaction (grants must respect stage `reward_credits` already capped at write time).
4. **Admin review gate**: what the operator sees (closing standings vs. live board), approve/void actions, audit rows (reuse `admin_action_audit` patterns), and what "auto-pay without review" would need before it's safe (probably: never, initially).
5. **Storefront surface**: where last week's settled standings appear (the runbook's "vanishes from every surface" complaint), and the `challenge_stage`/settlement notification templates (registry entries per the toasts spec).
6. **Failure modes**: reset-time config edits (settings changed mid-close), ties at rank 10, a winner's account frozen at payout time (reuse the frozen-gate posture), settlement crash mid-payout (per-winner idempotency makes resume safe — show why), the `recorded_value_usd` NULL-fallback question from Current state.
7. **Column fate**: `payout_credits`/`payout_card_ids` — recommend drop-in-a-migration once the snapshot table lands (they are the retired flat model).
8. **Build plan sketch**: 3-5 executor-plan-sized chunks with effort tags (snapshot model+close job; payout writer+ledger reason; admin review; storefront history+notifications), each with its test strategy (module-tier specs for window math + idempotency; smoke-tier for ledger conservation across a settled week).
9. **Open questions for the operator**: the value-basis fallback, review-gate SLA (does an unapproved settlement block the next week? — recommend: no, snapshots queue), prize-card sourcing/stock (what if a featured card is out of stock at close), and whether week-1 launch uses the runbook's manual-settlement interim.

**Verify**: every section present; every claim carries a `file:line` citation from Step 1.

### Step 3: Sanity-check the ranking query cost (optional, DB up)

Draft the closing-week SQL (in the doc, as design prose/SQL sketch) and `EXPLAIN` it against a seeded DB; note whether `IDX_pull_rolled_at` covers it.

**Verify**: EXPLAIN summary in the doc, or "not run — no local DB" stated.

## Test plan

N/A (doc deliverable). The doc's own §8 defines the build's test strategy.

## Done criteria

- [ ] `docs/superpowers/specs/2026-07-20-challenge-settlement-design.md` exists with all 9 sections
- [ ] Zero production-code changes (`git status`: one new doc)
- [ ] Every design decision cites its code seam (spot-checkable)
- [ ] The open-questions list is answerable by the operator without reading code
- [ ] `plans/README.md` updated

## STOP conditions

- The decision record at `store/challenge/route.ts` no longer says stages-are-the-prize-pool (the model changed — re-confirm with the operator before designing).
- You find an EXISTING settlement implementation started somewhere (grep `settle` under modules/workflows first) — report and reconcile rather than designing a duplicate.
- The spike starts wanting to write code — that's the next plan's job; write the sketch instead.

## Maintenance notes

- After operator sign-off on the doc, its §8 chunks become plans 057+ (a future `/improve plan` or direct authoring).
- Plan 054's extraction gives the engine its home (`challenge-settlement.ts` beside `challenge.ts`); if 054 is skipped, the design still stands — only the file placement changes.
- The runbook §1.1 should flip from BLOCKING to "engine designed, build scheduled" once this doc merges — one-line runbook edit, note it in the report.
