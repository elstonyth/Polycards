# Plan 108: Count settled rows with no gross on file, and correct the audit doc's C2/C3 status

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 16cc85d3..HEAD -- backend/packages/api/src/modules/packs/globepay-settlement.ts backend/packages/api/src/modules/packs/service.ts backend/apps/admin/src/routes/settlement/ docs/payments/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (money reporting) + docs
- **Planned at**: commit `16cc85d3`, 2026-08-18

## Why this matters

The settlement report is the screen an operator reads to answer "what did this
month actually earn". It is built on one rule, stated at the top of its own
module: **NULL means unknown, never zero** — and it honors that rule for the
fee, counting the rows it had to exclude (`missingNet`) and rendering the fee
as `≥ RM x` when that count is non-zero.

It does **not** honor the same rule for the gross. SQL `SUM` skips NULLs, so a
settled deposit with no `amount_settled` counts in the period's row count and
contributes RM 0 to the gross — the period simply reads low, with nothing on
screen saying so. The audit that produced this report names exactly this failure
mode as an operational rule for the human, and names the flow that reaches it:
the over-ceiling quarantine path ends in manual settlement, and a hand-settled
row is written outside every code path that would set the column.

The same audit document's closing paragraph is now also wrong: it lists findings
C2 and C3 as "left open", but the very PR that shipped alongside it closed both.
An operator or agent reading it re-files closed work, or believes the payout
side still has no settled-amount column to reconcile against.

After this plan: an understated period is visible as understated, and the audit
doc says what the code actually does.

## Current state

### The asymmetry, in one query

`backend/packages/api/src/modules/packs/service.ts:4751-4763` — the deposits
aggregate. Note that `net_amount IS NULL` gets a `COUNT(*) FILTER` and
`amount_settled IS NULL` gets nothing:

```sql
SELECT ${bucket('settled_at')} AS period,
       COUNT(*)::bigint AS n,
       COALESCE(SUM(ROUND(amount_settled * 100)), 0)::bigint AS gross_cents,
       COALESCE(SUM(ROUND(net_amount * 100)) FILTER (WHERE net_amount IS NOT NULL), 0)::bigint AS net_cents,
       COALESCE(SUM(ROUND(amount_settled * 100)) FILTER (WHERE net_amount IS NOT NULL), 0)::bigint AS gross_with_net_cents,
       COUNT(*) FILTER (WHERE net_amount IS NULL)::bigint AS missing_net
  FROM globepay_deposit
 WHERE deleted_at IS NULL AND status = 'settled'
   AND settled_at IS NOT NULL AND settled_at >= ?::timestamptz
 GROUP BY 1
```

`SUM` ignores NULL inputs, so the `COALESCE(..., 0)` on `gross_cents` only fires
when the whole bucket is NULL. A single settled row with NULL `amount_settled`
sitting among priced rows is silently worth RM 0.

The withdrawals aggregate immediately below it (`:4775-4787`) is **not**
affected in the same way — its gross is `amount`, the debit basis, which is
`NOT NULL` on every row by construction. Read its comment before you touch
anything; the two directions differ deliberately.

### Why a NULL `amount_settled` on a settled row is reachable

`backend/packages/api/src/jobs/globepay-reconcile.ts:216-223` — the quarantine
branch leaves the row for a human:

```ts
if (action.kind === 'quarantine') {
  quarantined += 1;
  logger.error(
    `[globepay-reconcile] ${deposit.merchant_transaction_id} requeried at ${action.amount}, above the RM ${GLOBEPAY_MAX_RM} deposit ceiling — not credited, not written off; left ${deposit.status} for manual settlement`,
  );
  continue;
}
```

and `docs/payments/money-path-accuracy-audit-2026-08-17.md` states the resulting
rule:

