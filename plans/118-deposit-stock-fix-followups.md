# Plan 118: Close the #468 follow-ups — pin the stock-take wiring, the cap window, and the partial-take diagnostics

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 30eded61..HEAD -- backend/packages/api/src/modules/packs/card-stock.ts backend/packages/api/src/modules/packs/service.ts backend/packages/api/integration-tests/http/globepay-deposit-cap.spec.ts backend/packages/api/src/modules/packs/__tests__/`
> On any in-scope change since `30eded61`, compare the "Current state"
> excerpts before proceeding; on a mismatch, treat as STOP. `service.ts` is
> ~9,300 lines and moves constantly — re-locate its symbols BY NAME, never
> by line number.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests + bug (diagnostics)
- **Planned at**: commit `30eded61`, 2026-08-22

## Why this matters

PR #468 fixed two real money/goods bugs — the deposit-cap race (#429) and
the split-location stock over-decrement (#430) — and the fixes themselves
verify clean (the advisor re-read the lock scoping, the in-lock re-count,
the single capped-insert call site, and the planner arithmetic). Four
follow-ups remain, each small and each protecting the fix from silently
regressing:

1. **The #430 fix's wiring has zero test importers.** The pure planner
   (`planCardStockTake`) is well pinned, but nothing imports
   `takeCardStock` — the function that actually swaps the old
   single-location decrement for the planned multi-level takes. Revert
   `takeCardStock` to its pre-#468 body and every test in the repo stays
   green, with the planner as dead exported code behind a green spec.
2. **The cap's 20-minute window is untested by effect.** The integration
   spec seeds pending rows and asserts count behavior, but no case
   backdates a row past `GLOBEPAY_PENDING_WINDOW_MS`. Drop or invert the
   `created_at: { $gte }` filter in the capped insert and the suite stays
   green — while an abandoned-session backlog would permanently block a
   customer from depositing (the exact lockout the window exists to
   prevent).
3. **A partial multi-level take now logs a false fact.** The take loops N
   `adjustInventory` calls with no partial-progress capture; the sole
   consumer treats any throw as "nothing was taken", skips the
   `stock_earmarked` flip for ALL the winner's pulls, and logs
   "counter reads high" — when a mid-loop throw leaves the counter LOW by
   the applied units, which buyback will then never restore. The direction
   is unrecoverable by inspection.
4. **The capped insert omits the READ COMMITTED warning** its two
   structurally identical lock-then-read siblings in `service.ts` each
   carry verbatim. Not a live bug (its only caller passes no context), but
   the file treats this as a documented hazard class, and this method is
   the one place the paragraph is missing.

## Current state

Files (all under `backend/packages/api/`):

- `src/modules/packs/card-stock.ts` — `cardInventoryLevels` (container
  query → `{inventoryItemId, locationId, available}[]`), `planCardStockTake`
  (:158-190, pure), `takeCardStock` (:199-213), `findCardInventoryTarget`
  (:218+, the old single-location path still used by the ±1 callers).
- `src/modules/packs/service.ts` — `reserveSettledStock` (search for that
  name; the catch block is the one logging
  `'[settleChallengeWeek] stock take failed AFTER the payout committed — counter reads high, prize already granted'`),
  and `createGlobePayDepositCapped` (search by name; lock →
  `listAndCountGlobePayDeposits` with
  `created_at: { $gte: new Date(Date.now() - input.windowMs) }` → insert).
- `integration-tests/http/globepay-deposit-cap.spec.ts` — real-DB spec;
  helpers `pending(customerId, n)` and `capped(customerId)` at the top,
  four cases; the settled-row case flips status via
  `packs().updateGlobePayDeposits(rows.map(r => ({ id: r.id, status: 'settled' })))`.
- `src/modules/packs/__tests__/globepay-deposit.unit.spec.ts` — the
  by-key container stub exemplar (`harness()` at :36-55: resolve returns
  `logger` for `'logger'`, else `packs`).
- `src/jobs/settle-challenge-week.ts:38` — the only production binding:
  `decrementStock: takeCardStock(container)`.

Excerpts as of `30eded61`:

`card-stock.ts:199-213` (`takeCardStock` — the untested wiring, and the
loop with no partial capture):

```ts
export const takeCardStock =
  (container: MedusaContainer) =>
  async (handle: string, qty: number): Promise<boolean> => {
    const levels = await cardInventoryLevels(container, handle);
    if (levels.length === 0) return false;
    const inventory = container.resolve(Modules.INVENTORY);
    for (const take of planCardStockTake(levels, qty)) {
      await inventory.adjustInventory(
        take.inventoryItemId,
        take.locationId,
        -take.qty,
      );
    }
    return true;
  };
