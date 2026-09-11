# Plan 132: Held-withdrawal accountability — durable audit rows on approve/deny, a sweep refund reason that names the gateway's answer, a preflight that stops logging the key

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. Do NOT update
> `plans/README.md`; the reviewer maintains it.
>
> **Drift check (run first)**:
> `git diff --stat 1bc30e6b..HEAD -- backend/packages/api/src/modules/packs/gateway-withdrawal.ts backend/packages/api/src/modules/packs/service.ts backend/packages/api/src/modules/packs/models/admin-action-audit.ts backend/packages/api/src/modules/packs/models/gateway-withdrawal.ts backend/packages/api/src/jobs/withdrawal-reconcile.ts backend/packages/api/src/scripts/check-tgpay.ts backend/packages/api/src/modules/packs/migrations/`
> Expected on a branch cut from origin/master `51f74bcd`: `service.ts` (+126,
> partner groups — hunks at the `MedusaService` head and around
> `setPlayerGroup`, none inside `claimWithdrawalAgainstDebit` or `audit`),
> `models/admin-action-audit.ts` (+5: `customer_group` / `edit_group_policy`
> enum members) and a new `Migration20260909090000.ts`. Anything else
> changed → compare against the "Current state" excerpts; on a mismatch,
> STOP. Line numbers below are at `1bc30e6b`; on origin/master everything in
> `service.ts` after line ~1100 sits ~77 lines lower — **locate by symbol
> name, never by line number**.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW–MED — touches the two admin exits from `held`; the audit insert must ride the claim's transaction
- **Depends on**: none (131 makes its tests gate a merge; not a code dependency)
- **Category**: security / bug
- **Planned at**: commit `1bc30e6b` (working tree), 2026-09-10; drift-checked against origin/master `51f74bcd`

## Why this matters

Three small gaps on the live TGPay payout path, all on the same surface, all
cheap now that #560 moved the approve/deny bodies into the module:

1. **Approve submits a real bank transfer and deny appends a refund to the
   append-only ledger, and neither writes an `admin_action_audit` row.** The
   only record of _who_ and _why_ is a `logger.info` line. This repo has
   already paid for exactly that: `gateway-withdrawal.ts:618-625` records that
   on 2026-08-11 the codes for eight failed production payouts "were gone by
   the next morning" because DigitalOcean run logs cover only the current
   deployment. The gateway _switch_ in the same PR writes a proper audit row
   (`service.ts` `editPaymentGateway`, action `edit_payment_gateway`) and
   shipped a CHECK migration to allow it — the pattern is one call away.
2. **Every swept refund of a TGPay payout records the same reason string.**
   `withdrawal-reconcile.ts` derives the reason from `detail.statusId`, which
   is always `null` for TGPay (their statuses are strings; the column is
   numeric — `docs/payments/tgpay-setup.md:68-69`). So a payout the gateway
   explicitly answered `reject` and a payout that aged out with no record
   both get `sweep: stale with no gateway record`. Plan 095 added
   `failure_reason` precisely to keep those two apart.
3. **The documented post-deploy preflight logs 8 characters of the TGPay
   public key.** The mask was written for the sandbox's 51-character keys;
   production keys are 10 and 8 characters (`docs/payments/tgpay-setup.md:96-98`),
   so the "prefix" is most of the value, and it lands in run logs every time
   the operator runs the preflight the setup doc tells them to run.

After this plan: approve and deny each leave an `admin_action_audit` row with
the actor, the row id, the amount and the reason, written in the same
transaction as the status claim; a swept refund's `failure_reason` names what
the gateway actually said; the preflight logs the key's length, never its
characters.

## Current state

### Files