> One operational rule the mirror introduces: **a deposit settled BY HAND must
> write `amount_settled`** [...] The settlement report sums `amount_settled` over
> settled deposit rows — a manually-settled row without it counts in `count`
> and contributes RM 0 to gross, understating the period silently. The
> quarantine path (over-ceiling callbacks/requeries) is the one flow that ends
> in manual settlement today.

A hand-settled row is written by an operator in SQL or the admin, i.e. outside
every writer that sets the column. The guard is therefore not pre-emptive.

### The shapes to extend

`backend/packages/api/src/modules/packs/globepay-settlement.ts` — pure merge
math, no DB, no container. Its types:

```ts
/** One period-bucket of settled gateway rows, as grouped by the service SQL. */
export type GatewayPeriodRow = {
  period: string;
  count: number;
  grossCents: number;
  netCents: number;
  grossWithNetCents: number;
  missingNet: number;
};

export type SettlementDirection = {
  count: number;
  gross: number;
  net: number;
  fee: number;
  missingNet: number;
};

const EMPTY_DIRECTION: SettlementDirection = {
  count: 0,
  gross: 0,
  net: 0,
  fee: 0,
  missingNet: 0,
};

function toDirection(row: GatewayPeriodRow | undefined): SettlementDirection {
  if (!row) return EMPTY_DIRECTION;
  return {
    count: row.count,
    gross: row.grossCents / 100,
    net: row.netCents / 100,
    // Fee over the known-net subset ONLY — see the NULL-net rule above.
    fee: (row.grossWithNetCents - row.netCents) / 100,
    missingNet: row.missingNet,
  };
}
```

and the SQL row mapper in the service (`service.ts:4734-4749`):

```ts
type RawGateway = {
  period: string;
  n: string;
  gross_cents: string;
  net_cents: string;
  gross_with_net_cents: string;
  missing_net: string;
};
const toGateway = (r: RawGateway): GatewayPeriodRow => ({
  period: r.period,
  count: Number(r.n),
  grossCents: Number(r.gross_cents),
  netCents: Number(r.net_cents),
  grossWithNetCents: Number(r.gross_with_net_cents),
  missingNet: Number(r.missing_net),
});
```

### The admin surface, and the exact pattern to copy

`backend/apps/admin/src/routes/settlement/page.tsx` already renders the
fee-floor case. Copy this shape for the gross:

```tsx
// :225-250 (abridged)
                    <Table.Cell className="text-right tabular-nums">
                      {rm(p.deposits.gross)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle text-right tabular-nums">
                      {p.deposits.missingNet > 0 ? (
                        <Tooltip
                          content={t('settlement.feeFloorHint', {
                            count: p.deposits.missingNet,
                          })}
                        >
                          <span>≥ {rm(p.deposits.fee)}</span>
                        </Tooltip>
                      ) : (
                        rm(p.deposits.fee)
                      )}
                    </Table.Cell>
```

and the page footer already aggregates the same counter:

```tsx
// :76-79
const missingNetTotal = (data?.periods ?? []).reduce(
  (sum, p) => sum + p.deposits.missingNet + p.withdrawals.missingNet,
  0,
);
```

i18n strings live in `backend/apps/admin/src/i18n/en.json` under
`"settlement"` (starts line 630). The existing hint to mirror:

```json
    "feeFloorHint": "{{count}} settled row(s) have no net on file (settled before fee tracking) — the fee shown is a floor, not the total.",
```

### The doc paragraph that is wrong

`docs/payments/money-path-accuracy-audit-2026-08-17.md`, final paragraph:

> C1, C2, C3, E1–E3 and F1 are left open and are recorded here rather than
> fixed, because each needs its own decision (a status + migration for E1, a
> provider conversation for E2, a schema column for C2).

Both C2 and C3 are closed at `16cc85d3`:

- **C2** ("the withdrawal settle path does not record what was actually paid"):
  `globepay_withdrawal.amount_settled` exists (`models/globepay-withdrawal.ts`,
  `Migration20260817090000.ts` adds both `amount_settled` and
  `raw_amount_settled`), and it is written by the callback
  (`api/hooks/globepay/withdrawal/route.ts:299`) and by the sweep
  (`jobs/globepay-withdrawal-reconcile.ts:212`).
