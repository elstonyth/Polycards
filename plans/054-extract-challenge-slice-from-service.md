# Plan 054: Extract the Weekly-Challenge slice (and the one-shot backfills) out of service.ts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat b5944e26..HEAD -- backend/packages/api/src/modules/packs/service.ts`
> service.ts is the repo's highest-churn file — expect drift. Re-locate every
> symbol by NAME (grep), not line number, and STOP only if a listed method's
> body has materially changed.

> **Re-baselined 2026-08-15 (plan 106) against `5c74ce17`; supersedes the
> 5,096-line-era inventory below.** Line numbers, the symbol list, and the
> dependency status were re-measured; the extraction pattern, decorator
> constraint, caller list, and spec list were left untouched (only
> re-anchored). See the "Cross-slice dependency" and "Sequencing option"
> subsections added under Current state.

> **Drift-proofed 2026-08-18 (plan 111) against `16cc85d3`.** `service.ts`
> measured **9,302 lines** — a third drift in three days against the 8,852
> figure the 2026-08-15 re-baseline (plan 106) set (+450 lines since then).
> Plan 111 therefore replaced the absolute Line-count row in "Commands you
> will need" and the absolute line-count targets in Step 5's Verify and in
> Done criteria with criteria stated **relative to a baseline the executor of
> THIS plan records at the moment they start** (see those sections below) —
> so no future growth on `service.ts` can invalidate them, and a fourth
> re-baseline is not needed for that reason. The line-numbered symbol anchors
> in the inventory below remain stale by construction; the drift-check
> banner's "re-locate every symbol by NAME (grep), not line number"
> instruction above is the operative one, unchanged by this plan.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (the money-core file; mitigation: move-only, no behavior change, dense existing specs)
- **Depends on**: 044 and 047 first (both touch challenge validators/service edges; land them, then rebase) — **SATISFIED**: both merged, squashed into PR #247 (`plans/README.md:1139`)
- **Category**: tech-debt
- **Planned at**: commit `b5944e26`, 2026-07-20

## Why this matters

`service.ts` grew 4,425 → 5,096 lines (+671, +15%) in one round — 3.5× the largest prior round's growth — almost entirely from the Weekly-Challenge slice and three one-shot backfills landing inside the god object that five audit rounds have flagged as the repo's highest-blast-radius refactor target. The challenge slice is self-contained (own models `challenge-settings`/`challenge-stage`, own validators, cohesive read/write set) and is the natural FIRST extraction seam: moving it now (a) reverses this round's growth, (b) rehearses the facade-delegation pattern the eventual full refactor needs, and (c) hands plan 056's settlement engine a clean module to build beside instead of deepening the pile.

