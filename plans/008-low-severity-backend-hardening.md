# Plan 008: Low-severity backend hardening bundle

> **✅ Status: DONE — implemented in PR #59.** Items B/C/E/F were applied in this
> PR; A & D were already-safe (verified, no change). Item F (admin-cards FX
> fallback) is **done here**, not pre-existing. The "Current state" / items below
> are the pre-implementation baseline at commit `4ca2593`, kept as the record.
> See [README.md](README.md) for status — do not re-run this as a fresh checklist.

> **Executor instructions**: This bundles several small, independent hardening
> items. **Each item begins with "read + confirm" — the line numbers are from
> the audit and may have shifted; verify the cited pattern before editing.** Do
> the items in order; each has its own verification. Skip (and note) any item
> whose code no longer matches. Honor STOP conditions. Update `plans/README.md`
> when done.
>
> **Drift check (run first)**:
> `git diff --stat 4ca2593..HEAD -- backend/packages/api/src`
> Backend `src` is broad here; expect to re-read each item's file before editing.

## Status

- **Priority**: P3
- **Effort**: M (many small items)
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug / hardening
- **Planned at**: commit `4ca2593`, 2026-07-02

## Why this matters

None of these is a live money-loss or security hole — the audit confirmed the
money core is well-guarded. These are the tail: defensive asserts, config bounds,
silent-truncation risks, and one column-type verification. Individually minor;
together they remove a class of "works until an edge case" surprises. Ship them
as one small PR.

## Items

Each item is self-contained. Read the file, confirm the pattern, apply the fix,
verify.

### Item A — Bound `teamOverridePct` to (0, 100) at settings save

- **Confirmed**: `backend/packages/api/src/modules/packs/referral-commission.ts`
  `teamOverrideSchedule()` already stops runaway growth at runtime — line 55
  breaks when the raw pre-round product `< 1` sen, and line 63 (`if (amountSen >= prev) break`)
  stops any non-decaying/growing rate on the first generation. So an out-of-range
  `overridePercent` cannot compound. **The gap is upstream**: the percent is not
  validated where it's saved (rewards-settings), so a misconfigured value is
  accepted and silently produces a degenerate (empty) schedule.
- **Fix**: in the rewards-settings write path (find it — likely
  `src/api/admin/rewards-settings/route.ts` and/or
  `src/modules/packs/rewards-settings-validate.ts`), validate that the team
  override percent is a finite number in `(0, 100)`; reject with `INVALID_DATA`
  otherwise. Do NOT change `teamOverrideSchedule` — its runtime guards are
  correct and are the real safety net.
- **Verify**: backend build → exit 0; a rewards-settings save with pct = 0, 100,
  or 150 returns 400.

### Item B — Assert `pack_open` external-funded sign in `mutateCreditAtomic`

- **From audit (re-confirm)**: `backend/packages/api/src/modules/packs/service.ts`
  ~line 407-421 — for a `pack_open` debit, `externalFundedCents` is computed via
  a double-negation of `consumeExternalSen`. It's correct today, but there is no
  assert that the stamped value is `<= 0` for a debit. A future regression in
  `consumeExternalSen` could stamp a positive external-funded value and inflate
  the VIP spend basis.
- **Fix**: after the external-funded computation for `pack_open`, add a defensive
  guard: if `input.reason === 'pack_open' && externalFundedCents > 0`, throw
  `MedusaError(INVALID_DATA, ...)`. Cheap insurance on the VIP basis.
- **Verify**: backend build → exit 0; existing money unit tests still pass
  (`corepack yarn test:integration:modules` and/or `test:unit`).

### Item C — Replace silent `take: 1000` truncation with explicit handling

- **From audit (re-confirm)** two sites:
  - `backend/packages/api/src/api/admin/gacha/eligible-products/route.ts` ~line 18-20
    (`listProducts({}, { take: 1000 })` + `listCards({}, { take: 1000 })`).
  - `backend/packages/api/src/workflows/steps/update-delivery-order.ts` ~line 101-104
    (`listDeliveryOrderItems(..., { take: 1000 })`).
- **Risk**: if the real count exceeds 1000, rows are silently dropped — the admin
  card picker shows a partial catalog; a large delivery order updates only the
  first 1000 items' pull statuses.
