# Plan 026: Compute the playthrough gate's "used" on the deposit-funded basis (external_funded_cents), not raw ledger amount

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat dbce0561..HEAD -- backend/packages/api/src/modules/packs/service.ts backend/packages/api/src/modules/packs/withdrawable.ts backend/packages/api/src/modules/packs/__tests__/wallet-summary.spec.ts scripts/qa-withdraw-gate.mjs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (semantics change to the most compliance-sensitive money control; mitigated: the gate is display-only today — no cashout writer exists yet)
- **Depends on**: none
- **Category**: bug / security
- **Planned at**: commit `dbce0561`, 2026-07-13

## Why this matters

PR #140 added a playthrough withdrawal gate: a customer's balance becomes
withdrawable only once their lifetime pack-open spend covers their lifetime
deposits. Its stated purpose (its own header comment) is that non-deposit
credit "never counts as used, so selling a card back cannot unlock deposits
that were never played through" — i.e. prevent deposit pass-through
(deposit → withdraw without playing), the classic laundering pattern a
playthrough rule exists to stop.

The implementation counts **all** `pack_open` spend by raw ledger `amount`,
regardless of what funded it. But the money core already tracks exactly
"deposit money consumed by opens" in a dedicated column,
`external_funded_cents` (the VIP basis uses it; `creditSummary` aggregates
it). Because the gate uses `amount`, play funded by commission, buyback, or
admin-adjustment credit banks playthrough. Concrete hole: (1) earn matured
referral commission (a live, no-deposit path), (2) open packs with it —
those rows carry `external_funded_cents = 0` but full negative `amount`,
(3) now `topup` real money — the gate is already satisfied by the earlier
promo-funded play, so the fresh deposit is immediately "withdrawable"
without ever being played. The lifetime aggregate means play-before-deposit
works; timing cannot save it.

Today `withdrawable` is only displayed on the wallet page. But
`withdrawable.ts:11-12` mandates: "The future cashout writer MUST route
through this function before writing a 'cashout' ledger row." Shipping
cash-out on the current basis ships the hole. Fix the basis now, while it's
still display-only.

**Intent note for the reviewer**: the `amount` basis is self-documented at
`withdrawable.ts:16-18`, so this is technically a deliberate line of code —
but it contradicts the same file's stated invariant (lines 3-5), and no
decision doc anywhere in the repo defends the `amount` basis against the
`external_funded_cents` basis the rest of the money core uses (round-4 audit
checked). This plan implements the stated invariant. If the maintainer
actually wants "any play counts, whatever funded it", reject this plan in
`plans/README.md` instead — but then the wallet-page copy and the
`withdrawable.ts` header must be rewritten to say so, because today the code
promises something it doesn't do.

## Current state

Files:

- `backend/packages/api/src/modules/packs/withdrawable.ts` — the pure gate
  (31 lines). Header states the invariant; `PlaythroughInput.usedCents` doc
  currently says "Σ −amount over `pack_open` rows".
- `backend/packages/api/src/modules/packs/service.ts` — `walletSummary`
  (~line 2200) computes the gate's two sums in SQL and feeds
  `playthroughState`.
- `backend/packages/api/src/modules/packs/__tests__/wallet-summary.spec.ts`
  — module-level integration spec (real DB via `moduleIntegrationTestRunner`).
- `backend/packages/api/src/modules/packs/models/credit-transaction.ts` —
  ledger model; documents `external_funded_cents` semantics.
- `scripts/qa-withdraw-gate.mjs` — Playwright QA script that seeds
  wallet-gate scenarios against a local stack (repo root).

The gate SQL as it exists today (`service.ts:2228-2231`):

```ts
'SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS balance_cents, ' +
  "COALESCE(SUM(ROUND(amount * 100)) FILTER (WHERE reason = 'topup' AND amount > 0), 0)::bigint AS deposited_cents, " +
  "COALESCE(SUM(-ROUND(amount * 100)) FILTER (WHERE reason = 'pack_open'), 0)::bigint AS used_cents " +
  'FROM credit_transaction WHERE customer_id = ? AND deleted_at IS NULL',
```

The correct basis already exists elsewhere in the same file —
`creditSummary` (`service.ts:~565-570`):

```ts
"COALESCE(SUM(CASE WHEN reason = 'pack_open' THEN -external_funded_cents ELSE 0 END), 0)::bigint AS ext_spend_cents ";
```

