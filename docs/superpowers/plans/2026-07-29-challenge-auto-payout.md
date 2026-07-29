# Weekly Challenge Auto-Payout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-07-29-challenge-auto-payout-design.md`

**Goal:** An hourly job that settles the just-ended challenge week — paying the top-10 the union of all pool-unlocked stages' rank rewards (credits + cards), exactly once.

**Architecture:** Windowed variant of the shared challenge-week CTE (`weeksBack`); a `challenge_payout` table whose rows are the settled-week record (unique index as backstop); per-winner short transactions serialized by the existing `credit:${customerId}` advisory lock; pure settlement maths in a standalone module. Job = enumerate → per-winner settle → post-commit notifications.

**Tech Stack:** Medusa v2 module service (MikroORM models, raw SQL via `LedgerSqlManager`), Medusa scheduled jobs, jest (`test:unit`, `test:integration:modules`), vitest for the one storefront copy entry.

## Global Constraints

- All backend work in `backend/packages/api`. **Edit backend `.ts` files via a node script through Bash if a global prettier hook rewrites quotes** (memory: global-prettier-hook-churns-backend) — check `git diff` after the first edit; if quote churn appears, switch to scripted edits.
- **Money-path invariants:** at most one `credit:` advisory-lock acquisition chain per transaction; never forward one shared context across winners; never read `creditSummary` inside an uncommitted ledger transaction (memory: VIP external-basis backfill).
- `rank_rewards[].card_id` is a Card **id**; `pull.card_id` is a Card **handle** — resolve before minting pulls (spec §Granting).
- Payout rows go through generated `createChallengePayouts` (bigNumber `raw_credits` twin), never raw INSERT.
- Migration via `corepack yarn medusa db:generate packs` — never hand-written (bigNumber columns).
- `source: 'reward'` on all reward pulls; `pack_id: 'challenge-<yyyy-mm-dd>'`.
- Credits reason: existing `'reward_credit'` enum value; idempotency reference `challenge:${weekStartIso}:${customerId}`.
- **Sequencing:** branch off master AFTER the Spec A suspension PR merges (both touch `src/lib/notifications/copy.ts`).
- Worktree (pre-consented); fresh worktree needs `corepack yarn` install at `backend/` and `corepack yarn build` in `backend/packages/odds-math` (memory: worktree-build-odds-math-dist). Backend tests run against the `pokenic-postgres` container.
- Stage commits by explicit path; unrelated uncommitted changes exist in the tree.

---

### Task 1: Windowed challenge-week CTE + `challengeWeekBounds`

**Files:**
- Modify: `backend/packages/api/src/modules/packs/service.ts:352-382` (type, CTE, params helper), `:5745-5812` (both aggregates)

**Interfaces:**
- Consumes: existing `ChallengeWeekAnchor { timezone; resetDay; resetHour }`, `CHALLENGE_WEEK_ANCHOR_CTE`, `challengeWeekAnchorParams`.
- Produces:
  - `type ChallengeWeekAnchor = { timezone: string; resetDay: number; resetHour: number; weeksBack?: number }` (default 0 = current week).
  - CTE `anchor` now emits `start_utc` **and** `end_utc`.
  - `challengeWeekPool(opts)` / `challengeWeekTop(opts)` accept `weeksBack` and bound `rolled_at` on both sides.
  - New `async challengeWeekBounds(opts: ChallengeWeekAnchor): Promise<{ startUtc: Date; endUtc: Date }>`.

- [ ] **Step 1: Extend the type and CTE**

Replace lines 351-382 with:

```ts
// The (timezone, reset-day, reset-hour) anchor a challenge-week query filters
// on. weeksBack selects a PAST week: 0 (default) = the running week, 1 = the
// most recently ended week (settlement's window).
type ChallengeWeekAnchor = {
  timezone: string;
  resetDay: number;
  resetHour: number;
  weeksBack?: number;
};

// Shared CTE resolving one challenge week's UTC [start, end) from a
// ChallengeWeekAnchor. Downstream queries append their SELECT and filter
// `pu.rolled_at >= (SELECT start_utc FROM anchor) AND
//  pu.rolled_at <  (SELECT end_utc   FROM anchor)`. Kept in ONE place so the
// community pool, the pull-value ranking, AND settlement can never drift onto
// different week boundaries. Anchor computed via AT TIME ZONE (DST-correct);
// EXTRACT(DOW) uses 0=Sunday…6=Saturday, matching challenge_settings. wkfix:
// if today IS the reset day but before the reset hour, the naive anchor lands
// in the future — step back one week. weeksBack shifts the whole week left in
// LOCAL time (before the AT TIME ZONE conversion), so a DST transition inside
// the shifted week still lands on the wall-clock reset hour. Takes 6 params
// (timezone, resetDay, resetHour, weeksBack, timezone, timezone).
const CHALLENGE_WEEK_ANCHOR_CTE =
  'WITH nowtz AS (SELECT now() AT TIME ZONE ? AS t), ' +
  'wk AS ( ' +
  "  SELECT date_trunc('day', t) " +
  "         - ((EXTRACT(DOW FROM t)::int - ? + 7) % 7) * interval '1 day' " +
  "         + ? * interval '1 hour' AS start_local, t " +
  '    FROM nowtz ' +
  '), wkfix AS ( ' +
  '  SELECT CASE WHEN start_local > t ' +
  "         THEN start_local - interval '7 days' ELSE start_local END " +
  "         - ? * interval '7 days' AS start_local " +
  '    FROM wk ' +
  '), anchor AS ( ' +
  '  SELECT start_local AT TIME ZONE ? AS start_utc, ' +
  "         (start_local + interval '7 days') AT TIME ZONE ? AS end_utc " +
  '    FROM wkfix ' +
  ') ';
