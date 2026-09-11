# Plan 133: Make payout `net_amount` mean what the wallet paid, count the audit panel's gross floor, and backfill withdrawal nets

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. Do NOT update
> `plans/README.md`; the reviewer maintains it.
>
> **Drift check (run first)**:
> `git diff --stat 1bc30e6b..HEAD -- backend/packages/api/src/api/hooks/tgpay/withdrawal/route.ts backend/packages/api/src/modules/packs/gateway.ts backend/packages/api/src/modules/packs/money.ts backend/packages/api/src/modules/packs/gateway-settlement.ts backend/packages/api/src/modules/packs/gateway-audit.ts backend/packages/api/src/jobs/gateway-audit.ts backend/packages/api/src/api/admin/payments/audit/route.ts backend/apps/admin/src/lib/admin-rest.ts backend/apps/admin/src/routes/settlement/page.tsx backend/apps/admin/src/i18n/en.json docs/payments/tgpay-setup.md`
> Expected on a branch cut from origin/master `51f74bcd`: **empty** — none of
> these files changed in #575/#576. `service.ts` (also in scope) did change
> there (+126, partner groups) but not inside `gatewayAuditTotals`; locate by
> symbol name. Any other change → compare against "Current state"; on a
> mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED — changes the meaning of a stored money column for one direction; must not touch `gross`
- **Depends on**: none
- **Category**: bug (money reporting)
- **Planned at**: commit `1bc30e6b` (working tree), 2026-09-10; drift-checked against origin/master `51f74bcd`

## Why this matters

**1. Payout `net_amount` models a fee deduction TGPay does not make.** The
payout callback and the payout requery both store `net_amount = amount − fee`
(`netOfFee`). TGPay charges the payout fee **on top**: the sandbox proof in
`docs/payments/tgpay-setup.md:176-179` records a RM 50 payout "fee RM 1,
`amountIncludeFee` 51" and "the payout wallet dropped 300 → 249". The
recipient receives 50; our wallet pays 51. The stored 49 matches neither.

Consequences today, on live money: the settlement report and the gateway
audit panel print net 49 / gross 50 / fee 1 for a payout that cost 51. The
derived fee is right (by luck of subtraction), but Σnet is what the panel
puts beside the gateway's payout wallet, and it is off by 2 × Σfee per period
with nothing saying why. The hook's own comment ("net here is what the payout
cost us less what the recipient got") is self-contradictory — the direction
was never settled. `tgpay-client.ts:263` already parses `amountIncludeFee`;
nothing reads it.

