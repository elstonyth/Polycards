# Plan 072: Price buyback off the fresh pull read — `revealed_at`, not just `instant_closed_at`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f14da91..HEAD -- backend/packages/api/src/workflows/steps/buyback-pull.ts backend/packages/api/src/modules/packs/buyback-rate.ts`
> On a mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW — the fresh value can only move the deadline _inside_ the already-enforced `rolled_at + revealGraceMs()` ceiling, so no client can extend its own window
- **Depends on**: none
- **Category**: bug (money — quote-vs-credit parity)
- **Planned at**: commit `0f14da91`, 2026-08-02

## Why this matters

The buyback step re-reads the pull "right before pricing" specifically so a
concurrent write from the reveal client can't be missed — but then uses the
fresh read for only **one** of the two fields the pricing helper consumes.
If the reveal ping (`POST /store/pulls/:id/reveal`) commits in the gap
between the step's first read and its fresh read, the stale `revealed_at:
null` collapses the instant-rate deadline to `rolled_at + 30s` — usually
already past — and the customer is credited the flat 90% for a sell the
reveal UI quoted at the pack's instant rate. Quote-vs-credit parity is this
path's stated invariant (see the comment block below). The race is narrow
(the ping normally lands long before any sell), so this is a latent
under-credit, not a routine one — but the fix is one line.

## Current state

`backend/packages/api/src/workflows/steps/buyback-pull.ts:104-118`:

```ts
// Re-read the closure stamp right before pricing. `pull` was read several
// awaits ago (frozen check + card + pack lookups); the reveal's async
// close-instant POST could have landed in that gap, and pricing the instant
// premium off the stale pre-close read would let a quick vault sell beat the
// close and claim 99% (CodeRabbit). The fresh read collapses that window to
// the sub-ms between here and the conditional status flip below.
const [fresh] = await packs.listPulls({ id: pull.id }, { take: 1 });
const { percent, rate_type } = resolveBuybackRate(pack, {
  rolled_at: pull.rolled_at,
  revealed_at: pull.revealed_at, // ← STALE (read at line 61)
  // Once the reveal has closed the window (left it / concluded), the credit
  // is the flat vault rate even inside the 30s — the credit must match what
  // the vault quoted.
  instant_closed_at: fresh?.instant_closed_at ?? pull.instant_closed_at, // ← fresh
});
```

`backend/packages/api/src/modules/packs/buyback-rate.ts:75-88` — how
`revealed_at` feeds the deadline:

```ts
export function instantDeadlineMs(rolledAt, revealedAt): number {
  const rolledMs = new Date(rolledAt).getTime();
  if (!Number.isFinite(rolledMs)) return NaN;
  const cap = rolledMs + revealGraceMs();
  if (revealedAt == null) return Math.min(rolledMs + instantWindowMs(), cap);
  ...
  return Math.min(revealedMs + instantWindowMs(), cap);
}
```

Every result is capped at `rolled_at + revealGraceMs()` (`:81,:87`) — that cap
is why using the fresher (later) `revealed_at` cannot be abused to extend the
window beyond the enforced ceiling.

Existing tests: `backend/packages/api/src/modules/packs/__tests__/buyback-rate.unit.spec.ts`
(pure-function coverage of `resolveBuybackRate`/`instantDeadlineMs`) and
`__tests__/close-instant.integration.spec.ts`.

## Commands you will need

| Purpose            | Command (from `backend/packages/api`)                                                        | Expected |
| ------------------ | -------------------------------------------------------------------------------------------- | -------- |
| Typecheck          | `corepack yarn check-types` (fallback `node ../../node_modules/typescript/bin/tsc --noEmit`) | exit 0   |
| Targeted unit spec | `corepack yarn test:unit --testPathPattern buyback-rate`                                     | pass     |
| Full unit tier     | `corepack yarn test:unit`                                                                    | all pass |

## Scope

**In scope**:

- `backend/packages/api/src/workflows/steps/buyback-pull.ts` (one line + comment)
- `backend/packages/api/src/modules/packs/__tests__/buyback-rate.unit.spec.ts` (add cases if the branch below is uncovered)

**Out of scope**:

- `buyback-rate.ts` itself — the math is correct.
- The close-instant route/step, `quote-buyback` path, or any rate constant.
- `rolled_at` sourcing (immutable after insert; the stale copy is safe there).

## Git workflow

- Branch: `advisor/072-buyback-fresh-revealed-at`
- Conventional commit, e.g. `fix(buyback): price off the fresh revealed_at, matching the fresh instant_closed_at`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Use the fresh read for `revealed_at`

In `buyback-pull.ts`, change the pricing input to:

```ts
revealed_at: fresh?.revealed_at ?? pull.revealed_at,
```

and extend the existing comment block with one sentence: both fields the
pricing helper reads come from the same fresh read; `rolled_at` stays from
the first read because it is immutable after insert.

**Verify**: typecheck exits 0;
`grep -n "revealed_at: fresh" backend/packages/api/src/workflows/steps/buyback-pull.ts` → 1 match.

### Step 2: Cover the deadline branch in the unit spec

In `buyback-rate.unit.spec.ts`, confirm (and add if missing) cases pinning:

1. `revealed_at = null` → deadline is `rolled_at + instantWindowMs()` (capped).
2. `revealed_at` set later than `rolled_at` → deadline anchors on
   `revealed_at + instantWindowMs()`, still capped at `rolled_at + revealGraceMs()`.
3. The pair of the two: with the same `nowMs` between the two deadlines,
   case 1 resolves flat and case 2 resolves instant — this is exactly the
   under-credit the stale read produced.

**Verify**: `corepack yarn test:unit --testPathPattern buyback-rate` → all
pass, including any new cases.

## Test plan

Step 2's unit cases are the regression net at the math layer. A true
step-level race test (stamping `revealed_at` between the step's two reads)
would need an interception seam the step doesn't have — deliberately not
built for a one-line fix; noted under Maintenance.

Final: `corepack yarn test:unit` → full tier green.

## Done criteria

- [ ] `grep -n "revealed_at: fresh" .../buyback-pull.ts` → 1 match
- [ ] Unit cases from Step 2 exist and pass
- [ ] Backend typecheck + full unit tier green
- [ ] No files outside scope modified; `plans/README.md` row updated

## STOP conditions

- The excerpt at `buyback-pull.ts:104-118` doesn't match (drift).
- `fresh` turns out to be used for additional fields already (someone fixed
  it) — mark the plan REJECTED (fixed independently) in the index.
- Any test outside the buyback specs fails after the change.

## Maintenance notes

- If a mutable field is ever added to Pull that feeds `resolveBuybackRate`,
  it must be sourced from `fresh` too — the pattern is now "all pricing
  inputs from the fresh read except immutable `rolled_at`".
- Reviewer: check no behavior change for the common path (reveal pinged long
  before sell — both reads agree; identical output).
- Deferred: an injectable read seam in the step to make the race directly
  testable — only worth it if this class recurs.