// resetDay/resetHour/weeksBack stay NUMBERS — they feed integer arithmetic in
// the CTE, so a string would change the query's typing.
const challengeWeekAnchorParams = (
  w: ChallengeWeekAnchor,
): (string | number)[] => [
  w.timezone,
  w.resetDay,
  w.resetHour,
  w.weeksBack ?? 0,
  w.timezone,
  w.timezone,
];
```

- [ ] **Step 2: Bound both aggregates above**

In `challengeWeekPool` and `challengeWeekTop`, change the WHERE tail:
```
'   AND pu.rolled_at >= (SELECT start_utc FROM anchor)',
```
becomes (both methods):
```
'   AND pu.rolled_at >= (SELECT start_utc FROM anchor) ' +
'   AND pu.rolled_at <  (SELECT end_utc FROM anchor)',
```
(`challengeWeekTop` keeps its trailing `GROUP BY/ORDER BY/LIMIT` after the new condition.) With `weeksBack: 0` the upper bound is in the future — behaviour identical, existing suites stay green.

- [ ] **Step 3: Add `challengeWeekBounds`**

Next to the two aggregates:

```ts
// Resolve one challenge week's UTC [start, end) — settlement's payout key
// comes from the SAME CTE as the aggregates, so they can never disagree on
// the boundary. (All queries in a settlement run execute after the cron
// fire, which is at-or-after the reset instant — see the spec's
// boundary-race note.)
@InjectManager()
async challengeWeekBounds(
  opts: ChallengeWeekAnchor,
  @MedusaContext() sharedContext: Context = {},
): Promise<{ startUtc: Date; endUtc: Date }> {
  const em = (sharedContext.transactionManager ??
    sharedContext.manager) as unknown as LedgerSqlManager;
  const [row] = await em.execute<{ start_utc: string; end_utc: string }[]>(
    CHALLENGE_WEEK_ANCHOR_CTE + 'SELECT start_utc, end_utc FROM anchor',
    challengeWeekAnchorParams(opts),
  );
  return { startUtc: new Date(row!.start_utc), endUtc: new Date(row!.end_utc) };
}
```

- [ ] **Step 4: Typecheck + existing units**

Run (from `backend/packages/api`): `corepack yarn check-types && corepack yarn test:unit`
Expected: clean — no existing spec pins the old 4-param CTE string; if one does, update its expectation to the 6-param form.

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src/modules/packs/service.ts
git commit -m "feat(challenge): windowed week CTE (weeksBack) + challengeWeekBounds"
```

---

### Task 2: `challenge_payout` model + migration

**Files:**
- Create: `backend/packages/api/src/modules/packs/models/challenge-payout.ts`
- Modify: `backend/packages/api/src/modules/packs/service.ts:384-416` (MedusaService registration)
- Create (generated): `backend/packages/api/src/modules/packs/migrations/Migration<timestamp>.ts`

**Interfaces:**
- Produces: model `ChallengePayout` (table `challenge_payout`); generated service methods `listChallengePayouts`, `createChallengePayouts`, `updateChallengePayouts` used by Task 4.

- [ ] **Step 1: Model file**

```ts
import { model } from '@medusajs/framework/utils';

// One settled reward per (week, customer, kind, card). The row set for a
// week_start IS the "this week is settled" record the hourly job gates on.
// card_id: NOT nullable — '' on credits rows. Postgres treats NULLs as
// DISTINCT in a unique index; a nullable card_id would let the credits row
// insert twice and void the backstop below. The advisory-lock check in
// settleChallengeWinner is the primary guard; this index is the last resort.
export const ChallengePayout = model
  .define('challenge_payout', {
    id: model.id().primaryKey(),
    // Resolved start_utc of the paid week (challengeWeekBounds).
    week_start: model.dateTime(),
    customer_id: model.text(),
    rank: model.number(),
    kind: model.enum(['credits', 'card']),
    card_id: model.text().default(''),
    credits: model.bigNumber().default(0),
    // Audit links: the ledger row / vault pull this payout produced.
    credit_transaction_id: model.text().nullable(),
    pull_id: model.text().nullable(),
    status: model.enum(['granted', 'skipped_no_stock']).default('granted'),
    // { pool_myr, unlocked_stages: number[] } — why this payout happened.
    snapshot: model.json(),
  })
  .indexes([
    {
      name: 'UQ_challenge_payout_week_customer_kind_card',
      on: ['week_start', 'customer_id', 'kind', 'card_id'],
      unique: true,
      where: 'deleted_at IS NULL',
    },
    {
      name: 'IDX_challenge_payout_week',
      on: ['week_start'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default ChallengePayout;
```