- **C3** (`verify_outcome` "has no reader"): it is returned by
  `api/admin/globepay/withdrawals/route.ts:235` and rendered on the admin
  Withdrawals page.

C1, E1–E3 and F1 remain genuinely open — do not touch those.

### Conventions that apply

- **Money is integer sen in SQL and in the merge; divide by 100 exactly once,
  at the end.** Every aggregate is `ROUND(amount * 100)::bigint`. Do not
  introduce a float subtraction on already-rounded 2 dp values — the module's
  `delta` computation carries a comment explaining why.
- **NULL is unknown.** Any new counter exists to make an exclusion visible, not
  to let a reader assume zero.
- Comment density in this module is high and explanatory. Match it.
- Admin UI strings go through `t('settlement.<key>')` with the string in
  `i18n/en.json`; no bare literals in the table.

## Commands you will need

| Purpose                     | Command                                                                                                                                                                | Working directory      | Expected on success                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------- |
| Backend typecheck           | `corepack yarn check-types`                                                                                                                                            | `backend`              | exit 0                                       |
| Backend lint                | `./node_modules/.bin/eslint packages/api/src/modules/packs/globepay-settlement.ts packages/api/src/modules/packs/service.ts apps/admin/src/routes/settlement/page.tsx` | `backend`              | exit 0                                       |
| Settlement unit tests       | `node ../../node_modules/jest/bin/jest.js src/modules/packs/__tests__/globepay-settlement.unit.spec.ts`                                                                | `backend/packages/api` | all pass                                     |
| Backend unit tier           | `corepack yarn test:unit`                                                                                                                                              | `backend/packages/api` | all pass                                     |
| Settlement HTTP integration | `corepack yarn test:integration:http --testPathPattern globepay-settlement`                                                                                            | `backend/packages/api` | all pass (needs Postgres + Redis, see below) |
| Admin build/typecheck       | `corepack yarn check-types`                                                                                                                                            | `backend`              | exit 0 (covers `apps/admin`)                 |

**Backend lint note**: `corepack yarn lint` is known to die on this machine.
Call eslint directly instead, e.g. from `backend`:
`./node_modules/.bin/eslint packages/api/src/modules/packs/globepay-settlement.ts packages/api/src/modules/packs/service.ts apps/admin/src/routes/settlement/page.tsx`

**Never pipe test output through `tail`** — it truncates the failure summary.

**Integration tests need infrastructure**: the `pokenic-postgres` and
`pokenic-redis` Docker containers must be running, and
`backend/packages/api/.env.test` (tracked) points at them. If they are not up
and you cannot start them, run the unit tiers only and say so explicitly in your
report — do not claim the integration suite passed.

## Scope

**In scope**:

- `backend/packages/api/src/modules/packs/globepay-settlement.ts`
- `backend/packages/api/src/modules/packs/service.ts` (only
  `globepaySettlementRows` and its `RawGateway`/`toGateway` locals — this is a
  9,300-line file, keep the diff to that method)
- `backend/packages/api/src/modules/packs/__tests__/globepay-settlement.unit.spec.ts`
- `backend/packages/api/integration-tests/http/globepay-settlement.spec.ts`
- `backend/apps/admin/src/routes/settlement/page.tsx`
- `backend/apps/admin/src/i18n/en.json` (the `"settlement"` block only)
- `backend/apps/admin/src/lib/admin-rest.ts` **only if** the settlement
  response type is declared there and needs the new field
- `docs/payments/money-path-accuracy-audit-2026-08-17.md`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):

- The withdrawals aggregate's `gross_cents` basis (`amount`, not
  `amount_settled`). It is deliberately different and `amount` is never NULL;
  changing it would silently redefine the report.
