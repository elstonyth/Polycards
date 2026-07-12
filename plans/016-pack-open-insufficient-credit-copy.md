# Plan 016: Put the numbers in the pack-open "Not enough credits" error

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> "STOP conditions" item occurs, stop and report — do not improvise. When done,
> update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat e9ce6968..HEAD -- backend/packages/api/src/modules/packs/service.ts`
> If the file changed, re-read the two throw sites and compare against the
> "Current state" excerpts before editing; on a mismatch, treat it as a STOP
> condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (UX)
- **Planned at**: commit `e9ce6968`, 2026-07-12

## Why this matters

When a customer can't afford a pack, the error is the bare string `'Not enough
credits to open this pack.'` — it names neither the pack price, the shortfall,
nor the current balance. A newbie holding RM 3 who tries a RM 25 pack can't tell
they need RM 22 more, or what the pack even costs, from the error alone. This is
the last of a family of "name the number" error-copy gaps the rest of the delta
already closed (topup, daily-draw, delivery-address). Fail-closed integrity is
intact — this is purely the message. The numbers (price, current balance) are
already in scope at both throw sites; the sibling `adjustment` branch one line
away already interpolates them.

## Current state

- `backend/packages/api/src/modules/packs/service.ts:693-704` — throw site A,
  with the exemplar interpolation right beside it:

  ```ts
  // 3) Floor check — covers both "enough credit to open" and "no overdraft".
  if (deltaCents < 0 && beforeCents + deltaCents < floorCents) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      input.reason === 'pack_open'
        ? 'Not enough credits to open this pack.' // <-- bare
        : `Deduction exceeds the customer's balance (RM ${(
            beforeCents / 100
          ).toFixed(2)}) — the balance cannot go below RM ${(
            floorCents / 100
          ).toFixed(2)}.`, // <-- exemplar
    );
  }
  ```

- `backend/packages/api/src/modules/packs/service.ts:1858-1862` — throw site B
  (the `settleOpen` path), also bare:

  ```ts
  if (availableCents + deltaCents < 0) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Not enough credits to open this pack.',
    );
  }
  ```

  At site B, `beforeCents`, `availableCents`, and `deltaCents` are in scope
  (`deltaCents` is negative = the price). At site A, `beforeCents`, `deltaCents`,
  and `floorCents` are in scope.

**Money-unit note**: values here are integer **cents** (`*Cents`); divide by 100
and `.toFixed(2)` for the RM display, exactly as the exemplar does. Do NOT change
any arithmetic — only the message string.

## Commands you will need

| Purpose            | Command                                                      | Expected |
| ------------------ | ------------------------------------------------------------ | -------- |
| Backend build      | from `backend/packages/api`: `npm run build`                 | exit 0   |
| Backend HTTP tests | from `backend/packages/api`: `npm run test:integration:http` | all pass |

## Scope

**In scope:**

- `backend/packages/api/src/modules/packs/service.ts` (the two message strings only)
- The pack-open charge HTTP spec (`integration-tests/http/pack-open-charge.spec.ts`
  or similar) — assert the message contains the numbers (see Test plan)

**Out of scope:**

- Any charge/floor arithmetic — do not touch.
- The storefront display of this error — the storefront's `friendlyError`
  (`src/lib/data/packs.ts`) replaces insufficient-credit messages with generic
  copy, so this plan's numbers reach direct API clients only; surfacing them to
  the storefront user is plan 016b's job.

## Git workflow

- Branch: `advisor/016-pack-open-insufficient-credit-copy`
- Conventional commits, e.g. `fix(store): pack-open insufficient-credit error names price, balance, and shortfall`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Interpolate the numbers at throw site A

Replace the bare `'Not enough credits to open this pack.'` in the `pack_open`
branch with a message that includes the pack price (`-deltaCents`), the current
balance (`beforeCents`), and the shortfall. Mirror the exemplar's RM formatting:

```ts
input.reason === 'pack_open'
  ? `Not enough credits to open this pack. It costs RM ${(
      -deltaCents / 100
    ).toFixed(2)}, your balance is RM ${(beforeCents / 100).toFixed(2)} — ` +
    `top up RM ${((floorCents - (beforeCents + deltaCents)) / 100).toFixed(2)} more.`
  : `Deduction exceeds …`; /* unchanged */
```

(Confirm the shortfall expression against the floor logic; if `floorCents` is 0,
the shortfall is `-(beforeCents + deltaCents)`.)

**Verify**: backend build → exit 0.

### Step 2: Interpolate the numbers at throw site B

Apply the same treatment to `service.ts:1858-1862` using the in-scope
`beforeCents` / `availableCents` / `deltaCents`. Keep the two messages
consistent in wording.

**Verify**: backend build → exit 0.

### Step 3: Assert the numbers in a test

In the pack-open charge HTTP spec, add/extend an "insufficient credits" case
asserting the 400 message contains the price, the balance, AND the shortfall
(e.g. a regex for `RM` and the expected figures). Model after the existing
charge-spec setup.

**Verify**: from `backend/packages/api`, run the spec → passes.

## Test plan

- HTTP spec: a customer with balance < pack price opens a pack → 400 whose
  message names the price, balance, and shortfall (regex assertion — the done
  criteria require all three, so the test must not pass with the shortfall
  missing). Also confirm the balance is unchanged (fail-closed) — likely
  already asserted in the same spec.
- Verification: the spec passes; backend build exit 0.

## Done criteria

- [ ] Both `pack_open` insufficient-credit throw sites include price + balance + shortfall.
- [ ] A test asserts the message contains the numbers.
- [ ] Balance-unchanged (fail-closed) behavior is preserved.
- [ ] Backend build exits 0; the spec passes.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- The in-scope variable names at either site differ from the excerpts (drift) —
  re-read and use the live names; do not invent variables.
- Computing the shortfall would require a value not in scope — stop; report what's
  missing rather than fetching it (a fetch on the error path is out of scope).

## Maintenance notes

- Keep the two messages worded identically; if a third insufficient-credit throw
  site appears, factor a small helper `insufficientCreditsMessage(priceCents,
balanceCents)` rather than a third copy.
- A reviewer should confirm only strings changed — no arithmetic — and that the
  cents→RM formatting matches the sibling exemplar.