- [ ] **Step 2: Register in the service**

`service.ts`: `import ChallengePayout from './models/challenge-payout';` and add `ChallengePayout,` to the `MedusaService({ … })` map (after `ChallengeSettings`).

- [ ] **Step 3: Generate the migration**

Run (from `backend/packages/api`): `corepack yarn medusa db:generate packs`
Expected: a new `Migration*.ts` under `src/modules/packs/migrations/`.

- [ ] **Step 4: Inspect the migration — the bigNumber trap**

Open the generated file and confirm it creates BOTH `"credits" numeric` **and** `"raw_credits" jsonb` columns, the two partial indexes, and the enum CHECKs. If `raw_credits` is missing, STOP — the generate ran against a stale build; rebuild and regenerate (memory: bigNumber-needs-raw-column).

- [ ] **Step 5: Apply locally + typecheck**

Run: `corepack yarn medusa db:migrate && corepack yarn check-types`
Expected: migration applies against `pokenic-postgres`; types clean (`listChallengePayouts` now exists on the service type).

- [ ] **Step 6: Commit**

```bash
git add backend/packages/api/src/modules/packs/models/challenge-payout.ts backend/packages/api/src/modules/packs/service.ts backend/packages/api/src/modules/packs/migrations/
git commit -m "feat(challenge): challenge_payout model + migration (settled-week record)"
```

---

### Task 3: Pure settlement maths — `challenge-settle.ts` (TDD)

**Files:**
- Create: `backend/packages/api/src/modules/packs/challenge-settle.ts`
- Test: `backend/packages/api/src/modules/packs/__tests__/challenge-settle.unit.spec.ts`

**Interfaces:**
- Consumes: `ChallengeRankReward { rank: number; card_id: string | null; credits: number }` from `./challenge-validate`.
- Produces (Task 4 depends on these exact names):
  - `interface SettleStage { stage_number: number; threshold_myr: number; rank_rewards: ChallengeRankReward[] }`
  - `function unlockedStages(stages: SettleStage[], poolMyr: number): SettleStage[]`
  - `interface RankPayout { rank: number; credits: number; cardIds: string[] }`
  - `function payoutByRank(unlocked: SettleStage[]): Map<number, RankPayout>`

- [ ] **Step 1: Write the failing spec**

`__tests__/challenge-settle.unit.spec.ts`:

```ts
import {
  unlockedStages,
  payoutByRank,
  type SettleStage,
} from '../challenge-settle';

const stage = (
  n: number,
  threshold: number,
  rewards: { rank: number; card_id?: string | null; credits?: number }[],
): SettleStage => ({
  stage_number: n,
  threshold_myr: threshold,
  rank_rewards: rewards.map((r) => ({
    rank: r.rank,
    card_id: r.card_id ?? null,
    credits: r.credits ?? 0,
  })),
});

describe('unlockedStages', () => {
  const stages = [
    stage(1, 1000, [{ rank: 1, credits: 50 }]),
    stage(2, 5000, [{ rank: 1, credits: 100 }]),
    stage(3, 10000, [{ rank: 1, card_id: 'card_a' }]),
  ];

  it('unlocks every stage at or below the pool (>= is inclusive)', () => {
    expect(unlockedStages(stages, 5000).map((s) => s.stage_number)).toEqual([
      1, 2,
    ]);
  });

  it('unlocks nothing below the lowest threshold', () => {
    expect(unlockedStages(stages, 999)).toEqual([]);
  });

  it('unlocks all above the highest threshold', () => {
    expect(unlockedStages(stages, 10_000).map((s) => s.stage_number)).toEqual([
      1, 2, 3,
    ]);
  });
});

describe('payoutByRank', () => {
  it('sums credits and collects card ids across unlocked stages', () => {
    const unlocked = [
      stage(1, 0, [
        { rank: 1, credits: 50, card_id: 'card_a' },
        { rank: 4, credits: 20 },
      ]),
      stage(2, 0, [
        { rank: 1, credits: 100, card_id: 'card_b' },
        { rank: 2, card_id: 'card_c' },
      ]),
    ];
    const by = payoutByRank(unlocked);
    expect(by.get(1)).toEqual({
      rank: 1,
      credits: 150,
      cardIds: ['card_a', 'card_b'],
    });
    expect(by.get(2)).toEqual({ rank: 2, credits: 0, cardIds: ['card_c'] });
    expect(by.get(4)).toEqual({ rank: 4, credits: 20, cardIds: [] });
    expect(by.has(3)).toBe(false); // sparse rank pays nothing
  });

  it('keeps duplicate card ids (two stages may award the same card twice)', () => {
    const by = payoutByRank([
      stage(1, 0, [{ rank: 1, card_id: 'card_a' }]),
      stage(2, 0, [{ rank: 1, card_id: 'card_a' }]),
    ]);
    expect(by.get(1)!.cardIds).toEqual(['card_a', 'card_a']);
  });
});
```

**Design note the test encodes:** duplicate card ids are KEPT — two unlocked stages each awarding `card_a` to rank 1 mean two physical cards. But the unique index is `(week, customer, kind, card_id)`, which cannot hold two `card_a` rows for one customer. Resolution (implement in Step 3): `payoutByRank` returns duplicates; Task 4 aggregates them into ONE payout row per distinct card with a `qty` inside `snapshot`, minting `qty` pulls. The row stays unique; the physical count survives.