- `backend/packages/api/src/modules/packs/gateway-withdrawal.ts` (1,532 lines) — `submitHeldWithdrawal` (line 1093) and `denyHeldWithdrawal` (line 1425); the two admin exits from `held`.
- `backend/packages/api/src/modules/packs/service.ts` — `audit()` (protected, line 582), `claimWithdrawalAgainstDebit` (line 3418), `AdminAuditRow` type (line 525).
- `backend/packages/api/src/modules/packs/models/admin-action-audit.ts` — the `entity_type` and `action` enums.
- `backend/packages/api/src/modules/packs/migrations/Migration20260909090000.ts` — (origin/master only) the most recent CHECK-widening migration; the template for Step 2.
- `backend/packages/api/src/jobs/withdrawal-reconcile.ts` — the payout sweep; reason string at lines 260-270.
- `backend/packages/api/src/modules/packs/models/gateway-withdrawal.ts` — `gateway_status` column comment (lines 73-75).
- `backend/packages/api/src/scripts/check-tgpay.ts` — the preflight (46 lines).
- `backend/packages/api/src/api/admin/payments/withdrawals/[id]/{approve,deny}/route.ts` — thin routes; they pass `adminId: req.auth_context.actor_id` and need no change.

### Excerpts

`service.ts` — the audit helper every admin money mutation uses, and its row type:

```ts
// service.ts:525-534
export type AdminAuditRow = Pick<
  InferTypeOf<typeof AdminActionAudit>,
  | 'admin_id'
  | 'entity_type'
  | 'entity_id'
  | 'action'
  | 'before'
  | 'after'
  | 'reason'
>;

// service.ts:582-587
  protected async audit(
    row: AdminAuditRow,
    sharedContext: Context,
  ): Promise<void> {
    await this.createAdminActionAudits([row], sharedContext);
  }
```

`service.ts` — the exemplar this plan copies (the gateway switch):

```ts
// service.ts:723-734 (inside editPaymentGateway, an @InjectTransactionManager method)
await this.audit(
  {
    admin_id: input.adminId,
    entity_type: 'site_settings',
    entity_id: row?.id ?? 'singleton',
    action: 'edit_payment_gateway',
    before,
    after: data,
    reason: input.reason,
  },
  sharedContext,
);
```

`service.ts` — the claim both admin exits go through. It is
`@InjectTransactionManager`, takes the customer's `credit:` advisory lock,
reads the debit row, and flips the status **in the same transaction**:

```ts
// service.ts:3418-3439 (signature)
  @InjectTransactionManager()
  async claimWithdrawalAgainstDebit(
    input: {
      id: string;
      customerId: string;
      debitReference: string;
      from: readonly WithdrawalStatus[];
      to: WithdrawalStatus;
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ debited: boolean; claimed: boolean }> {

// service.ts:3485-3492 (the claim, inside the try)
      const claimed = await this.claimWithdrawalStatus(
        { id: input.id, from: input.from, to: debited ? input.to : 'failed' },
        sharedContext,
      );
      return { debited, claimed };
```

`gateway-withdrawal.ts` — approve, after the claim; the only accountability
write is a log line:

```ts
// gateway-withdrawal.ts:1235-1244
const { debited, claimed } = await packs.claimWithdrawalAgainstDebit({
  id: row.id,
  customerId: row.customer_id,
  debitReference: withdrawalIdempotencyReference(
    row.customer_id,
    row.merchant_transaction_id,
  ),
  from: ['held'],
  to: 'pending',
});
// gateway-withdrawal.ts:1273-1275
logger.info(
  `[payments] admin ${adminId} APPROVED withdrawal ${row.id} (${row.merchant_transaction_id}) — RM ${amount} to bank ${row.bank_code}`,
);
```

`gateway-withdrawal.ts` — deny, same shape (`from: ['held', 'failed'], to: 'failed'`), log at 1498-1500:

```ts
// gateway-withdrawal.ts:1486-1495
const { debited, claimed } = await packs.claimWithdrawalAgainstDebit({
  id: row.id,
  customerId: row.customer_id,
  debitReference: withdrawalIdempotencyReference(
    row.customer_id,
    row.merchant_transaction_id,
  ),
  from: ['held', 'failed'],
  to: 'failed',
});
```

`gateway-withdrawal.ts` imports the module service through a facet type:
`const packs = resolvePacks<GatewayWithdrawals>(scope);` — the facet is a
`Pick<PacksModuleService, ...>` in `modules/packs/facets.ts`. `audit()` is
`protected`, so these functions cannot call it directly; Step 3 threads the
audit row **into** `claimWithdrawalAgainstDebit` instead, which is also what
makes it transactional.

