# Plan 014: Fix the header balance chip desync after a daily-box credit win

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> "STOP conditions" item occurs, stop and report — do not improvise. When done,
> update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat e9ce6968..HEAD -- src/app/daily/DailyClient.tsx src/components/app-shell/TopUpProvider.tsx`
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

`applyBalance(value)` **sets** the header credit chip to an **absolute** value.
On a daily-box credit win, `DailyClient` calls `applyBalance(res.prize.amountMyr)`
— but `amountMyr` is the _prize's face value_, not the new balance. So a user
with RM 100 who wins RM 5 sees the header chip drop to RM 5 (looks like they lost
RM 95). The backend credited correctly and the ledger/vault reads are right —
this is a **display desync, not fund loss** — but it is sticky: nothing re-reads
the balance until a hard reload, and it happens on a money surface where a
visibly-wrong balance erodes trust. Every other `applyBalance` caller passes a
real absolute balance; `DailyClient` is the only one passing a delta. The fix is
to re-read the authoritative balance instead.

## Current state

- `src/app/daily/DailyClient.tsx:77-84` — the bug:

  ```ts
  if (res.prize) {
    if (res.prize.kind === 'credit' && res.prize.amountMyr != null) {
      applyBalance(res.prize.amountMyr); // <-- passes the PRIZE amount, not the new balance
    }
    setDrawResult(res.prize);
  } else {
    setDrawError('Draw recorded, but no prize data was returned.');
  }
  ```

- `src/components/app-shell/TopUpProvider.tsx:88-94` — `applyBalance` sets an
  absolute value:

  ```ts
  const applyBalance = useCallback(
    (value: number) => {
      if (!customer) return;
      setBalance({ forId: customer.id, value });
    },
    [customer],
  );
  ```

  and `refreshBalance` is exposed on the same context (`TopUpProvider.tsx:113`) —
  it re-reads the authoritative balance from the server.

- Every sibling caller passes an absolute balance, confirming the contract:
  - `src/app/(account)/vault/VaultClient.tsx:63` — `applyBalance(next)` (a balance)
  - `src/app/slots/[slug]/SlotMachineClient.tsx:439` — `applyBalance(held.balance)`
  - `TopUpProvider.tsx:123` — `applyBalance(next)`

- The draw response schema (`src/lib/data/schemas.ts`, `DrawBoxSchema`) has **no
  balance field** — only the prize's `amount_myr`. So there is no authoritative
  balance in the draw response to pass; you must re-read it.

## Commands you will need

| Purpose              | Command                             | Expected |
| -------------------- | ----------------------------------- | -------- |
| Storefront typecheck | from repo root: `npm run typecheck` | exit 0   |
| Storefront tests     | from repo root: `npm test`          | all pass |
| Storefront lint      | from repo root: `npm run lint`      | exit 0   |

## Scope

**In scope:**

- `src/app/daily/DailyClient.tsx` (replace the wrong `applyBalance` call)

**Out of scope:**

- `TopUpProvider.tsx` — `applyBalance`/`refreshBalance` are correct; use them.
- The daily-draw backend route or `DrawBoxSchema` — do not add a balance field
  in this plan (that's the larger alternative; the smaller fix is to re-read).
- The prize-reveal display of `amountMyr` as the _prize_ value (that's correct).

## Git workflow

- Branch: `advisor/014-daily-credit-balance-desync`
- Conventional commits, e.g. `fix(store): re-read balance after a daily credit win instead of setting it to the prize amount`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Replace `applyBalance(prize)` with a balance re-read

Confirm `refreshBalance` is available from the same `useTopUp()` hook that
provides `applyBalance` in `DailyClient` (read the destructure near the top of
the file; add `refreshBalance` to it if needed). Then, on a credit win, call
`refreshBalance()` instead of `applyBalance(res.prize.amountMyr)`:

```ts
if (res.prize) {
  if (res.prize.kind === 'credit' && res.prize.amountMyr != null) {
    void refreshBalance(); // re-read the authoritative balance
  }
  setDrawResult(res.prize);
} else {
  setDrawError('Draw recorded, but no prize data was returned.');
}
```

(`refreshBalance` is async; `void` it or `await` it — match how the file handles
the existing async draw call.)

**Verify**: `npm run typecheck` → exit 0.

## Test plan

- If `src/lib` has a unit-testable seam here it's thin; the primary check is
  typecheck + manual: win a credit box with a non-zero prior balance and confirm
  the header chip shows `prior + prize`, not `prize`.
- If a small vitest already covers `DailyClient` or `useTopUp`, extend it to
  assert a credit win triggers a balance refresh (not an absolute set to the
  prize). Otherwise do not add a brittle test — this is presentational glue;
  typecheck + manual is the repo's norm for this surface (see CLAUDE.md testing
  guidance).
- Verification: `npm run typecheck` exit 0; `npm test` all pass; `npm run lint` exit 0.

## Done criteria

- [ ] `DailyClient` no longer calls `applyBalance` with a prize amount.
- [ ] A credit win triggers `refreshBalance()` (authoritative re-read).
- [ ] `npm run typecheck`, `npm test`, `npm run lint` all exit 0 / pass.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- `refreshBalance` is not exposed by the `useTopUp` context in this file (drift) —
  stop; do not reach into the provider internals.
- The draw response now DOES include an authoritative balance field (drift) —
  then pass THAT to `applyBalance` instead of re-reading, and note it.

## Maintenance notes

- The `applyBalance` contract is "absolute balance only." Any new caller must
  pass a real balance or call `refreshBalance()` — never a delta/prize amount.
- If the daily-draw route is later changed to return the post-credit balance,
  switch this to `applyBalance(res.balance)` to save a round-trip.
- A reviewer should confirm no other caller passes a non-balance to `applyBalance`.
