# Plan 013: Paginate the Customer360 commissions and audit tables

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> "STOP conditions" item occurs, stop and report — do not improvise. When done,
> update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat e9ce6968..HEAD -- "backend/apps/admin/src/routes/customers/[id]/page.tsx" backend/apps/admin/src/lib/admin-rest.ts backend/apps/admin/src/lib/queries.ts backend/apps/admin/src/routes/support/page.tsx`
> If any file changed, re-read it and compare against the "Current state"
> excerpts before editing; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `e9ce6968`, 2026-07-12

## Why this matters

Customer360 fetches commissions and audit events at **page 0 only** and renders
no pager. Both endpoints default to `limit=50`, so for any customer with more
than 50 commissions or 50 audit events, the older rows are silently unreachable
with no indication they exist. This directly undercuts the fraud-investigation
workflow the screen exists for — an operator reversing or suspending older
commissions, or reading full audit history, simply can't see past row 50. The
support page already solves this exact problem with a `Pager` on its
transactions and pulls tables; this plan mirrors that pattern for commissions
and audit.

## Current state

- `backend/apps/admin/src/routes/customers/[id]/page.tsx:63-65` — page 0, no pager:

  ```ts
  const { data: commissionsData, isError: commissionsError } =
    useCustomerCommissions(customerId);
  const { data: auditData, isError: auditError } = useCustomerAudit(customerId);
  ```

  This file imports no `Pager` and renders none for these two tables. (The
  referral tree shows a `truncated` flag at ~line 352; commissions/audit show no
  such hint.)

- `backend/apps/admin/src/lib/admin-rest.ts:228-262` — both endpoints already
  accept `page` and return paginated data:

  ```ts
  export const getCustomerCommissions = (id: string, page = 0, limit = 50) =>
    …`/admin/customers/${…}/commissions?limit=${limit}&offset=${page * limit}`…
  export const getCustomerAudit = (id: string, page = 0, limit = 50) =>
    …`/admin/customers/${…}/audit?limit=${limit}&offset=${page * limit}`…
  ```

  Confirm the response shape (does it return a `total`/`count` for the pager's
  `hasMore`? read the route handlers or the existing typed return). The support
  page's tx pager relies on the same shape family — read it.

- **Exemplar to copy** — `backend/apps/admin/src/routes/support/page.tsx`:
  imports `Pager` (line 28), holds `txPage`/`pullPage` state, and renders
  `<Pager page={txPage} … />` at lines ~358 and ~472. Match this exactly:
  `useState` page counters, pass `page` into the query hook, render `<Pager>`
  with the same `from`/`to`/`hasMore` props.

- The query hooks `useCustomerCommissions` / `useCustomerAudit` live in
  `backend/apps/admin/src/lib/queries.ts` — read them to see whether they already
  accept a `page` arg (the support-page tx/pull hooks do, with
  `keepPreviousData`). If they take no page arg yet, add one, mirroring the
  support-page hooks.

## Commands you will need

| Purpose               | Command                                    | Expected |
| --------------------- | ------------------------------------------ | -------- |
| Admin build/typecheck | from `backend/apps/admin`: `npm run build` | exit 0   |
| Admin tests           | from `backend/apps/admin`: `npm test`      | all pass |

## Scope

**In scope:**

- `backend/apps/admin/src/routes/customers/[id]/page.tsx` (page state + `<Pager>` for both tables)
- `backend/apps/admin/src/lib/queries.ts` (add `page` param to the two hooks **iff** they lack it)

**Out of scope:**

- `admin-rest.ts` — the REST functions already page; do not change them.
- The referral tree's `truncated` display — leave as-is.
- The support page — it is the exemplar, not a target.
- Backend routes — they already support `limit`/`offset`.

## Git workflow

- Branch: `advisor/013-customer360-pagination`
- Conventional commits, e.g. `fix(admin): paginate Customer360 commissions + audit tables`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the pager contract

Read `support/page.tsx` around lines 355-360 and 470-475 to capture the exact
`<Pager>` props (`page`, `from`, `to`, `hasMore`, `onPrev`/`onNext` or whatever
it uses), and read `components/Pager.tsx` for its prop names. Read
`queries.ts` for the support tx/pull hooks and the commissions/audit hooks.

**Verify**: no build step — this is a read step. You now know the pattern.

### Step 2: Thread page state into the two hooks

In `page.tsx`, add `const [commPage, setCommPage] = useState(0)` and
`const [auditPage, setAuditPage] = useState(0)`. Pass them into
`useCustomerCommissions(customerId, commPage)` and
`useCustomerAudit(customerId, auditPage)`. If those hooks don't yet accept a
page arg, add one in `queries.ts` mirroring the support tx/pull hooks (include
`placeholderData: keepPreviousData` if the support hooks use it, to avoid
row flicker on page change).

**Verify**: admin build → exit 0.

### Step 3: Render a `<Pager>` under each table

Add a `<Pager>` beneath the commissions table and the audit table, wired to the
respective page state and the query result's total/hasMore, exactly as the
support tx/pull pagers do.

**Verify**: admin build → exit 0; `npm test` → all pass.

## Test plan

- No unit test exists for this page; verified by build + manual interaction: a
  customer with >50 commissions/audit rows can page to the older rows via the new
  pagers.
- Verification: admin build exit 0; `npm test` all pass.

## Done criteria

- [ ] Commissions table has a working `<Pager>` bound to `commPage`.
- [ ] Audit table has a working `<Pager>` bound to `auditPage`.
- [ ] The hooks receive the page arg (added if they lacked it).
- [ ] Admin build exits 0; `npm test` passes.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- The commissions/audit response has no `total`/`count` to compute `hasMore`, and
  the support pager depends on one — stop and report (the pager pattern needs the
  count; adding it is a backend change out of this plan's scope).
- The support-page pager pattern differs materially from what's described — match
  the live pattern, not this excerpt.

## Maintenance notes

- The pager `from`/`to`/`hasMore` math should be identical across all Customer360
  and support tables — if you find yourself hand-rolling it, reuse the same
  helper the support page uses.
- A reviewer should confirm both new pagers actually change the fetched page (not
  just render) and that `keepPreviousData` (if used) prevents row flicker.