**2. The audit panel's deposit gross is a floor with no counter.**
`gatewayAuditTotals` sums `amount_settled` and counts `missing_net`, but a
deposit settled by hand (the over-ceiling quarantine path,
`jobs/deposit-reconcile.ts:223-229`) has `amount_settled = NULL` and is
silently skipped — the exact failure `gateway-settlement.ts:1-25` ("THE NULL
RULE") exists to prevent, and which the settlement report already counts as
`missingGross`. The one screen built to reconcile our totals against the
gateway's wallet therefore breaks its own rule.

**3. The audit sweep claims to backfill `net_amount` for both directions and
does it for deposits only** (`jobs/gateway-audit.ts:27-28` vs `:103-107` and
`:154-158`). Once (1) lands, the withdrawal loop is also the cheapest way to
backfill the handful of production payout rows written since 2026-09-06 with
the old convention — no ad-hoc SQL.

After this plan: for a payout, `net_amount` = what left our payout wallet
(`amount + fee`, TGPay's `amountIncludeFee`); for a deposit it stays what we
received (`amountAfterFee`). The settlement fee is `|gross − net|` per
direction. The audit panel shows `missing_gross` beside `missing_net` with the
same floor wording. The withdrawal audit loop backfills a NULL net from the
requery, which also repairs the already-written rows on its next hourly run.

## Current state

### Files

- `backend/packages/api/src/api/hooks/tgpay/withdrawal/route.ts` — payout callback; writes `netAmount` at line 156.
- `backend/packages/api/src/modules/packs/gateway.ts` — TGPay adapter; `getDepositDetail` (`netAmount: Number(q.amountAfterFee)` at 436) and `getWithdrawalDetail` (`netAmount: netOfFee(...)` at 496).
- `backend/packages/api/src/modules/packs/tgpay-client.ts` — `queryPayout` response type declares `amountIncludeFee: number` at 263 (unused).
- `backend/packages/api/src/modules/packs/money.ts` — `netOfFee` (line 55) and `toOptionalMoney`.
- `backend/packages/api/src/modules/packs/gateway-settlement.ts` — pure settlement math; `toDirection` derives `fee` at 117.
- `backend/packages/api/src/modules/packs/service.ts` — `gatewayAuditTotals` (line ~6296; two raw SQL aggregates at 6332-6350).
- `backend/packages/api/src/api/admin/payments/audit/route.ts` — `GET /admin/payments/audit`; `moneyTotals` helper at 122-135; `SideTotals` type at 116-121.
- `backend/apps/admin/src/lib/admin-rest.ts` — `GatewayAuditTotals` interface (439-445).
- `backend/apps/admin/src/routes/settlement/page.tsx` — audit panel render (457-560); the settlement table already renders `missingNet` / `missingGross` hints (390-440).
- `backend/apps/admin/src/i18n/en.json` — `settlement.auditOurDeposits` (635), `settlement.auditOurWithdrawals` (636), `settlement.grossFloorHint` (619), `settlement.feeFloorHint` (618).
- `backend/packages/api/src/jobs/gateway-audit.ts` — hourly sweep; deposit backfill at 103-107, withdrawal write at 154-158.
- `docs/payments/tgpay-setup.md` — the wire facts (lines 29-37, 68-69, 176-179).

### Excerpts

The callback (payout leg):

```ts
// api/hooks/tgpay/withdrawal/route.ts:146-158
await applyWithdrawalOutcome(req.scope, withdrawal, {
  gatewayRef: gatewayTransactionId,
  gatewayTransactionId:
    withdrawal.gateway_transaction_id ?? gatewayTransactionId,
  amountSettled: toOptionalMoney(data.amount),
  // The settlement report reads fee = gross − net, so net here is what the
  // payout cost us less what the recipient got: amount − fee. NULL
  // (unknown) when either is missing — never a zero fee by omission.
  netAmount: netOfFee(data.amount, data.fee),
  settledAt: new Date(),
});
```

The requery (payout leg) and the deposit leg for contrast:

```ts
// modules/packs/gateway.ts:484-497
  async getWithdrawalDetail(merchantTransactionId, config) {
    const q = await tgpay.queryPayout(merchantTransactionId, config);
    const amount = Number(q.order?.amount);
    return {
      ...
      amount,
      // Same rule as the payout callback (money.ts netOfFee); NaN when
      // unknown, which toOptionalMoney turns into NULL on the row.
      netAmount: netOfFee(q.order?.amount, q.order?.fee) ?? NaN,

// modules/packs/gateway.ts:436 (getDepositDetail)
      netAmount: Number(q.amountAfterFee),
```

```ts
// modules/packs/money.ts:50-59
/**
 * What a payout cost us less what the recipient got, for the settlement
 * report's fee = gross − net rule. NULL (unknown) when either side is
 * missing — never a zero fee by omission. 2-dp inputs, 2-dp result.
 */
export function netOfFee(amount: unknown, fee: unknown): number | null {
  const a = toOptionalMoney(amount);
  const f = toOptionalMoney(fee);
  return a === null || f === null ? null : Number((a - f).toFixed(2));
}
```

The TGPay payout query shape (`tgpay-client.ts` ~255-268) declares
`order: { payoutRefNum, merchantRefNum, amount, fee, amountIncludeFee }`.
The payout **callback** body is flat: `{ transactionId, status, amount, fee,
paymentAt, orderno, payType }` — it carries `fee` but no `amountIncludeFee`
(`docs/payments/tgpay-setup.md:29-37`).

Settlement math:

```ts
// modules/packs/gateway-settlement.ts:110-121
function toDirection(row: GatewayPeriodRow | undefined): SettlementDirection {
  if (!row) return EMPTY_DIRECTION;
  return {
    count: row.count,
    gross: row.grossCents / 100,
    net: row.netCents / 100,
    // Fee over the known-net subset ONLY — see the NULL rule above.
    fee: (row.grossWithNetCents - row.netCents) / 100,
    missingNet: row.missingNet,
    missingGross: row.missingGross,
  };
}
```

The settlement report's `GatewayPeriodRow` (lines 28-45) already carries
`missingGross`; the header (lines 9-25) is the NULL rule this plan extends
to the audit panel. `mergeSettlementPeriods` checks `delta.withdrawals`
against the ledger `cashout` using **gross** (= `amount`) — that is why
`gross` must not change.

The audit totals:

```ts
// service.ts:6326-6350 (gatewayAuditTotals)
    const toTotals = (r: Raw) => ({
      count: Number(r.n),
      grossCents: Number(r.gross_cents),
      netCents: Number(r.net_cents),
      missingNet: Number(r.missing_net),
    });
    const [dep] = await em.execute<Raw[]>(
      `SELECT COUNT(*)::bigint AS n,
              COALESCE(SUM(ROUND(amount_settled * 100)), 0)::bigint AS gross_cents,
              COALESCE(SUM(ROUND(net_amount * 100)) FILTER (WHERE net_amount IS NOT NULL), 0)::bigint AS net_cents,
              COUNT(*) FILTER (WHERE net_amount IS NULL)::bigint AS missing_net
         FROM gateway_deposit
        WHERE deleted_at IS NULL AND status = 'settled' AND gateway = ?`,
      [gateway],
    );
    const [wd] = await em.execute<Raw[]>(
      `SELECT COUNT(*)::bigint AS n,
              COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS gross_cents,
              ... (same shape; `amount` is NOT NULL so no missing_gross needed)
```

Admin type and copy:

```ts
// backend/apps/admin/src/lib/admin-rest.ts:439-445
export interface GatewayAuditTotals {
  count: number;
  gross: number;
  /** Σ net over rows whose net is known — a FLOOR when missing_net > 0. */
  net: number;
  missing_net: number;
}
```

```json
// backend/apps/admin/src/i18n/en.json:618-619, 635-636
"feeFloorHint": "{{count}} settled row(s) have no net on file (settled before fee tracking) — the fee shown is a floor, not the total.",
"grossFloorHint": "{{count}} settled row(s) have no gross on file (likely a deposit settled by hand whose amount_settled was never recorded) — the gross shown is a floor, not the total.",
"auditOurDeposits": "Our settled deposits (net / gross)",
"auditOurWithdrawals": "Our settled payouts (gross)",
```

The sweep:

```ts
// jobs/gateway-audit.ts:24-28 (docblock)
 * records the verdict on the row. Never moves money; the reconcile sweeps own
 * that. Also backfills `net_amount` where the gateway reports a net we never
 * received (TGPay's callback carries no fee; its query does).
// jobs/gateway-audit.ts:99-107 (deposit loop — backfills)
    await packs.updateGatewayDeposits({
      id: row.id,
      audited_at: now,
      audit_note: note,
      ...(row.net_amount == null && netAmount !== null && row.status === 'settled'
        ? { net_amount: netAmount }
        : {}),
    });
// jobs/gateway-audit.ts:154-158 (withdrawal loop — does not)
    await packs.updateGatewayWithdrawals({
      id: row.id,
      audited_at: now,
      audit_note: note,
    });
```

### Conventions

- Money in reports is integer **sen** (cents) until the final `/100`
  (`gateway-settlement.ts:6-7`). Row columns are 2-dp decimals via
  `toOptionalMoney`.
- NULL means UNKNOWN, never zero — every consumer counts the rows it
  excluded (`gateway-settlement.ts:9-25`).
- Vocabulary (CONTEXT.md §"Selling and cashing out"): a payout is a
  **Withdrawal**; what the customer receives is the withdrawal **amount**;
  the gateway's charge is the **fee**. This plan introduces no new term —
  `net_amount` keeps its column name; only its documented meaning per
  direction is fixed.
- Admin UI: `@medusajs/ui` primitives, copy via `t('settlement.*')` keys in
  `en.json`; the settlement table's floor hints (page.tsx 390-440) are the
  pattern for the panel.

## Commands you will need

| Purpose                                                     | Command                                                                                                                             | Expected on success                                         |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Backend typecheck                                           | `cd backend && corepack yarn check-types`                                                                                           | exit 0                                                      |
| Admin typecheck (real one — `tsc -p` is a false green here) | `cd backend/apps/admin && ../../node_modules/.bin/tsc -b`                                                                           | exit 0                                                      |
| Admin unit tests                                            | `cd backend && corepack yarn workspace @acme/admin test`                                                                            | all pass                                                    |
| Backend unit (filtered)                                     | `cd backend/packages/api && corepack yarn test:unit gateway-settlement gateway-audit gateway-withdrawal tgpay withdrawal/__tests__` | all pass                                                    |
| HTTP specs touching these rows                              | `cd backend/packages/api && node integration-tests/run-http-shards.mjs gateway-settlement tgpay-callback`                           | all pass (local `pokenic-postgres` up, no `DB_*` overrides) |
| Prettier (backend has no check script)                      | `cd backend && corepack yarn prettier --check "packages/api/src/**/*.ts" "apps/admin/src/**/*.{ts,tsx}"`                            | exit 0                                                      |

## Scope

**In scope** (the only files you should modify):

- `backend/packages/api/src/api/hooks/tgpay/withdrawal/route.ts`
- `backend/packages/api/src/modules/packs/gateway.ts` — `getWithdrawalDetail` in the tgpay adapter only
- `backend/packages/api/src/modules/packs/money.ts` — add a helper; do not change `netOfFee`'s arithmetic (see Step 1)
- `backend/packages/api/src/modules/packs/gateway-settlement.ts` — `toDirection` + header comment
- `backend/packages/api/src/modules/packs/service.ts` — `gatewayAuditTotals` only
- `backend/packages/api/src/api/admin/payments/audit/route.ts`
- `backend/packages/api/src/jobs/gateway-audit.ts` — withdrawal loop only
- `backend/apps/admin/src/lib/admin-rest.ts` — `GatewayAuditTotals` only
- `backend/apps/admin/src/routes/settlement/page.tsx` — audit panel only
- `backend/apps/admin/src/i18n/en.json` — keys named in Step 5
- `docs/payments/tgpay-setup.md` — one paragraph under "What the code does"
- Tests: `modules/packs/__tests__/gateway-settlement.unit.spec.ts`, `jobs/__tests__/gateway-audit.unit.spec.ts`, `api/hooks/tgpay/withdrawal/__tests__/route.unit.spec.ts`, `modules/packs/__tests__/gateway.unit.spec.ts` (or wherever the tgpay adapter's `getWithdrawalDetail` is pinned — `grep -rl "getWithdrawalDetail" backend/packages/api/src --include=*.spec.ts`), plus the admin vitest for the panel if one exists (`ls backend/apps/admin/src/routes/settlement/__tests__`).

**Out of scope** (do NOT touch, even though they look related):

- `gross` / `amount` / `amount_settled` semantics anywhere — `mergeSettlementPeriods`' ledger delta depends on gross = `amount`.
- `applyWithdrawalOutcome`, `refundWithdrawal`, `claimWithdrawalStatus` — the money movers; they only carry `netAmount` through.
- The deposit leg (`gateway-deposit.ts`, `hooks/tgpay/deposit`) — its net is already what we received.
- `gateway-reconcile.ts` / `withdrawal-reconcile.ts` — the reconcile sweep passes `detail.netAmount` through `applyWithdrawalOutcome`; it picks up Step 2's change with no edit (verify by reading, do not modify).
- Any migration — no column changes.
- The retired GlobePay rows (`gateway = 'globepay'`): their `net_amount` was written by a different gateway with its own convention; leave them and say so in the doc paragraph (Step 6).

## Git workflow

- Branch: `advisor/133-payout-net-amount`
- Conventional commits, e.g. `fix(payments): record a payout's net as what the wallet paid, not amount minus fee`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: One helper for the payout convention

`money.ts`: add beside `netOfFee`:

```ts
/**
 * What a payout COST our payout wallet: the recipient's amount plus the
 * gateway's fee (TGPay charges payout fees on top — a RM 50 payout with a
 * RM 1 fee drains 51; docs/payments/tgpay-setup.md "Verified 2026-09-05").
 * This is the payout direction's `net_amount`, so that the settlement fee is
 * |gross − net| in BOTH directions: deposits net = amount − fee (what we
 * received), payouts net = amount + fee (what we paid). NULL (unknown) when
 * either side is missing — never a zero fee by omission.
 */
export function payoutCost(amount: unknown, fee: unknown): number | null {
  const a = toOptionalMoney(amount);
  const f = toOptionalMoney(fee);
  return a === null || f === null ? null : Number((a + f).toFixed(2));
}
```

Leave `netOfFee` in place (it still describes deposits); update its docblock's
first line to "What we RECEIVED from a deposit: amount less the gateway's fee"
and remove the words "a payout cost us". Then grep: `grep -rn "netOfFee" backend/packages/api/src` — after Steps 2–3 the only non-test callers left must be deposit-side (or none). If any payout-side caller remains that this plan did not list, STOP.

**Verify**: `cd backend && corepack yarn check-types` → exit 0.

### Step 2: Callback and requery record the cost

`api/hooks/tgpay/withdrawal/route.ts:156`: `netAmount: payoutCost(data.amount, data.fee)`; rewrite the three-line comment: "net_amount on a payout is what the wallet PAID — amount + fee (TGPay charges on top). NULL when the callback omits the fee — never a zero fee by omission." Update the import.

`modules/packs/gateway.ts` tgpay `getWithdrawalDetail`: prefer the gateway's
own figure when present, fall back to the sum:

```ts
      netAmount:
        toOptionalMoney(q.order?.amountIncludeFee) ??
        payoutCost(q.order?.amount, q.order?.fee) ??
        NaN,
```

with the comment: "`amountIncludeFee` is what their wallet page shows; the
sum is the same number when both parts are present (verified on the
sandbox: 50 + 1 = 51)". Keep the `?? NaN` — `toOptionalMoney` turns NaN into
NULL on the row (existing contract, `gateway.ts:494-495`).

**Verify**: `cd backend/packages/api && corepack yarn test:unit "withdrawal/__tests__" gateway.unit` → the existing case `'a missing fee leaves net unknown (null), never a zero fee'` (`withdrawal/__tests__/route.unit.spec.ts:145`) still passes; any case asserting `net_amount: 49` for `{amount: 50, fee: 1}` now fails — update it to 51 (that is the point of the plan; note each such change in the commit body).

### Step 3: Settlement fee per direction

`gateway-settlement.ts` `toDirection` takes the row only; the direction is
known to the caller. Change the signature to
`toDirection(row, direction: 'deposit' | 'withdrawal')` and derive:

```ts
    fee:
      direction === 'deposit'
        ? (row.grossWithNetCents - row.netCents) / 100
        : (row.netCents - row.grossWithNetCents) / 100,
```

Update both call sites in the same file (grep `toDirection(`). Extend the
header comment (after the NULL rule) with a short **DIRECTION RULE**
paragraph: deposits net = received (≤ gross), payouts net = paid (≥ gross),
fee = |gross − net| over the known-net subset, and why gross is the ledger
anchor in both directions.

**Verify**: `cd backend/packages/api && corepack yarn test:unit gateway-settlement` → the case `'computes gross / net / fee in whole cents, converted once'` (line 27) — if it feeds a withdrawal bucket with net < gross it now reports a negative fee; fix the **fixture** to the new convention (net = gross + fee) and assert fee positive. Add the Step 7 cases.

### Step 4: `missing_gross` on the audit totals

`service.ts` `gatewayAuditTotals`:

- `Raw` gains `missing_gross: string`; `toTotals` gains `missingGross: Number(r.missing_gross)`.
- Deposit SQL: add `COUNT(*) FILTER (WHERE amount_settled IS NULL)::bigint AS missing_gross`.
- Withdrawal SQL: add `0::bigint AS missing_gross` (`amount` is NOT NULL; say so in a comment so nobody "fixes" it).
- The method's return type gains `missingGross: number` on both sides.

`api/admin/payments/audit/route.ts`: `SideTotals` gains `missingGross`;
`moneyTotals`' `side()` emits `missing_gross: s.missingGross`.

`backend/apps/admin/src/lib/admin-rest.ts` `GatewayAuditTotals`: add
`missing_gross: number;` with the doc `/** Settled deposits whose amount_settled is NULL (settled by hand) — `gross` is a FLOOR when > 0. */`.

**Verify**: `cd backend && corepack yarn check-types` → exit 0; `cd backend/apps/admin && ../../node_modules/.bin/tsc -b` → exit 0.

### Step 5: Render the floor on the panel

`backend/apps/admin/src/routes/settlement/page.tsx`, audit panel (from line
457): under the `auditOurDeposits` tile add the same hint the settlement
table uses when `audit.data.totals.deposits.missing_gross > 0`:
`t('settlement.grossFloorHint', { count })`, and when
`missing_net > 0`: `t('settlement.feeFloorHint', { count })`. Reuse the exact
JSX shape of the settlement table's hints at page.tsx 390-395 (read them; copy
the element and class names). Change the two tile labels in `en.json`:

- `auditOurDeposits`: "Our settled deposits (net received / gross)"
- `auditOurWithdrawals`: "Our settled payouts (gross / net paid incl. fee)"

and render the withdrawals tile with both numbers (`gross`, `net`) the way
the deposits tile already renders two (page.tsx 485-489).

**Verify**: `cd backend && corepack yarn workspace @acme/admin test` → pass; `cd backend/apps/admin && ../../node_modules/.bin/tsc -b` → exit 0.

### Step 6: Withdrawal loop backfills net

`jobs/gateway-audit.ts` withdrawal loop: mirror the deposit loop —
`updateGatewayWithdrawals({ id, audited_at, audit_note, ...(row.net_amount == null && netAmount !== null && row.status === 'settled' ? { net_amount: netAmount } : {}) })`,
where `netAmount` is `toOptionalMoney(detail.netAmount)` from the same
`answer` the deposit loop derives it from (read lines 60-100 for the exact
variable the deposit branch uses and copy the derivation). Update the
docblock at 24-28 to say **both** loops backfill.

This is also the repair path for payout rows written before this plan under
the old convention: they have a non-NULL (wrong) net, so the `== null` guard
skips them. Add a **second** condition, guarded to the payout direction and
to TGPay rows only:

```ts
      // Repair (plan 133): rows settled before 2026-09-10 stored net as
      // amount − fee. The gateway's figure is authoritative; overwrite when
      // it disagrees. Deposits never had the inverted convention — do not
      // mirror this there.
      ...(row.gateway === 'tgpay' && netAmount !== null && row.status === 'settled' &&
        toOptionalMoney(row.net_amount) !== netAmount
        ? { net_amount: netAmount }
        : {}),
```

Log one `logger.info` line per repaired row naming `merchant_transaction_id`,
old net and new net (money values only; no PII).

`docs/payments/tgpay-setup.md`, under "What the code does", add one
paragraph: `net_amount` on a payout row is the wallet cost (`amount + fee`,
their `amountIncludeFee`); on a deposit it is what we received; the hourly
audit sweep backfills or repairs a payout net from the query; `globepay` rows
keep whatever that gateway wrote and are not repaired.

**Verify**: `cd backend/packages/api && corepack yarn test:unit gateway-audit` → pass with the two new cases from Step 7.

### Step 7: Tests

See Test plan; then run the whole Commands table.

## Test plan

- `gateway-settlement.unit.spec.ts` (pure, no DB) — model after the existing
  cases at lines 27-72:
  - a withdrawal bucket `{ gross 5000, net 5100, grossWithNet 5000 }` → `fee 1.00`, `net 51.00`, `gross 50.00`.
  - a deposit bucket unchanged: `{ gross 5000, net 4900 }` → `fee 1.00`.
  - mixed: missingNet > 0 on the withdrawal side → fee is over the known subset only.
- `api/hooks/tgpay/withdrawal/__tests__/route.unit.spec.ts` — `{ amount: 50, fee: 1 }` on a `success` callback stores `net_amount: 51`; a missing fee stores NULL (existing case).
- tgpay adapter spec — `getWithdrawalDetail` with `order.amountIncludeFee: 51` → `netAmount 51`; with only `amount 50, fee 1` → 51; with neither → NaN.
- `jobs/__tests__/gateway-audit.unit.spec.ts` — model after `'stamps an agreeing row with no note and backfills the net the gateway reports'` (line 56): (a) a settled TGPay withdrawal with `net_amount: null` gets `net_amount` from the query; (b) a settled TGPay withdrawal with `net_amount: 49` and a query answering 51 is repaired to 51 with one info log; (c) a `globepay` row with a wrong net is **not** touched.
- `gatewayAuditTotals`: covered by the HTTP spec `gateway-settlement.spec.ts` if it drives `/admin/payments/audit` (grep it for `payments/audit`); if not, add one case there: seed one settled deposit with `amount_settled: null` → response `totals.deposits.missing_gross === 1` and `gross` excludes it.
- Admin panel: if `routes/settlement/__tests__` exists, one render test that the floor hint appears when `missing_gross > 0`; otherwise skip (presentational; the round's Playwright script `scripts/qa-tgpay-admin-audit.mjs` is the visual check — run it against a local stack only if one is already up; not required).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd backend && corepack yarn check-types` exits 0
- [ ] `cd backend/apps/admin && ../../node_modules/.bin/tsc -b` exits 0
- [ ] `cd backend/packages/api && corepack yarn test:unit gateway-settlement gateway-audit "withdrawal/__tests__" gateway.unit` exits 0, with ≥ 8 new assertions across the four files
- [ ] `grep -n "netOfFee(" backend/packages/api/src/api/hooks/tgpay/withdrawal/route.ts backend/packages/api/src/modules/packs/gateway.ts` → no matches in the withdrawal route; in `gateway.ts` only inside `getDepositDetail` (if at all)
- [ ] `grep -c "missing_gross" backend/packages/api/src/modules/packs/service.ts backend/packages/api/src/api/admin/payments/audit/route.ts backend/apps/admin/src/lib/admin-rest.ts` → each ≥ 1
- [ ] `grep -c "net_amount" backend/packages/api/src/jobs/gateway-audit.ts` → ≥ 3 (docblock, deposit loop, withdrawal loop)
- [ ] `grep -c "amount + fee\|amountIncludeFee" docs/payments/tgpay-setup.md` → ≥ 2 (the existing sandbox fact plus the new paragraph)
- [ ] `git status --porcelain` lists only in-scope files

## STOP conditions

Stop and report back (do not improvise) if:

- Any test or fixture in the repo encodes payout `net_amount = amount − fee`
  as a **product decision** (a comment citing an operator, a spec file under
  `docs/superpowers/specs/`, or an ADR) rather than as the derivation this
  plan corrects. The advisor found none; if you do, the convention needs the
  operator, not you.
- `mergeSettlementPeriods` or any consumer compares **net** (not gross)
  against the ledger `cashout` — changing net would then move a
  reconciliation delta and this plan's "gross is the anchor" premise is wrong.
- TGPay's payout callback turns out to carry `amountIncludeFee` in a live
  fixture (the doc says it does not): prefer it over the sum, mirror Step 2's
  requery order, and note the doc correction.
- The withdrawal loop in `jobs/gateway-audit.ts` does not have the query
  detail's `netAmount` available where the write happens (structure changed).

## Maintenance notes

- Reviewers: the one invariant to check is `gross` untouched in every SQL and
  every fixture. The ledger delta check keys on it.
- The repair branch in Step 6 is self-limiting (only overwrites when the
  gateway disagrees) but it is a **write to a settled money row from a
  sweep**. After it has run once in production (next hourly run after
  deploy), the operator should confirm via the audit panel that Σnet payouts
  moved by exactly 2 × Σfee for the affected rows and then may remove the
  repair branch in a follow-up — or keep it, since it is a no-op once rows
  agree. Record the decision in the plan's README row.
- If a second gateway with fee-deducted payouts (recipient gets amount − fee)
  is ever added, `payoutCost` is wrong for it; the adapter must supply the
  wallet cost directly and the DIRECTION RULE comment must name the
  exception.
- Deferred (unplanned CORRECTNESS-03): nothing asserts the gateway wallet is
  in MYR; `checkBalance` already returns `currencyCode`. A refusal in the
  admin switch when it is present and not `MYR` is a five-line follow-up —
  not this plan.