- **Fix**: at minimum, detect truncation — if a query returns exactly the cap,
  log a warning naming the endpoint and the cap so the gap is visible. Better
  (delivery-order step): page until exhausted, since correctness (all pull
  statuses updated) matters there. For eligible-products (a picker), a logged
  warning + a comment documenting the ceiling is acceptable; a follow-up can add
  real pagination (note it, don't build it here).
- **Verify**: backend build → exit 0; delivery-order workflow tests still pass.

### Item D — Verify the leaderboard points column is BIGINT

- **From audit (re-confirm)**: `backend/packages/api/src/api/store/leaderboard/route.ts`
  aggregates `Σ(pack price × 100)` in the DB. The concern is only real if the
  underlying column is a 32-bit int.
- **Fix**: this is a **verification**, likely a no-op. Find the migration/model
  backing the leaderboard aggregation (it may aggregate over the credit ledger /
  pulls rather than a stored points column). Confirm the summed column is
  BIGINT / has adequate range. If it's genuinely a 32-bit column that accumulates
  cents, note it as a follow-up migration (do NOT write a data migration in this
  bundle — that's its own plan). If it's already BIGINT or computed on the fly,
  record "verified, no action."
- **Verify**: a written note of the column type + verdict.

### Item E — Validate admin audit/commissions pagination at the route boundary

- **From audit (re-confirm)**:
  `backend/packages/api/src/api/admin/customers/[id]/audit/route.ts` ~line 7-8 and
  `backend/packages/api/src/api/admin/customers/[id]/commissions/route.ts` ~line 10-11
  coerce `limit`/`offset` via `Number(...)` with no bounds. **The service layer
  already clamps** (max ~200, min ~1), so there is no live DoS — this is API
  hygiene: reject clearly-invalid input (negative, NaN, absurd) at the boundary
  with a 400 instead of silently clamping.
- **Fix**: add a small bounds check in each route before calling the service:
  `limit` in `[1, 200]`, `offset >= 0`; return `INVALID_DATA` on violation.
- **Verify**: backend build → exit 0; a request with `limit=-5` or
  `offset=abc` returns 400.

### Item F — Don't 500 the admin cards page when the FX read fails

- **From audit (re-confirm)**: `backend/packages/api/src/api/admin/cards/route.ts`
  ~line 19-21 — `await Promise.all([listCards(...), resolveFxRate(packs)])`. If
  the FX read throws, the whole card-list GET 500s even though the catalog loaded.
- **Fix**: fetch the FX rate with its own try/catch and fall back to
  `DEFAULT_USD_MYR` (already exported from `modules/packs/pricing`) on failure,
  logging a warning. The card list should render regardless of FX health.
- **Verify**: backend build → exit 0.

## Commands you will need

| Purpose                 | Command                                            | Expected |
| ----------------------- | -------------------------------------------------- | -------- |
| Backend build/typecheck | from `backend/packages/api`: `corepack yarn build` | exit 0   |
| Module tests            | `corepack yarn test:integration:modules`           | pass     |
| HTTP tests              | `corepack yarn test:integration:http`              | pass     |
| Unit tests              | `corepack yarn test:unit`                          | pass     |

> If `corepack yarn` exits 127 in a fresh worktree, invoke the tools via `node`
> against `node_modules` binaries. Do not run installs.

## Test plan

- Items A, E: add/extend an HTTP integration spec asserting the new 400s (model
  after an existing spec in `integration-tests/http`).
- Item B: covered by existing money unit/module tests staying green; optionally
  add a targeted assert.
- Items C, D, F: no behavior change to unit-test meaningfully — verify by build +
  the logged-warning/fallback reasoning; D is a written verdict.
- Verification: `corepack yarn build` + the three test suites pass.

## Scope

**In scope** (read + confirm each before editing):

- `src/modules/packs/referral-commission.ts` (do NOT change; reference only for Item A)
- the rewards-settings write path (route + validate module) — Item A
- `src/modules/packs/service.ts` — Item B only (the `pack_open` external-funded block)
- `src/api/admin/gacha/eligible-products/route.ts`, `src/workflows/steps/update-delivery-order.ts` — Item C
- leaderboard model/migration — Item D (read only, verdict)
- `src/api/admin/customers/[id]/audit/route.ts`, `.../commissions/route.ts` — Item E
- `src/api/admin/cards/route.ts` — Item F
- new/extended HTTP specs under `integration-tests/http`

**Out of scope:**

- The `teamOverrideSchedule` runtime decay logic (Item A) — correct, don't touch.
- Any data migration (Item D) — if a column needs widening, that's a separate plan.
- Real pagination UI/endpoints (Item C) — note as follow-up, don't build here.
- The per-customer lock / ledger mechanics — out of scope and already sound.

## Git workflow

- Branch: `advisor/008-backend-hardening`
- One commit per item (or per logical group), conventional commits, e.g.
  `fix(admin): fall back to default FX rate when the FX read fails`
- Do NOT push or open a PR unless the operator instructed it.

## Done criteria

- [ ] Item A: team-override pct rejected outside (0,100) at settings save; runtime schedule untouched.
- [ ] Item B: `pack_open` external-funded sign assert added.
- [ ] Item C: both `take:1000` sites either page-to-exhaustion (delivery) or log truncation (picker) — no silent drop.
- [ ] Item D: leaderboard points column type verified; verdict recorded (no data migration written here).
- [ ] Item E: audit/commissions routes reject invalid `limit`/`offset` with 400.
- [ ] Item F: admin cards GET renders with a fallback FX rate when the FX read fails.
- [ ] `corepack yarn build` exits 0; module + HTTP + unit suites pass.
- [ ] No files outside the in-scope list modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

- Any item's cited code no longer matches (drift) — skip that item, note it, keep going with the rest.
- Item B: the existing money tests fail after the assert — the assert is catching
  a real pre-existing case; stop and report (do not weaken the assert to pass).
- Item D: the points column IS 32-bit and already near overflow — stop and
  escalate; a live data migration is out of scope for this bundle.
- A fix requires touching the per-customer lock / ledger core — stop; out of scope.

## Maintenance notes

- Items are deliberately conservative (asserts, bounds, logs) so they can't
  regress behavior. A reviewer should confirm none of them changes a success-path
  result — only rejects bad input or adds observability.
- Item C's picker and Item D's column are the two most likely to graduate into
  their own follow-up plans (real pagination; a BIGINT migration) — link them if
  the counts grow.