```

`service.ts`, `reserveSettledStock`'s catch (locate by the log string):

```ts
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          '[settleChallengeWeek] stock take failed AFTER the payout committed — counter reads high, prize already granted',
          { customer_id: …, week_start: …, handle: r.handle, qty: r.qty, error: String(err) },
        );
      }
```

`service.ts`, the isolation paragraph the capped method is missing — copy
its wording from the sibling (locate by searching `DEPENDS ON READ COMMITTED`;
two hits exist today):

```ts
// DEPENDS ON READ COMMITTED (the default; @InjectTransactionManager
// forwards `isolationLevel` from the caller's context and this path passes
// none) — … under REPEATABLE READ the … would use a snapshot from before
// that commit and the … would leak again. Do not compose this method into
// a context carrying a stricter isolation level.
```

Repo facts:

- **Integration tests run against the real `pokenic-postgres`/
  `pokenic-redis` Docker containers** (they must be up: `docker ps` shows
  both). The runner is `medusaIntegrationTestRunner`; suites share a DB, so
  every case uses its own customer id (the spec's header says so).
- jest 30: `--testPathPatterns` (plural).
- The `raw_*` bigNumber trap does not apply here — no new money column is
  written by any step.
- Backend eslint is vacuous for `packages/api`; typecheck + jest are the
  gates.

## Commands you will need

Run from `backend/`. If jest resolves under `packages/api/node_modules`,
use that path.

| Purpose          | Command                                                                                                                                                                                                                               | Expected                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Typecheck        | `corepack yarn check-types`                                                                                                                                                                                                           | exit 0                  |
| Unit: card-stock | `node node_modules/jest/bin/jest.js --config packages/api/jest.config.js --testPathPatterns "card-stock"`                                                                                                                             | all pass                |
| Unit: deposit    | same, `--testPathPatterns "globepay-deposit"`                                                                                                                                                                                         | all pass                |
| Integration: cap | from `backend/packages/api`: `corepack yarn test:integration:http --testPathPatterns "globepay-deposit-cap"` (check `package.json` for the exact integration script name — `grep -n "integration" backend/packages/api/package.json`) | all pass incl. new case |

Docker infra check first: `docker ps --format "{{.Names}}"` must list
`pokenic-postgres` and `pokenic-redis`.

## Scope

**In scope**:

- `src/modules/packs/card-stock.ts` (partial-take diagnostics)
- `src/modules/packs/service.ts` — ONLY: the `reserveSettledStock` warn
  text and the doc block above `createGlobePayDepositCapped`
- `src/modules/packs/__tests__/card-stock-take.unit.spec.ts` (create)
- `integration-tests/http/globepay-deposit-cap.spec.ts` (one new case)

**Out of scope**:

- `planCardStockTake` and its spec — correct and pinned; don't touch.
- The deposit lock/count/insert code itself — verified correct; comments
  only.
- `settle-challenge-week.ts`, `grant-skipped-challenge-cards.ts`,
  `settle-challenge-now.ts` — the callers stay as they are.
- Any transaction/rollback mechanism for the multi-level take.
  `adjustInventory` commits on the inventory module's own connection
  (service.ts documents this near the decrement sites); making the take
  atomic is not achievable from here and the conservative
  partial-progress direction is accepted — this plan only makes the
  diagnostics tell the truth.

## Git workflow

- Branch: `advisor/118-deposit-stock-fix-followups`
- Conventional commits, e.g. `test(backend): pin takeCardStock's split-location wiring`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Unit-pin `takeCardStock`'s wiring

Create `src/modules/packs/__tests__/card-stock-take.unit.spec.ts`. Build a
by-key container stub (model on `globepay-deposit.unit.spec.ts`'s
`harness()`): `resolve(key)` returns a fake QUERY module for the key
`cardInventoryLevels` actually resolves (read `cardInventoryLevels`'s
first lines to get the exact key — it uses the container query with the
`ContainerRegistrationKeys.QUERY`-style resolution; mirror whatever it
does) and a fake inventory module `{ adjustInventory: jest.fn() }` for
`Modules.INVENTORY`.