- [ ] **Step 2: Run to verify it fails**

Run: `corepack yarn test:unit --testPathPattern challenge-settle`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { ChallengeRankReward } from './challenge-validate';

/** Stage projection settlement needs (matches listChallengeStages select). */
export interface SettleStage {
  stage_number: number;
  threshold_myr: number;
  rank_rewards: ChallengeRankReward[];
}

/** Stages the final pool unlocked — >= is inclusive (spec rule 3). */
export function unlockedStages(
  stages: SettleStage[],
  poolMyr: number,
): SettleStage[] {
  return stages
    .filter((s) => poolMyr >= s.threshold_myr)
    .sort((a, b) => a.stage_number - b.stage_number);
}

export interface RankPayout {
  rank: number;
  credits: number;
  cardIds: string[]; // may repeat — same card from two stages = two copies
}

/** Union of every unlocked stage's prize table, keyed by rank (spec rule 5):
 *  credits summed, card ids collected in stage order. Ranks absent from all
 *  tables are absent from the map. */
export function payoutByRank(
  unlocked: SettleStage[],
): Map<number, RankPayout> {
  const by = new Map<number, RankPayout>();
  for (const s of unlocked) {
    for (const r of s.rank_rewards) {
      const cur = by.get(r.rank) ?? { rank: r.rank, credits: 0, cardIds: [] };
      cur.credits += r.credits;
      if (r.card_id) cur.cardIds.push(r.card_id);
      by.set(r.rank, cur);
    }
  }
  return by;
}
```

- [ ] **Step 4: Run tests**

Run: `corepack yarn test:unit --testPathPattern challenge-settle`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src/modules/packs/challenge-settle.ts backend/packages/api/src/modules/packs/__tests__/challenge-settle.unit.spec.ts
git commit -m "feat(challenge): pure settlement maths (stage unlock + per-rank union)"
```

---

### Task 4: `settleChallengeWeek` + `settleChallengeWinner` on the service

**Files:**
- Modify: `backend/packages/api/src/modules/packs/service.ts` (two methods, next to the challenge aggregates; import `unlockedStages`, `payoutByRank`, `SettleStage` from `./challenge-settle`)

**Interfaces:**
- Consumes: Task 1 `challengeWeekBounds` / windowed aggregates; Task 2 generated payout methods; Task 3 maths; existing `mutateCreditAtomic`, `createPulls`, `listCards`, `listChallengeStages`, `challengeSettings`.
- Produces (job in Task 5 calls exactly this):

```ts
export interface SettleDeps {
  /** Available stock per card HANDLE (job binds getCardStockByHandle). */
  getStock: (handles: string[]) => Promise<Map<string, number | null>>;
}
export interface SettledWinner {
  customerId: string;
  rank: number;
  credits: number;
  cardHandles: string[];   // granted
  skippedCardIds: string[]; // recorded skipped_no_stock
}
// returns { weekStartIso, settled, winners } — settled:false = gated/no-op
async settleChallengeWeek(deps: SettleDeps): Promise<{
  weekStartIso: string;
  settled: boolean;
  winners: SettledWinner[];
}>
```

- [ ] **Step 1: Write the enumerator `settleChallengeWeek`**

`@InjectManager()` (plain read context — NO transaction at this level, mirroring `matureDueCommissions`):

