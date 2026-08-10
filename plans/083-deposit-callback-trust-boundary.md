# Plan 083: Bound the credited deposit amount, and validate the signed MerchantCode on every hook route

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat db2767f5..HEAD -- backend/packages/api/src/api/hooks/globepay backend/packages/api/src/modules/packs/globepay-deposit.ts backend/packages/api/src/modules/packs/globepay-reconcile.ts backend/packages/api/src/jobs/globepay-reconcile.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `db2767f5`, 2026-08-07

## Why this matters

Two gaps in what the GlobePay365 callback is trusted to tell us. Neither is
exploitable without the gateway's private key today — the signature
verification is sound and fails closed — but both are the difference between
"one bad event" and "unbounded loss", and both fixes are a few lines.

**1. The credited amount has no ceiling.** The settled-deposit callback credits
`data.Amount` after checking only that it is finite and positive. The submit
path caps a top-up at RM 10,000 (`GLOBEPAY_MAX_RM`); the callback path caps
nothing, and neither does `mutateCreditAtomic`, whose only top-up-side guard is
`deltaCents > 0`. Any single event producing a validly-signed callback with an
inflated amount — a gateway-side bug, a key compromise, a merchant-account
reconfiguration — converts one-for-one into spendable balance. Since #376
armed production withdrawals, that balance is convertible to real cash with no
ceiling anywhere in between. The reconcile sweep has the same hole: its
`settle` action credits `Number(detail.amount)` from the requery with no bound.

The sibling `payout-verify` route already demonstrates the right instinct — it
cross-checks the amount against the recorded row before letting money move.

**2. The signed `MerchantCode` is never read.** All three hook routes declare
`MerchantCode: string` on the signed payload type and none of them compares it
to the configured merchant. The sibling field `CurrencyCode` **is** validated,
with an explicit comment about guarding against the account being
reconfigured. The one signed field that says "this money is yours" gets no such
guard. If GlobePay signs callbacks with a platform-wide key rather than a
per-merchant key, a callback describing a payment into a _different_ merchant
account would verify here. Whether that is true is unknown (see STOP
conditions) — but the check is one comparison and is correct regardless.

After this plan: a callback cannot credit more than the deposit path could ever
have created, and every hook route refuses a callback addressed to a different
merchant.

## Current state

Files and roles:

- `backend/packages/api/src/api/hooks/globepay/deposit/route.ts` — the deposit
  callback. Amount validation at 217-226; `MerchantCode` declared at :40,
  never read.
- `backend/packages/api/src/api/hooks/globepay/withdrawal/route.ts` —
  `MerchantCode` declared at :33, never read.
- `backend/packages/api/src/api/hooks/globepay/payout-verify/route.ts` —
  `MerchantCode` declared at :17 and :24, never read. Its amount cross-check
  at :66-83 is the pattern to admire, not to change.
- `backend/packages/api/src/modules/packs/globepay-deposit.ts` — the submit
  path; the caps live at :46-47 and are enforced at :131-136.
- `backend/packages/api/src/modules/packs/globepay-reconcile.ts` —
  `reconcileAction`; its `settle` branch returns the requery's amount.
- `backend/packages/api/src/modules/packs/globepay-client.ts` — `config` is
  built here; `config.merchantCode` is already loaded at :46.

### The amount check today (`hooks/globepay/deposit/route.ts:217-226`, verbatim)

```ts
const creditedAmount = Number(data.Amount);
if (!Number.isFinite(creditedAmount) || creditedAmount <= 0) {
  req.scope
    .resolve('logger')
    .error(
      `[globepay] settled callback for ${merchantTransactionId} carried a non-positive Amount (${data.Amount}) — refusing to credit`,
    );
  res.status(400).send('rejected');
  return;
}
```

That is the entire bound on money entering the system through this route.

### The decision it must respect (`hooks/globepay/deposit/route.ts:195-201`, verbatim)

```ts
// 4) Settled. Credit the amount THEY confirmed, not the amount we requested —
// a customer can pay a different sum than the one the top-up sheet asked for,
// and the ledger must reflect money actually received.
```

**This is a recorded decision and stays.** The fix is a _ceiling_, not an
equality check against `amount_requested`.

### The sibling guard to mirror (`hooks/globepay/deposit/route.ts:207-215`, verbatim)

```ts
if (data.CurrencyCode !== config.currencyCode) {
  req.scope
    .resolve('logger')
    .error(
      `[globepay] settled callback for ${merchantTransactionId} is ${data.CurrencyCode}, expected ${config.currencyCode} — refusing to credit`,
    );
  res.status(400).send('rejected');
  return;
}
```

Your `MerchantCode` guard goes immediately beside this one, in the same shape.

### The submit-path caps (`globepay-deposit.ts:46-47`, verbatim)

