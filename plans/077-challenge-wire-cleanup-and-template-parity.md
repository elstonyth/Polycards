# Plan 077: Drop the dead challenge wire fields; lock the notification-template seam with a parity test

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f14da91..HEAD -- backend/packages/api/src/api/store/challenge/route.ts backend/packages/api/integration-tests/http/challenge.spec.ts backend/packages/api/src/modules/packs/notify-feed.ts src/lib/notifications/copy.ts "src/lib/notifications/__tests__/copy.test.ts"`
> On a mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW-MED — removes two fields from a public (publishable-key) route; no in-repo consumer exists, rollback is trivial
- **Depends on**: none
- **Category**: tech-debt / tests
- **Planned at**: commit `0f14da91`, 2026-08-02

## Why this matters

Two cross-seam contract hazards:

1. `/store/challenge` still emits `rewardCardIds`/`rewardCredits` under a
   comment claiming "the shipped storefront reads these until the per-rank UI
   lands" — that UI landed; **zero** storefront reads remain. Worse,
   `rewardCredits` is a `Math.max`, not a sum — anyone who trusts the comment
   and re-adopts the field gets a wrong number on a money surface.
2. The seven-template notification list exists in three hand-maintained
   copies (backend `FeedTemplate` union → storefront `NOTIFICATION_COPY` →
   the test's local `TEMPLATES` array). The test locks copies 2↔3 to each
   other but never reaches copy 1: a template added to the backend ships
   green while the storefront feed falls through to unknown-key handling on
   a surface announcing money events (`topup_credited`,
   `commission_matured`, `challenge_payout`). This is the exact mirror-drift
   class plan 041 built source-parsing parity tests for; this pair postdates
   041 and never got one.

## Current state

`backend/packages/api/src/api/store/challenge/route.ts:85-95`:

```ts
// Legacy projection — the shipped storefront reads these until the
// per-rank UI lands (plan 057 phase 2): podium = ranks 1-3 cards,
// rewardCredits = the largest credits configured for ranks 4-10.
rewardCardIds: table
  .filter((x) => x.rank <= 3 && x.card_id)
  .map((x) => x.card_id as string),
rewardCredits: Math.max(
  0,
  ...table.filter((x) => x.rank >= 4).map((x) => Number(x.credits)),
),
```

Consumers: whole-repo grep hits only the route itself,
`backend/packages/api/integration-tests/http/challenge.spec.ts:431-434`
(assertions), and two historical docs. The storefront's `ChallengeSchema`
(`src/lib/data/schemas.ts`) does not declare the fields;
`src/lib/data/challenge.ts` consumes `rankRewards` exclusively.

`backend/packages/api/src/modules/packs/notify-feed.ts:3-10`:

```ts
export type FeedTemplate =
  | 'commission_matured'
  | 'vip_level_up'
  | 'reward_won'
  | 'voucher_claimed'
  | 'delivery_status'
  | 'topup_credited'
  | 'challenge_payout';
