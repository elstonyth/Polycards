# Plan 125: Commission-engine follow-ups — stop losing free rips, unfreeze paid referrers, show `RF` in the ledger console

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. Do NOT update
> `plans/README.md`; the reviewer maintains it.
>
> **Drift check (run first)**:
> `git diff --stat affaab51..HEAD -- backend/packages/api/src/modules/packs/service.ts backend/packages/api/src/jobs/pay-referral-week.ts backend/apps/admin/src/lib/admin-rest.ts backend/apps/admin/src/routes/ledger/page.tsx backend/apps/admin/src/i18n/en.json`
> On any change, re-read the file before proceeding and compare against the
> "Current state" excerpts below. On a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED — touches the weekly payout path and the task-claim read path
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `affaab51`, 2026-08-26

## Why this matters

PR #490 shipped the weekly commission engine and the `/task` hub. Three defects
came with it, all on money-adjacent paths, none caught by any test:

1. A free rip (a claimed pack reward) that the player does not spin before
   Monday 00:00 MYT disappears from the only screen that lists it. The
   entitlement row survives and is still redeemable by URL, so this is a
   silently swallowed reward — and the unique claim index guarantees the player
   can never re-earn that week's task.
2. A referrer sitting on an AUTO freeze (negative balance from a clawback)
   whose Wednesday commission repays the debt gets credited and **stays
   frozen**. Available balance keeps reading 0, so opens, free-pack claims and
   withdrawals stay blocked until some unrelated top-up happens to trigger the
   reconciliation. Support sees "we paid them"; the player sees a locked wallet.
3. The admin Transactions console does not know the `RF` ledger type exists.
   Every commission payout row renders the literal string `ledger.typeRf` in
   the Type column, and there is no filter tab for referral payouts — the one
   view an operator would use to reconcile a Wednesday run.

After this plan: an unspent free rip survives the week rollover, a paid
referrer's AUTO freeze lifts with the payment, and commission payouts are
labelled and filterable in the operator's money log.

## Current state

### Defect 1 — `pending_spins` is scoped to the current task week

`backend/packages/api/src/modules/packs/service.ts` — `taskHubFor` is the
`/task` hub's read. Its own docblock states the contract that the code breaks:

```ts
// service.ts:1838-1845
  }): Promise<{
    week_start: string;
    vip_level: number;
    /** Free rips this customer has claimed but not yet spun. Listed at the top
     *  level rather than on the task row on purpose: the task that granted it
     *  may since have been retired or run out its window, and the entitlement
     *  must not vanish with it. */
    pending_spins: {
```

The claims query is period-scoped, and `pendingSpins` is derived from it:

```ts
// service.ts:1861-1886 (abridged — the third element of the Promise.all)
const week = taskWeekFor(input.now ?? new Date());
const [defs, facts, claims] = await Promise.all([
  this.listTaskDefinitions(/* ... */),
  this.taskFactsFor({ customerId: input.customerId, week }, sharedContext),
  this.listTaskClaims(
    {
      customer_id: input.customerId,
      period_key: [week.weekStartIso, ''],
    },
    {
      select: ['id', 'task_id', 'period_key', 'claim_ref', 'reward_snapshot'],
      take: 1000,
    },
    sharedContext,
  ),
]);
const claimed = new Set(claims.map((c) => `${c.task_id}:${c.period_key}`));
```

```ts
// service.ts:1892-1908
// Unspent pack entitlements. `claim_ref` null is the whole test — it is
// stamped with the pull id the moment the spin commits.
const pendingSpins = claims
  .filter((c) => {
    if (c.claim_ref) return false;
    const snap = (c.reward_snapshot ?? {}) as {
      type?: string;
      pack_id?: string;
    };
    return snap.type === 'pack' && typeof snap.pack_id === 'string';
  })
  .map((c) => ({
    claim_id: c.id,
    task_id: c.task_id,
    title: titleById.get(c.task_id) ?? 'Free rip',
    pack_id: String((c.reward_snapshot as { pack_id?: string }).pack_id ?? ''),
  }));
```

