# Plan 009: Bound the card markup multiplier on the edit path and in the backend validator

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> "STOP conditions" item occurs, stop and report — do not improvise. When done,
> update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat e9ce6968..HEAD -- backend/apps/admin/src/routes/cards/page.tsx backend/apps/admin/src/routes/cards/RegisterCardModal.tsx backend/packages/api/src/api/admin/cards/validate.ts`
> If any file changed, re-read it and compare against the "Current state"
> excerpts before editing; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (money)
- **Planned at**: commit `e9ce6968`, 2026-07-12

## Why this matters

A card's `market_multiplier` scales the customer-facing price shown on the
storefront and used in vault/buyback quotes. The **register** modal already caps
the margin to `[0, 1000]%` (a prior audit fix). The **edit** path does not:
`canSave` never validates the field, the input has no `min`/`max`, and the
backend validator only rejects `<= 0` with **no upper bound**. An operator
editing a card can fat-finger or paste `market_multiplier_pct: 9999`, and it is
accepted end-to-end — silently multiplying every price for that card. This is a
real money-facing defect, not just UX. Closing it makes the edit path match the
already-guarded register path and adds a backend ceiling so no client can bypass
it.

## Current state

- `backend/apps/admin/src/routes/cards/page.tsx:149-156` — `canSave` validates
  name/image/market_value but **not** the markup:

  ```ts
  const canSave =
    !!form &&
    form.name.trim() !== '' &&
    form.image.trim() !== '' &&
    form.market_value.trim() !== '' &&
    Number(form.market_value) >= 0 &&
    !saving &&
    !uploading;
  ```

- `backend/apps/admin/src/routes/cards/page.tsx:676-684` — the markup input has
  `step={1}` but no bounds:

  ```tsx
  <Input
    id="card-markup"
    type="number"
    step={1}
    value={form.market_multiplier_pct}
    onChange={(e) => patch({ market_multiplier_pct: e.target.value })}
  />
  ```

- `backend/apps/admin/src/routes/cards/RegisterCardModal.tsx:204-206` — the
  register path **is** capped (this is the exemplar to match). Re-read to copy
  the exact expression it uses for the `[0, 1000]` margin bound.

- `backend/packages/api/src/api/admin/cards/validate.ts:114-122` — backend
  `optMultiplier` rejects only non-positive:

  ```ts
  const optMultiplier = (b: Record<string, unknown>): number | undefined => {
    const v = b.market_multiplier;
    if (v === undefined || v === null || v === '') return undefined;
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
      bad(`'market_multiplier' must be a positive number.`);
    }
    return n as number;
  };
  ```

**Unit note**: the client field is a _percent_ (`market_multiplier_pct`), and
the backend stores a _multiplier_ (`market_multiplier`, e.g. `1 + pct/100`). The
register modal's bound is on the percent. Do NOT change any pct↔multiplier
conversion — only add bounds. Confirm the exact conversion in `page.tsx`'s save
handler before choosing the backend ceiling so client and backend bounds line
up (a client cap of 1000% ⇒ multiplier ≤ 11; pick the backend ceiling to match
whatever conversion the save handler actually uses).

## Commands you will need

| Purpose               | Command                                                             | Expected |
| --------------------- | ------------------------------------------------------------------- | -------- |
| Admin build/typecheck | from `backend/apps/admin`: `npm run build` (`tsc -b && vite build`) | exit 0   |
| Admin tests           | from `backend/apps/admin`: `npm test` (`vitest run`)                | all pass |
| Backend unit tests    | from `backend/packages/api`: `npm run test:unit`                    | all pass |

> If a direct `tsc`/`eslint`/`vite` binary is not on PATH, invoke via `node`
> against `node_modules/.bin` or the binary's JS entry (see plan 004 note). Do
> not run installs.

## Scope

**In scope:**

- `backend/apps/admin/src/routes/cards/page.tsx` (client guard + input bounds)
- `backend/packages/api/src/api/admin/cards/validate.ts` (backend ceiling)
- `backend/packages/api/src/api/admin/cards/__tests__/validate.unit.spec.ts` (add a case)
- `plans/README.md` (this plan's status row only)

**Out of scope:**

- `RegisterCardModal.tsx` — already correct; read it as the exemplar, do NOT edit.
- Any pct↔multiplier conversion math — do not touch.
- `market_value` validation — already guarded.

## Git workflow

- Branch: `advisor/009-card-edit-markup-bound`
- Conventional commits, e.g. `fix(admin): bound card markup on the edit path and backend validator`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Mirror the register-modal bound into `canSave`

Re-read `RegisterCardModal.tsx:204-206` for the exact `[0, 1000]` expression.
In `page.tsx`, extend `canSave` so Save is disabled when `market_multiplier_pct`
is present but outside `[0, 1000]`. Keep an empty field allowed only if the
register path allows it (match register semantics). Example shape:

```ts
&& (form.market_multiplier_pct.trim() === '' ||
    (Number(form.market_multiplier_pct) >= 0 &&
     Number(form.market_multiplier_pct) <= 1000))
```

**Verify**: admin build → exit 0.

### Step 2: Add `min`/`max` to the markup input

On the `card-markup` `<Input>` (page.tsx:676-684) add `min={0} max={1000}`,
matching the register input.

**Verify**: admin build → exit 0.

### Step 3: Add an upper bound to the backend validator

In `validate.ts` `optMultiplier`, add an upper-bound check so an out-of-range
multiplier is rejected with a clear message. Choose the ceiling to correspond to
the client's 1000% cap under the actual conversion (e.g. if stored multiplier =
`1 + pct/100`, ceiling ≈ 11; confirm against the save handler). Keep the
existing `<= 0` rejection.

```ts
if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > <CEILING>) {
  bad(`'market_multiplier' must be between 0 (exclusive) and <CEILING>.`);
}
```

**Verify**: from `backend/packages/api`: `npm run test:unit` → all pass.

### Step 4: Add a backend test case

In `validate.unit.spec.ts`, add a case asserting an over-ceiling
`market_multiplier` is rejected (mirror the existing `<= 0` rejection test).

**Verify**: `npm run test:unit` → all pass, including the new case.

## Test plan

- Backend: new `validate.unit.spec.ts` case for over-ceiling multiplier
  (rejected) — model after the existing non-positive rejection test in the same
  file.
- Admin: verified by build + manual interaction (no unit test for the page).
  Manual: editing a card, typing `9999` in markup keeps Save disabled.
- Verification: admin build exit 0; `npm run test:unit` all pass.

## Done criteria

- [ ] Card **edit** `canSave` rejects markup outside `[0, 1000]%`.
- [ ] Markup input has `min={0} max={1000}`.
- [ ] Backend `optMultiplier` rejects an over-ceiling multiplier with a clear message.
- [ ] New backend unit test for the ceiling exists and passes.
- [ ] Admin build exits 0; backend `test:unit` passes.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- The register-modal bound is not `[0, 1000]` or lives elsewhere — re-read and
  match the _actual_ register semantics rather than assuming.
- The pct↔multiplier conversion is not `1 + pct/100` — recompute the backend
  ceiling to match; if the conversion is unclear, stop and report.
- A guard would require editing conversion math — stop; out of scope.

## Maintenance notes

- Client and backend bounds must stay in sync with the conversion. If the
  conversion changes, revisit both the input `max` and `optMultiplier`'s ceiling.
- A reviewer should confirm the backend ceiling corresponds to the 1000% client
  cap under the real conversion, and that no conversion math changed.
