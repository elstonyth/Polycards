# Plan 003: Don't log users out on a transient /api/me error

> **✅ Status: DONE — implemented in PR #59.** The "Current state" / steps below
> describe the pre-implementation baseline at commit `4ca2593`, kept as the
> historical record; the live code already reflects the completed work. See
> [README.md](README.md) for status — do not re-run this as a fresh checklist.

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> "STOP conditions" item occurs, stop and report — do not improvise. When done,
> update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 4ca2593..HEAD -- src/components/auth/AuthProvider.tsx src/app/api/me/route.ts`
> If either file changed, compare the "Current state" excerpt against the live
> code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `4ca2593`, 2026-07-02

## Why this matters

`AuthProvider.refresh()` hydrates the logged-in customer on mount by fetching
`/api/me`. Its `catch` block is unconditional: **any** thrown error — a dropped
connection, a 5xx, a JSON parse blip — results in `setCustomer(null)`, i.e. the
UI silently treats a logged-in user as logged out until they manually refresh
the page. A real 401 (genuinely logged out) and a transient network failure are
indistinguishable to the current code, and they should not be. The fix is to
only clear the customer when the server actually says "not authenticated," and
to preserve the prior state on transient failures.

## Current state

- `src/components/auth/AuthProvider.tsx:28-38` — the refresh callback:
  ```ts
  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/me', { cache: 'no-store' });
      const data = (await res.json()) as { customer: AuthCustomer | null };
      setCustomer(data.customer);
    } catch {
      setCustomer(null);
    } finally {
      setIsLoading(false);
    }
  }, []);
  ```
  Note it does not check `res.ok`; it parses the body unconditionally and only
  falls into `catch` on a thrown error (network failure or a non-JSON body).
- `src/app/api/me/route.ts` — the proxy route this calls. **Read it first** to
  learn its contract: what status it returns when the user is unauthenticated
  (likely 200 with `{ customer: null }`) vs. when its upstream fetch fails.
  The fix below must match whatever that route actually does — do not assume.

## Commands you will need

| Purpose   | Command             | Expected on success |
| --------- | ------------------- | ------------------- |
| Typecheck | `npm run typecheck` | exit 0, no errors   |
| Lint      | `npm run lint`      | exit 0              |
| Build     | `npm run build`     | exit 0              |

## Step 1: Read the `/api/me` contract

Open `src/app/api/me/route.ts` and determine, precisely:

- What HTTP status + body it returns for an **unauthenticated** user.
- What it returns / how it fails on an **upstream/transient error**.

Write those two facts into your working notes — Step 2 depends on them.

## Step 2: Distinguish "logged out" from "transient failure"

Rewrite `refresh()` so that:

- On a definitive "not authenticated" signal from `/api/me` (per Step 1 — e.g.
  a 401, or a 200 with `customer: null`), call `setCustomer(null)` (correct).
- On a transient failure (network throw, 5xx, non-`ok` status that is _not_ the
  unauthenticated signal), **do not** clear the customer — leave the previous
  state intact. Log via the repo logger if one is used in client components
  (check imports elsewhere in `src/components`); otherwise leave it silent.
- `setIsLoading(false)` still runs in `finally` (first load must not hang).

Target shape (adapt to the actual `/api/me` contract from Step 1):

```ts
const refresh = useCallback(async () => {
  try {
    const res = await fetch('/api/me', { cache: 'no-store' });
    if (!res.ok) {
      // Only a genuine "unauthenticated" clears the session; anything else is
      // transient — keep whatever we had rather than flashing logged-out.
      if (res.status === 401) setCustomer(null);
      return;
    }
    const data = (await res.json()) as { customer: AuthCustomer | null };
    setCustomer(data.customer);
  } catch {
    // Network/transient — preserve prior state, do NOT force logout.
  } finally {
    setIsLoading(false);
  }
}, []);
```

If Step 1 shows `/api/me` returns 200 + `{ customer: null }` for logged-out
users (the likely case), then the happy path already handles logout correctly
and the `catch`/`!res.ok` branches should simply stop clearing state.

**Verify**: `npm run typecheck` → exit 0. `npm run lint` → exit 0.

## Test plan

- This is a small client component; the repo does not unit-test presentational
  providers. Verify by build + reasoning against the `/api/me` contract.
- Optional manual proof via preview tools: load the app logged in, then use
  `preview_eval` to force `/api/me` to fail (e.g. intercept fetch) and confirm
  the header stays logged-in rather than flipping to logged-out.
- Verification: `npm run build` → exit 0.

## Scope

**In scope:**

- `src/components/auth/AuthProvider.tsx`

**Out of scope:**

- `src/app/api/me/route.ts` — read it, do not change it (its contract is the
  input to this fix, not the fix).
- Login/signup actions in `src/lib/actions/auth.ts` — they set state directly and
  are unaffected.

## Git workflow

- Branch: `advisor/003-auth-transient-error`
- Conventional commits, e.g. `fix(auth): keep session on transient /api/me failure`
- Do NOT push or open a PR unless the operator instructed it.

## Done criteria

- [ ] `refresh()` only calls `setCustomer(null)` on a definitive unauthenticated response.
- [ ] Transient failures (throw / 5xx) preserve the previous customer state.
- [ ] `setIsLoading(false)` still runs on every path (first-load never hangs).
- [ ] `npm run typecheck` exits 0, `npm run lint` exits 0, `npm run build` exits 0.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- The `refresh()` excerpt doesn't match the live file (drift) — stop and report.
- `/api/me` returns something other than the two contracts anticipated (e.g. it
  throws server-side for logged-out users) — adjust to the real contract and
  note it, or stop if it's ambiguous.

## Maintenance notes

- If `/api/me`'s status contract changes, this branch logic must change with it —
  keep them in sync.
- A reviewer should confirm first-load still resolves `isLoading` to `false` on
  the transient path (the `finally` guarantees it — don't remove it).