`period_key` is the week's Monday ISO date for a weekly task and the empty
string for an achievement. The filter `[week.weekStartIso, '']` is an IN-list,
so **last week's** weekly claim (whose `period_key` is the previous Monday) is
not in `claims` at all, and therefore cannot be in `pendingSpins`.

The `claimed` set on line 1886 is built from the same array and **must stay
period-scoped** — a weekly task becomes claimable again each week, and widening
that query would mark it permanently claimed. This is why the fix is a second
query, not a filter change.

The redemption path itself has no period check, which is what makes the reward
recoverable-but-invisible:

```ts
// service.ts:7246-7262 (abridged)
  async redeemTaskPackClaim(
    input: { customerId: string; claimId: string; /* ... */ },
    @MedusaContext() sharedContext: Context = {},
  ): Promise</* ... */> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `taskclaim:${input.claimId}`,
    ]);

    const [claim] = await this.listTaskClaims({ id: input.claimId }, { take: 1 }, sharedContext);
    // Ownership before anything else — the claim id comes from the client.
    if (!claim || claim.customer_id !== input.customerId) {
      return { redeemed: false, reason: 'not_found' };
    }
    if (claim.claim_ref) {
      return { redeemed: false, reason: 'already_redeemed', pullId: claim.claim_ref };
    }
```

`/task` is the only surface that lists free rips:
`src/app/task/TaskHubClient.tsx:222-243` renders them and links to
`/slots/<pack>/spin?freeRip=<claimId>`.

### Defect 2 — the payout bypasses the auto-unfreeze reconcile

`payWeeklySettlement` writes the credit with a raw insert, not through
`mutateCreditAtomic`:

```ts
// service.ts:1507-1545 (abridged — inside the per-line loop)
      const entry = await this.recordLedgerEntry(
        {
          type: 'RF',
          customerId: line.customer_id,
          refId: line.id,
          walletDelta: line.amount_cents / 100,
          vaultDelta: null,
          payload: {
            type: 'RF',
            week_start: weekStartIso,
            basis_cents: line.basis_cents,
            rate_bp: line.rate_bp,
          },
        },
        sharedContext,
      );
      if (entry.replayed) {
        await this.updateWeeklySettlementLines(
          { selector: { id: line.id }, data: { status: 'paid' as const } },
          sharedContext,
        );
        continue;
      }
      const [txn] = await this.createCreditTransactions(
        [
          {
            customer_id: line.customer_id,
            amount: line.amount_cents / 100,
            reason: 'referral_commission',
          },
        ],
        sharedContext,
      );
      await this.updateWeeklySettlementLines(
        {
          selector: { id: line.id, status: 'pending' as const },
          data: { status: 'paid' as const, paid_transaction_id: txn.id },
        },
        sharedContext,
      );
      paid++;
    }
```

`mutateCreditAtomic` is what normally lifts an AUTO freeze on a positive
inflow. A helper exists for exactly the "credit written outside
`mutateCreditAtomic`" case, and its docblock says so:

```ts
// service.ts:3439-3466
  // Auto-clear an AUTO freeze after a positive inflow written OUTSIDE
  // mutateCreditAtomic (the buyback step inserts its credit directly, with a
  // UNIQUE pull_id duplicate guard + clean error mapping that the generic
  // mutate path would lose). Takes the SAME per-customer advisory lock and
  // re-reads the committed balance, so it's race-safe against concurrent
  // mutations and idempotent — calling it after the credit has committed lifts
  // an AUTO freeze whose debt is now repaid, the same as mutateCreditAtomic's
  // inline unfreeze. No-op when not frozen or still negative. (F1)
  @InjectTransactionManager()
  async maybeAutoUnfreezeForCustomer(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<void> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${customerId}`,
    ]);
    const rows = await em.execute<{ balance_cents: string | null }[]>(
      'SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS balance_cents ' +
        'FROM credit_transaction WHERE customer_id = ? AND deleted_at IS NULL',
      [customerId],
    );
    await this.maybeAutoUnfreeze(
      customerId,
      Number(rows[0]?.balance_cents ?? 0),
      sharedContext,
    );
  }