`withdrawal-reconcile.ts` — the reason string:

```ts
// withdrawal-reconcile.ts:110-116
      try {
        detail = await getWithdrawalDetail(
          withdrawal.merchant_transaction_id,
          config,
        );
        gatewayStatus = detail.statusId;
        action = withdrawalReconcileAction(detail.state);
// withdrawal-reconcile.ts:264-270
        // What the SWEEP knew when it closed this row (plan 095): the
        // gateway's own status number, or its absence when the payout went
        // stale with no record to requery. Without it a swept-closed row and
        // a submit-refused one look identical afterwards.
        gatewayStatus === null
          ? 'sweep: stale with no gateway record'
          : `sweep: requery statusId ${gatewayStatus}`,
```

`gateway.ts` — why `statusId` is always null for TGPay:

```ts
// gateway.ts:484-497 (tgpay adapter, getWithdrawalDetail)
    return {
      transactionId: q.order?.payoutRefNum ?? '',
      merchantTransactionId,
      statusId: null,
      status: q.status,
      ...
      state: tgpay.tgpayPayoutState(q.status),
```

`WithdrawalDetail` (`gateway-types.ts:120-132`) carries `statusId: number | null`,
`status: string` (the gateway's own word) and `state: SettlementState`.

`models/gateway-withdrawal.ts` — the stale comment:

```ts
// models/gateway-withdrawal.ts:73-75
    // Their raw numeric status from the last callback/requery (4 = success,
    // 5 = fail, else processing), for support.
    gateway_status: model.number().nullable(),
```

`check-tgpay.ts` — the leak:

```ts
// check-tgpay.ts:28-30
logger.info(
  `[tgpay-preflight] calling balance endpoints against ${config.baseUrl} as ${config.publicKey.slice(0, 8)}…`,
);
```

### The audit enums at origin/master

`models/admin-action-audit.ts` `entity_type` has no value for a gateway
withdrawal row; `action` has no approve/deny value. The DB CHECKs are only
rewritten by an explicit migration — `Migration20260906090000.ts:3-7` and
`Migration20260909090000.ts:4-8` both record learning this the hard way. The
latter is the template: it declares `ENTITY_TYPES_BEFORE/AFTER` and
`ACTIONS_BEFORE/AFTER` arrays, an `inList` helper, drops and re-adds both
constraints in `up()`, and in `down()` refuses to narrow while rows exist.

### Conventions

- Migrations: class `Migration<YYYYMMDDHHmmss>` in `modules/packs/migrations/`,
  `override async up()` / `down()`, raw SQL via `this.addSql(...)`, a header
  comment saying why. Destructive `down()` paths guard with a `DO $$ ... RAISE
EXCEPTION` block (see plan 019 / `destructive-migration-guard-recipe`).
- Unit specs: `*.unit.spec.ts` beside the code in `__tests__/`, jest, no DB.
  The held-withdrawal behaviour is pinned by
  `modules/packs/__tests__/held-withdrawal.integration.spec.ts` (real DB,
  `moduleIntegrationTestRunner`) — its `describe('denyHeldWithdrawal')` at
  line 546 already has a case named `'claims the row failed BEFORE
refunding, and audits the admin'` (line 547) — read it: "audits" there
  means the **log line**. Extend it rather than duplicating.
- Vocabulary (CONTEXT.md §"Selling and cashing out"): the row is a
  **Withdrawal**; the admin decision is **approve** / **deny**; `held` is the
  status awaiting that decision.

## Commands you will need

| Purpose                                 | Command                                                                                                   | Expected on success                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Backend typecheck                       | `cd backend && corepack yarn check-types`                                                                 | exit 0                                                                                                             |
| Backend lint                            | `cd backend && corepack yarn lint`                                                                        | exit 0 (if the turbo task dies locally, run `backend/node_modules/.bin/eslint packages/api/src` from `backend/`)   |
| Unit specs (filtered)                   | `cd backend/packages/api && corepack yarn test:unit gateway-withdrawal withdrawal-reconcile`              | all pass                                                                                                           |
| Module-integration spec (real local DB) | `cd backend/packages/api && corepack yarn test:integration:modules held-withdrawal`                       | all pass                                                                                                           |
| HTTP spec for the admin routes          | `cd backend/packages/api && node integration-tests/run-http-shards.mjs gateway-settlement tgpay-callback` | all pass (≤6 patterns per invocation; needs the local `pokenic-postgres` container up and NO `DB_*` env overrides) |
| Migration applies                       | `cd backend/packages/api && corepack yarn medusa db:migrate`                                              | exit 0 (may hang after "applied" — memory note; Ctrl-C once you see the migration name applied)                    |

## Scope

**In scope** (the only files you should modify):

- `backend/packages/api/src/modules/packs/models/admin-action-audit.ts`
- `backend/packages/api/src/modules/packs/migrations/Migration20260910100000.ts` (create)
- `backend/packages/api/src/modules/packs/service.ts` — `claimWithdrawalAgainstDebit` only
- `backend/packages/api/src/modules/packs/gateway-withdrawal.ts` — `submitHeldWithdrawal`, `denyHeldWithdrawal` only
- `backend/packages/api/src/modules/packs/facets.ts` — only if the `GatewayWithdrawals` facet type needs `claimWithdrawalAgainstDebit`'s new signature (it is a `Pick`, so probably not)
- `backend/packages/api/src/jobs/withdrawal-reconcile.ts` — the reason string only
- `backend/packages/api/src/modules/packs/models/gateway-withdrawal.ts` — comment only
- `backend/packages/api/src/scripts/check-tgpay.ts`
- `backend/packages/api/src/modules/packs/__tests__/held-withdrawal.integration.spec.ts`
- `backend/packages/api/src/jobs/__tests__/withdrawal-reconcile.unit.spec.ts` (exists as `*reconcile*.unit.spec.ts` under `modules/packs/__tests__/` or `jobs/__tests__/` — find with `ls backend/packages/api/src/**/__tests__/*withdrawal-reconcile*`)
- `backend/packages/api/src/modules/packs/__tests__/gateway-withdrawal.unit.spec.ts`

**Out of scope** (do NOT touch, even though they look related):

- The approve/deny **routes** — they already pass `adminId`; the audit belongs in the module.
- `refundWithdrawal`, `applyWithdrawalOutcome`, `withdrawForCashout`, `claimWithdrawalStatus` — the money movers. This plan adds a row _beside_ the claim; it does not touch how money moves.
- The `failure_reason` first-writer-wins rule (`gateway-withdrawal.ts` refund path) — unchanged.
- The admin SPA (`backend/apps/admin`) — the audit timeline already renders every `admin_action_audit` row generically; no UI change needed. If it turns out to filter by `entity_type`, report it in Maintenance notes, do not extend scope.
- `payer-ip.ts`, the allowlist, the callbacks — separate finding (plan 136 / unplanned SECURITY-03).

## Git workflow

- Branch: `advisor/132-held-withdrawal-audit`
- Commits per step, conventional style, e.g. `feat(payments): audit held-withdrawal approve and deny in the claim transaction`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Widen the model enums

In `models/admin-action-audit.ts`:

- `entity_type`: add `'gateway_withdrawal'` after `'customer_group'`, with a
  one-line comment `// Held-withdrawal approve/deny (plan 132).`
- `action`: add `'approve_withdrawal'` and `'deny_withdrawal'` after
  `'edit_group_policy'`, same comment.

**Verify**: `cd backend && corepack yarn check-types` → exit 0 (the enum widening compiles; nothing uses the values yet).

### Step 2: Write the CHECK migration

Create `modules/packs/migrations/Migration20260910100000.ts` by copying
`Migration20260909090000.ts` (read it from origin/master: `git show origin/master:backend/packages/api/src/modules/packs/migrations/Migration20260909090000.ts`) and editing:

- Header comment: "Plan 132: submitHeldWithdrawal / denyHeldWithdrawal write
  an admin_action_audit row with entity_type 'gateway_withdrawal' and action
  'approve_withdrawal' | 'deny_withdrawal'. The model enums gained the values;
  the DB CHECKs are only rewritten by an explicit migration."
- `ENTITY_TYPES_BEFORE` = the 20 values that migration's `ENTITY_TYPES_AFTER` produced (its BEFORE list plus `'customer_group'`); `ENTITY_TYPES_AFTER = [...ENTITY_TYPES_BEFORE, 'gateway_withdrawal']`.
- `ACTIONS_BEFORE` = that migration's `ACTIONS_AFTER` (its BEFORE list plus `'edit_group_policy'`); `ACTIONS_AFTER = [...ACTIONS_BEFORE, 'approve_withdrawal', 'deny_withdrawal']`.
- `down()` guard: `WHERE action IN ('approve_withdrawal','deny_withdrawal') OR entity_type = 'gateway_withdrawal'`, exception text `admin_action_audit holds approve/deny withdrawal rows; refusing to narrow the CHECKs`.
- Class name `Migration20260910100000`.

Do NOT regenerate `.snapshot-packs.json` with `db:generate` — a CHECK on an
enum column is not represented there (the two predecessor migrations did not
touch it either; verify with `git show origin/master --stat -- backend/packages/api/src/modules/packs/migrations/.snapshot-packs.json`
— the 2026-09-09 snapshot change came from the partner-groups model, not the CHECK).

**Verify**: `cd backend/packages/api && corepack yarn medusa db:migrate` → the
new migration name appears as applied. Then, read-only, confirm the CHECK
now contains the new values:

```
psql "$DATABASE_URL" -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='admin_action_audit_action_check'"
```

→ output contains `'approve_withdrawal'` and `'deny_withdrawal'`. (If `psql`
is unavailable, `docker exec pokenic-postgres psql -U medusa -d medusa -c "..."`.)

### Step 3: Thread an optional audit row through the claim

In `service.ts`, `claimWithdrawalAgainstDebit`:

- Add to `input` an optional `audit?: Omit<AdminAuditRow, 'entity_type' | 'entity_id'>`.
- Inside the `try`, **after** `claimed` is computed and **only when
  `claimed === true`**, write the row in the same transaction:

```ts
if (claimed && input.audit) {
  await this.audit(
    {
      ...input.audit,
      entity_type: 'gateway_withdrawal',
      entity_id: input.id,
    },
    sharedContext,
  );
}
return { debited, claimed };
```

- Update the method's docblock: one paragraph saying the audit row rides the
  claim's transaction so a CHECK violation or any insert failure rolls the
  claim back (a status flip with no record, or a record with no flip, are
  both impossible).

Do not move the `return`, the lock, the `SET LOCAL lock_timeout`, or the
55P03 translation.

**Verify**: `cd backend && corepack yarn check-types` → exit 0.

### Step 4: Pass the row from approve and deny

`gateway-withdrawal.ts`:

`submitHeldWithdrawal` — extend the claim call:

```ts
const { debited, claimed } = await packs.claimWithdrawalAgainstDebit({
  id: row.id,
  customerId: row.customer_id,
  debitReference: withdrawalIdempotencyReference(
    row.customer_id,
    row.merchant_transaction_id,
  ),
  from: ['held'],
  to: 'pending',
  audit: {
    admin_id: adminId,
    action: 'approve_withdrawal',
    before: { status: row.status },
    after: { status: 'pending', amount, bank_code: row.bank_code },
    reason: `approved held withdrawal ${row.merchant_transaction_id} (RM ${amount})`,
  },
});
```

`denyHeldWithdrawal` — same, with `action: 'deny_withdrawal'`,
`after: { status: 'failed', amount: Number(row.amount) }`, reason
`` `denied held withdrawal ${row.merchant_transaction_id} (RM ${Number(row.amount)})` ``.

Rules:

- `before`/`after` are `Record<string, unknown>` JSON columns — keep them to
  status + amount + bank code. **Never** include `account_number` or
  `account_holder_name` (the existing spec `'logs the actor and the row, and
NEVER the account number'` at line 529 pins that for logs; extend it to the
  audit row in Step 6).
- The approve row's `after.status` is `'pending'` even though the submit may
  later refuse and refund — the row records the operator's decision, not the
  outcome. Say so in a comment. The outcome is on the withdrawal row itself
  (`status`, `failure_reason`).
- Keep the two `logger.info` lines; they are still the fastest thing to grep
  during an incident.

**Verify**: `cd backend/packages/api && corepack yarn test:unit gateway-withdrawal` → all pass (the existing unit suite drives these functions through a fake `packs` — the fake's `claimWithdrawalAgainstDebit` must accept the new field; adjust the fake, not the assertion).

### Step 5: Name the gateway's answer in the sweep's refund reason

`withdrawal-reconcile.ts`: the loop already has `detail` (typed
`WithdrawalDetail | null`) in scope where the reason is built. Replace the
ternary at lines ~268-270 with:

```ts
        detail
          ? `sweep: requery said ${detail.status || detail.state}` +
            (gatewayStatus !== null ? ` (statusId ${gatewayStatus})` : '')
          : 'sweep: stale with no gateway record',
```

and adjust the comment above it: the gateway's own status **word** (TGPay)
or number (a gateway that has one), or its absence when the payout went
stale with no record to requery. Confirm `detail` is `null` on the
not-found branch and non-null on the reject branch by reading the `try/catch`
above (lines ~110-140) — if `detail` is not in scope at the reason site, hoist
it (declare `let detail: WithdrawalDetail | null = null;` before the try).

`models/gateway-withdrawal.ts:73-75`: rewrite the comment: "Their raw numeric
status from the last callback/requery, for gateways that have one (GlobePay:
4 = success, 5 = fail). NULL for every gateway whose statuses are strings —
TGPay — so support reads `failure_reason` / `audit_note` instead."

**Verify**: `cd backend/packages/api && corepack yarn test:unit withdrawal-reconcile` → all pass after Step 7's new case is added. `jobs/__tests__/withdrawal-reconcile.unit.spec.ts:439` asserts the stale literal for the not-found branch — it stays valid. The literal `'sweep: requery statusId 5'` at `held-withdrawal.integration.spec.ts:613,623` and `withdrawal-forensics.integration.spec.ts:90,97` is **fixture data** (a pre-set `failure_reason` used to prove deny keeps the first writer's reason) — do NOT change those; they are not the sweep's output.

### Step 6: Stop logging the key

`check-tgpay.ts:28-30` — replace the template with:

```ts
    `[tgpay-preflight] calling balance endpoints against ${config.baseUrl} (public key: ${config.publicKey.length} chars)`,
```

Add a one-line comment: production keys are 8–10 characters, so a prefix
would be the key. Then, in your completion report, add this operator note
verbatim: "The pre-fix preflight logged an 8-character prefix of the TGPay
public key on every run since 2026-09-06. If any DigitalOcean run log from
that window was exported, pasted into a ticket or shared outside the
operator's own console, rotate the TGPay key pair from the back office (both
keys — the pair authenticates their callbacks to us)."

