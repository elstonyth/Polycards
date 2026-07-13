# Plan 040: Make WalletSchema degrade gracefully + add it to the contract test

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. Your reviewer
> maintains `plans/README.md` — do not edit it.
>
> **Drift check (run first)**:
> `git diff --stat 38f7dbdd..HEAD -- src/lib/data/schemas.ts src/lib/data/__tests__/schemas.test.ts src/lib/actions/wallet.ts`
> On any change, compare "Current state" against live code before proceeding.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (latent)
- **Planned at**: commit `38f7dbdd`, 2026-07-13

## Why this matters

`WalletSchema` hard-requires the two wallet fields added by PR #140
(`withdrawable`, `playthrough`). A backend response missing either — an older
backend during a non-lockstep deploy — fails the **entire** wallet parse
(`parseOne` → `null` → the wallet page shows "Got an unexpected response")
instead of degrading. This contradicts the module's own documented graceful
convention (`OddsEntrySchema.marketPriceMyr` is `.optional()`, `next_unlock`
is `.nullable()`). Compounding it, `WalletSchema` is the **one** schema the
contract test (`schemas.test.ts`) doesn't exercise, so a field rename/removal
on either side is caught by nothing until the page breaks at runtime. Latent
under the current lockstep deploy, but it is the single wallet field-shape
schema with no safety net on either axis.

## Current state

`src/lib/data/schemas.ts:241-255`:

```ts
export const WalletSchema = z.looseObject({
  balance: finite,
  available: finite,
  locked: finite,
  is_frozen: z.boolean(),
  next_unlock: z.looseObject({ amount: finite, date: z.string() }).nullable(),
  // Playthrough withdrawal gate: withdrawable is 0 until playthrough.remaining
  // hits 0 (lifetime deposits fully spent on pack opens).
  withdrawable: finite,
  playthrough: z.looseObject({
    deposited: finite,
    used: finite,
    remaining: finite,
  }),
});
```

Note `z.looseObject` allows _extra_ keys but still **requires** declared ones;
`withdrawable` and `playthrough` are declared non-optional.

The graceful convention to mirror, in the same file: `OddsEntrySchema` uses
`.optional()` for `marketPriceMyr` (~line 63), and `next_unlock` above uses
`.nullable()`. The consumer `src/lib/actions/wallet.ts:60` runs
`parseOne(WalletSchema, …)` and the whole wallet page depends on it not
returning `null`.

`src/lib/data/__tests__/schemas.test.ts` imports and exercises 13 schemas
(PackRow, OddsEntry, RecentPull, Leaderboard, PublicProfile, CreditTransaction,
VaultItem, Balance, WonCard, OpenBuyback, BuybackResult, CardDetail) plus
`CREDIT_REASONS` — `WalletSchema` is **absent**. The file's import block
(lines 2-18) is where a new schema gets added.

## Commands you will need

| Purpose                  | Command (repo root)   | Expected |
| ------------------------ | --------------------- | -------- |
| Install                  | `npm install`         | exit 0   |
| Typecheck + lint + build | `npm run check`       | exit 0   |
| Schema test              | `npm test -- schemas` | all pass |

## Scope

**In scope**:

- `src/lib/data/schemas.ts` — make `withdrawable`/`playthrough` optional with
  sane fallbacks.
- `src/lib/actions/wallet.ts` — only if a default must be applied where the
  parsed wallet is consumed (so the page renders sensibly when the fields are
  absent).
- `src/lib/data/__tests__/schemas.test.ts` — add `WalletSchema` coverage.

**Out of scope**:

- The wallet page component's layout — a missing playthrough block should
  degrade (hide the section / show neutral copy), not restyle the page.
- The backend wallet response — this is a client-resilience change only.
- Any other schema.

## Git workflow

- Branch: `advisor/040-walletschema-graceful-degrade`
- Commit: `fix(wallet): degrade gracefully when withdrawal fields are absent`
- Do not push or open a PR.

## Steps

### Step 1: Relax the two fields

Make `withdrawable` `.optional()` and `playthrough` `.optional()` (or provide
`.catch`/default per the repo's zod v4 convention — check how
`marketPriceMyr` does it and match exactly). Keep the inner `playthrough`
shape strict when present. Update the comment to note the fields are optional
for backward/forward-compat, mirroring the `OddsEntrySchema` convention.

**Verify**: `npm run check` → exit 0.

### Step 2: Apply sensible fallbacks at the consumer

In `wallet.ts` (or wherever the parsed wallet flows into the page props),
ensure `withdrawable`/`playthrough` absence yields a safe render: e.g.
`withdrawable` defaults to `0` / not-eligible, and the playthrough block is
treated as unknown (hidden) rather than crashing. Do the minimum so the page
renders without the fields; don't redesign it.

**Verify**: `npm run check` → exit 0.

### Step 3: Add WalletSchema to the contract test

Import `WalletSchema` in `schemas.test.ts` and add a `describe('WalletSchema')`
block modeled on a sibling schema's block. Cases: (a) a full valid wallet
parses; (b) a wallet **missing** `withdrawable` and `playthrough` still parses
(returns an object, not `null`) — this is the regression this plan fixes;
(c) a malformed `playthrough` (wrong inner type) is rejected/handled per the
chosen convention.

**Verify**: `npm test -- schemas` → all pass, including the new block.

## Test plan

Step 3 is the test plan: three `WalletSchema` cases in `schemas.test.ts`, the
key one being "missing new fields still parses". Model on any existing schema
block in that file. Verification: `npm test -- schemas`.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `npm test -- schemas` passes with a new `WalletSchema` block
- [ ] A wallet response missing `withdrawable`/`playthrough` parses to a
      non-null object (asserted by the new test)
- [ ] `grep -n "WalletSchema" src/lib/data/__tests__/schemas.test.ts` → present
- [ ] `git status` shows no files outside scope

## STOP conditions

- The repo's zod version doesn't support the graceful pattern you reached for
  (check `marketPriceMyr`'s exact syntax and copy it — if that syntax doesn't
  exist here, the premise is wrong; report).
- Making the fields optional forces a non-trivial refactor of the wallet page
  (more than a fallback default) — report; the reviewer may rescope.

## Maintenance notes

- Once real cash-out ships (DIR-01), the wallet page will lean harder on
  `withdrawable`/`playthrough`; the graceful-degrade path is for deploy-skew
  windows, not a permanent "these might not exist" — the fields will always be
  present in a current backend.
- A reviewer should confirm the degraded render (fields absent) doesn't
  silently show "withdrawable" as available when it's actually unknown.