**Update (2026-08-15, plan 106):** this is the repo's only standing TODO surviving ten audit rounds, and the file kept growing without it: 5,096 → 8,852 lines (+3,756) since this plan was written, none of it from the challenge slice itself — payout/withdrawal hardening (+760, 51% of the delta), account deletion + disabled-player handling (+421, 28%), the free welcome pack (+156, 10%), and further weekly-challenge work (+132, 9%; scheduling, editable schedules, and the settlement engine plan 056 anticipated). The Weekly-Challenge block is now `:7149-8303` (~1,155 lines) and has grown 8 methods the original inventory below didn't list — see the re-anchored inventory. `Depends on: 044 and 047` above is now SATISFIED (both merged, squashed into PR #247) — the only remaining blocker to dispatching this plan is its own staleness, which this re-baseline fixes.

## Current state

- `backend/packages/api/src/modules/packs/service.ts` (**8,852 lines at `5c74ce17`** — re-measured 2026-08-15, plan 106; was 5,096 lines at `b5944e26`) — symbols to move, re-located by grep:
  - `:326` `PULLED_VALUE_USD_SQL` — **SHARED** (used by `leaderboardTop`'s wins CTE AND the challenge aggregates) — see Step 2 for where it goes.
  - `:429` `CHALLENGE_WEEK_ANCHOR_CTE`, `:448` `challengeWeekAnchorParams` — challenge-only.
  - `:7551` `challengeWeekPool`, `:7580` `challengeWeekTop` — the two week aggregates (raw SQL through the ORM's knex/em).
  - `:8214` `challengeSettings`, `:8233` `editChallengeSettings`, `:7153` `saveChallengeStages` — config read/writes with audit rows.
  - `:6023` `backfillExternalFundedBasis`, `:6061` `backfillExternalFundedBasisForCustomer`, `:8172` `backfillRecordedPullValues` — one-shot migration backfills, invoked only by `medusa exec` scripts under `src/scripts/` (verify each caller by grep before moving).
  - `:3094` `listSettledPayoutDestinations` (**new since plan-time**, length unverified — re-count at extraction time) — a fourth one-shot backfill; sole caller confirmed at `scripts/backfill-payout-destinations.ts:90`. Same treatment as the other three in Step 4.
  - `:7051` `saveVipLevels` — VIP, NOT challenge; LEAVE IT (its extraction couples to the vip-ladder slice — out of scope).
  - **8 methods new since plan-time, missing from the original inventory — all challenge-slice, all in scope for Step 3:** `:7281` `promoteDueChallengeSchedules`, `:7346` `promoteOneChallengeSchedule`, `:7402` `editChallengeSchedule`, `:7494` `challengeWinnerWeeks`, `:7623` `challengeWeekBounds`, `:7657` `settleChallengeWeek`, `:7856` `settleChallengeWinner` (`protected`), `:8120` `reserveSettledStock` (`private`). Together with the original 5 service methods (plus the 2 module-level symbols `challengeWeekAnchorParams`/`CHALLENGE_WEEK_ANCHOR_CTE`) these make up the Weekly-Challenge block, now `:7149-8303` (~1,155 lines, up from ~600). See "Cross-slice dependency" below before extracting `settleChallengeWinner`.
- The extraction pattern — TWO established shapes among the sibling helpers, and the challenge methods need the SECOND one:
  1. **Pure-function helpers** (`withdrawable.ts`, `credit-summary.ts`, `buyback-rate.ts`, `voucher-ranges.ts`): exports take plain data, no DB handle. NOT the shape for this slice — the challenge methods are DB-bound.
  2. **Service-as-argument helpers** (`pricing.ts` — read `resolveFxRate(source: FxRateSource)` and how `challengeWeekPool` already calls it): the helper takes the service (typed to a narrow interface) and/or a resolved `em`, and the DECORATED service method stays home, resolving what the helper needs and forwarding it. This is your exemplar.
- **Decorator reality (this is the load-bearing constraint)**: every method in scope carries `@InjectManager()` or `@InjectTransactionManager()` + `@MedusaContext()` (re-verified at `:6022, :6060, :7152, :7550, :7579, :8171, :8213, :8232`, plus the 8 newly-inventoried methods above — same pattern, verify by grep). Those decorators MUST remain on the service methods — they are what threads the transaction manager. The extracted functions in `challenge.ts` therefore take `(em, service, args)`-style parameters; the service method keeps its decorator + `@MedusaContext()` signature, resolves `em = sharedContext.transactionManager ?? sharedContext.manager`, and forwards. `challengeSettings`/`editChallengeSettings` also call `this.listChallengeSettings(...)`/`this.listCards(...)`, so the extracted functions need the service instance (narrow interface), not just `em`.
- The facade keeps its public method names + signatures, so ALL callers — routes, workflows, tests — stay untouched.
- Callers that must keep working unchanged (grep at plan time; re-verify): `api/store/challenge/route.ts`, `api/store/leaderboard/route.ts` (weekly period → `challengeWeekTop`), `api/admin/challenge/{stages,settings}/route.ts`, scripts calling the backfills, and the specs below. Re-measured 2026-08-15: the facade also now reaches `api/admin/challenge/schedule/route.ts`, `api/store/customers/me/delete/route.ts` (via the `deletedCustomerIds` coupling below), `jobs/settle-challenge-week.ts`, `scripts/settle-challenge-now.ts`, and `modules/packs/challenge-validate.ts` — still routes/jobs/scripts/validators only, no new god-object coupling.
- The specs that lock behavior (your safety net — they must pass before AND after): `modules/packs/__tests__/challenge*.spec.ts` + `challenge-validate.unit.spec.ts`, `recorded-pull-value.integration.spec.ts`, `wallet-summary.spec.ts`, `credit-external-funded.spec.ts`, the leaderboard HTTP suite, `store/challenge` HTTP suite. Run the modules+unit tiers to enumerate exactly.
- CONTEXT.md vocabulary: "Pull", "Open", "PackOdds" — keep names/comments consistent; the new module is about the **Weekly Pulled Value Challenge** (its proper noun).

### Cross-slice dependency (new since plan-time)

`settleChallengeWinner` (`:7856`) reads `this.deletedCustomerIds(ranking, sharedContext)` at `:7801` — a read-only predicate defined in the account-deletion region (`:4068`), also called from `:3578`. The comment at `:7797-7801` explains why:

> A deleted customer keeps their `pull` rows — the books are retained on purpose — so they stay ranked, and settlement would mint real balance and a real card to an account with no owner. Read once for the whole ranking, outside the per-winner transactions.

This wasn't in the original interface design. The narrow service interface the extracted `challenge.ts` functions take (per the decorator-forwarder shape above) must include `deletedCustomerIds` as a read-only dependency — it does not need to move with the slice (it stays with account-lifecycle, see below), just be reachable through the narrow interface passed in.

### Sequencing option — cheaper first extraction (new since plan-time)

Two smaller, newer slices are self-contained candidates that could go FIRST, at lower risk, and would settle where `deletedCustomerIds` should live before this plan extracts anything that calls it:

- **Account-lifecycle** (`:3921-4232`): `deleteAccountPreflight`, `deletedCustomerIds`, `purgeAccountPacksData`. No ledger-write coupling, owns its own route family (`api/store/customers/me/delete/route.ts`).
- **Free-pack** (`:2824-2940`): `markFreePackAvailable`, `claimFreePack`, `clearFreePackClaim`, `hasPaidOpen`, `getActiveFreePack`.

Extracting account-lifecycle first would rehearse the facade-delegation pattern on a smaller, lower-risk slice AND resolve where `deletedCustomerIds` should live (its own module, re-exported/imported by `challenge.ts`, vs. duplicated) before this plan's Step 3 has to make that call under pressure. This is presented as an option for whoever sequences the extraction work, not a mandate — plan 054 itself is scoped to the challenge slice only and does not require account-lifecycle to move first.

> **Promoted to a recommendation 2026-08-18 (plan 111).** After eleven audit
> rounds without the challenge slice being started, the evidence is about the
> size of the first bite, not about the team or the plan's correctness. Plan
> 111 promotes the account-lifecycle slice above from an option to the
> **recommended first extraction**: it rehearses the same facade-delegation
> pattern this plan needs, at lower risk, and it settles where
> `deletedCustomerIds` should live (see "Cross-slice dependency" above)
> before the challenge slice's `settleChallengeWinner` has to depend on it —
> that coupling did not exist when this sequencing option was first written
> and makes the challenge slice a harder first bite than it used to be. This
> is an ordering recommendation, not a replacement: plan 054 stays valid as
> written for the challenge slice, and the challenge extraction is **not
> cancelled** — only sequenced second. The account-lifecycle extraction does
> not yet exist as its own plan file (tracked in `plans/README.md`'s Round 12
> section as a follow-up to write).

## Commands you will need

| Purpose                            | Command                                                                                                            | Expected                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend deps (fresh worktree)      | `cd backend && corepack yarn install --immutable`                                                                  | exit 0                                                                                                                                                                     |
| Workspace dep build                | `cd backend/packages/odds-math && corepack yarn build`                                                             | exit 0                                                                                                                                                                     |
| Typecheck                          | `cd backend/packages/api && corepack yarn check-types`                                                             | exit 0                                                                                                                                                                     |
| Unit tier                          | `corepack yarn test:unit`                                                                                          | all pass                                                                                                                                                                   |
| Modules tier (DB up)               | `corepack yarn test:integration:modules`                                                                           | all pass                                                                                                                                                                   |
| Money smoke (DB up)                | `corepack yarn test:integration:smoke`                                                                             | all pass                                                                                                                                                                   |
| Challenge/leaderboard HTTP (DB up) | `corepack yarn test:integration:http -- "challenge\|leaderboard"`                                                  | all pass                                                                                                                                                                   |
| Baseline (record at start)         | `wc -l backend/packages/api/src/modules/packs/service.ts`, run before any edit                                     | a number; write it into the PR description — that number, not a number from this plan, is the comparison point                                                             |
| Slice gone from `service.ts`       | `grep -c "<symbolName>" backend/packages/api/src/modules/packs/service.ts` for every symbol in the inventory above | `0`, or the count of a thin decorated forwarder only — say which symbols kept one and why                                                                                  |
| Slice present in `challenge.ts`    | `grep -c "<symbolName>" backend/packages/api/src/modules/packs/challenge.ts`; `wc -l` on the new module            | every symbol found; line count within a reasonable margin of the block removed from `service.ts`                                                                           |
| Net deletion on `service.ts`       | `git diff --stat` on `service.ts`, this change only                                                                | net deletion ≥ N lines, where N = lines actually removed by the extraction — NOT an absolute `wc -l` floor (concurrent work on master can add lines during the extraction) |

## Scope

**In scope**:

- `backend/packages/api/src/modules/packs/service.ts` (deletions + thin decorated forwarders only)
- NEW `backend/packages/api/src/modules/packs/challenge.ts` (the slice)
- NEW `backend/packages/api/src/modules/packs/pulled-value.ts` (the shared SQL constant — see Step 2) — or an existing shared home if one fits better (e.g. `pricing.ts` if that's where its FX/fallback inputs live; executor judgment, state the choice)
- NEW `backend/packages/api/src/modules/packs/backfills.ts` (the four one-shots — re-baselined 2026-08-15, plan 106: `listSettledPayoutDestinations` joins the original three)

**Out of scope**:

- ANY behavior change — this is a move-only refactor. SQL strings byte-identical.
- `saveVipLevels` and the VIP slice; `leaderboardTop` itself; validators (`challenge-validate.ts`) — they already live outside.
- Route files, scripts, specs — they keep calling the service facade; only if a spec imports a moved PRIVATE symbol directly may that import be updated (record it).
- Renaming public service methods.

## Git workflow

- Branch: `advisor/054-extract-challenge-slice`
- Commits per step (move slice → move backfills → wire+verify), `refactor(packs): ...` style.
- Do NOT push/PR unless instructed.
- NOTE (this machine): global formatter hook may churn backend quote style — check `git diff` after each edit; whole-file churn on a 5k-line file is unacceptable — use a node script for service.ts edits if the hook fires.

## Steps

### Step 1: Baseline

Run unit + modules tiers (+ smoke) green; record counts and `wc -l service.ts`.

**Verify**: all green; numbers recorded.

### Step 2: Move the shared pulled-value SQL

Create `pulled-value.ts` exporting `PULLED_VALUE_USD_SQL` (and its companion constants/comment block, byte-identical). service.ts imports it; both `leaderboardTop` and the challenge code consume the import.

**Verify**: `corepack yarn check-types` → 0; grep shows ONE definition site.

### Step 3: Extract the challenge slice

Create `challenge.ts` housing `challengeWeekAnchorParams` + `CHALLENGE_WEEK_ANCHOR_CTE`, and the BODIES of the full challenge slice as exported functions taking explicit dependencies — `(em, service, args)` or narrower, per method. Exemplar: `pricing.ts`'s `resolveFxRate(source: FxRateSource)` (service-as-narrow-interface argument), which `challengeWeekPool` already consumes.

**Method list re-baselined 2026-08-15 (plan 106) — 13 service methods, not the original 5** (plus `challengeWeekAnchorParams`/`CHALLENGE_WEEK_ANCHOR_CTE`, module-level, not service methods). Original five: `challengeWeekPool`, `challengeWeekTop`, `challengeSettings`, `editChallengeSettings`, `saveChallengeStages`. Plus the 8 added since plan-time (see Current state inventory): `promoteDueChallengeSchedules`, `promoteOneChallengeSchedule`, `editChallengeSchedule`, `challengeWinnerWeeks`, `challengeWeekBounds`, `settleChallengeWeek`, `settleChallengeWinner`, `reserveSettledStock`. `settleChallengeWinner`'s narrow service interface must also carry `deletedCustomerIds` (read-only) — see "Cross-slice dependency" above; that method itself stays where it lives (account-lifecycle region) unless the "Sequencing option" is taken.

The service methods stay home as THIN DECORATED FORWARDERS — this is deliberate and is NOT a "one-line delegation" in the literal sense: each keeps its `@InjectManager()`/`@InjectTransactionManager()` decorator and `@MedusaContext()` parameter (stripping them breaks transaction threading — see the plan-021 `mature-commissions` precedent), resolves `em = sharedContext.transactionManager ?? sharedContext.manager` exactly as the current body does, and calls the extracted function with `(em, this, args)`. A correct forwarder is therefore ~3-5 lines: decorator, signature, em-resolve, return-call. Move the methods' doc comments to `challenge.ts` with the bodies. Two of the 8 new methods are not on the public facade — `settleChallengeWinner` is `protected`, `reserveSettledStock` is `private` — they still move, but re-verify their callers are all inside service.ts or the new sibling module, not external.

**Verify**: `check-types` → 0; unit + modules tiers green; challenge/leaderboard HTTP green.

### Step 4: Extract the backfills

Same treatment into `backfills.ts` for the **four** `backfill*`/one-shot methods: the original three plus `listSettledPayoutDestinations` (`:3094`, re-baselined 2026-08-15, plan 106 — sole caller `scripts/backfill-payout-destinations.ts:90`). Grep each script under `src/scripts/` that invokes them — they call service methods, which remain as delegations, so scripts stay untouched.

**Verify**: `check-types` → 0; `node --check` passes on any script if edited (should be none); modules tier green.

### Step 5: Final gates

**Verify**: full unit + modules + smoke green with counts equal to Step 1; `git diff --stat service.ts` (this change only, per plan 111's relative criteria — see "Commands you will need") shows a net deletion of at least the number of lines actually moved into `challenge.ts`/`backfills.ts`, not an absolute `wc -l` floor; `git diff service.ts` contains ONLY deletions, imports, and thin decorated forwarders (decorator + signature + em-resolve + call — no logic edits beyond that shape).

## Test plan

No new tests — the move is locked by the existing dense suites (Step 1 baseline = Step 5 counts). If any spec imports a moved private symbol, update the import and list it in the report.

## Done criteria

- [ ] `service.ts` shrank by at least the size of what moved (plan 111, 2026-08-18: relative criterion, replaces the old absolute-line-count target) — `git diff --stat` on `service.ts` for this change only shows a net deletion ≥ N lines, where N is the baseline recorded at Step 1 (before any edit) minus the count after; concurrent work on master can add lines during the extraction, so this is about the delta this change makes, not an absolute `wc -l` floor. Challenge/backfill logic lives in the new siblings.
- [ ] All eleven public method names unchanged on the service (re-baselined 2026-08-15, plan 106 — the original 5 plus 6 added since plan-time: `promoteDueChallengeSchedules`, `promoteOneChallengeSchedule`, `editChallengeSchedule`, `challengeWinnerWeeks`, `challengeWeekBounds`, `settleChallengeWeek`; `settleChallengeWinner` stays `protected` and `reserveSettledStock` stays `private` — not on the facade) (grep from route files resolves)
- [ ] Unit + modules + smoke + challenge/leaderboard HTTP all green, same counts as baseline
- [ ] SQL strings byte-identical (diff the moved constants against baseline)
- [ ] No files outside scope modified except recorded spec-import updates (`git status`)
- [ ] `plans/README.md` updated

## STOP conditions

- A "challenge" method turns out to share private state with non-challenge service internals beyond em/repos (coupling the move can't cleanly cut) — report the actual dependency graph.
- Any tier's pass count differs from baseline for reasons other than a moved import.
- A method's dependencies exceed `em` + the narrow service interface (private state the forwarder can't cleanly pass) — report the actual dependency graph. NEVER strip an `@InjectManager`/`@InjectTransactionManager`/`@MedusaContext` decorator to force purity — the decorated-forwarder shape in Step 3 is the required pattern, not a contingency.
- Plans 044/047 not yet merged (dependency order) — rebase first.

## Maintenance notes

- Plan 056's settlement engine should live beside `challenge.ts` (e.g. `challenge-settlement.ts`), NOT in service.ts — this extraction is what makes that natural.
- The backfills in `backfills.ts` are one-shots; once confirmed run in prod (see the vip-external-basis operational note), they're candidates for deletion in a later cleanup.
- Reviewer: the whole review is "is this move-only?" — any hunk that isn't a deletion, an import, or a thin decorated forwarder (decorator + signature + em-resolve + call) is a red flag. The forwarders keeping their decorators is CORRECT, not scope creep.