**Verify**: `grep -n "publicKey.slice\|publicKey.substring\|publicKey}" backend/packages/api/src/scripts/check-tgpay.ts` → no matches.

### Step 7: Tests

See Test plan. Run the full filtered set.

**Verify**: all four commands in the Commands table that run tests → pass.

## Test plan

- `modules/packs/__tests__/held-withdrawal.integration.spec.ts` (real DB —
  the CHECK is what makes this the right layer):
  - extend `'submits the row's OWN stored destination, stamps the gateway id and moves no money'` (line 218) — after approve, `listAdminActionAudits({ entity_id: row.id })` returns exactly one row with `action: 'approve_withdrawal'`, `admin_id` = the actor, `entity_type: 'gateway_withdrawal'`, and `JSON.stringify(row.after)` does **not** contain the account number.
  - extend `'a double approve submits exactly ONCE — the second loses the claim'` (line 267) — exactly one audit row after two approves (the loser never claimed).
  - extend `'claims the row failed BEFORE refunding, and audits the admin'` (line 547) — one `deny_withdrawal` row.
  - extend `'is re-runnable on its OWN failed row and credits exactly once'` (line 584) — a re-run deny writes a **second** audit row (it re-claims `failed → failed`, and `claimed` is true) — assert count 2 and say in the test name that a re-run is a new decision.
  - new: `'an audit insert failure rolls the claim back'` — stub `createAdminActionAudits` on the service to throw, call deny, assert the row is still `held` and no refund was written. (This is the transactional property; if the module test runner makes stubbing the protected method impractical, assert it instead via a spy on `claimWithdrawalStatus` + `audit` ordering in `gateway-withdrawal.unit.spec.ts` and note the substitution.)