```

**The exemplar to match** is the buyback step, the repo's other direct-insert
credit path. Copy this shape — post-commit, best-effort, warn-and-continue:

```ts
// backend/packages/api/src/workflows/steps/buyback-pull.ts:255-268
// F1: this buyback credit was written outside mutateCreditAtomic, so it
// skipped the inline auto-unfreeze. Lift an AUTO freeze whose debt this
// repays, under the same per-customer lock. Best-effort: the credit already
// committed, so a lingering freeze is no worse than before and clears on the
// next inflow — never fail a successful buyback on the unfreeze check.
try {
  await packs.maybeAutoUnfreezeForCustomer(input.customer_id);
} catch (error) {
  logger.warn(
    `buyback-pull: auto-unfreeze check failed for '${input.customer_id}' — buyback continues. ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}
```

**Why the unfreeze must run after the settlement transaction commits, not
inside it.** `payWeeklySettlement` is decorated `@InjectTransactionManager()`
and its own comment records that the whole run commits as one transaction:

```ts
// service.ts:1448-1454
  // ponytail: the whole run commits as ONE transaction — fine at this
  // volume; chunk per-line (settleChallengeWeek style) if runs ever grow to
  // thousands of lines.
  @InjectTransactionManager()
  async payWeeklySettlement(
    input: { settlementId: string; adminId?: string },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ paid: number; skipped: number }> {
```

Calling `maybeAutoUnfreezeForCustomer(id, sharedContext)` inside the loop would
join that transaction and take a `credit:<id>` advisory lock **per customer,
held until the run commits**. That is N held locks across one long transaction,
racing every concurrent top-up — a deadlock surface this plan will not open.
The buyback precedent runs it bare, post-commit, and so will we.

The method's current return is `{ paid, skipped }` (`service.ts:1583`). It has
exactly two callers:

```ts
// backend/packages/api/src/jobs/pay-referral-week.ts:38-49 (abridged)
  for (const run of approved) {
    try {
      const result = await packs.payWeeklySettlement({ settlementId: run.id });
      say(
        'info',
        `[pay-referral-week] settlement ${run.id}: paid ${result.paid}, skipped ${result.skipped}`,
      );
    } catch (e: unknown) {
      failed++;
      say('error', `[pay-referral-week] settlement ${run.id} FAILED, will retry next tick: ${...}`);
    }
  }
```

```ts
// backend/packages/api/src/api/admin/referrals/settlements/[id]/pay/route.ts:13-23
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  res.json(
    await packs.payWeeklySettlement({
      settlementId: req.params.id,
      adminId: req.auth_context.actor_id,
    }),
  );
}
```

### Defect 3 — the admin ledger console has no `RF`

Backend enum and DB CHECK both carry `RF`:

```ts
// backend/packages/api/src/modules/packs/ledger.ts:15
export type LedgerType = 'TP' | 'SP' | 'SE' | 'OD' | 'AD' | 'WP' | 'WD' | 'RF';
```

The admin's hand-copy does not:

```ts
// backend/apps/admin/src/lib/admin-rest.ts:1375-1377
/** The ledger event types (POLYCARD-BACK §5.1). */
export type LedgerType = 'TP' | 'SP' | 'SE' | 'OD' | 'AD' | 'WP' | 'WD';
```

The console's tab list omits it, and the comment above it is now false — #490
shipped the writer at `service.ts:1507-1522`:

```ts
// backend/apps/admin/src/routes/ledger/page.tsx:28-40
// undefined is the "All" tab. WP (challenge settlement) is written by
// settleChallengeWinner (plan 060). The remaining types are
// still writerless — Epic 6 (referral payouts) is cancelled, so that filter
// always returns zero rows. It is empty, not broken, so it gets no
// special-case copy.
const TYPES: (LedgerType | undefined)[] = [
  undefined,
  'TP',
  'SP',
  'SE',
  'OD',
  'AD',
  'WP',
  'WD',
];
```

One label key feeds both the tabs and the Type column, so a missing key breaks
both at once:

```ts
// backend/apps/admin/src/routes/ledger/page.tsx:51-54
// 'TP' -> 'ledger.typeTp'; the All tab -> 'ledger.typeAll'. Shared by the
// filter tabs AND the Type column, so one code can never carry two names.
const typeLabelKey = (tp: LedgerType | undefined): string =>
  `ledger.type${tp ? tp[0] + tp[1].toLowerCase() : 'All'}`;
```

```jsonc
// backend/apps/admin/src/i18n/en.json:733-745 (abridged)
  "ledger": {
    "title": "Transactions",
    "typeAll": "All",
    "typeTp": "Top-up",
    "typeSp": "Spend",
    "typeSe": "Sell",
    "typeOd": "Order",
    "typeAd": "Adjustment",
    "typeWp": "Challenge",
    "typeWd": "Withdrawal",
```

There is no `typeRf`. i18next with no missing-key handler renders the key
itself, so the Type column shows `ledger.typeRf`. The backend route already
accepts `?type=RF` (`backend/packages/api/src/api/admin/ledger/route.ts:52`) —
only the console is behind.

### Conventions to match

- **Domain vocabulary** (from `CONTEXT.md`, which the executor has not read):
  a **Weekly Settlement** is one run per closed week, `draft` → `approved` →
  `paid`; **lines** are one per customer; the **Task Week** anchors on Monday
  00:00 MYT and is deliberately NOT the Tuesday Referral Week. Use these terms
  in names and comments. Do **not** introduce the term "commission reversal" or
  "generation" — those belong to the removed programme (ADR 0007).
- Service methods take `@MedusaContext() sharedContext: Context = {}` as the
  last parameter and thread it into every nested call.
- Backend specs live beside their subject in `src/**/__tests__/` and are named
  `*.unit.spec.ts` or `*.integration.spec.ts`.
- TypeScript strict, no `any`, named exports, 2-space indent.

## Commands you will need

Run backend commands from `backend/`, storefront commands from the repo root.

| Purpose            | Command                                                                 | Expected on success                                                                                        |
| ------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Backend typecheck  | `corepack yarn check-types` (from `backend/`)                           | exit 0, no errors                                                                                          |
| Admin typecheck    | `node_modules/.bin/tsc -b` (from `backend/apps/admin/`)                 | exit 0 — **`tsc -p` checks ZERO files here and exits 0 regardless; it is a references stub. Always `-b`.** |
| Backend unit tests | `corepack yarn test:unit` (from `backend/packages/api/`)                | all pass                                                                                                   |
| One unit spec      | `corepack yarn test:unit <filename-fragment>`                           | that suite passes                                                                                          |
| Module integration | `corepack yarn test:integration:modules` (from `backend/packages/api/`) | all pass                                                                                                   |
| Backend build      | `corepack yarn build` (from `backend/`)                                 | exit 0                                                                                                     |

Notes that will otherwise cost you an hour:

- Never pipe a test command through `tail` — it truncates the summary and you
  will misread a red run as green.
- If `corepack yarn test:unit` fails to start on Windows, invoke jest directly:
  `node ../../node_modules/jest/bin/jest.js` with the same env the script sets.
- `corepack yarn lint` from `backend/` does **not** cover `packages/api` (no
  eslint config there). Do not treat a green backend lint as coverage of your
  API changes; the typecheck and the tests are the real gate.

## Scope

**In scope** (the only files you may modify):

- `backend/packages/api/src/modules/packs/service.ts`
- `backend/packages/api/src/jobs/pay-referral-week.ts`
- `backend/packages/api/src/api/admin/referrals/settlements/[id]/pay/route.ts`
- `backend/apps/admin/src/lib/admin-rest.ts`
- `backend/apps/admin/src/routes/ledger/page.tsx`
- `backend/apps/admin/src/i18n/en.json`
- `backend/packages/api/src/modules/packs/__tests__/task-engine.integration.spec.ts` (extend)
- `backend/packages/api/integration-tests/http/auto-unfreeze.spec.ts` (extend)

**Out of scope** (do NOT touch, even though they look related):

- `src/app/task/TaskHubClient.tsx` and anything under `src/` — the storefront
  already renders whatever `pending_spins` contains; no client change is needed
  and a change there would widen the blast radius onto a separate deploy unit.
- `redeemTaskPackClaim` (`service.ts:7246`) — its lack of a period check is
  what makes the entitlement recoverable. Leave it alone.
- The `claimed` set and the period-scoped `listTaskClaims` call it is built
  from (`service.ts:1871-1886`) — widening that query would mark weekly tasks
  permanently claimed. Add a query; do not change this one.
- `mutateCreditAtomic`, `maybeAutoUnfreeze`, `maybeAutoUnfreezeForCustomer` —
  call the last one, change none of them.
- The `payWeeklySettlement` transaction shape, the `recordLedgerEntry`-before-
  credit ordering, and the `status: 'pending'` guard on the line update. These
  are the idempotency mechanism; changing any of them is out of scope.
- Any other `LedgerType` member, and the `ledger/route.ts` backend endpoint.

## Git workflow

- Branch: `advisor/125-commission-engine-followups`, cut from `origin/master`
  (not local `master` — squash merges make the local branch diverge).
- Conventional commits, matching `git log` style. Example from this repo:
  `fix(backend): close the deposit-cap race and the split-location over-decrement, restore the deleted coverage (#468)`
- Commit per step or per logical unit.
- Do NOT push or open a PR — the reviewer does that.

## Steps

### Step 1: Make `pending_spins` survive the week rollover

In `service.ts`, inside `taskHubFor`, add a **second** claims query for unspent
pack entitlements, independent of `period_key`. Add it as a fourth element of
the existing `Promise.all` so it costs no extra round-trip wave.

Target shape:

```ts
      this.listTaskClaims(
        { customer_id: input.customerId, claim_ref: null },
        {
          select: ['id', 'task_id', 'period_key', 'claim_ref', 'reward_snapshot'],
          take: 1000,
        },
        sharedContext,
      ),
```

Then derive `pendingSpins` from that new array instead of `claims`, keeping the
existing `.filter`/`.map` bodies **unchanged** — including the `claim_ref`
guard, which stays as a defence in case the selector does not narrow.

Add a comment above the new query explaining why it is separate: the `claimed`
set must stay period-scoped so a weekly task becomes claimable again next week,
while an unspent entitlement must outlive its week (quote the existing docblock
contract at `service.ts:1841-1844`).

If `listTaskClaims` does not accept `claim_ref: null` as a selector, fall back
to querying without it and keeping the `claim_ref` filter in JS — but note
which you did in the commit message.

**Verify**: `corepack yarn check-types` from `backend/` → exit 0.

### Step 2: Prove Step 1 with a test that crosses the week boundary

Extend `backend/packages/api/src/modules/packs/__tests__/task-engine.integration.spec.ts`.
Its existing `pending_spins` assertions are same-week only (around lines 227-228
and 281) — read them first and match their setup style.

Add a case that:

1. claims a task whose reward is a pack (a free rip), at a fixed `now`;
2. calls `taskHubFor` again with `now` advanced past the **next Monday
   00:00 MYT** anchor;
3. asserts the entitlement is **still** listed in `pending_spins` with the same
   `claim_id`.

**This test must be mutation-proved.** After it passes, temporarily revert
`pendingSpins` to derive from the period-scoped `claims` array again, re-run,
and confirm the new case goes **RED**. Restore your fix. If the case passes
against the reverted code, it is vacuous — rewrite it and report what you
changed. Do not proceed with a test that cannot fail.

**Verify**: `corepack yarn test:integration:modules` from
`backend/packages/api/` → all pass, including your new case. Then the mutation
check above.

### Step 3: Return the paid customer ids from `payWeeklySettlement`

Change the return type from `{ paid: number; skipped: number }` to
`{ paid: number; skipped: number; paid_customer_ids: string[] }`.

Collect the ids inside the existing loop at the point where `paid++` happens
(`service.ts:1552`) — i.e. only customers whose credit was actually written on
**this** call. Do **not** include lines that took the `entry.replayed` early
`continue`: those were paid on an earlier run and their unfreeze already had its
chance. Do not include skipped/voided lines.

Change nothing else about the method: same transaction shape, same ordering,
same guards.

**Verify**: `corepack yarn check-types` from `backend/` → exit 0. Both callers
still compile (they read `.paid`/`.skipped` only).

### Step 4: Run the auto-unfreeze post-commit in both callers

In `backend/packages/api/src/jobs/pay-referral-week.ts`, after the successful
`payWeeklySettlement` call inside the existing `try`, loop over
`result.paid_customer_ids` and call
`packs.maybeAutoUnfreezeForCustomer(customerId)` — bare, no shared context, so
it runs in its own transaction after the settlement committed.

Wrap **each** call in its own `try`/`catch` that logs via the existing `say`
helper at `'error'` level and continues. Match the buyback precedent's
reasoning in the comment: the credit already committed, so a lingering freeze is
no worse than before and clears on the next inflow — never fail a successful
payout on the unfreeze check.

Do the same in
`backend/packages/api/src/api/admin/referrals/settlements/[id]/pay/route.ts`:
await the pay call into a local, run the same best-effort loop, then
`res.json(result)`. Resolve the logger with
`req.scope.resolve(ContainerRegistrationKeys.LOGGER)` and guard that resolution
the way the job's `say` helper does, so a test container without a logger cannot
throw.

**Verify**: `corepack yarn check-types` from `backend/` → exit 0.

### Step 5: Cover the unfreeze-after-payout case

Extend `backend/packages/api/integration-tests/http/auto-unfreeze.spec.ts`.
Read its existing scenarios first (A / A2 / B — top-up via `mutateCreditAtomic`,
partial repay, manual freeze) and match their setup and naming.

Add a scenario: a customer with an AUTO freeze from a negative balance, a
`weekly_settlement` in `approved` with one pending line whose `amount_cents`
covers the debt; pay it; assert the freeze is lifted and available balance is
no longer 0.

Add a negative case in the same scenario or beside it: a **manual** freeze must
**not** be lifted by a payout. `maybeAutoUnfreeze` is scoped to `cause='auto'`,
so this should already hold — the test pins it.

Mutation-prove the positive case: remove your Step 4 loop, confirm RED, restore.

**Verify**: `corepack yarn test:integration:http auto-unfreeze` from
`backend/packages/api/` → all pass.

### Step 6: Teach the admin console about `RF`

Three additive edits plus one comment deletion:

1. `backend/apps/admin/src/lib/admin-rest.ts:1377` — add `| 'RF'` to
   `LedgerType`.
2. `backend/apps/admin/src/routes/ledger/page.tsx` — add `'RF'` to the `TYPES`
   array, and **replace** the stale comment above it. The current text says
   "Epic 6 (referral payouts) is cancelled, so that filter always returns zero
   rows"; that is false as of PR #490. State instead that `RF` is written by
   `payWeeklySettlement` (the weekly commission payout) and name any type that
   genuinely still has no writer, if one remains.
3. `backend/apps/admin/src/i18n/en.json` — add `"typeRf": "Referral"` to the
   `ledger` block, placed to match the order of the `TYPES` array.

Place `'RF'` consistently in both the array and the JSON so the tab order and
the key order agree.

**Verify**:

- `node_modules/.bin/tsc -b` from `backend/apps/admin/` → exit 0.
- `grep -n "typeRf" backend/apps/admin/src/i18n/en.json` → exactly 1 match.
- `grep -n "Epic 6" backend/apps/admin/src/routes/ledger/page.tsx` → **0
  matches**.
- `node -e "JSON.parse(require('fs').readFileSync('backend/apps/admin/src/i18n/en.json','utf8')); console.log('ok')"`
  from the repo root → prints `ok` (the JSON is still valid).

### Step 7: Full green

**Verify**, in order:

1. `corepack yarn check-types` from `backend/` → exit 0
2. `node_modules/.bin/tsc -b` from `backend/apps/admin/` → exit 0
3. `corepack yarn test:unit` from `backend/packages/api/` → all pass
4. `corepack yarn test:integration:modules` from `backend/packages/api/` → all pass
5. `corepack yarn build` from `backend/` → exit 0
6. `git status --porcelain` → only the in-scope files listed above

## Test plan

| Test                            | File                                                               | Cases                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Free rip survives the rollover  | `modules/packs/__tests__/task-engine.integration.spec.ts` (extend) | claim a pack reward; advance `now` past the next Monday MYT anchor; entitlement still in `pending_spins`. **Mutation-proved** against the period-scoped derivation. |
| Payout lifts an AUTO freeze     | `integration-tests/http/auto-unfreeze.spec.ts` (extend)            | AUTO-frozen customer + approved settlement line covering the debt → paid and unfrozen. **Mutation-proved** by removing the Step 4 loop.                             |
| Manual freeze survives a payout | same file                                                          | manual freeze + payout → still frozen.                                                                                                                              |

Pattern to follow for the module test: the existing `pending_spins` assertions
in `task-engine.integration.spec.ts`. For the HTTP test: the existing A / A2 / B
scenarios in `auto-unfreeze.spec.ts`.

Note the module test runner resets the database between each `it`, so seed
inside each test rather than in `beforeAll`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `corepack yarn check-types` (from `backend/`) exits 0
- [ ] `node_modules/.bin/tsc -b` (from `backend/apps/admin/`) exits 0
- [ ] `corepack yarn test:unit` (from `backend/packages/api/`) exits 0
- [ ] `corepack yarn test:integration:modules` (from `backend/packages/api/`) exits 0, including the new cross-week case
- [ ] `corepack yarn test:integration:http auto-unfreeze` exits 0, including the new payout scenario
- [ ] `corepack yarn build` (from `backend/`) exits 0
- [ ] `grep -n "Epic 6" backend/apps/admin/src/routes/ledger/page.tsx` returns no matches
- [ ] `grep -c "typeRf" backend/apps/admin/src/i18n/en.json` returns 1
- [ ] Both new tests were mutation-proved RED against the unfixed code, and you state in your report exactly what you reverted to prove each one
- [ ] `git status --porcelain` lists only files from the In-scope list

## STOP conditions

Stop and report back — do not improvise — if:

- Any "Current state" excerpt does not match the live code (the tree has
  drifted since this plan was written).
- `listTaskClaims` cannot express `claim_ref: null` as a selector **and** the
  JS-filter fallback in Step 1 would require loading more than the existing
  `take: 1000` window.
- Either new test passes against the unfixed code and you cannot construct a
  version that fails. Report the vacuous test and the setup you tried.
- Changing the `payWeeklySettlement` return type breaks a caller you were not
  told about (`grep -rn "payWeeklySettlement" backend/` to enumerate before you
  start).
- The admin i18n file has a missing-key handler you did not know about, making
  the `ledger.typeRf` render claim wrong — report it; the fix is still correct
  but the stated impact changes.
- You find that the auto-unfreeze _already_ runs somewhere on the payout path.
  Report where; do not add a second call.

## Maintenance notes

- **For the reviewer**: scrutinise (a) that the `claimed` set is still built
  from the period-scoped query — widening it silently makes weekly tasks
  once-per-account; (b) that `paid_customer_ids` excludes the `entry.replayed`
  branch, or a re-run will re-attempt unfreezes for customers paid weeks ago;
  (c) that the unfreeze calls are outside the settlement transaction — an
  inside call would hold N `credit:<id>` advisory locks to commit.
- The `take: 1000` window on the new unspent-entitlements query is a bound, not
  a guarantee. If a player can ever accumulate more than 1,000 unspent free
  rips, this needs pagination — currently impossible given one claim per task
  per period, but revisit if achievements ever become repeatable.
- Deliberately deferred out of this plan: the payout notifies nobody (no feed
  event, no email), which is a product decision, not a bug. Every sibling money
  job calls `notifyFeed`; this one does not. Recorded as a direction option in
  round 14, not fixed here.
