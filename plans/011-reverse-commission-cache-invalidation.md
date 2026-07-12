# Plan 011: Refresh balance + transactions views after an admin commission reversal

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> "STOP conditions" item occurs, stop and report — do not improvise. When done,
> update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat e9ce6968..HEAD -- backend/apps/admin/src/lib/queries.ts backend/apps/admin/src/lib/query-keys.ts`
> If either file changed, re-read it and compare against the "Current state"
> excerpts before editing; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `e9ce6968`, 2026-07-12

## Why this matters

Reversing a commission on the Customer360 screen inserts a **negative** credit
transaction (a clawback) per beneficiary and can auto-freeze the account if the
balance goes negative. But the `useReverseCommission` mutation invalidates only
the commissions and audit query keys — **not** the customer's balance
(`customerGacha`) or the transactions ledger (`customerTransactionsKey`). So
after a reversal, the Customer360 header keeps showing the pre-clawback balance
(and can show a positive balance for an account the reversal just froze), and
the clawback row is missing from the transactions view until a manual refresh.
On the exact screen used for fraud review, showing a stale balance is a
correctness and trust problem. The fix is two extra invalidations.

## Current state

- `backend/apps/admin/src/lib/queries.ts:427-444` — `useReverseCommission`
  invalidates commissions + audit only:

  ```ts
  export const useReverseCommission = () => {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (vars: {
        commId: string;
        customerId: string;
        reason: string;
      }) => reverseCommission(vars.commId, vars.reason),
      onSuccess: (_data, vars) => {
        toast.success('Commission reversed');
        qc.invalidateQueries({
          queryKey: qk.customerCommissionsKey(vars.customerId),
        });
        qc.invalidateQueries({
          queryKey: qk.customerAuditKey(vars.customerId),
        });
      },
      onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
    });
  };
  ```

  (`qk` is the query-keys import; confirm the alias name in the file's imports.)

- `backend/apps/admin/src/lib/query-keys.ts` — the keys to add:

  ```ts
  customerGacha: (id: string) => ['admin', 'customer', id, 'gacha'] as const,          // :13
  customerTransactionsKey: (id: string) => [...],                                        // :30
  ```

  The Customer360 header balance is read via `useCustomerGacha` (the `gacha`
  view's `balance` field), and the support/transactions ledger via
  `customerTransactionsKey`.

- `reverseCommission` writes the negative `credit_transaction` in the backend
  (`backend/packages/api/src/modules/packs/service.ts:1182-1195`) and may
  auto-freeze (`service.ts:1218-1228`) — this is why the balance view goes stale.
  You do not need to change the backend; only broaden the client invalidation.

## Commands you will need

| Purpose               | Command                                    | Expected |
| --------------------- | ------------------------------------------ | -------- |
| Admin build/typecheck | from `backend/apps/admin`: `npm run build` | exit 0   |
| Admin tests           | from `backend/apps/admin`: `npm test`      | all pass |

## Scope

**In scope:**

- `backend/apps/admin/src/lib/queries.ts` (broaden `useReverseCommission` invalidation only)
- `plans/README.md` (this plan's status row only)

**Out of scope:**

- `useSuspendCommission` / `useUnsuspendCommission` — these flip status only (no
  credit row), so their existing commission-list invalidation is sufficient. Do
  not change them.
- The backend `reverseCommission` service — correct as-is.
- `query-keys.ts` — the keys already exist; only reference them.

## Git workflow

- Branch: `advisor/011-reverse-commission-invalidation`
- Conventional commits, e.g. `fix(admin): refresh balance + tx views after commission reversal`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the two invalidations

In `useReverseCommission.onSuccess`, after the existing two `invalidateQueries`
calls, add:

```ts
qc.invalidateQueries({ queryKey: qk.customerGacha(vars.customerId) });
qc.invalidateQueries({ queryKey: qk.customerTransactionsKey(vars.customerId) });
```

Use the exact key-factory names as they appear in the file's `qk`/query-keys
import.

**Verify**: admin build → exit 0; `npm test` → all pass.

## Test plan

- The admin app has no unit test for this hook; verified by build + manual
  interaction: after reversing a commission on Customer360, the header balance
  and transactions list reflect the clawback without a manual page refresh.
- Verification: admin build exit 0; `npm test` all pass.

## Done criteria

- [ ] `useReverseCommission` invalidates commissions, audit, `customerGacha`, and `customerTransactionsKey`.
- [ ] Suspend/unsuspend hooks are unchanged.
- [ ] Admin build exits 0; `npm test` passes.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- The Customer360 balance is NOT sourced from `useCustomerGacha` (drift) —
  re-trace which hook feeds the header balance and invalidate that key instead.
- The key-factory names differ from the excerpts — use the live names.

## Maintenance notes

- Any future admin action that writes a credit_transaction for a customer must
  invalidate `customerGacha` + `customerTransactionsKey` (and `customerAuditKey`
  if it audits). This is the recurring shape — consider a small
  `invalidateCustomerMoneyViews(qc, id)` helper if a third writer appears.
- A reviewer should confirm no other Customer360 stat drifts on reversal (e.g. a
  wallet-summary view, if one exists).