```ts
@InjectManager()
async settleChallengeWeek(
  deps: SettleDeps,
  @MedusaContext() sharedContext: Context = {},
): Promise<{ weekStartIso: string; settled: boolean; winners: SettledWinner[] }> {
  const settings = await this.challengeSettings(sharedContext);
  const week = {
    timezone: settings.timezone,
    resetDay: settings.reset_day,
    resetHour: settings.reset_hour,
    weeksBack: 1,
  };
  const { startUtc } = await this.challengeWeekBounds(week, sharedContext);
  const weekStartIso = startUtc.toISOString();

  // Hourly self-gate, PER WINNER (spec §Scheduling): customers who already
  // hold payout rows for this week are skipped before any transaction opens.
  // Deliberately NOT a whole-week early return — a crash mid-batch leaves
  // some winners paid and some not, and a whole-week gate would lock the
  // unpaid remainder out forever. Racy by itself; the in-transaction
  // lock+check in settleChallengeWinner is the real guard.
  const existingRows = await this.listChallengePayouts(
    { week_start: startUtc },
    { select: ['customer_id'], take: 1000 },
  );
  const settledCustomers = new Set(existingRows.map((r) => r.customer_id));

  const [stageRows, poolMyr] = await Promise.all([
    this.listChallengeStages(
      {},
      { select: ['stage_number', 'threshold_myr', 'rank_rewards'], take: 1000 },
    ),
    this.challengeWeekPool(week, sharedContext),
  ]);
  const stages: SettleStage[] = stageRows.map((r) => ({
    stage_number: r.stage_number,
    threshold_myr: Number(r.threshold_myr),
    rank_rewards:
      (r.rank_rewards as unknown as ChallengeRankReward[]) ?? [],
  }));
  const unlocked = unlockedStages(stages, poolMyr);
  if (unlocked.length === 0) return { weekStartIso, settled: false, winners: [] };

  const top = await this.challengeWeekTop({ ...week, limit: 10 }, sharedContext);
  if (top.length === 0) return { weekStartIso, settled: false, winners: [] };
  const byRank = payoutByRank(unlocked);

  // Resolve card ids -> handles ONCE (spec: rank_rewards holds Card.id,
  // pull.card_id holds Card.handle — never pass ids into createPulls).
  const allCardIds = [
    ...new Set([...byRank.values()].flatMap((p) => p.cardIds)),
  ];
  const cardRows = allCardIds.length
    ? await this.listCards(
        { id: allCardIds },
        { select: ['id', 'handle'], take: allCardIds.length },
      )
    : [];
  const handleById = new Map(cardRows.map((c) => [c.id, c.handle]));

  const snapshot = {
    pool_myr: poolMyr,
    unlocked_stages: unlocked.map((s) => s.stage_number),
  };
  const winners: SettledWinner[] = [];
  for (const [i, t] of top.entries()) {
    if (settledCustomers.has(t.customer_id)) continue; // paid on a prior tick
    const payout = byRank.get(i + 1);
    if (!payout || (payout.credits <= 0 && payout.cardIds.length === 0)) {
      continue; // rank pays nothing this week
    }
    // One SHORT transaction per winner — deliberately NO sharedContext
    // forwarding (matureDueCommissions invariant: one credit: advisory-lock
    // chain per transaction, never accumulated across winners).
    const settled = await this.settleChallengeWinner({
      weekStart: startUtc,
      customerId: t.customer_id,
      rank: i + 1,
      payout,
      handleById,
      snapshot,
      getStock: deps.getStock,
    });
    if (settled) winners.push(settled);
  }
  return { weekStartIso, settled: winners.length > 0, winners };
}
```
(`ChallengeRankReward` is already imported in the routes; add the type import to service.ts from `./challenge-validate` if absent.)

- [ ] **Step 2: Write the per-winner transaction `settleChallengeWinner`**

`@InjectTransactionManager()` — the whole winner settles or rolls back:

```ts
@InjectTransactionManager()
protected async settleChallengeWinner(
  input: {
    weekStart: Date;
    customerId: string;
    rank: number;
    payout: RankPayout;
    handleById: Map<string, string>;
    snapshot: { pool_myr: number; unlocked_stages: number[] };
    getStock: (handles: string[]) => Promise<Map<string, number | null>>;
  },
  @MedusaContext() sharedContext: Context = {},
): Promise<SettledWinner | null> {
  const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
  const { weekStart, customerId, rank, payout } = input;
  const weekStartIso = weekStart.toISOString();

  // 1) Serialize against every money path for this customer — SAME lock key
  //    as mutateCreditAtomic (advisory xact locks are reentrant, so the
  //    credits call below re-acquiring it is a no-op).
  await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `credit:${customerId}`,
  ]);

  // 2) Check under the lock, INSIDE this txn (sharedContext!) — any existing
  //    row means a concurrent run or earlier tick already settled this
  //    customer's week. The unique index stays as the last-resort backstop.
  const [already] = await this.listChallengePayouts(
    { week_start: weekStart, customer_id: customerId },
    { take: 1 },
    sharedContext,
  );
  if (already) return null;

  const rows: {
    week_start: Date;
    customer_id: string;
    rank: number;
    kind: 'credits' | 'card';
    card_id: string;
    credits: number;
    credit_transaction_id: string | null;
    pull_id: string | null;
    status: 'granted' | 'skipped_no_stock';
    snapshot: Record<string, unknown>;
  }[] = [];

  // 3a) Credits — one ledger mutation for the summed amount.
  let creditTxnId: string | null = null;
  if (payout.credits > 0) {
    const { id } = await this.mutateCreditAtomic(
      {
        customerId,
        amount: payout.credits,
        reason: 'reward_credit',
        idempotencyReference: `challenge:${weekStartIso}:${customerId}`,
      },
      sharedContext,
    );
    creditTxnId = id;
    rows.push({
      week_start: weekStart,
      customer_id: customerId,
      rank,
      kind: 'credits',
      card_id: '',
      credits: payout.credits,
      credit_transaction_id: creditTxnId,
      pull_id: null,
      status: 'granted',
      snapshot: input.snapshot,
    });
  }

  // 3b) Cards — dedupe ids into (id, qty); resolve handle; stock-gate; mint
  //     qty pulls or record skipped_no_stock (spec: no credit substitution).
  const qtyById = new Map<string, number>();
  for (const id of payout.cardIds) {
    qtyById.set(id, (qtyById.get(id) ?? 0) + 1);
  }
  const cardHandles: string[] = [];
  const skippedCardIds: string[] = [];
  const handles = [...qtyById.keys()]
    .map((id) => input.handleById.get(id))
    .filter((h): h is string => Boolean(h));
  const stockByHandle = handles.length
    ? await input.getStock(handles)
    : new Map<string, number | null>();

  for (const [cardId, qty] of qtyById) {
    const handle = input.handleById.get(cardId);
    const stock = handle ? stockByHandle.get(handle) : undefined;
    // In stock: tracked with >= qty available, or untracked (null). An
    // unresolvable id (deleted card) or absent stock row = skipped.
    const inStock =
      Boolean(handle) &&
      stockByHandle.has(handle!) &&
      (stock === null || (stock !== undefined && stock >= qty));

    let pullId: string | null = null;
    if (inStock) {
      for (let i = 0; i < qty; i += 1) {
        const [pull] = await this.createPulls(
          [
            {
              customer_id: customerId,
              pack_id: `challenge-${weekStartIso.slice(0, 10)}`,
              card_id: handle!,
              order_id: null,
              rolled_at: new Date(),
              source: 'reward',
            },
          ],
          sharedContext,
        );
        pullId = pull.id;
      }
      cardHandles.push(handle!);
    } else {
      skippedCardIds.push(cardId);
    }
    rows.push({
      week_start: weekStart,
      customer_id: customerId,
      rank,
      kind: 'card',
      card_id: cardId,
      credits: 0,
      credit_transaction_id: null,
      pull_id: pullId, // last pull when qty > 1; qty recorded in snapshot
      status: inStock ? 'granted' : 'skipped_no_stock',
      snapshot: { ...input.snapshot, qty },
    });
  }

  if (rows.length === 0) return null;
  // 4) The settled-week record — generated create (writes raw_credits).
  await this.createChallengePayouts(rows, sharedContext);

  return {
    customerId,
    rank,
    credits: payout.credits,
    cardHandles,
    skippedCardIds,
  };
}
```