- `gross_with_net_cents` and the fee math. The fee is already correct and
  already guarded.
- Any migration or index. This plan adds a `COUNT(*) FILTER`, nothing schema-level.
- Findings C1, E1, E2, E3, F1 in the audit doc — genuinely still open.
- The `/admin/globepay/balance` route and everything else on the settlement
  screen.

## Git workflow

- Branch: `advisor/108-settlement-missing-gross`
- Conventional commits, e.g.
  `fix(settlement): count settled deposits with no gross on file`
  and `docs(payments): correct the C2/C3 status in the money-path audit`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

> **Order matters.** The types come first, then the SQL that fills them. Doing
> it the other way round leaves the tree un-typecheckable between steps, which
> would make Step 1's own gate unpassable.

### Step 1: Carry the counter through the merge math (types first)

In `backend/packages/api/src/modules/packs/globepay-settlement.ts`:

1. Add `missingGross: number` to `GatewayPeriodRow`, with a doc comment:
   "Settled rows in this bucket whose gross is NULL — they count in `count` and
   contribute 0 to `gross`, so `gross` is a FLOOR whenever this is non-zero."
2. Add `missingGross: number` to `SettlementDirection` with the same meaning,
   and to `EMPTY_DIRECTION` as `0`.
3. Map it in `toDirection`: `missingGross: row.missingGross`.
4. Extend the module's header block — the "THE NULL-NET RULE" paragraph — so it
   states the rule for **both** columns. The rule is one rule; do not write a
   second, competing paragraph.

Do **not** change `gross` itself. The floor value is the honest number to show;
the counter is what tells the reader it is a floor.

Adding a required field to `GatewayPeriodRow` makes `service.ts`'s `toGateway`
stop compiling — that is the intended forcing function, and Step 2 fixes it.
So the gate for this step is a grep, not a typecheck:

**Verify**:
`grep -c "missingGross" backend/packages/api/src/modules/packs/globepay-settlement.ts`
→ ≥ 4 (both types, `EMPTY_DIRECTION`, `toDirection`).

### Step 2: Fill it from the SQL

In `backend/packages/api/src/modules/packs/service.ts`, in
`globepaySettlementRows`:

1. Add to the **deposits** query, alongside `missing_net`:

```sql
              COUNT(*) FILTER (WHERE amount_settled IS NULL)::bigint AS missing_gross,
```

2. Add to the **withdrawals** query the same column, hard-coded to zero with a
   comment — the two result sets share one `RawGateway` type and one mapper, and
   a withdrawal's gross basis (`amount`) is `NOT NULL` by construction, so there
   is nothing to count:

```sql
              0::bigint AS missing_gross,  -- withdrawals gross on `amount`, never NULL
```

3. Add `missing_gross: string` to `RawGateway` and
   `missingGross: Number(r.missing_gross)` to `toGateway`.

Write a comment above the deposits filter explaining what it counts and why it
exists — same voice as the `missing_net` rule at the top of
`globepay-settlement.ts`. Name the quarantine → manual-settlement path as the
reachable flow.

**Verify**: from `backend`, `corepack yarn check-types` → exit 0, no errors.
(This is the first point in the plan where the tree typechecks again. If it
still fails, the error names the missing piece — fix it here, do not proceed.)

### Step 3: Surface it on the admin settlement screen

In `backend/apps/admin/src/routes/settlement/page.tsx`:

1. Add a `grossFloorHint` string to the `"settlement"` block of
   `backend/apps/admin/src/i18n/en.json`, mirroring `feeFloorHint`'s wording and
   placeholder shape — state that the gross shown is a floor and that the
   likeliest cause is a hand-settled deposit whose `amount_settled` was never
   written.
2. Wrap the **deposits gross** cell in the same `Tooltip` + `≥` pattern the fee
   cell uses, gated on `p.deposits.missingGross > 0`.
3. Add a `missingGrossTotal` reduction next to the existing `missingNetTotal`
   (`:76-79`) and render it in the same footer note area, on the same condition
   shape.