`external_funded_cents` semantics (model comment,
`credit-transaction.ts:37-40`): "external-funded sen this row added
(top-up, +) or consumed (pack_open, −). 0 for buyback/adjustment. NULL on
pre-1b rows (read as 0, forward-only). **Signed integer sen**". Key writers,
all verified in round-4:

- `mutateCreditAtomic` (`service.ts:~690-699`): topup rows get
  `+deltaCents`; pack_open debits get `-consumeExternalSen(charge, externalBalance)`
  — i.e. only the deposit-funded portion, never more than the remaining
  external balance.
- `settleOpen` (`service.ts:~1867`): same `consumeExternalSen` computation
  for the live open path.
- `reverseCreditTransaction` (`service.ts:~814-826`): the reversal mirror
  row carries `external_funded_cents: -originalExt` — "restores external
  balance + basis". So the external basis is reversal-coherent: an aborted
  open gives back exactly the deposit-funded playthrough it consumed.
- Commission rows: `external_funded_cents: 0` ("commissions carry no
  external basis", `service.ts:~1210`); buyback/adjustment: 0.

The existing playthrough test (`wallet-summary.spec.ts:205-262`, "buybacks
never unlock unspent deposits") seeds its `pack_open` rows via
`createCreditTransactions` **without** `external_funded_cents` — it only
worked under the `amount` basis because in that scenario the open was
deposit-funded so the two bases coincide. It will go red when you change the
SQL; fixing its fixtures is part of this plan (see Step 3).

Units trap: `amount` is decimal RM (needs `ROUND(amount * 100)`);
`external_funded_cents` is **already integer sen** — no `* 100`. Copy the
`creditSummary` expression, don't adapt the `amount` one.

Repo conventions: integer-sen arithmetic; append-only ledger; comments
explain invariants at the definition site (match the existing comment
density in `walletSummary`).

## Commands you will need

| Purpose              | Command (working dir)                                                               | Expected on success |
| -------------------- | ----------------------------------------------------------------------------------- | ------------------- |
| Start DB/Redis       | `docker start pokenic-postgres pokenic-redis`                                       | both names printed  |
| Install              | `corepack yarn install --immutable` (in `backend/`)                                 | exit 0              |
| Build workspace deps | `corepack yarn build --filter="@acme/api^..."` (in `backend/`)                      | exit 0              |
| Typecheck            | `corepack yarn check-types` (in `backend/`)                                         | exit 0              |
| This spec only       | `corepack yarn test:integration:modules wallet-summary` (in `backend/packages/api`) | all pass            |
| Unit specs           | `corepack yarn test:unit withdrawable` (in `backend/packages/api`)                  | all pass            |

Note: the `test:*` scripts use `TEST_TYPE=... jest` inline-env syntax — run
them from Git Bash (or CI) on Windows, not PowerShell/cmd.

## Scope

**In scope** (the only files you should modify):

- `backend/packages/api/src/modules/packs/service.ts` — the `used_cents`
  expression inside `walletSummary` and the comment block above it, nothing else in the file
- `backend/packages/api/src/modules/packs/withdrawable.ts` — doc comments only (the math is unchanged)
- `backend/packages/api/src/modules/packs/__tests__/wallet-summary.spec.ts`
- `scripts/qa-withdraw-gate.mjs` — only if its seeds write raw `pack_open` rows (Step 5)
- `plans/README.md` — status row

**Out of scope** (do NOT touch, even though they look related):

- `deposited_cents` (the `topup AND amount > 0` filter). A reversed/refunded
  topup would leave `deposited` overstated (over-locking, never
  over-withdrawing) — but no topup-reversal path exists today. Documented as
  a maintenance note; do not "fix" it here.
- `mutateCreditAtomic`, `settleOpen`, `reverseCreditTransaction`,
  `consumeExternalSen` — the external-basis writers are correct; changing
  them risks the VIP basis.
- The storefront (`src/lib/actions/wallet.ts`, `src/app/(account)/wallet/page.tsx`,
  `src/lib/data/schemas.ts`) — the wire shape and copy are unchanged.
- `/store/credits` route.
- Any cashout writer — it does not exist yet; do not create one.

## Git workflow

- Branch: `advisor/026-playthrough-external-basis` (executors in this repo
  historically work in isolated worktrees branched from the current master).
- Conventional commits, e.g. `fix(wallet): playthrough gate counts deposit-funded spend only (external basis)`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Swap the `used_cents` expression to the external basis

In `walletSummary` (`service.ts:~2228-2231`), replace the `used_cents` line:

```ts
"COALESCE(SUM(-ROUND(amount * 100)) FILTER (WHERE reason = 'pack_open'), 0)::bigint AS used_cents ";
```

with the external-funded expression (mirror `creditSummary`'s
`ext_spend_cents`; FILTER and CASE forms are equivalent — keep the FILTER
style used by the neighboring lines):

```ts
"COALESCE(SUM(-external_funded_cents) FILTER (WHERE reason = 'pack_open'), 0)::bigint AS used_cents ";
```

No `ROUND(... * 100)` — `external_funded_cents` is already integer sen.
`SUM` skips NULL rows (pre-Phase-1b), which reads as 0 used — conservative
(over-locks); acceptable because no real-money customers exist yet (mock
gateway) — see Maintenance notes.

Update the comment block above the query (`service.ts:~2215-2220`): "used"
is now "Σ −external_funded_cents over pack_open rows — deposit-funded spend
only; commission/buyback/adjustment-funded opens contribute 0; a reversed
open restores its basis via the mirror row's `-originalExt`".

**Verify**: `corepack yarn check-types` (in `backend/`) → exit 0.

### Step 2: Run the existing spec — expect RED

**Verify**: `corepack yarn test:integration:modules wallet-summary` (in
`backend/packages/api`, containers running) → the case "playthrough gate —
buybacks never unlock unspent deposits" **fails** (its `pack_open` fixture
rows have no `external_funded_cents`, so `used` is now 0 and the gate stays
locked). The other two `walletSummary` cases still pass. If it does NOT
fail, STOP — the SQL change didn't land where you think it did.

### Step 3: Fix the existing fixture to model deposit-funded opens honestly

In `wallet-summary.spec.ts:217-232` and `:245-253`, the raw
`createCreditTransactions` rows for `pack_open` must carry the external
basis a real deposit-funded open would have:

- the `-40` open row → add `external_funded_cents: -4000`
- the `-60` open row → add `external_funded_cents: -6000`

(The topup was made via `mutateCreditAtomic`, which already banked
`+10000` sen external.) Leave the buyback row as-is (no external field —
NULL reads as 0, matching a real buyback's 0).

**Verify**: `corepack yarn test:integration:modules wallet-summary` → all
previous cases green again.

### Step 4: Add the discriminating case (the red→green proof for the bug)

Add a fourth `it(...)` to the `walletSummary` describe block, modeled on the
existing playthrough case:

`'walletSummary: playthrough gate — promo-funded play does not unlock a later deposit'`

1. New customer id (e.g. `cus_ws_promo_basis`).
2. Seed a commission-style credit: `createCreditTransactions` one row
   `{ amount: 100, reason: 'direct_referral', external_funded_cents: 0, pull_id: null, reference: null }`.
3. Seed the promo-funded play: one row
   `{ amount: -100, reason: 'pack_open', external_funded_cents: 0, pull_id: null, reference: null }`
   (this is what a real open funded entirely by non-deposit balance writes —
   `consumeExternalSen` returns 0 when the external balance is 0).
4. NOW deposit: `mutateCreditAtomic({ customerId, amount: 100, reason: 'topup', reference: 'topup_ws_promo' })`.
5. Assert:
   - `w.playthrough.deposited` is `100`
   - `w.playthrough.used` is `0` (the promo-funded open counts nothing)
   - `w.playthrough.remaining` is `100`
   - `w.withdrawable` is `0` — **the unplayed deposit stays locked**
6. Then play the deposit through: one more `pack_open` row
   `{ amount: -100, external_funded_cents: -10000, ... }` (or via the
   service's real open path if convenient) and assert the gate opens:
   `w.playthrough.remaining === 0`, `w.withdrawable` ≈ `w.available`.

Under the pre-plan `amount` basis, assertion 5 fails (used would be 100 and
the deposit instantly withdrawable) — state this in a comment so the test
documents the bug class.

**Verify**: `corepack yarn test:integration:modules wallet-summary` → all 4
cases pass. Run it twice; both green.

### Step 5: Update doc comments and the QA script's seeds

1. `withdrawable.ts`: update the header (lines 1-12) and
   `PlaythroughInput.usedCents` doc (lines 16-18) to say the used sum is
   `Σ −external_funded_cents` over `pack_open` rows (deposit-funded spend
   only; reversals restore the basis). Do not change the function.
2. `scripts/qa-withdraw-gate.mjs`: read it. If any seeded scenario inserts
   `pack_open` rows directly (SQL or API bypass) **without** setting
   `external_funded_cents`, add the matching negative sen value so the
   scenarios still exercise the states they name (S3 locked / S1b unlocked).
   If the script only drives real topup/open endpoints, no change is needed
   — note that in your report.

**Verify**: `corepack yarn check-types` (in `backend/`) → exit 0. Root
`npm run typecheck` is unaffected (no storefront change) — run it anyway,
expect exit 0.

### Step 6: Full neighbor sweep

**Verify**: `corepack yarn test:unit withdrawable` → pass (pure function
untouched). `corepack yarn test:integration:smoke` (in
`backend/packages/api`) → all suites pass (the gate feeds
`/store/credits`, which `credit-topup.spec`/`economy.spec` touch).

## Test plan

- Modified: `wallet-summary.spec.ts` — fixture rows gain explicit
  `external_funded_cents`; new discriminating case per Step 4 (happy path:
  deposit-funded play opens the gate; regression: promo-funded play does
  not unlock a later deposit; edge: NULL external rows count 0).
- Pattern to follow: the existing cases in the same file (same
  `moduleIntegrationTestRunner` harness, same seeding style).
- Verification: `corepack yarn test:integration:modules wallet-summary` →
  4/4 pass, twice.

## Done criteria

Machine-checkable; ALL must hold:

- [ ] `grep -n "SUM(-ROUND(amount \* 100)) FILTER (WHERE reason = 'pack_open')" backend/packages/api/src/modules/packs/service.ts` → no matches
- [ ] `grep -n "external_funded_cents) FILTER (WHERE reason = 'pack_open')" backend/packages/api/src/modules/packs/service.ts` → exactly one match inside `walletSummary` (plus the pre-existing CASE form in `creditSummary` if you grep loosely — check the line number is ~2230)
- [ ] `corepack yarn check-types` (backend/) exits 0
- [ ] `corepack yarn test:integration:modules wallet-summary` → 4 passing cases, including the new promo-funded case
- [ ] `corepack yarn test:integration:smoke` → all pass
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `walletSummary` SQL at `service.ts:~2228` no longer matches the
  "Current state" excerpt (drift since `dbce0561`).
- You find a decision doc / ADR / PR discussion that explicitly chose the
  raw-`amount` basis over the external basis (round-4 audit found none — if
  one exists, the intent question reopens and the maintainer decides).
- Step 2 does NOT go red, or Step 4's new case passes even **before** your
  SQL change (would mean the two bases coincide in your fixture — re-check
  the `external_funded_cents: 0` seeding).
- A production writer of `pack_open` rows other than
  `mutateCreditAtomic`/`settleOpen`/`reverseCreditTransaction`/`reverseOpen`
  turns up (grep `reason: 'pack_open'` and `reason: "pack_open"` across
  `backend/packages/api/src`) — a writer that doesn't set
  `external_funded_cents` would silently zero its playthrough.
- `qa-withdraw-gate.mjs` seeds scenarios in a way you cannot map to the new
  basis with confidence.

## Maintenance notes

- **Deposited-side asymmetry (deferred, latent)**: `deposited` counts only
  positive topup rows; a future topup-refund/chargeback path writing
  negative `topup` rows would overstate `deposited` and over-lock. When such
  a path lands, net topups the way `pack_open` nets. Never a
  money-loss direction, so deliberately not fixed here.
- **Pre-Phase-1b NULL rows** read as 0 used → legacy customers over-locked.
  Harmless while there are no real-money customers; if the platform launches
  with pre-1b data, decide a backfill then.
- **The future cashout writer** must recompute deposited/used/available
  **under the per-customer `credit:` advisory lock** and cap payout at
  `available` — `playthroughState` returns a boolean + remaining, not an
  amount. See plan README round-4 direction notes (DIR-01).
- Reviewer scrutiny: the unit-vs-sen distinction in the SQL (no `*100` on
  `external_funded_cents`), and that `creditSummary` was not touched.
