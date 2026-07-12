# Plan 015: Close the remaining admin money-input validation gaps (round 2)

> **Executor instructions**: Follow this plan step by step. Each item is a small
> independent guard; run the verification after each. If any "STOP conditions"
> item occurs, stop and report. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat e9ce6968..HEAD -- "backend/apps/admin/src/routes/customers/[id]/page.tsx" backend/apps/admin/src/routes/daily-rewards/page.tsx backend/apps/admin/src/routes/support/page.tsx`
> If any file changed, re-read it and compare against the "Current state"
> excerpts before editing; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `e9ce6968`, 2026-07-12

## Why this matters

This is the round-2 follow-up to plan 004 (which closed the support-page money
gaps). Two sibling paths were missed and let an operator submit a meaningless or
out-of-range mutation the UI's own signals say should be blocked. Each is a
one-to-few-line client guard; the backend remains the authoritative validator.

1. **Customer360 credit-adjust accepts `0`.** The support page rejects a
   zero-amount adjustment (plan 004), but the Customer360 adjust modal guards
   only `!Number.isFinite(amount)` — `Number("0")` is finite and non-empty, so a
   `0` passes and writes a spurious zero-amount transaction + audit row on the
   exact screen used for fraud review.
2. **Daily-box product-prize qty exceeds its own `max={1}`.** The qty input sets
   `max={1}`, but `rowErrors` only checks `>= 1` and save sends
   `Number(r.qtyInput) || 1`, so typing `3` submits `qty: 3` — the client cap is
   cosmetic and an out-of-range qty reaches the backend.

## Current state

### Item 1 — Customer360 zero-adjust

- `backend/apps/admin/src/routes/customers/[id]/page.tsx:113-128` — the guard
  allows `0`:

  ```ts
  function applyAdjustCredits() {
    if (!customerId) return;
    const amount = Number(creditAmount.trim());
    if (!Number.isFinite(amount)) {          // <-- 0 passes
      toast.error(t('support.adjustInvalid'));
      return;
    }
    if (!creditNote.trim()) return;
    closeModal();
    adjustCredits.mutate({ id: customerId, amount, note: creditNote }, …);
  }
  ```

- `backend/apps/admin/src/routes/customers/[id]/page.tsx:165-168` —
  `confirmDisabled` also lets `"0"` through (checks non-empty only):

  ```ts
  const confirmDisabled =
    modal === 'credits'
      ? !creditAmount.trim() || !creditNote.trim()
      : !reason.trim();
  ```

- **Exemplar** — `backend/apps/admin/src/routes/support/page.tsx:96-103`
  (`requestAdjust`) already rejects `value === 0`. Match it. (Signed adjustments
  are intended — block exactly `0`, keep both signs.)

### Item 2 — Daily-box product qty

- `backend/apps/admin/src/routes/daily-rewards/page.tsx:655-656` — `rowErrors`
  checks only the lower bound:

  ```ts
  if (r.kind === 'product' && !(Number(r.qtyInput) >= 1))
    return 'Qty must be at least 1.';
  ```

- `backend/apps/admin/src/routes/daily-rewards/page.tsx:716` — save sends the raw value:

  ```ts
  qty: Number(r.qtyInput) || 1,
  ```

- `backend/apps/admin/src/routes/daily-rewards/page.tsx:914-924` — the input
  declares `max={1}` (the intended ceiling), which `rowErrors` doesn't enforce.

## Commands you will need

| Purpose               | Command                                    | Expected |
| --------------------- | ------------------------------------------ | -------- |
| Admin build/typecheck | from `backend/apps/admin`: `npm run build` | exit 0   |
| Admin tests           | from `backend/apps/admin`: `npm test`      | all pass |

## Scope

**In scope:**

- `backend/apps/admin/src/routes/customers/[id]/page.tsx` (reject zero-adjust)
- `backend/apps/admin/src/routes/daily-rewards/page.tsx` (enforce qty upper bound)

**Out of scope:**

- `support/page.tsx` — already guarded (plan 004); it's the exemplar.
- The `useAdjustCredits` hook — could be centralized (see maintenance note) but
  this plan fixes the caller to keep the diff minimal and match the support
  pattern. Do not change the hook's signature.
- Backend validators — remain authoritative; do not weaken.

## Git workflow

- Branch: `advisor/015-admin-money-input-round2`
- Conventional commits, e.g. `fix(admin): reject zero credit-adjust on Customer360 and bound daily-box qty`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Reject exactly `0` on the Customer360 adjust

In `applyAdjustCredits` (customers/[id]/page.tsx), extend the guard to reject `0`:

```ts
if (!Number.isFinite(amount) || amount === 0) {
  toast.error(t('support.adjustInvalid'));
  return;
}
```

Optionally also fold `Number(creditAmount) === 0` into `confirmDisabled` so the
confirm button is disabled for `0` (belt-and-suspenders, matching support UX).

**Verify**: admin build → exit 0.

### Step 2: Enforce the daily-box qty upper bound

In `daily-rewards/page.tsx` `rowErrors`, add the upper bound that matches the
input's `max`. If `max={1}` is the real ceiling, make it:

```ts
if (
  r.kind === 'product' &&
  !(Number(r.qtyInput) >= 1 && Number(r.qtyInput) <= 1)
)
  return 'Qty must be exactly 1.';
```

If product prizes are actually meant to allow >1 (confirm by reading the backend
box-prize handler / `box-snapshot.ts`), instead raise the input's `max` and the
guard to the real ceiling so the input and the validator agree — do not leave
them inconsistent. Pick one and make input + guard match.

**Verify**: admin build → exit 0; `npm test` → all pass.

## Test plan

- Admin app is verified by build + manual interaction (no page unit test).
  Manual: (1) a `0` credit adjust on Customer360 toasts and does not mutate;
  (2) a daily-box product qty above the ceiling keeps Save disabled / shows the
  row error.
- If you touch `box-snapshot.ts` logic (you should not need to), its
  `box-snapshot.test.ts` must still pass.
- Verification: admin build exit 0; `npm test` all pass.

## Done criteria

- [ ] Customer360 credit-adjust rejects exactly `0` (both signs still allowed).
- [ ] Daily-box product qty input and `rowErrors` agree on the same ceiling.
- [ ] Admin build exits 0; `npm test` passes.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- The intended product-qty ceiling is genuinely unclear (input says 1, backend
  allows more) — stop and report which is authoritative rather than guessing.
- The support-page zero-guard has been removed/changed (drift) — re-read; match
  the live pattern.

## Maintenance notes

- Credit-adjust now has the zero-guard in two callers (support + Customer360).
  The lazy root-cause fix is to move `value === 0` into `useAdjustCredits` so a
  third caller can't diverge again — deferred here to keep the diff minimal, but
  worth doing if a third adjust entry point appears.
- Any new admin money/qty input should keep its `max`/`min` attribute and its
  validation guard in sync.