Do not add the tooltip to the withdrawals gross cell — its `missingGross` is
structurally zero, and a control that can never fire is noise.

**Verify**: from `backend`, `corepack yarn check-types` → exit 0. Then
`grep -c "grossFloorHint" apps/admin/src/i18n/en.json apps/admin/src/routes/settlement/page.tsx`
→ `1` and `≥1` respectively.

### Step 4: Prove the counter is load-bearing (unit)

Extend
`backend/packages/api/src/modules/packs/__tests__/globepay-settlement.unit.spec.ts`.
Its existing cases already build `GatewayPeriodRow` literals — model the new
ones on the `missingNet: 1` case at `:52-67`.

Add at least these cases:

1. **A bucket with one unpriced settled deposit**: `count: 2`,
   `grossCents: 10_000` (one row priced, one NULL), `missingGross: 1`. Assert
   `deposits.gross === 100` **and** `deposits.missingGross === 1` — i.e. the
   report still shows the floor and now also shows that it is one.
2. **A fully-known bucket**: `missingGross: 0`, and assert
   `deposits.missingGross === 0` so a regression that hard-codes a non-zero
   default fails.
3. **The empty half**: a period present only in the ledger renders
   `EMPTY_DIRECTION`; assert `deposits.missingGross === 0`.

**Mutation-prove it**: temporarily change `toDirection` to return a constant `0`
for `missingGross`, re-run the suite, and confirm cases 1 fails. Revert the
mutation. Record the exact fail/pass split in your report — a test that cannot
fail is the thing this repo has been bitten by before.

**Verify**: from `backend/packages/api`,
`node ../../node_modules/jest/bin/jest.js src/modules/packs/__tests__/globepay-settlement.unit.spec.ts`
→ all pass, N new cases visible in the output.

### Step 5: Pin it end-to-end (integration)

Extend
`backend/packages/api/integration-tests/http/globepay-settlement.spec.ts`.
Its existing suite (`describe('GET /admin/globepay/settlement')`) seeds gateway
rows and asserts the report. Add a case that seeds a **settled deposit with
`amount_settled` left NULL** and asserts the response's
`periods[i].deposits.missingGross` is 1 while `deposits.count` includes it and
`deposits.gross` excludes it.

This is the case the unit test cannot reach: it proves the SQL `FILTER`, not the
merge.

**Verify**: from `backend/packages/api`,
`corepack yarn test:integration:http --testPathPattern globepay-settlement`
→ all pass. If the infrastructure is unavailable, say so explicitly and do not
mark this step done.

### Step 6: Correct the audit doc

In `docs/payments/money-path-accuracy-audit-2026-08-17.md`:

1. Amend the final paragraph so it lists **C1, E1–E3 and F1** as open, and adds
   a sentence stating that C2 and C3 were closed by the settlement mirror that
   shipped alongside this document, naming the files
   (`models/globepay-withdrawal.ts` + `Migration20260817090000.ts` +
   `api/hooks/globepay/withdrawal/route.ts` for C2;
   `api/admin/globepay/withdrawals/route.ts` + the admin Withdrawals page for
   C3). Do not delete the C2/C3 sections themselves — the finding write-ups stay
   as history; mark each with a one-line `**CLOSED <date>** — <where>` banner at
   the top of its section, matching how this repo annotates superseded content
   elsewhere.
2. Amend the "operational rule" paragraph to say that the report now **counts**
   hand-settled rows with no `amount_settled` and renders the gross as a floor —
   so the rule is still a rule, but breaking it is now visible rather than
   silent.

**Verify**:
`grep -n "C1, E1" docs/payments/money-path-accuracy-audit-2026-08-17.md` → 1 match;
`grep -c "CLOSED" docs/payments/money-path-accuracy-audit-2026-08-17.md` → ≥2.

## Test plan