```ts
export const GLOBEPAY_MIN_RM = 30;
export const GLOBEPAY_MAX_RM = 10000;
```

### The sweep's uncapped settle (`globepay-reconcile.ts`, `reconcileAction`, verbatim)

```ts
if (input.state === 'success') {
  // Trust the requery's amount over our requested one, for the same reason
  // the callback path does: the customer may have paid a different sum.
  return { kind: 'settle', amount: input.amount };
}
```

### Repo conventions to match

- `/hooks/*` routes answer a **gateway**, not a browser: they use
  `res.status(...).send('rejected' | 'success' | 'error')` rather than throwing
  `MedusaError`. Match the surrounding style exactly.
- Every refusal logs with the `[globepay]` prefix and the
  `merchantTransactionId`. Never log signatures, keys, or full payloads.
- Comments state the why and name the alternative that was rejected. Match the
  density of the surrounding blocks.
- Backend source is Prettier-formatted with single quotes; keep diffs narrow.

## Commands you will need

| Purpose           | Command                                                                                                                      | Expected on success |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Backend typecheck | `cd backend/packages/api && corepack yarn check-types`                                                                       | exit 0              |
| Hook route tests  | `cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest globepay --runInBand --forceExit` | all pass            |
| Backend unit tier | `cd backend/packages/api && corepack yarn test:unit`                                                                         | all pass            |
| Backend lint | NONE. `backend/packages/api` has no eslint config and no `lint` script, so `turbo run lint` skips it and CI never lints this package. Do NOT author one — out of scope. | n/a |

## Scope

**In scope**:

- `backend/packages/api/src/api/hooks/globepay/deposit/route.ts`
- `backend/packages/api/src/api/hooks/globepay/withdrawal/route.ts`
- `backend/packages/api/src/api/hooks/globepay/payout-verify/route.ts`
- `backend/packages/api/src/modules/packs/globepay-reconcile.ts` (the
  `settle` bound only)
- `backend/packages/api/src/jobs/globepay-reconcile.ts` (only if the bound
  must be applied at the call site rather than in `reconcileAction`)
- The matching `__tests__` specs beside each of the above (extend)
- `plans/README.md` (status row)

**Out of scope**:

- The signature/decrypt chain in `globepay.ts` and `globepay-client.ts`. It is
  correct and fails closed; do not touch it.
- The "credit what they confirmed, not what we requested" decision. Do not
  replace the ceiling with an equality check.
- The blanket-`400`-means-not-found bug in both sweeps — that is plan 084.
- `mutateCreditAtomic`'s `deltaCents > 0` guard. A global top-up ceiling in the
  service would also constrain admin credits and rewards; the ceiling belongs
  at the gateway boundary.

## Git workflow

- Branch: `advisor/083-deposit-callback-trust`
- Conventional commits, e.g.
  `fix(payments): cap the credited deposit amount and check the signed MerchantCode`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the merchant-code guard to all three hook routes

Immediately after `openCallback` returns the verified payload (and, in the
deposit route, beside the existing `CurrencyCode` check), compare the signed
`MerchantCode` against `config.merchantCode`.

- Compare case-insensitively (`toUpperCase()` both sides) — a casing
  difference between the configured value and what they echo is a
  configuration nuisance, not an attack, and a case-sensitive compare would
  reject legitimate traffic.
- On mismatch: log with the `[globepay]` prefix, the
  `merchantTransactionId`, and both codes; respond `400` / `'rejected'`.
- Write a comment stating what the check is for: the callback is authenticated
  by the RSA signature, but the signature says "GlobePay sent this", not "this
  payment is yours" — `MerchantCode` is the field that says the latter.

Apply the identical guard in all three routes. Do not factor it into a shared
helper unless the three call sites turn out to be byte-identical after you
write them; three four-line guards in three files is clearer than an
indirection here.

**Verify**: `corepack yarn check-types` → exit 0, and
`grep -rn "MerchantCode" backend/packages/api/src/api/hooks/ | grep -v __tests__ | grep -v ": *string"`
returns three comparison sites.

### Step 2: Cap the credited amount in the deposit callback

Extend the existing amount check so that an amount above `GLOBEPAY_MAX_RM` is
refused. Requirements:

- Import `GLOBEPAY_MAX_RM` from `globepay-deposit.ts` rather than re-declaring
  a number.
- **Quarantine, do not write off.** On an over-cap amount: log loudly (this is
  an operator alert, not routine), leave the row `pending` so a human can
  settle it manually, and respond with a **non-2xx** so the gateway retries
  and the event is not silently swallowed. Do **not** mark the row `failed` —
  the customer may genuinely have paid.
- Place the check after the existing non-positive check, so the two log lines
  stay distinguishable.

