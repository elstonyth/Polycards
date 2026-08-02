# Plan 059: Recover the executed-but-never-merged round-6 fixes into master

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a993f34a..HEAD -- backend/packages/api/src/modules/packs/models/notification-read.ts backend/packages/api/src/workflows/steps/update-card.ts backend/packages/api/src/modules/packs/notify-feed.ts .github/workflows/ tests/e2e/ "src/app/(account)/notifications/"`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (run FIRST — plans 060–068 assume this landed or was explicitly skipped)
- **Category**: bug / tests / dx (recovery)
- **Planned at**: commit `a993f34a`, 2026-08-01

## Why this matters

On 2026-07-21, seven advisor plans (045, 046, 048, 049, 051, 052 — plus doc
plan 050) were executed in worktrees, code-reviewed, and marked DONE in
`plans/README.md`. **Their branches were never merged to master.** The
worktree branch refs are gone, but the commits still exist in this clone's
object database (verified: `git show` resolves every SHA below). Two of the
lost fixes (the notification unread-count index, the update-card rollback)
and one lost test enablement (the dark `pw-test-card` e2e specs) were
independently re-found as live defects by the 2026-08-01 round-8 audit —
proof the loss is real, not theoretical. This plan re-lands the code content;
plan 068 re-does the doc content fresh (former plan 050), so docs are OUT of
scope here.

## Current state

Orphan commits to recover (all resolvable via `git show <sha>`):

| Round-6 plan | Commit(s), in order                            | Subject                                                                                           | Files touched                                                                                                                                                                                                                                                    |
| ------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 045          | `4ef61aa1`                                     | perf(notifications): index the unread-count path                                                  | `backend/packages/api/src/modules/packs/migrations/Migration20260720150000.ts` (new), `models/notification-read.ts`                                                                                                                                              |
| 046          | `20265acf`, `7589302f`                         | fix(cards): roll back card mutation when the product mirror fails (+ unchanged-key re-bake guard) | `backend/packages/api/src/workflows/steps/update-card.ts`, `steps/__tests__/update-card.unit.spec.ts`                                                                                                                                                            |
| 048          | `625ec383`, `8812eec3`                         | test(e2e): seed pw-test-card + enable rewards flag                                                | `.github/workflows/e2e.yml`, `backend/packages/api/src/scripts/seed-e2e-fixtures.ts`, `tests/e2e/card-management.spec.ts`, `tests/e2e/rewards.spec.ts`                                                                                                           |
| 049          | `4092ca3d`                                     | ci(backend): exclude unit specs from the modules tier; turbo cache for http shards                | `.github/workflows/ci.yml`, `backend/packages/api/jest.config.js`                                                                                                                                                                                                |
| 051          | `4140ac51`, `f6427fb5`, `42a060f1`, `fa5a3e7a` | fix(notifications): true unread total on Mark-all-read; halt SFX on unmount                       | `src/app/(account)/notifications/NotificationsClient.tsx`, `page.tsx`, `src/lib/notifications/unread-total.ts` (new), `__tests__/unread-total.test.ts` (new), `src/lib/use-sound.ts`                                                                             |
| 052          | `3eac438a`, `3f0a8f4f`                         | refactor(notifications): notifyFeedNonfatal wrapper                                               | `backend/packages/api/src/modules/packs/notify-feed.ts`, 7 producer sites incl. `api/store/credits/topup/route.ts`, `api/store/daily/draw/route.ts`, `api/store/rewards/claim/[grantId]/route.ts`, `jobs/mature-commissions.ts`, `workflows/steps/settle-vip.ts` |

Evidence the content is absent from master today (verify each before starting):

- 045: `backend/packages/api/src/modules/packs/models/notification-read.ts:15`
  has ONLY the composite unique `on: ['notification_id', 'customer_id']` —
  no `customer_id` index. `ls backend/packages/api/src/modules/packs/migrations | grep 20260720150000` → no match.
  The COUNT it serves is live: `api/store/notifications/route.ts:60-66`
  (`listAndCountNotificationReads({ customer_id, read_at: {$ne: null} })`).
- 046: `grep -n "catch" backend/packages/api/src/workflows/steps/update-card.ts` → no matches (no rollback).
- 048: `grep -n "pw-test-card" .github/workflows/e2e.yml backend/packages/api/src/scripts/seed-e2e-fixtures.ts` → no matches; `tests/e2e/card-management.spec.ts:49-52` still `test.skip(...)` on the missing product.
- 049: `grep -c "Cache turbo" .github/workflows/ci.yml` → `3` (the http-shard job lacks its step).
- 051: `grep -rn "serverTotal\|unread-total" src` → no matches; the client
  (`src/app/(account)/notifications/NotificationsClient.tsx:120-122`) carries a
  comment claiming `unread_count` is "page-scoped over the same 50 rows", which
  contradicts the backend contract at
  `backend/packages/api/src/api/store/notifications/route.ts:23-26`
  ("TRUE unread total across ALL the customer's feed notifications (not page-scoped)").
- 052: `grep -rn "notifyFeedNonfatal" backend/packages/api/src` → no matches.

Why the merge never happened: this repo squash-merges PRs, so content lands
under new SHAs — round-6 plans 044/047 (PR #247), 053 (in `auth.test.ts`,
verified by the `decoy@leak.example` fixtures), and the a11y/CSP gate work
(PR #251) DID land that way. The seven above did not get a PR.

Files have drifted since 2026-07-21 (the delta rewrote parts of the e2e specs,
jest config, ci.yml surroundings, notifications client). **Cherry-pick, expect
conflicts, and resolve by intent** — the per-plan intent is one line each in
the table above; the original plan files `plans/045-…` through
`plans/052-…` (same directory) carry full context if a conflict is ambiguous.

## Commands you will need

| Purpose                                                                   | Command                                                                                                                                                                                               | Expected on success |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Storefront typecheck+lint+build                                           | `npm run check` (repo root)                                                                                                                                                                           | exit 0              |
| Storefront unit tests                                                     | `npm test` (repo root)                                                                                                                                                                                | all pass            |
| Backend typecheck                                                         | `cd backend && corepack yarn check-types`                                                                                                                                                             | exit 0              |
| Backend unit tier                                                         | `cd backend/packages/api && corepack yarn test:unit`                                                                                                                                                  | all pass            |
| Backend modules tier (needs `pokenic-postgres`/`pokenic-redis` docker up) | `cd backend/packages/api && corepack yarn test:integration:modules`                                                                                                                                   | all pass            |
| Workflow YAML sanity                                                      | `node -e "const y=require('js-yaml');y.load(require('fs').readFileSync('.github/workflows/ci.yml','utf8'));y.load(require('fs').readFileSync('.github/workflows/e2e.yml','utf8'));console.log('ok')"` | prints `ok`         |

## Scope

**In scope** (only files listed in the commit table above, plus):

- `plans/README.md` (status rows)

**Out of scope**:

- Plan 050's doc content (`CHANGELOG.md`, `docs/ops/*`, `slot-machine-redesign.md`)
  — plan 068 re-does docs fresh against the current tree; recovering the stale
  2026-07-21 doc text would reintroduce statements #296 and later made false.
- Any new feature work in the touched files. This plan ONLY re-lands the six
  recovered changes.
- `backend/packages/api/src/api/admin/*` (plans 060/061 own those).

## Git workflow

- Branch: `advisor/059-recover-round6` from current master.
- One commit per recovered plan (six commits), message style: keep each orphan
  commit's original conventional-commit subject, append `(recovered, plan 059)`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Recover 045 (unread-count index)

`git cherry-pick 4ef61aa1`. Conflicts unlikely (model + new migration).
After it applies, confirm the migration filename doesn't collide:
`ls backend/packages/api/src/modules/packs/migrations | grep 20260720` must
show both `Migration20260720140000.ts` (pre-existing) and
`Migration20260720150000.ts` (recovered). If the recovered migration's
timestamp now sorts BEFORE migrations the delta added (it will — 2026-07-28
migrations exist), that is fine for MikroORM (each migration is tracked by
name, not order) — but verify the index DDL uses `IF NOT EXISTS`.

**Verify**: `cd backend && corepack yarn check-types` → exit 0.
`grep -n "customer_id" backend/packages/api/src/modules/packs/models/notification-read.ts`
→ shows a standalone index on `customer_id` in addition to the composite.

### Step 2: Recover 046 (update-card rollback)

`git cherry-pick 20265acf` then `git cherry-pick 7589302f`. The delta touched
workflow steps; on conflict, the intent is: wrap the Product-mirror write in
try/catch, restore all 19 forward-written Card fields on failure, reclaim the
new slab key at both return sites, and guard the rollback slab delete with an
equality check so an unchanged-key re-bake never deletes the card's only slab.

**Verify**: `cd backend/packages/api && corepack yarn test:unit -- update-card`
→ the recovered `update-card.unit.spec.ts` passes (10 cases; 5 failure-path).

### Step 3: Recover 048 (dark e2e specs)

`git cherry-pick 625ec383` then `git cherry-pick 8812eec3`. `e2e.yml` and both
spec files drifted in the delta — resolve toward: (a) the seed step also
provisions `pw-test-card` (via `seed-e2e-fixtures.ts` or an added
`create-test-product.ts` exec line), (b) `REWARDS_REDEMPTION_ENABLED` is set in
the nightly backend env, (c) the `test.skip` guard in
`card-management.spec.ts` becomes a hard failure ("skip-is-an-alarm").
CAUTION: `tests/e2e/rewards.spec.ts` is now a documented `describe.skip`
against surfaces PR #294 suspended (`rewards.spec.ts:25`). If the cherry-pick
un-skips specs that drive suspended UI, KEEP the current `describe.skip` for
the storefront-claim half and recover only what still has a live surface —
record exactly what you kept skipped in the commit body.

**Verify**: `npx playwright test --list --config playwright.config.ts` → exits 0,
lists the card-management specs without errors. YAML sanity command → `ok`.

### Step 4: Recover 049 (CI dedupe + http-shard cache)

`git cherry-pick 4092ca3d`.

**Verify**: `grep -c "Cache turbo" .github/workflows/ci.yml` → `4`.
`cd backend/packages/api && corepack yarn test:unit` → passes (unit tier
unaffected). If docker DB available: `corepack yarn test:integration:modules`
→ passes and the suite list no longer includes `*.unit.spec.ts` files.

### Step 5: Recover 051 (true unread total + SFX halt)

`git cherry-pick 4140ac51 f6427fb5 42a060f1 fa5a3e7a` one at a time. The
client file was edited by the delta; on conflict the intent is: lift the
server's TRUE `unread_count` (backend contract:
`api/store/notifications/route.ts:23-26`) into client state (`serverTotal`),
zero it when Mark-all-read succeeds, and label the button from it — and delete
the now-false "page-scoped over the same 50 rows" comment at
`NotificationsClient.tsx:120-122`. For `use-sound.ts`: the delta rewrote it
(ramped loop bed with cleanup at `use-sound.ts:171`); if the pool-effect
cleanup the 051 commits add already exists in the current file, skip that hunk
(`git cherry-pick --skip` if the whole commit is redundant) and note it.

**Verify**: `npm test` → passes incl. `unread-total.test.ts`; `npm run check` → exit 0.

### Step 6: Recover 052 (notifyFeedNonfatal)

`git cherry-pick 3eac438a` then `3f0a8f4f`. Producer sites drifted (#290 moved
the feed channel; #294 suspended storefront reward surfaces but the backend
routes remain live). On conflict, the intent is: every best-effort
`notifyFeed(...)` call outside the notifications module goes through
`notifyFeedNonfatal(...)` (in `modules/packs/notify-feed.ts`), which catches,
logs with the idempotency key, and never throws into a money path. NOTE: if
`settleChallengeWinner`'s `onSettled` notify path
(`backend/packages/api/src/jobs/settle-challenge-week.ts`) hand-rolls the same
try/catch, converting it is IN scope for this step (same class), but do not
change its transaction placement.

**Verify**:
`grep -rn "notifyFeed(" backend/packages/api/src --include=*.ts | grep -v notify-feed.ts | grep -v __tests__ | grep -v spec` →
only `notifyFeedNonfatal` call sites remain (no bare `notifyFeed(` producers).
`cd backend/packages/api && corepack yarn test:unit` → passes.

### Step 7: Full gates + index update

Run all commands in the table. Update `plans/README.md`: flip 045, 046, 048,
049, 051, 052 round-6 rows from their current DONE text to
`DONE (recovered to master via plan 059, <date>)`.

## Test plan

No new tests are authored here — the recovered commits carry their own
(update-card.unit.spec.ts 10 cases, unread-total.test.ts, the e2e guard
conversions). The test plan IS the per-step verify commands plus the full
gates in step 7.

## Done criteria

- [ ] All six recovery commits present on the branch; `git log --oneline` shows 6 commits each naming its round-6 plan
- [ ] `npm run check` and `npm test` exit 0 (repo root)
- [ ] `cd backend && corepack yarn check-types` exit 0; `cd backend/packages/api && corepack yarn test:unit` all pass
- [ ] `grep -rn "notifyFeedNonfatal" backend/packages/api/src | head -1` returns a match
- [ ] `grep -c "Cache turbo" .github/workflows/ci.yml` → 4
- [ ] `grep -n "pw-test-card" backend/packages/api/src/scripts/seed-e2e-fixtures.ts .github/workflows/e2e.yml` returns at least one match
- [ ] `plans/README.md` rows updated
- [ ] No files outside the in-scope list modified (`git status`)

## STOP conditions

Stop and report back (do not improvise) if:

- Any orphan SHA fails to resolve (`git show <sha>` errors) — the object may
  have been pruned since planning; report which, and whether `git fsck --lost-found` surfaces it.
- A cherry-pick conflict cannot be resolved from the one-line intent plus the
  original plan file — do NOT guess at money-path semantics (steps 2 and 6
  touch them).
- Step 3's e2e recovery would re-enable a spec whose UI surface no longer
  exists at all (not just suspended) — report which spec.
- More than 2 verification failures on any single step.

## Maintenance notes

- Root cause to fix operationally: round-6 execution ended without an
  integration PR (rounds 2/4 used an `advisor/roundN-execution` rollup branch
  - PR). Recommend the operator adopt that as a standing rule; recorded in
    the round-8 README notes.
- Reviewer scrutiny: step 2 (money-adjacent rollback semantics) and step 6
  (notify wrapper must never move a notify INTO a transaction).
- Deferred: plan 050's doc recovery (superseded by plan 068); 055/056
  need no recovery (superseded — see round-8 README).