- **New unit cases** in `globepay-settlement.unit.spec.ts`: unpriced-row bucket,
  fully-known bucket, empty half (3 cases minimum). Pattern: the existing
  `missingNet: 1` case at `:52-67`.
- **New integration case** in `integration-tests/http/globepay-settlement.spec.ts`:
  a settled deposit with NULL `amount_settled`, asserting `missingGross === 1`,
  `count` includes it, `gross` excludes it. Pattern: the existing
  `'buckets by MYT calendar month, sums net-known fees, and cross-checks the ledger'`
  case at `:97`.
- **Mutation proof** on the unit suite as described in Step 4.
- Verification: `corepack yarn test:unit` from `backend/packages/api` → all
  pass; the two commands in Steps 4 and 5 → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `corepack yarn check-types` from `backend` exits 0
- [ ] Direct eslint over the changed files exits 0
- [ ] `corepack yarn test:unit` from `backend/packages/api` exits 0
- [ ] `node ../../node_modules/jest/bin/jest.js src/modules/packs/__tests__/globepay-settlement.unit.spec.ts` → all pass, ≥3 new cases
- [ ] `corepack yarn test:integration:http --testPathPattern globepay-settlement` → all pass (or explicitly reported as un-runnable, with the reason)
- [ ] `grep -c "missingGross" backend/packages/api/src/modules/packs/globepay-settlement.ts` ≥ 4
- [ ] `grep -n "missing_gross" backend/packages/api/src/modules/packs/service.ts` → exactly 3 matches (deposits SQL, withdrawals SQL, `RawGateway`)
- [ ] `grep -n "grossFloorHint" backend/apps/admin/src/i18n/en.json` → 1 match
- [ ] `grep -n "C1, E1" docs/payments/money-path-accuracy-audit-2026-08-17.md` → 1 match
- [ ] The mutation proof was run and its fail/pass split is in the report
- [ ] `git status --short` lists only in-scope files
- [ ] `plans/README.md` status row for 108 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows `globepay-settlement.ts`, `service.ts`'s
  `globepaySettlementRows`, or the admin settlement page changed since
  `16cc85d3` and the excerpts above no longer match.
- Adding `missing_gross` to the withdrawals query as a literal `0::bigint` is
  rejected by the driver, or the two queries turn out **not** to share the
  `RawGateway` type. Report it; the alternative (two row types) is a bigger
  change than this plan authorizes.
- The mutation proof does **not** produce a failure — that means the new
  assertions are not load-bearing, and shipping them would add a second vacuous
  gate to a repo that already has one.
- You discover the assumption **"a settled deposit can have NULL
  `amount_settled`"** is false — i.e. some writer or constraint guarantees the
  column. The doc correction (Step 6) still stands; report that Steps 1–5 became
  pre-emptive rather than corrective, and let the operator decide.
- Correcting the doc would require changing a finding you have not verified
  yourself. Verify C2 and C3 against the live code before writing the amendment;
  do not take this plan's word for it.

## Maintenance notes

- **The rule to protect**: every aggregate over a nullable money column needs a
  matching exclusion counter. There are now two (`missingNet`, `missingGross`);
  a third nullable column added to either gateway table needs a third, or the
  report starts lying again in a new place.
- **A reviewer should scrutinize**: that `gross` itself was not changed (the
  floor is the honest number), that the withdrawals side got a literal zero and
  not a real filter, and that the mutation proof was actually run.
- **Deferred out of this plan**: nothing here alarms on a non-zero
  `missingGross` — it is a display counter. If manual settlement becomes common,
  the follow-up is a scheduled check, not a bigger tooltip.
- **Related open findings** in the same document, left untouched on purpose:
  C1 (mock top-ups indistinguishable in the economy report), E1 (ambiguous
  withdrawal requery waits forever), E2 (unverified requery error taxonomy),
  E3 (third near-copy of the refund ordering), F1 (`ledger-conservation.spec.ts`
  is narrower than its name).