Cases:

1. **Split take**: levels `[{A, loc1, available: 3}, {A, loc2, available: 2}]`,
   `takeCardStock(container)('handle', 4)` → resolves `true` and
   `adjustInventory` called EXACTLY twice: `(A, loc1, -3)` then
   `(A, loc2, -1)`. This is the case that fails if the wiring reverts to
   the pre-#468 single-location body.
2. **Untracked handle**: levels `[]` → resolves `false`, zero
   `adjustInventory` calls.
3. **Owed remainder**: one level `{A, loc1, available: 2}`, qty 5 →
   one call `(A, loc1, -5)` (the negative IS the operator signal — assert
   the full 5 lands on the last level, not a clamp to 2).

If mocking `cardInventoryLevels`'s query shape turns out to be deeper than
one resolve (it walks `variants → inventory_items → location_levels`),
mock at module level instead: `jest.mock('./card-stock')`-style partial
mocks are NOT acceptable (they'd stub the subject); instead stub the
container's query to return the nested rows shape `cardInventoryLevels`
walks (read its loop — the shape is
`rows[].variants[].inventory_items[].inventory.{id}` +
`.inventory.location_levels[]`). This keeps the REAL
`cardInventoryLevels → planCardStockTake → adjustInventory` chain under
test, which is the entire point.

**Verify**: jest `--testPathPatterns "card-stock"` → all pass (planner
spec + new file). Mutation proof: temporarily change `takeCardStock`'s
loop to the old shape (single `adjustInventory(levels[0].…, -qty)`) → the
new case 1 FAILS → revert.

### Step 2: Window-boundary case in the cap integration spec

Add to `integration-tests/http/globepay-deposit-cap.spec.ts`, alongside
the settled-row case (same shape):

```ts
it('does not count a pending row older than the window', async () => {
  const customer = 'cus_cap_stale';
  const rows = await seed(customer, CAP);
  await packs().updateGlobePayDeposits(
    rows.map((r) => ({
      id: r.id,
      created_at: new Date(Date.now() - GLOBEPAY_PENDING_WINDOW_MS - 60_000),
    })),
  );
  expect(
    await packs().createGlobePayDepositCapped(capped(customer)),
  ).not.toBeNull();
});
```

`GLOBEPAY_PENDING_WINDOW_MS` is already imported at the top of the spec.
If `updateGlobePayDeposits` refuses to write `created_at` (framework
timestamps are sometimes ORM-managed), fall back to raw SQL through the
same manager the service uses in its own integration seeds — check how
other integration specs run raw SQL (`grep -rn "execute(" backend/packages/api/integration-tests/http/*.ts | head`)
and copy that mechanism; if none exists, STOP and report.

**Verify**: the cap integration suite → all pass, 5 cases. Mutation
proof (cheap, in-memory read of the spec's value): temporarily change the
new case's backdate to `- 60_000` (inside the window) → the case FAILS
(cap refuses) → revert. This proves the case actually exercises the
boundary.

### Step 3: Truthful partial-take diagnostics

In `card-stock.ts`, wrap the loop so a mid-plan throw reports what was
applied:

```ts
const inventory = container.resolve(Modules.INVENTORY);
const plan = planCardStockTake(levels, qty);
const applied: CardStockTake[] = [];
try {
  for (const take of plan) {
    await inventory.adjustInventory(
      take.inventoryItemId,
      take.locationId,
      -take.qty,
    );
    applied.push(take);
  }
} catch (err) {
  // adjustInventory commits per call on the inventory module's own
  // connection — nothing here can roll the applied takes back. Attach
  // the split so the operator log can say which units actually moved
  // (without this, a partial take is indistinguishable from none).
  throw new CardStockTakeError(plan, applied, err);
}
return true;
```

with a small exported error class in the same file:

```ts
export class CardStockTakeError extends Error {
  constructor(
    readonly plan: CardStockTake[],
    readonly applied: CardStockTake[],
    cause: unknown,
  ) {
    super(
      `card stock take applied ${applied.length}/${plan.length} level adjustments: ${String(cause)}`,
    );
  }
}
```

Then in `service.ts` `reserveSettledStock`'s catch, replace the fixed
"counter reads high" text with direction-aware wording:

```ts
        const appliedQty =
          err instanceof CardStockTakeError
            ? err.applied.reduce((s, t) => s + t.qty, 0)
            : 0;
        // eslint-disable-next-line no-console
        console.warn(
          appliedQty > 0
            ? '[settleChallengeWeek] stock take PARTIALLY applied then failed — counter reads LOW by the applied units and the pulls stay unflagged (buyback will not restore them); reconcile by hand'
            : '[settleChallengeWeek] stock take failed AFTER the payout committed — counter reads high, prize already granted',
          { customer_id: …, week_start: …, handle: r.handle, qty: r.qty, applied_qty: appliedQty, error: String(err) },
        );
```

(Keep the existing object fields; add `applied_qty`.) Import
`CardStockTakeError` from `./card-stock`.

**Verify**: `corepack yarn check-types` → exit 0. Add unit case 4 to the
new spec: second `adjustInventory` call rejects → the thrown error is a
`CardStockTakeError` with `applied` = the first take only. jest
`--testPathPatterns "card-stock"` → all pass. Then the challenge
integration tier that consumes `decrementStock`
(`--testPathPatterns "challenge-settle"`) → all pass (its fakes throw
plain Errors — the `instanceof` guard keeps the old wording for those, so
no existing assertion breaks; if one does, read it before touching it).

### Step 4: Copy the READ COMMITTED paragraph onto `createGlobePayDepositCapped`

In `service.ts`, extend the doc block above `createGlobePayDepositCapped`
with the sibling paragraph, adapted to this method (locate the wording at
the two existing `DEPENDS ON READ COMMITTED` sites and mirror it):
the count at the locked re-read must see rows committed by the
transaction that just released the lock; under REPEATABLE READ the count
would read a pre-lock snapshot and the cap race would silently reopen.
"Do not compose this method into a context carrying a stricter isolation
level."

**Verify**: `grep -c "DEPENDS ON READ COMMITTED" backend/packages/api/src/modules/packs/service.ts` → 3 (was 2).

## Test plan

Steps 1–3 ARE the test plan: 4 new unit cases in
`card-stock-take.unit.spec.ts` (split, untracked, owed remainder, partial
throw), 1 new integration case (window boundary), plus the two mutation
proofs. Pattern exemplars: `globepay-deposit.unit.spec.ts` (by-key
container stub), the cap spec's own settled-row case (integration shape).

## Done criteria

- [ ] `corepack yarn check-types` exits 0
- [ ] jest `--testPathPatterns "card-stock"` → all pass, ≥4 new cases
- [ ] Cap integration suite → all pass, 5 cases (new: stale-window)
- [ ] jest `--testPathPatterns "challenge-settle"` → all pass
- [ ] Both mutation proofs performed and reverted (state them in the report)
- [ ] `grep -c "DEPENDS ON READ COMMITTED" …/service.ts` → 3
- [ ] `grep -n "counter reads high" …/service.ts` → still ≥1 match (the no-progress branch keeps it) and `grep -n "counter reads LOW" …/service.ts` → 1 match
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Excerpt/symbol mismatch after re-locating by name (drift).
- `updateGlobePayDeposits` cannot write `created_at` AND no existing
  integration spec demonstrates a raw-SQL mechanism — report, don't invent
  one.
- Mocking `cardInventoryLevels`'s query requires stubbing more than the
  container `resolve` (e.g. the query object has a fluent API you'd have
  to reimplement) — report the actual shape; a wrong fake here would pin
  the mock, not the wiring.
- `pokenic-postgres`/`pokenic-redis` containers are not running and
  cannot be started.
- Any existing `challenge-settle` assertion depends on the exact old warn
  string — report before changing it.

## Maintenance notes

- If a future change makes the multi-level take transactional (e.g. the
  inventory module ever exposes a batch adjust), `CardStockTakeError` and
  the partial branch collapse back to the simple form — delete them then.
- The window-boundary integration case doubles as the regression pin for
  anyone "simplifying" the `$gte` filter out of the capped insert.
- Reviewer: Step 3 must not change WHEN the earmark flip is skipped (any
  throw still skips it for that reservation — the change is log-only plus
  the error type).
