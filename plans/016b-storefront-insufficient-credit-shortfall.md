# Plan 019: Show the top-up shortfall in the storefront insufficient-credit CTA

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> "STOP conditions" item occurs, stop and report. When done, update the status
> row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat e9ce6968..HEAD -- "src/app/slots/[slug]/PackDetailClient.tsx" "src/app/slots/[slug]/SlotMachineClient.tsx"`
> If either file changed, re-read it and compare against the "Current state"
> excerpts before editing; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (complements plan 016, which improved the _backend_ message)
- **Category**: bug (UX) / follow-up
- **Planned at**: commit `e9ce6968`, 2026-07-12

## Why this matters

Plan 016 made the backend's "Not enough credits" error name the price, balance,
and shortfall — but the storefront never shows those numbers: `openPack`
(`src/lib/actions/packs.ts:104,195`) deliberately maps any `/not enough
credits/i` message through `friendlyError` to a generic string (so raw backend
errors are never surfaced) and instead sets `needsTopUp` to render a top-up CTA.
That sanitization is correct and must stay. The right way to deliver the
plan-016 intent on the storefront is **client-side**: both pack screens already
know the pack price and the user's balance, so the shortfall can be shown next
to the existing CTA without parsing the server string. This turns "Not enough
credits — Top up credits →" into "You're RM 22 short — Top up credits →", which
is the concrete, actionable copy the original finding (sim #14) asked for, with
zero backend coupling.

## Current state

Both screens already compute affordability and have `balance` + price in scope.

- `src/app/slots/[slug]/PackDetailClient.tsx`:
  - `const { balance, openTopUp } = useTopUp();` (line 57)
  - `const priceNum = priceNumber(active.price);` (line 85)
  - already gates on `balance !== null && balance < priceNum * qty` (line 119)
  - the CTA (around line 393), rendered inside the `openError` alert:

    ```tsx
    {
      openError && (
        <p role="alert" className="mt-2 text-center text-[11px] text-red-300">
          {openError}
          {needsTopUp && (
            <>
              {' '}
              <button
                type="button"
                onClick={openTopUp}
                className="font-bold text-buyback-fg underline underline-offset-2 hover:text-buyback-fg"
              >
                Top up credits →
              </button>
            </>
          )}
        </p>
      );
    }
    ```

  - `qty` is the batch quantity in scope here (see line 119). The total cost is
    `priceNum * qty`.

- `src/app/slots/[slug]/SlotMachineClient.tsx`:
  - `const { balance, applyBalance } = useTopUp();` (line 160)
  - `const cost = priceNumber(pack.price);` (line 137)
  - `const canAfford = balance !== null && balance >= cost * reels;` (line 214)
  - the CTA (around line 789), inside the `error` alert:

    ```tsx
    {
      error && (
        <p role="alert" className="mt-3 text-center text-[12px] text-red-300">
          {error}
          {needsTopUp && (
            <>
              {' '}
              <Link
                href="/vault"
                className="font-bold text-buyback-fg underline underline-offset-2 hover:text-buyback-fg"
              >
                Add credits in your Vault →
              </Link>
            </>
          )}
        </p>
      );
    }
    ```

  - `reels` is the reel count in scope here; total cost is `cost * reels`.

- **RM formatting**: use whatever the file already uses to render RM amounts (a
  `rm()`/currency helper or a `.toFixed(2)` with an `RM ` prefix). Grep the file
  for how it prints the price elsewhere and MATCH it — do not invent a new
  formatter. `priceNumber` parses a string to a number; it is not a display
  formatter.

## Commands you will need

| Purpose              | Command                             | Expected |
| -------------------- | ----------------------------------- | -------- |
| Storefront typecheck | from repo root: `npm run typecheck` | exit 0   |
| Storefront tests     | from repo root: `npm test`          | all pass |
| Storefront lint      | from repo root: `npm run lint`      | exit 0   |

## Scope

**In scope:**

- `src/app/slots/[slug]/PackDetailClient.tsx` (shortfall in the CTA)
- `src/app/slots/[slug]/SlotMachineClient.tsx` (shortfall in the CTA)

**Out of scope:**

- `src/lib/actions/packs.ts` / `src/lib/errors.ts` — do NOT loosen `friendlyError`
  or pass the raw backend string through; the sanitization is by design.
- The backend message (plan 016 handles it).
- The batch-open (`open-batch`) success/return shape.

## Git workflow

- Conventional commits, e.g. `feat(store): show the top-up shortfall in the insufficient-credit CTA`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: PackDetailClient — prepend the shortfall to the CTA

In the `needsTopUp` branch (~line 393), when `balance !== null`, show the
shortfall before the existing button. Compute `shortfall = priceNum * qty -
balance` (guard `> 0`). Render it using the file's existing RM formatter, e.g.:

```tsx
{
  needsTopUp && (
    <>
      {' '}
      {balance !== null && priceNum * qty - balance > 0 && (
        <>
          You're {/* RM */}
          {fmt(priceNum * qty - balance)} short.{' '}
        </>
      )}
      <button type="button" onClick={openTopUp} className="…">
        Top up credits →
      </button>
    </>
  );
}
```

Replace `fmt(...)` with the file's real RM formatter. Keep the existing button
and styling untouched. If `balance` is null (unknown), fall back to today's
copy (CTA only, no shortfall).

**Verify**: `npm run typecheck` → exit 0.

### Step 2: SlotMachineClient — same, using `cost * reels`

In the `needsTopUp` branch (~line 789), prepend the shortfall computed as
`cost * reels - balance` (guard `> 0`, `balance !== null`), formatted with the
file's RM helper. Keep the existing `/vault` link and styling.

**Verify**: `npm run typecheck` → exit 0.

## Test plan

- This is presentational glue on two client components; the repo's norm for such
  work is typecheck + lint + build, not a unit test (see CLAUDE.md testing
  guidance — visual/presentational surfaces aren't unit-tested).
- Do NOT add a brittle render test. If a vitest already covers either component's
  affordability logic, extend it to assert the shortfall string renders when
  `balance < cost`; otherwise skip.
- Manual reasoning: a user with RM 3 on a RM 25 pack sees "You're RM 22 short."
  next to the top-up CTA; a user with unknown balance sees today's CTA-only copy.
- Verification: `npm run typecheck`, `npm test`, `npm run lint` all exit 0 / pass.

## Done criteria

- [ ] Both CTAs show the RM shortfall when `balance !== null` and it is `> 0`.
- [ ] The shortfall uses the file's existing RM formatter (no new formatter).
- [ ] `balance === null` falls back to the current CTA-only copy.
- [ ] `friendlyError` / `packs.ts` untouched.
- [ ] `npm run typecheck`, `npm test`, `npm run lint` all exit 0 / pass.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- Neither `balance` nor the pack price is actually in scope at a CTA site (drift)
  — STOP and report; do not thread new props or call the provider in a new place.
- The file has no existing RM formatter to reuse and formatting is ambiguous —
  STOP and report rather than inventing a currency format.

## Maintenance notes

- This is the client-side half of the "name the number" fix; plan 016 is the
  backend half (which reaches API clients). Keep them conceptually paired.
- A reviewer should confirm no raw backend error string is surfaced (the
  shortfall is computed from client-side `balance` + price, not parsed from the
  server message).