```

`src/lib/notifications/__tests__/copy.test.ts:4-12` — a hand-copied
`const TEMPLATES = [...] as const;` — and `:27-34`:

```ts
expect(Object.keys(NOTIFICATION_COPY).sort()).toEqual([...TEMPLATES].sort());
```

**The parity-test pattern to follow** — `src/lib/__tests__/buyback-parity.test.ts:14-29`:
reads the backend source file with `readFileSync` from `process.cwd()`
(`backend/packages/api/src/modules/packs/buyback-rate.ts`), regexes the
constant out, and throws a "if it was renamed or moved, update this guard —
do not delete it" error when the match fails.

## Commands you will need

| Purpose                                               | Command                                                                                                                   | Expected |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------- |
| Storefront tests                                      | `npm test`                                                                                                                | all pass |
| Storefront check                                      | `npm run check`                                                                                                           | exit 0   |
| Backend typecheck                                     | from `backend/packages/api`: `corepack yarn check-types` (fallback `node ../../node_modules/typescript/bin/tsc --noEmit`) | exit 0   |
| Challenge HTTP suite (needs pokenic-postgres + redis) | `NODE_OPTIONS=--experimental-vm-modules TEST_TYPE=integration:http npx jest integration-tests/http/challenge.spec.ts`     | all pass |

## Scope

**In scope**:

- `backend/packages/api/src/api/store/challenge/route.ts` (delete the two projections + comment)
- `backend/packages/api/integration-tests/http/challenge.spec.ts` (delete the assertions on those fields)
- `src/lib/notifications/__tests__/copy.test.ts` (derive `TEMPLATES` from the backend source)
- New `src/lib/notifications/__tests__/template-parity.test.ts` — or fold the
  parity assertion into `copy.test.ts` (executor's call; one file is fine)

**Out of scope**:

- `notify-feed.ts`, `copy.ts` themselves — both are correct today.
- `ChallengeSchema` / `challenge.ts` — already clean.
- Any other field on the `/store/challenge` response.

## Git workflow

- Branch: `advisor/077-challenge-wire-and-parity`
- Conventional commits, e.g. `chore(api): drop the dead rewardCardIds/rewardCredits challenge projections`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Delete the legacy projection

Remove `rewardCardIds` and `rewardCredits` (and their comment) from the
`stages` map in `route.ts:85-95`. Then delete the corresponding assertions in
`challenge.spec.ts` (located around `:431-434`; find them with
`grep -n "rewardCardIds\|rewardCredits" backend/packages/api/integration-tests/http/challenge.spec.ts`).

**Verify**: backend typecheck exits 0;
`grep -rn "rewardCardIds\|rewardCredits" backend/packages/api/src src/ | grep -v plans/` → no matches.

### Step 2: Run the challenge HTTP suite

**Verify**: the suite passes on a live DB (command above). If no DB is
available locally, state so — CI's integration-http job covers it — and rely
on typecheck + the grep.

### Step 3: Parity test across the notification seam

Following `buyback-parity.test.ts` exactly (same `readFileSync` +
`process.cwd()` join, same "update this guard — do not delete it" failure
message): parse the `FeedTemplate` union members out of
`backend/packages/api/src/modules/packs/notify-feed.ts` with a regex over the
`export type FeedTemplate =` block (match the quoted members), and assert
set-equality with `Object.keys(NOTIFICATION_COPY)`.

Then remove the hand-copied `TEMPLATES` array from `copy.test.ts` and derive
it from the parsed union (the parse helper can live in the test file and be
shared), so the list exists in exactly two places: the backend union and the
storefront copy table — with the test bridging them.

**Verify**: `npm test` → all pass. Mutation check (temporary, do not commit):
add a bogus member `'x_probe'` to the `FeedTemplate` union, re-run the
storefront test — it must FAIL naming the missing copy; revert.

## Test plan

Step 3 is the test work. The mutation check in its Verify is the
anti-vacuity proof (the repo has history with vacuous guards — prove the new
one can actually go red before finishing).

## Done criteria

- [ ] `grep -rn "rewardCardIds\|rewardCredits"` over `backend/packages/api/src`, `backend/packages/api/integration-tests`, and `src/` → no matches
- [ ] Parity test exists, passes, and was proven RED once by mutation (state it in the report)
- [ ] `copy.test.ts` no longer carries a hand-copied template array
- [ ] `npm test`, `npm run check`, backend typecheck all green
- [ ] No files outside scope modified; `plans/README.md` row updated

## STOP conditions

- A storefront read of either field exists after all (the grep in Step 1
  finds a `src/` consumer) — the premise is wrong; report.
- The `FeedTemplate` union has moved or changed shape such that a reasonable
  regex can't extract it — report; do not weaken the assertion to "at least
  the known seven".
- The challenge HTTP suite fails on anything other than the deleted
  assertions.

## Maintenance notes

- The route is publishable-key public; an out-of-tree consumer is
  conceivable but nothing in this repo reads the fields, and restoring them
  is a two-line revert. If the operator knows of an external consumer, mark
  this plan REJECTED instead.
- New notification templates now fail the storefront suite until copy is
  added — that is the intended forcing function; the failure message should
  say "add copy to NOTIFICATION_COPY".
- Reviewer: check the regex parses ALL union members (count = 7 today) and
  that the test fails loudly, not silently, when the backend file moves.
