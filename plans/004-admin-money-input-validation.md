# Plan 004: Close admin money-input validation gaps

> **✅ Status: DONE — implemented in PR #59.** The "Current state" / steps below
> describe the pre-implementation baseline at commit `4ca2593`, kept as the
> historical record; the live code already reflects the completed work. See
> [README.md](README.md) for status — do not re-run this as a fresh checklist.

> **Executor instructions**: Follow this plan step by step. Each item is a small
> independent fix; run the verification after each. If any "STOP conditions"
> item occurs, stop and report. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 4ca2593..HEAD -- backend/apps/admin/src/routes/support/page.tsx "backend/apps/admin/src/routes/products/from-pricecharting/page.tsx" backend/apps/admin/src/lib/admin-rest.ts`
> If any file changed, re-read it and compare against the "Current state"
> excerpts before editing; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `4ca2593`, 2026-07-02

## Why this matters

The admin dashboard is operated by trusted staff, so these are UX-correctness /
fail-fast gaps rather than security holes — but they let an operator submit
meaningless or dangerous-looking mutations that either waste a round-trip or
create confusing state. Each is a one-to-few-line client-side guard that makes
the form reject bad input before it hits the backend. The backend remains the
authoritative validator; this is defense at the point of entry.

> **Note on units**: admin money inputs are entered in RM and converted for the
> backend elsewhere. Do NOT change any RM↔SEN/USD conversion in this plan — only
> add the guards described. If a guard would touch conversion code, stop.

## Current state

Each item below was confirmed against the live code where marked ✅; items
marked ⚠ are from the audit and **must be re-confirmed by reading the file
first** (line numbers may have shifted).

- ✅ **Zero-amount credit adjust** — `backend/apps/admin/src/routes/support/page.tsx`,
  `requestAdjust()`:

  ```ts
  const value = Number(amount);
  if (!Number.isFinite(value)) {
    // <-- allows 0
    toast.error(t('support.adjustInvalid'));
    return;
  }
  setConfirmOpen(true);
  ```

  A `0` passes validation and opens the confirm dialog → a no-op adjustment.
  The Apply `Button` is `disabled={!amount.trim() || !note.trim()}` and
  `isLoading={adjusting}` (double-submit is already guarded — do not add more).

- ⚠ **PriceCharting stock allows 0** —
  `backend/apps/admin/src/routes/products/from-pricecharting/page.tsx`, the
  `canSave` computation (audit cited ~line 188-189):
  `Number.isInteger(Number(stock)) && Number(stock) >= 0`. Creating a tracked
  card product with `stock: 0` produces an out-of-stock product on success.
  Re-read to confirm exact expression and line.

- ⚠ **Markup % unbounded** — same file (audit cited ~line 168, 330-336): the
  markup/multiplier input has `min={0}` only; `multiplier = 1 + Number(pct)/100`
  is computed with no upper bound, allowing extreme or (via other paths)
  nonsensical multipliers. Re-read to confirm.

- ⚠ **Customer-search query length unbounded** —
  `backend/apps/admin/src/lib/admin-rest.ts`, `searchCustomers(q)` (audit cited
  ~line 133-138): `q` is passed straight into
  `encodeURIComponent(q)` with no length cap. Re-read to confirm; the caller is
  the search box in `support/page.tsx`.

## Commands you will need

| Purpose                    | Command                                                                                                   | Expected on success |
| -------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------- |
| Admin typecheck/build      | from `backend/apps/admin`: `node ../../node_modules/vite/bin/vite.js build` (or the admin `build` script) | exit 0              |
| Admin lint (if configured) | from `backend/apps/admin`: run the repo's lint entrypoint via node                                        | exit 0              |

> `eslint`/`tsc` are not on PATH in this repo — invoke via `node` against the
> node_modules binary if a direct command fails. Do not run installs.

## Step 1: Reject zero (and confirm sign policy) on credit adjust

In `support/page.tsx` `requestAdjust()`, extend the guard to reject `0`:

```ts
const value = Number(amount);
if (!Number.isFinite(value) || value === 0) {
  toast.error(t('support.adjustInvalid'));
  return;
}
```

Signed adjustments (negative = debit, positive = credit) are intended, so keep
both signs — only block exactly `0`.

**Verify**: admin build → exit 0. Manually reason: entering `0` now toasts and
does not open the confirm dialog.

## Step 2: Require positive stock in the PriceCharting create flow

Re-read `from-pricecharting/page.tsx`. In the `canSave` expression, change the
stock check from `>= 0` to `> 0` so Save only enables for a positive integer
stock. If there is adjacent hint text stating "0 or more," update it to reflect
"at least 1."

**Verify**: admin build → exit 0.

## Step 3: Bound the markup percentage

Re-read `from-pricecharting/page.tsx`. Add a sane upper bound to the markup
input: a `max` attribute (e.g. `max={1000}`) AND a guard in `canSave` (or the
save handler) that rejects a markup outside `[0, 1000]`. Keep `min={0}`.

**Verify**: admin build → exit 0.

## Step 4: Cap the customer-search query length

Re-read `admin-rest.ts` `searchCustomers`. Add a length guard before the fetch,
or in the calling `search()` in `support/page.tsx`:

```ts
if (q.length > 256) {
  /* toast + return, or truncate */
}
```

Prefer guarding at the call site (`support/page.tsx`) so the user gets a toast,
and keep `admin-rest.ts` a thin client. A 256-char cap is generous for a
name/email search.

**Verify**: admin build → exit 0.

## Test plan

- The admin app is verified by build + manual interaction, not unit tests.
- Manual check (preview or local admin at `:7000`): confirm each guard fires —
  `0` credit adjust blocked, `0` stock keeps Save disabled, an out-of-range
  markup keeps Save disabled, an over-long search string is blocked/truncated.
- Verification: admin build → exit 0 after all four steps.

## Scope

**In scope:**

- `backend/apps/admin/src/routes/support/page.tsx`
- `backend/apps/admin/src/routes/products/from-pricecharting/page.tsx`
- `backend/apps/admin/src/lib/admin-rest.ts`

**Out of scope:**

- Any RM↔SEN/USD conversion logic — do not touch (PR #50 fixed RM display; leave it).
- Backend validation — the backend remains the source of truth; do not weaken it.
- Double-submit guards — already handled by `@medusajs/ui` `Button isLoading`.

## Git workflow

- Branch: `advisor/004-admin-input-validation`
- Conventional commits, e.g. `fix(admin): reject zero/out-of-range money inputs at the form boundary`
- Do NOT push or open a PR unless the operator instructed it.

## Done criteria

- [ ] Credit adjust rejects exactly `0` (both signs still allowed).
- [ ] PriceCharting Save requires `stock > 0`.
- [ ] Markup input is bounded `[0, 1000]` (attribute + guard).
- [ ] Customer-search query length is capped (≤ 256).
- [ ] Admin build exits 0.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- Any ⚠ excerpt doesn't match the live file (drift) — re-read; if the logic has
  materially changed, stop and report rather than guessing.
- A guard would require editing money-conversion code — stop; that's out of scope.
- The admin build fails for a reason unrelated to your edit.

## Maintenance notes

- These are client-side fail-fast guards; the backend must still validate (it
  does). If a new admin money input is added, apply the same reject-zero /
  bounded-range pattern.
- A reviewer should confirm no conversion math changed — only guards were added.
