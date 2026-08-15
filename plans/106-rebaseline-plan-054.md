# Plan 106: Re-baseline plan 054 against the 8,852-line service.ts (and record the new extraction seams)

> **Executor instructions**: This plan edits ANOTHER PLAN FILE plus the plans
> index — no source code. Follow it step by step; run every verification. On
> any STOP condition, stop and report. When done, update the status row for
> this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git log --oneline 5c74ce17..HEAD -- backend/packages/api/src/modules/packs/service.ts plans/054-extract-challenge-slice-from-service.md`
> New commits touching either → re-run the Step 1 measurements yourself before
> editing; the numbers below are as of `5c74ce17`.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW (doc-only)
- **Depends on**: none
- **Category**: tech-debt (planning hygiene)
- **Planned at**: commit `5c74ce17`, 2026-08-15

## Why this matters

Plan 054 ("Extract the Weekly-Challenge slice out of service.ts") is the
repo's only standing TODO from ten audit rounds — and it has drifted badly.
It was written against a 5,096-line file with a ~600-line slice; `service.ts`
is now **8,852 lines** and the challenge block is **~1,155 lines**
(`:7149-8303`), with **8 methods plan 054's inventory does not list**. Worse,
the delta added a cross-slice coupling (`settleChallengeWeek` now calls
`this.deletedCustomerIds(...)` — an account-deletion-slice method) that plan
054's extraction interface doesn't carry. An executor dispatched on 054 today
would hit its own drift-check STOP immediately — or extract half the slice.
Meanwhile two NEWER, cleaner seams exist (account-lifecycle, free-pack) that
the plan should name so the god-object work starts at the cheapest point.

Round-11 measurements (verify in Step 1, then write into 054):

- Growth attribution 7,357 → 8,852 (+1,495 net; 105 → 122 methods): payout/
  withdrawal hardening +760 (51%), account deletion + disabled-player +421
  (28%), free welcome pack +156 (10%), weekly challenge +132 (9%).
- Challenge block `:7149-8303`; methods MISSING from 054's inventory:
  `promoteDueChallengeSchedules` (`:7281`), `promoteOneChallengeSchedule`
  (`:7346`), `editChallengeSchedule` (`:7402`), `challengeWinnerWeeks`
  (`:7494`), `challengeWeekBounds` (`:7623`), `settleChallengeWeek` (`:7657`),
  `settleChallengeWinner` (`:7856`), `reserveSettledStock` (`:8120`).
- New outbound dependency: `service.ts:7801` — settlement reads
  `this.deletedCustomerIds(ranking, sharedContext)` (lives in the
  account-deletion region `:4068`), with a correct comment about deleted
  customers staying ranked while settlement must skip them. The same predicate
  is also used at `:3578` (open-settlement path).
- Inbound seam still clean: all challenge methods reached only via the facade
  (`api/store/challenge`, `api/store/leaderboard`, `api/admin/challenge/*`,
  `jobs/settle-challenge-week.ts`, scripts).
- Fourth one-shot backfill accreted: `listSettledPayoutDestinations`
  (`:3094`, 61 lines, sole caller `scripts/backfill-payout-destinations.ts:90`).
- New self-contained slices (both landed whole in single commits, own routes,
  no reach-arounds): account-lifecycle `:3921-4232` (`deleteAccountPreflight`,
  `deletedCustomerIds`, `purgeAccountPacksData`) and free-pack `:2824-2940`
  (`markFreePackAvailable`, `claimFreePack`, `clearFreePackClaim`,
  `hasPaidOpen`, `getActiveFreePack`).

## Current state

- `plans/054-extract-challenge-slice-from-service.md` — the target. Key
  sections to touch: "Why this matters" (`:24-26`, cites 5,096 lines), the
  "Current state" symbol inventory (`:28-44`), Scope (`:59-73`), Steps. Its
  load-bearing content that must SURVIVE verbatim: the decorator constraint
  (`:40` — `@InjectManager`/`@InjectTransactionManager` + `@MedusaContext`
  stay on service methods; extracted functions take `(em, service, args)`),
  the two extraction shapes (`:37-39`), the caller list (`:42`), the spec
  safety-net list (`:43`), and the `PULLED_VALUE_USD_SQL` shared-constant
  handling (Step 2 there).
- `plans/README.md` — round-6 table row for 054 (status TODO) and the round-8
  reconciliation note that already re-flagged its growth.

## Commands you will need

| Purpose              | Command (from)                                                                                                                                                    | Expected                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Line count           | `wc -l backend/packages/api/src/modules/packs/service.ts`                                                                                                         | 8852 (at plan time)                                  |
| Challenge-block span | `grep -n "challengeWeekAnchorParams\|reserveSettledStock\|settleChallengeWinner\|promoteDueChallengeSchedules" backend/packages/api/src/modules/packs/service.ts` | line numbers to re-anchor the inventory              |
| Coupling check       | `grep -n "deletedCustomerIds" backend/packages/api/src/modules/packs/service.ts`                                                                                  | definition + the two call sites (`~:3578`, `~:7801`) |
| Facade check         | `grep -rn "settleChallengeWeek\|challengeWeekTop" backend/packages/api/src --include=*.ts -l`                                                                     | routes/jobs/service only                             |

## Scope

**In scope**:

- `plans/054-extract-challenge-slice-from-service.md`
- `plans/README.md` (054's row note + this plan's row)

**Out of scope**:

- ANY source file. This plan changes zero code.
- Executing the extraction itself (054 remains the extraction plan).

## Git workflow

- Branch: `advisor/106-rebaseline-054` (or commit directly with the round-11
  batch if the operator prefers plans-only commits together).
- One commit: `docs(plans): re-baseline 054 against the 8.8k-line service.ts`.

## Steps

### Step 1: re-measure

Run the four commands above; also
`git log --format='%h %s' --follow -20 -- backend/packages/api/src/modules/packs/service.ts`
for the attribution table. Where your numbers differ from this plan's, YOURS
win (the file moves weekly).

**Verify**: you hold current line numbers for every symbol in the inventory
below.

### Step 2: rewrite plan 054's drifted sections

In `plans/054-extract-challenge-slice-from-service.md`:

1. Add a dated banner under the executor block: "Re-baselined 2026-08-15
   (plan 106) against `5c74ce17`; supersedes the 5,096-line-era inventory."
2. "Why this matters": update the numbers (8,852 lines; challenge slice
   ~1,155; the dependency-plan note "Depends on: 044 and 047" is SATISFIED —
   both merged via PR #247; state that).
3. Symbol inventory: add the 8 missing methods with current line anchors;
   keep the existing entries re-anchored; keep `saveVipLevels` LEAVE-IT note.
4. NEW subsection "Cross-slice dependency (added by #400/#434 era)": the
   extracted challenge module's narrow service interface must include
   `deletedCustomerIds` (read-only predicate); quote the `:7795-7801` comment
   about deleted customers staying ranked.
5. NEW subsection "Sequencing option — cheaper first extraction": the
   account-lifecycle slice (`:3921-4232`) is newer, has no ledger-write
   coupling, owns its route family, and can rehearse the facade pattern at
   lower risk; extracting it first ALSO removes the `deletedCustomerIds`
   placement question (it moves to the lifecycle module, which the challenge
   module then imports). Present as an option for the operator, not a
   mandate.
6. Backfill list: add `listSettledPayoutDestinations` (`:3094`) to the
   one-shot-backfill relocation set.
7. Do NOT touch the decorator constraint, extraction shapes, caller list,
   spec list, or `PULLED_VALUE_USD_SQL` step except to re-anchor line numbers.

**Verify**: `grep -n "Re-baselined 2026-08-15" plans/054-*.md` → 1;
`grep -c "promoteDueChallengeSchedules\|reserveSettledStock" plans/054-*.md`
→ ≥2.

### Step 3: index update

`plans/README.md`: annotate 054's round-6 row status cell with
"(re-baselined by 106, 2026-08-15 — inventory current, deps satisfied)". Update
this plan's row to DONE.

**Verify**: grep both strings in the README.

## Test plan

Doc-only; the greps are the gates. No code, no suites.

## Done criteria

- [ ] Plan 054 carries the banner, current numbers, the 8 added symbols, the
      `deletedCustomerIds` interface note, and the sequencing option
- [ ] Its load-bearing sections (decorators, shapes, callers, specs) survive
- [ ] README rows updated (054 annotation + 106 DONE)
- [ ] `git diff` touches only the two plan files

## STOP conditions

- Plan 054's file has been executed or partially executed since `5c74ce17`
  (its README status changed from TODO) — reconcile with what actually
  happened instead of re-baselining a done plan.
- Your Step 1 measurements diverge so far from this plan's (e.g. the challenge
  block was ALREADY extracted) that the rewrite would be fiction — report the
  real state.

## Maintenance notes

- Every future audit round should re-run Step 1's four commands before
  trusting 054 — the file grows ~1–2k lines per round while it waits. If a
  third re-baseline is ever needed, that is the signal to just SCHEDULE the
  extraction instead of re-describing it.