- [ ] **Step 3: Typecheck**

Run: `corepack yarn check-types`
Expected: clean. (Watch: `mutateCreditAtomic` requires `sharedContext.transactionManager` — present under `@InjectTransactionManager`. `RankPayout` import from `./challenge-settle`.)

- [ ] **Step 4: Commit**

```bash
git add backend/packages/api/src/modules/packs/service.ts
git commit -m "feat(challenge): settleChallengeWeek — advisory-locked per-winner settlement"
```

---

### Task 5: Hourly job + notification template

**Files:**
- Create: `backend/packages/api/src/jobs/settle-challenge-week.ts`
- Modify: `backend/packages/api/src/modules/packs/notify-feed.ts` (extend `FeedTemplate`)
- Modify: `src/lib/notifications/copy.ts` + `src/lib/notifications/__tests__/copy.test.ts` (storefront entry)

**Interfaces:**
- Consumes: `settleChallengeWeek(deps)` (Task 4), `getCardStockByHandle(container, handles)` from `../modules/packs/card-stock`, `notifyFeed` from `../modules/packs/notify-feed`.
- Produces: feed template `'challenge_payout'` with data `{ week_start: string; rank: number; credits: number; card_count: number }`.

- [ ] **Step 1: Extend the template union**

`notify-feed.ts`: add `| 'challenge_payout'` to `FeedTemplate`.

- [ ] **Step 2: The job**

`src/jobs/settle-challenge-week.ts` (mirrors `mature-commissions.ts`):

```ts
import { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import { getCardStockByHandle } from '../modules/packs/card-stock';
import { notifyFeed } from '../modules/packs/notify-feed';
import type PacksModuleService from '../modules/packs/service';

/**
 * Hourly Weekly-Challenge settlement (spec 2026-07-29).
 *
 * Settles the most recently ENDED challenge week: pays the week's top-10 the
 * union of every community-pool-unlocked stage's rank rewards. Self-gating —
 * an already-settled week (any challenge_payout row) returns immediately, so
 * the hourly cadence is a retry net, not a re-pay risk. Cron cannot be driven
 * by the admin-configured cadence row (schedule is static at boot); the gate
 * is what honors the configured week boundary.
 *
 * Notifications fire AFTER each winner's transaction committed (they ride the
 * returned winners list), best-effort + idempotent per (week, customer).
 */
export default async function settleChallengeWeekJob(
  container: MedusaContainer,
) {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  const result = await packs.settleChallengeWeek({
    getStock: (handles) => getCardStockByHandle(container, handles),
  });
  if (!result.settled) return;

  for (const w of result.winners) {
    try {
      await notifyFeed(container, {
        receiverId: w.customerId,
        template: 'challenge_payout',
        data: {
          week_start: result.weekStartIso,
          rank: w.rank,
          credits: w.credits,
          card_count: w.cardHandles.length,
        },
        idempotencyKey: `challenge:${result.weekStartIso}:${w.customerId}`,
      });
    } catch (err) {
      try {
        container
          .resolve(ContainerRegistrationKeys.LOGGER)
          .warn(
            `[settle-challenge-week] notifyFeed failed for ${w.customerId} (week ${result.weekStartIso}) — settlement committed, notification dropped: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
      } catch {
        // logger unavailable in test containers — ignore
      }
    }
  }
}

