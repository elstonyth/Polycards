# Plan 036: Bound the daily-reward voucher amount server-side

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. Your reviewer
> maintains `plans/README.md` — do not edit it.
>
> **Drift check (run first)**:
> `git diff --stat 38f7dbdd..HEAD -- backend/packages/api/src/modules/packs/voucher-ranges.ts backend/packages/api/src/modules/packs/service.ts`
> On any change, compare "Current state" against live code before proceeding.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `38f7dbdd`, 2026-07-13

## Why this matters

`voucher_amount` on `vip_level` is a credit-minting lever: the daily draw
credits it as MYR when the rewards economy is live. It is the **one** admin
money input with no server-side upper bound — every sibling is capped (FX
`manual_rate ≤ 1000`, credit adjust `|amount| ≤ 10,000` with cent precision,
daily-box credit `≤ MAX_BOX_CREDIT_MYR`, card `market_value ≤
MAX_MARKET_VALUE_USD`, markup `≤ 11`). `foldRanges` validates each range's
`amount_myr` only as `Number.isFinite && >= 0`, then `saveVoucherRanges`
writes it straight through. A fat-fingered or hostile admin write can set an
arbitrarily large per-level payout across all 100 VIP levels with no backstop.
Latent today (economy is dormant behind `REWARDS_REDEMPTION_ENABLED`), but it
becomes real the moment the rewards economy launches — and plan 017 extracted
this fold logic verbatim without examining the ceiling, so no prior round
caught it. Closing it now is the cheap prerequisite for the rewards-launch
direction item.

## Current state

`backend/packages/api/src/modules/packs/voucher-ranges.ts` — the pure fold,
the only validation before the write:

```ts
export function foldRanges(ranges: VoucherRange[]): number[] {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    throw new Error('At least one range is required.');
  }
  const out = new Array<number>(LEVELS).fill(-1);
  for (const r of ranges) {
    if (
      !Number.isInteger(r.from) || !Number.isInteger(r.to) ||
      r.from < 1 || r.to > LEVELS || r.from > r.to
    ) {
      throw new Error(`Invalid range ${r.from}–${r.to}: levels must be integers within 1–${LEVELS}.`);
    }
    if (!(Number.isFinite(r.amount_myr) && r.amount_myr >= 0)) {
      throw new Error(`Invalid amount for range ${r.from}–${r.to}: must be ≥ 0.`);
    }
    // ... assigns out[level-1] = r.amount_myr
```

`service.ts` `saveVoucherRanges` (~4382) calls `foldRanges(ranges)` as the
sole validation, then writes `voucher_amount: nextAmount` per level.

The route `backend/packages/api/src/api/admin/daily-rewards/vouchers/route.ts`
(~48) delegates entirely to `saveVoucherRanges` and adds no amount bound.

**Exemplar to match** — the credit-adjust validator's error shape and
cent-precision check (`backend/packages/api/src/modules/packs/credit-adjust.ts`,
the `adjustAmountError`/`MAX_*` pattern: bound + non-cent-precise rejection
with a message string). Read it and mirror its style.

Seeded reference: `scripts/seed-reward-economy-demo.ts` seeds voucher amounts
in the 0–888 range, so any ceiling must be **≥ 888**.

Money convention: amounts are MYR with 2-decimal (cent) precision; a
"cent-precise" check is `Math.round(x * 100) === x * 100` (or the exact form
`credit-adjust.ts` uses — match it).

## Commands you will need

| Purpose            | Command (in `backend/packages/api`)                   | Expected |
| ------------------ | ----------------------------------------------------- | -------- |
| Install            | `corepack yarn install` (in `backend/`)               | exit 0   |
| Typecheck          | `corepack yarn check-types`                           | exit 0   |
| Voucher unit tests | `corepack yarn test:unit --testPathPattern="voucher"` | all pass |

## Scope

**In scope**:

- `backend/packages/api/src/modules/packs/voucher-ranges.ts` — add the ceiling
  - cent-precision check inside `foldRanges`.
- The voucher-ranges unit spec (find it: `grep -rl "foldRanges"
backend/packages/api/src/modules/packs/__tests__ backend/packages/api/integration-tests`;
  plan 017 created `voucher-ranges.spec.ts` or similar) — add cases.

**Out of scope**:

- `service.ts` `saveVoucherRanges` and the route — the check belongs in
  `foldRanges` (the single chokepoint), so those need no change.
- Any other validator or the daily-draw consumption path.

## Git workflow

- Branch: `advisor/036-voucher-amount-server-cap`
- Commit: `fix(admin): bound daily-reward voucher amount server-side`
- Do not push or open a PR.

## Steps

### Step 1: Add `MAX_VOUCHER_MYR` and the checks

At the top of `voucher-ranges.ts`, add an exported constant
`export const MAX_VOUCHER_MYR = 10_000;` (pick a ceiling comfortably above the
seeded 888 and consistent with the credit-adjust `10_000` ceiling — note the
choice in a comment). Inside `foldRanges`, extend the amount check so it also
rejects `r.amount_myr > MAX_VOUCHER_MYR` and non-cent-precise values, with a
message in the same shape as the existing range/amount errors, e.g.:

```
`Invalid amount for range ${r.from}–${r.to}: must be between 0 and ${MAX_VOUCHER_MYR} with at most 2 decimals.`
```

Keep the existing `>= 0` / finite guard; just widen the rejected set.

**Verify**: `corepack yarn check-types` → exit 0.

### Step 2: Add unit cases

In the voucher-ranges spec, add cases: (a) `amount_myr` exactly at
`MAX_VOUCHER_MYR` passes; (b) `amount_myr = MAX_VOUCHER_MYR + 0.01` throws;
(c) a non-cent-precise amount (e.g. `1.005`) throws; (d) the existing valid
seeded-range case still passes (regression). Model the structure on the
existing `foldRanges` cases in the same file.

**Verify**: `corepack yarn test:unit --testPathPattern="voucher"` → all pass,
including the new cases.

## Test plan

Four cases in Step 2, in the existing voucher-ranges spec, following its
arrange-act-assert style. No integration test needed — `foldRanges` is pure.

## Done criteria

- [ ] `corepack yarn check-types` exits 0
- [ ] `corepack yarn test:unit --testPathPattern="voucher"` passes with new cases
- [ ] `grep -n "MAX_VOUCHER_MYR" backend/packages/api/src/modules/packs/voucher-ranges.ts` → defined and used in the guard
- [ ] `git status` shows no files outside scope

## STOP conditions

- The voucher-ranges spec file doesn't exist where the grep points — report
  the actual location; do not create a spec in a new convention.
- `foldRanges` has callers beyond `saveVoucherRanges` that pass
  legitimately-larger amounts (grep `foldRanges` across `backend/`) — a
  ceiling would break them; report first.

## Maintenance notes

- When the rewards economy launches (direction item), this ceiling is the
  abuse cap the launch runbook should reference; revisit the exact value with
  the economy parameters.
- A reviewer should confirm the ceiling is ≥ the seeded max (888) so existing
  demo data still saves.