- `withdrawal-reconcile` unit spec: a `reject` requery on a TGPay row records `failure_reason` starting `sweep: requery said reject`; a not-found requery still records `sweep: stale with no gateway record`.
- Pattern to copy for DB assertions: the existing cases in `held-withdrawal.integration.spec.ts` (they read rows back through `packs.listGatewayWithdrawals` and the ledger through `listCreditTransactions`).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd backend && corepack yarn check-types` exits 0
- [ ] `cd backend/packages/api && corepack yarn test:unit gateway-withdrawal withdrawal-reconcile` exits 0
- [ ] `cd backend/packages/api && corepack yarn test:integration:modules held-withdrawal` exits 0, with ≥ 5 new/extended assertions on `admin_action_audit`
- [ ] `grep -c "approve_withdrawal" backend/packages/api/src/modules/packs/models/admin-action-audit.ts backend/packages/api/src/modules/packs/migrations/Migration20260910100000.ts backend/packages/api/src/modules/packs/gateway-withdrawal.ts` → each ≥ 1
- [ ] `grep -n "stale with no gateway record" backend/packages/api/src/jobs/withdrawal-reconcile.ts` → exactly 1 match, and `grep -c "requery said" backend/packages/api/src/jobs/withdrawal-reconcile.ts` → 1
- [ ] `grep -c "publicKey.slice" backend/packages/api/src/scripts/check-tgpay.ts` → 0
- [ ] `grep -rn "account_number\|account_holder_name" backend/packages/api/src/modules/packs/gateway-withdrawal.ts | grep -i "audit\|after:"` → no matches (no PII in the audit payload)
- [ ] `git status --porcelain` lists only in-scope files
- [ ] The completion report contains the Step 6 rotation note verbatim

## STOP conditions

Stop and report back (do not improvise) if:

- `claimWithdrawalAgainstDebit` no longer returns `{ debited, claimed }` from inside the `try`, or `audit()` is no longer `protected async audit(row, sharedContext)` — the transactional threading in Step 3 assumes both.
- `Migration20260909090000.ts` is absent from your branch (you are not on origin/master's lineage — the CHECK lists in Step 2 would be wrong).
- A migration newer than `20260909090000` exists that also rewrites `admin_action_audit_action_check` — its lists must be your BEFORE lists; report and wait.
- The `held-withdrawal.integration.spec.ts` suite is red **before** your change (baseline: it is green at `1bc30e6b` — the advisor ran the unit tier; run this suite once untouched first).
- `docker ps` shows no `pokenic-postgres` — the integration tier cannot run; report rather than skipping Step 7.

## Maintenance notes

- Any future exit from `held` (a third route, a script) must pass an `audit`
  row into `claimWithdrawalAgainstDebit`, or it will be the next unrecorded
  money decision. Reviewers: grep for `from: ['held'` and check `audit:` is
  beside it.
- The admin action timeline (`backend/apps/admin`, "Admin action timeline"
  panel) renders rows generically; if a future change filters it by
  `entity_type`, add `gateway_withdrawal`.
- Deferred, deliberately: a `reason` field typed by the operator on approve
  (the gateway switch has one). Approve today is a one-click button; adding
  a required reason is a UI change the operator should decide. The audit row
  carries a generated reason so the record exists either way.
- Deferred: the same audit-row treatment for the customer-initiated
  `withdrawForCashout` path is unnecessary — the ledger row _is_ its record.
- Deferred (unplanned finding SECURITY-03): an IPv6 or unparseable callback
  source is logged as `not-listed`; a distinct `unparseable-source` verdict
  would help incident triage. Not this plan.