export const config = {
  name: 'settle-challenge-week',
  schedule: '0 * * * *', // hourly; the week gate makes extra runs no-ops
};
```

- [ ] **Step 3: Storefront copy — failing test first**

In `src/lib/notifications/__tests__/copy.test.ts`: add `'challenge_payout'` to the `TEMPLATES` array (the "covers every template / no extras" test now fails), and add:

```ts
it('describes a challenge payout without linking to suspended surfaces', () => {
  const c = copyFor('challenge_payout');
  expect(c.href).toBe('/leaderboard');
  const body = c.body({ rank: 2, credits: 150, card_count: 1 });
  expect(body).toContain('#2');
  expect(body).toContain('RM');
});
```

Run: `npm test -- copy` → Expected: FAIL (missing entry).

- [ ] **Step 4: Copy entry**

In `src/lib/notifications/copy.ts` (Trophy icon — extend the `lucide-react` import):

```ts
challenge_payout: {
  icon: Trophy,
  variant: 'reward',
  // Nothing else announces the weekly settlement — it happens server-side
  // between sessions.
  policy: 'always',
  title: 'Weekly Challenge payout',
  body: (data) => {
    const rank = numOf(data, 'rank');
    const credits = numOf(data, 'credits');
    const cards = numOf(data, 'card_count');
    if (rank === null) return null;
    const parts: string[] = [];
    if (credits && credits > 0) parts.push(`${rm(credits)} in credit`);
    if (cards && cards > 0)
      parts.push(cards === 1 ? 'a featured card' : `${cards} featured cards`);
    if (parts.length === 0) return null;
    return `You finished #${rank} — ${parts.join(' and ')} added to your account.`;
  },
  href: '/leaderboard',
  action: 'View challenge',
},
```

Run: `npm test -- copy` → Expected: PASS (including the Spec-A dead-link test — `/leaderboard` is live).

- [ ] **Step 5: Backend typecheck + commit**

Run: `corepack yarn check-types` (backend) and `npm run typecheck` (root).
Expected: both clean.

```bash
git add backend/packages/api/src/jobs/settle-challenge-week.ts backend/packages/api/src/modules/packs/notify-feed.ts src/lib/notifications/copy.ts src/lib/notifications/__tests__/copy.test.ts
git commit -m "feat(challenge): hourly settle-challenge-week job + payout notification"
```

---

### Task 6: Modules integration spec

**Files:**
- Test: `backend/packages/api/src/modules/packs/__tests__/challenge-settle.integration.spec.ts`

**Interfaces:**
- Consumes: everything above via the module service inside `moduleIntegrationTestRunner`.

- [ ] **Step 1: Scaffold with the FULL model array**

Copy the `moduleIntegrationTestRunner` scaffold from `__tests__/reward-draw.spec.ts` **including its entire `moduleModels` array**, then add: `ChallengeStage`, `ChallengeSettings`, `ChallengePayout`, `FxRate`, `LedgerEntry`, `LedgerSequence`, `PixelPokemon` if the copied array lacks them (the runner builds schema from THIS array only — a missing model = `relation … does not exist` that `db:migrate` can never fix; memory: modules-tests-schema-from-modulemodels). `jest.setTimeout(300 * 1000)`.

Fixture helper inside `testSuite` (`beforeEach` after the runner's own `refreshDatabase`):

```ts
const WEEK = { timezone: 'UTC', resetDay: 1, resetHour: 0 }; // Monday 00:00 UTC
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