**Verify**: `corepack yarn check-types` → exit 0;
`grep -n "GLOBEPAY_MAX_RM" backend/packages/api/src/api/hooks/globepay/deposit/route.ts`
returns a match.

### Step 3: Apply the same ceiling to the reconcile sweep's settle path

`reconcileAction`'s `success` branch returns the requery's amount unbounded.
Add the same ceiling there. Prefer putting the bound in `reconcileAction`
(pure function, easy to test); if that turns out to need config the pure
function should not have, apply it at the call site in
`jobs/globepay-reconcile.ts` instead and say why in a comment.

An over-cap requery result must **not** settle and must **not** write the row
off — it should log loudly and leave the row for the next sweep, matching
Step 2's quarantine posture.

**Verify**: `corepack yarn check-types` → exit 0; the ceiling appears in
`grep -rn "GLOBEPAY_MAX_RM" backend/packages/api/src/modules/packs/globepay-reconcile.ts backend/packages/api/src/jobs/globepay-reconcile.ts`.

### Step 4: Tests

See "Test plan", then run the gates.

## Test plan

Extend the existing specs; read each before adding to it:

- `backend/packages/api/src/api/hooks/globepay/deposit/__tests__/route.unit.spec.ts`
- `backend/packages/api/src/api/hooks/globepay/withdrawal/__tests__/route.unit.spec.ts`
- `backend/packages/api/src/api/hooks/globepay/payout-verify/__tests__/route.unit.spec.ts`
- `backend/packages/api/src/modules/packs/__tests__/globepay-reconcile.unit.spec.ts`

These specs already build a signed-callback fixture with
`MerchantCode: 'Testpolycard'` — reuse it.

Cases (all required):

1. Deposit callback with `MerchantCode` **not** matching config → 400, no
   credit (assert the credit function was not called).
2. Deposit callback with `MerchantCode` differing only in **case** →
   succeeds (proves the compare is case-insensitive).
3. Same mismatch case for the withdrawal route and for payout-verify — one
   each.
4. Deposit callback with `Amount` above `GLOBEPAY_MAX_RM` → non-2xx, no
   credit, **row still `pending`** (assert the update was not called with
   `status: 'failed'`).
5. Deposit callback with `Amount` exactly at `GLOBEPAY_MAX_RM` → credits
   normally (boundary, off-by-one guard).
6. `reconcileAction` with `state: 'success'` and an over-cap amount → does not
   return `settle`.

Prove case 1 red-green: comment out the new guard, confirm the test fails,
restore it, confirm it passes. Report both.

Verification:
`cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules npx jest globepay --runInBand --forceExit`
→ all pass including the six new cases.

## Done criteria

- [ ] `cd backend/packages/api && corepack yarn check-types` exits 0
- [ ] `cd backend/packages/api && corepack yarn test:unit` exits 0
- [ ] All three hook routes compare `MerchantCode` (grep from Step 1 shows three sites)
- [ ] `grep -rn "GLOBEPAY_MAX_RM" backend/packages/api/src/api/hooks backend/packages/api/src/modules/packs/globepay-reconcile.ts backend/packages/api/src/jobs/globepay-reconcile.ts` returns matches in both the callback and the sweep
- [ ] The over-cap deposit path leaves the row `pending` (asserted by test 4)
- [ ] The red-green proof for test 1 is reported
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- An existing spec or fixture posts a callback with a `MerchantCode` that does
  **not** match what `globepayConfigFromEnv()` produces under the test env. That
  would mean the guard breaks the suite for a reason worth understanding
  before you paper over it — report the fixture rather than editing it to fit.
- `GLOBEPAY_MAX_RM` turns out to be smaller than the largest deposit ever
  actually settled in production. You cannot check this from the repo; if you
  have any evidence it is close, report it — a ceiling below real traffic
  quarantines genuine payments.
- You find a **fourth** hook route or another writer of `reason: 'topup'` from
  gateway input.

## Maintenance notes

- **The ceiling is a tripwire, not a business rule.** It equals the submit-path
  maximum by construction. If `GLOBEPAY_MAX_RM` is ever raised for product
  reasons, the callback ceiling follows automatically because it imports the
  same constant — that coupling is deliberate; do not fork the value.
- **Quarantine, never write off.** Both new refusal paths deliberately leave
  the row `pending`. A future refactor that "tidies" them into `failed` would
  turn an operator alert into silent money loss.
- Whether `MerchantCode` is exploitable depends on GlobePay's key scoping,
  which is not knowable from this repo. Plan 093 puts that question on the
  operator checklist. The guard is worth having either way.
- A reviewer should scrutinize: the case-insensitive compare, that the over-cap
  branch does not mark rows failed, and that the boundary test uses exactly
  `GLOBEPAY_MAX_RM` rather than a hardcoded 10000.