async function seedBase() {
  await service.createFxRates([
    { pair: 'USD_MYR', rate: 4, source: 'test', manual_override: false },
  ]);
  await service.createChallengeSettings([
    { id: 'global', cadence: 'fixed_weekly', ...{
      timezone: WEEK.timezone, reset_day: WEEK.resetDay, reset_hour: WEEK.resetHour,
    }, payout_credits: 0, payout_card_ids: [] },
  ]);
  const [card] = await service.createCards([
    {
      handle: 'test-charizard',
      name: 'Test Charizard',
      image: 'x.webp',
      market_value: 100, // + whatever fields the model requires — copy the
      // minimal card fixture from an existing modules spec (e.g.
      // vault-reward-render.integration.spec.ts) rather than inventing one.
    },
  ]);
  return { card };
}
// Prior-week pull worth USD 100 × fx 4 = MYR 400 in the pool.
async function seedPriorWeekPull(customerId: string, card: { handle: string }) {
  await service.createPulls([
    {
      customer_id: customerId,
      pack_id: 'bronze-pack',
      card_id: card.handle,
      order_id: null,
      rolled_at: daysAgo(8), // safely inside LAST week for any weekday
      source: 'pack',
      recorded_value_usd: 100,
    },
  ]);
}
```
**Anchor caveat:** `daysAgo(8)` is only "last week" when today is ≥1 day past the Monday reset. Make the boundary deterministic instead: compute last Monday 00:00 UTC in JS (`const monday = …` from `new Date()` UTC day arithmetic) and place pulls at `monday − 12h` (prior week) and `monday + 12h` (current week). Write that tiny date helper in the spec file — no library.

- [ ] **Step 2: Windowed-aggregate test**

```ts
it('pools only the settled week — current-week and reward pulls excluded', async () => {
  const { card } = await seedBase();
  await seedPriorWeekPull('cus_a', card);          // prior week → counts
  await service.createPulls([
    { customer_id: 'cus_a', pack_id: 'bronze-pack', card_id: card.handle,
      order_id: null, rolled_at: currentWeekDate, source: 'pack',
      recorded_value_usd: 100 },                    // current week → excluded
    { customer_id: 'cus_a', pack_id: 'challenge-x', card_id: card.handle,
      order_id: null, rolled_at: priorWeekDate, source: 'reward',
      recorded_value_usd: 100 },                    // reward → excluded
  ]);
  const pool = await service.challengeWeekPool({ ...WEEK, weeksBack: 1 });
  expect(pool).toBe(400); // one pull × USD100 × fx4
});
```

- [ ] **Step 3: Settle happy path + double-run idempotency**

```ts
it('settles once: credits paid, card minted, second run is a no-op', async () => {
  const { card } = await seedBase();
  await service.createChallengeStages([
    { stage_number: 1, threshold_myr: 100,
      rank_rewards: [{ rank: 1, card_id: card.id, credits: 50 }] },
  ]);
  await seedPriorWeekPull('cus_a', card);

  const stock = new Map([[card.handle, null]]); // untracked = grantable
  const deps = { getStock: async () => stock };

  const first = await service.settleChallengeWeek(deps);
  expect(first.settled).toBe(true);
  expect(first.winners).toEqual([
    expect.objectContaining({ customerId: 'cus_a', rank: 1, credits: 50,
      cardHandles: [card.handle], skippedCardIds: [] }),
  ]);
  expect(await service.creditBalance('cus_a')).toBe(50);
  const rewardPulls = await service.listPulls(
    { customer_id: 'cus_a', source: 'reward' }, { take: 10 });
  expect(rewardPulls).toHaveLength(1);
  expect(rewardPulls[0]!.card_id).toBe(card.handle); // HANDLE, not id

  const second = await service.settleChallengeWeek(deps);
  expect(second.settled).toBe(false);
  expect(await service.creditBalance('cus_a')).toBe(50); // unchanged
  const payoutRows = await service.listChallengePayouts({}, { take: 10 });
  expect(payoutRows).toHaveLength(2); // credits row + card row, once
});
```

- [ ] **Step 4: skipped_no_stock path**

```ts
it('records skipped_no_stock and mints no pull when stock is short', async () => {
  const { card } = await seedBase();
  await service.createChallengeStages([
    { stage_number: 1, threshold_myr: 100,
      rank_rewards: [{ rank: 1, card_id: card.id, credits: 0 }] },
  ]);
  await seedPriorWeekPull('cus_a', card);

  const result = await service.settleChallengeWeek({
    getStock: async () => new Map([[card.handle, 0]]), // tracked, none left
  });
  expect(result.winners[0]!.skippedCardIds).toEqual([card.id]);
  const rows = await service.listChallengePayouts({ kind: 'card' }, { take: 5 });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe('skipped_no_stock');
  expect(rows[0]!.pull_id).toBeNull();
  expect(
    await service.listPulls({ customer_id: 'cus_a', source: 'reward' }, { take: 5 }),
  ).toHaveLength(0);
  // A skipped week still gates: settled-week record exists.
  expect((await service.settleChallengeWeek({
    getStock: async () => new Map([[card.handle, 0]]),
  })).settled).toBe(false);
});
```

- [ ] **Step 5: Run the modules suite**

Run (from `backend/packages/api`, pokenic-postgres up): `corepack yarn test:integration:modules --testPathPattern challenge-settle.integration`
Expected: PASS. Common failures: missing model in `moduleModels` (schema error — add it, never `db:migrate`); card fixture missing a required column (copy a working fixture); `mutateCreditAtomic` needing rows the array lacks (add `LedgerEntry`/`LedgerSequence`); fx display cache leaking across specs (`clearFxDisplayCache()` from `../pricing` in `beforeEach`).

- [ ] **Step 6: Commit**

```bash
git add backend/packages/api/src/modules/packs/__tests__/challenge-settle.integration.spec.ts
git commit -m "test(challenge): settlement integration — windowing, idempotency, stock gate"
```

---

### Task 7: Full verification + wrap-up

- [ ] **Step 1: Full backend gates**

From `backend/packages/api`:
```bash
corepack yarn check-types
corepack yarn test:unit
corepack yarn test:integration:modules
```
Expected: all green.

- [ ] **Step 2: Storefront gates**

From the repo root: `npm run typecheck && npm test`
Expected: green (copy.ts entry covered).

- [ ] **Step 3: Live smoke via medusa exec (optional but recommended)**

Write `backend/packages/api/src/scripts/settle-challenge-now.ts` mirroring the job body (resolve service, call `settleChallengeWeek` with the real `getCardStockByHandle`, print the result JSON) and run `corepack yarn medusa exec ./src/scripts/settle-challenge-now.ts` against the local DB after seeding `scripts/seed-challenge.ts` + a prior-week pull. Assert by re-running: second output shows `settled: false`. Commit the script (it doubles as the operator's manual-settlement tool for the multi-week-outage limitation).

- [ ] **Step 4: Commit any remaining pieces, then PR**

PR after Spec A's PR merges (shared `copy.ts`). Body notes: hourly gate semantics, the accepted multi-week-outage limitation, and that `skipped_no_stock` rows are the operator's manual-fulfillment queue.
