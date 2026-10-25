# Lucky Draw Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A monthly Lucky Draw: tasks pay tickets, players put tickets on admin-configured prizes, each prize is drawn once at its draw time by the server, the winner is paid, and every result stays checkable.

**Architecture:** Everything backend lives in the existing `packs` Medusa module (five new tables, service methods, a pure `lucky-draw.ts` for the draw math), the same way the weekly challenge and tasks do. A once-a-minute job draws due prizes and pays them through the same calls `settleChallengeWinner` uses. The storefront gets one gated page (`/lucky-draw`), a vault row and a task-hub chip; the admin gets one page under Rewards plus a Tickets field on the task form.

**Tech Stack:** Medusa v2 (DML models, MikroORM migrations, jobs), Postgres, Next.js App Router storefront (zod schemas, server actions, vitest), Medusa admin SPA (React, `@medusajs/ui`, vitest), Jest unit + integration specs.

**Spec:** `docs/superpowers/specs/2026-10-24-lucky-draw-design.md` (approved 2026-10-24). Read it before any task.

## Global Constraints

- Live in production by **2026-11-01 MYT**. All times are Malaysia time (UTC+8) in copy; store UTC.
- Work on branch `feat/lucky-draw` in `.worktrees/lucky-draw` (cut from `master` `77babd5c`). Run `npm install` at the root and `corepack yarn install` in `backend/` first.
- `tickets` is a **column on `task_definition`**, never a member of the `TaskReward` union (the bare `else` in `claimTask` turns unknown reward types into free rips).
- Card prizes are granted exactly like weekly-challenge card prizes: `createPulls` with `source: 'reward'`, `bonus_bp: BONUS_BP_FULL`, `stock_earmarked: false`, stock taken **after** commit with `takeCardStock`, pull earmarked only if the take happened.
- Credit prizes are **bonus**: `mutateCreditAtomic({ reason: 'reward_credit', idempotencyReference: 'luckydraw:<prizeId>' })` + `recordLedgerEntry({ type: 'WP', refId: <credit txn id> })` in the same transaction.
- Entering needs a logged-in, not-frozen account with `hasTopUp(customerId) === true`.
- A prize's `seed` never leaves the server before that prize's result exists — not on store routes, not on admin routes — and is **never stored in the database before the draw**: the prize row holds only a random `seed_nonce` and the public `seed_hash`; the seed is `deriveDrawSeed(LUCKY_DRAW_SEED_SECRET, seed_nonce)`, computed at publish (to make the hash) and again at draw time, and written only into the result row. Reason: staff tools and the desk bots can read prize rows. Missing `LUCKY_DRAW_SEED_SECRET` → publish and draw refuse loudly. Test specs set `process.env.LUCKY_DRAW_SEED_SECRET ??= 'test-lucky-draw-seed-secret'` at the top of the file.
- One result per prize (unique index on `lucky_draw_result.prize_id`); a result is never updated or deleted by any code path.
- **Every entry the gate accepted is either in the draw or refunded.** Entering holds `pg_advisory_xact_lock_shared(hashtextextended('luckydraw:<prizeId>', 0))`; drawing and cancelling hold the exclusive `pg_advisory_xact_lock` on the same key and re-check for a result under it. The draw therefore waits for in-flight entries, and an entry that arrives after the draw sees the result and is refused.
- Tickets can only be earned from task claims (and refunds). No route sells tickets.
- Customer copy never says "bet", "gamble", "lottery" or "jackpot" (PRODUCT.md anti-casino). Words: Lucky Draw, tickets, enter, prize, draw, winner.
- New admin writes are audited with `this.audit({ admin_id, entity_type, entity_id, action, before, after, reason })`, like `saveTaskDefinition`.
- Storefront: server `page.tsx` + sibling `'use client'` component; `DESIGN.md` pills/tokens; `px-fluid`; honour `usePrefersReducedMotion`.
- TypeScript strict, no `any`, named exports, 2-space indent (AGENTS.md).
- Backend unit suite: `cd backend/packages/api && corepack yarn test:unit`. Run the **full** suite before calling the branch green.

## Review Focus

1. **Seed leak:** any store or admin JSON for an undrawn prize containing `seed` → must never happen. Pinned in Task 7 (store) and Task 5 (admin).
2. **Double-tap / parallel enter:** two concurrent enters for more tickets than the balance → exactly one succeeds, balance never below 0. Pinned in Task 4.
3. **Draw-time boundary:** an entry accepted just before `draw_at` whose transaction commits late → still counted; an entry tried at/after `draw_at`, or after the result exists → refused. Pinned in Tasks 4 and 6.
4. **Replayed claim / edited task:** re-claiming the same task period, or editing a task's tickets after claims → tickets paid once, at the claimed amount. Pinned in Task 3.
5. **Empty or all-disabled prize:** no entries, or every entrant disabled → one "no entries" result, nothing paid, disabled entrants refunded, the job does not retry it. Pinned in Task 6.

## File Map

Backend (`backend/packages/api/src/`):

| File                                                                                             | Responsibility                                                                                                         |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `modules/packs/lucky-draw.ts` (new)                                                              | Pure: limits, entry aggregation, seed/hash, winning ticket, winner pick, input validators                              |
| `modules/packs/models/lucky-draw-{event,prize,entry,ticket,result}.ts` (new)                     | DML models                                                                                                             |
| `modules/packs/models/task-definition.ts`                                                        | `tickets` column                                                                                                       |
| `modules/packs/migrations/Migration20261024120000.ts` (new)                                      | Five tables + `task_definition.tickets`                                                                                |
| `modules/packs/service.ts`                                                                       | Register models; ticket grant in `claimTask`; `tickets` in `saveTaskDefinition` / `taskHubFor`; all Lucky Draw methods |
| `jobs/draw-lucky-draw.ts` (new)                                                                  | Once-a-minute draw job                                                                                                 |
| `api/store/lucky-draw/**` (new)                                                                  | Player routes + `view.ts` (handles, shaping)                                                                           |
| `api/admin/lucky-draw/**` (new)                                                                  | Admin routes                                                                                                           |
| `api/admin/tasks/route.ts`, `api/admin/tasks/labels.ts`, `api/reports/growth/tasks/catalogue.ts` | Tickets in admin task API + labels                                                                                     |
| `api/admin-rbac.ts`, `api/middlewares.ts`                                                        | `lucky-draw` resource, auth + rate limits                                                                              |

Admin SPA (`backend/apps/admin/src/`): `routes/lucky-draw/page.tsx` + `lucky-draw-draft.ts` (new), `lib/admin-rest.ts`, `routes/tasks/{task-draft.ts,page.tsx}`, `i18n/{en,zhCN}.json`, `lib/nav-contract.test.ts`.

Storefront (`src/`): `lib/data/schemas.ts`, `lib/actions/lucky-draw.ts` (new), `lib/lucky-draw.ts` (new, pure), `app/(account)/lucky-draw/*` (new), `app/(account)/vault/{page.tsx,VaultClient.tsx}`, `app/task/{TaskHubClient.tsx,task-hub.ts}`, `scripts/qa-lucky-draw.mjs` (new).

**Order:** Tasks 1→7 are sequential (each builds on the last). Once Task 5's and Task 7's Interfaces are merged, Tasks 8, 9 and 10 can run in parallel; Task 11 is last.

---

### Task 1: Draw math (pure)

**Files:**

- Create: `backend/packages/api/src/modules/packs/lucky-draw.ts`
- Test: `backend/packages/api/src/modules/packs/__tests__/lucky-draw.unit.spec.ts`

**Interfaces:**

- Produces:
  - `export const MAX_TASK_TICKETS = 10_000;`
  - `export const MAX_ENTRY_TICKETS = 1_000_000;`
  - `export const MAX_PRIZE_CREDIT_MYR = 50_000;`
  - `export const LUCKY_DRAW_PULL_PACK_ID = 'lucky-draw';` (synthetic `pull.pack_id` for prize cards, like `'task-reward'`)
  - `export interface DrawEntryRow { id: string; customer_id: string; tickets: number }`
  - `export interface DrawEntrant { customer_id: string; tickets: number }`
  - `export function aggregateEntries(rows: DrawEntryRow[]): DrawEntrant[]` — no time filter: the draw counts every committed entry on the prize; the cut-off is enforced at entry time under the prize lock (Tasks 4 and 6).
  - `export function newDrawSeed(): string`
  - `export function drawSeedHash(seed: string): string`
  - `export function deriveDrawSeed(secret: string, nonce: string): string` — HMAC-SHA256(key = secret, message = `'lucky-draw-seed:' + nonce`) hex; throws INVALID_DATA on an empty secret. Test vector: `deriveDrawSeed('test-secret', 'b'.repeat(64)) === '7e0cbfdfea31e0b95b8f7337da2f76a786f76f956dbd03af4d33dcb6564312da'`. (Added after Task 1 by a security ruling; `newDrawSeed()` now makes the nonce.)
  - `export function winningTicketIndex(seed: string, prizeId: string, totalTickets: number): number`
  - `export function drawWinner(entrants: DrawEntrant[], seed: string, prizeId: string): { winner: DrawEntrant; ticketIndex: number; totalTickets: number } | null`
  - `export function validateTaskTickets(raw: unknown): number`
  - `export function validateEntryTickets(raw: unknown): number`

- [ ] **Step 1: Write the failing tests**

```ts
const SEED = 'a'.repeat(64);

it('aggregateEntries sums per customer and sorts by customer_id', () => {
  const rows = [
    { id: 'e1', customer_id: 'cus_b', tickets: 20 },
    { id: 'e2', customer_id: 'cus_a', tickets: 30 },
    { id: 'e3', customer_id: 'cus_b', tickets: 30 },
  ];
  expect(aggregateEntries(rows)).toEqual([
    { customer_id: 'cus_a', tickets: 30 },
    { customer_id: 'cus_b', tickets: 50 },
  ]);
});

it('drawSeedHash is sha256 hex of the seed string', () => {
  expect(drawSeedHash(SEED)).toBe(
    'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
  );
});

it('winningTicketIndex is HMAC-SHA256(seed, prizeId) mod total — fixed vectors', () => {
  expect(winningTicketIndex(SEED, 'ldpz_test', 100)).toBe(41);
  expect(winningTicketIndex(SEED, 'ldpz_test', 10)).toBe(1);
  expect(winningTicketIndex(SEED, 'ldpz_test', 3)).toBe(2);
  expect(winningTicketIndex(SEED, 'ldpz_other', 100)).toBe(31);
});

it('drawWinner walks cumulative tickets in entrant order', () => {
  const entrants = [
    { customer_id: 'cus_a', tickets: 30 }, // 0..29
    { customer_id: 'cus_b', tickets: 50 }, // 30..79  ← index 41
    { customer_id: 'cus_c', tickets: 20 }, // 80..99
  ];
  expect(drawWinner(entrants, SEED, 'ldpz_test')).toEqual({
    winner: { customer_id: 'cus_b', tickets: 50 },
    ticketIndex: 41,
    totalTickets: 100,
  });
});

it('drawWinner returns null with no tickets', () => {
  expect(drawWinner([], SEED, 'ldpz_test')).toBeNull();
});

it('newDrawSeed is 64 hex chars and differs per call', () => {
  const a = newDrawSeed();
  const b = newDrawSeed();
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(a).not.toBe(b);
});

it('validateTaskTickets: null/undefined → 0; integer 0..MAX_TASK_TICKETS; else INVALID_DATA', () => {
  expect(validateTaskTickets(undefined)).toBe(0);
  expect(validateTaskTickets(null)).toBe(0);
  expect(validateTaskTickets(50)).toBe(50);
  for (const bad of [-1, 1.5, '5', MAX_TASK_TICKETS + 1])
    expect(() => validateTaskTickets(bad)).toThrow();
});

it('validateEntryTickets: integer 1..MAX_ENTRY_TICKETS; else INVALID_DATA', () => {
  expect(validateEntryTickets(1)).toBe(1);
  for (const bad of [0, -3, 2.5, '10', null, MAX_ENTRY_TICKETS + 1])
    expect(() => validateEntryTickets(bad)).toThrow();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend/packages/api && corepack yarn test:unit src/modules/packs/__tests__/lucky-draw.unit.spec.ts`
Expected: FAIL, module `../lucky-draw` not found.

- [ ] **Step 3: Implement `lucky-draw.ts`**

Pure module, imports only `node:crypto`, `MedusaError` and `pickWonRow` (`./pick`). `newDrawSeed` = `randomBytes(32).toString('hex')`. `drawSeedHash` = `createHash('sha256').update(seed).digest('hex')`. `winningTicketIndex` = `Number(BigInt('0x' + createHmac('sha256', seed).update(prizeId).digest('hex')) % BigInt(totalTickets))` — a 256-bit value mod a total under 2^53 has negligible bias; say so in a one-line comment. `drawWinner` = `pickWonRow(entrants.map(e => ({ ...e, weight: e.tickets })), ticketIndex)`, returning the entrant without `weight`. Validators throw `MedusaError.Types.INVALID_DATA` with messages naming the field and range.

- [ ] **Step 4: Run to verify they pass**

Run: same command. Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src/modules/packs/lucky-draw.ts backend/packages/api/src/modules/packs/__tests__/lucky-draw.unit.spec.ts
git commit -m "feat(lucky-draw): pure draw math — seeded winner pick, entry aggregation, validators"
```

---

### Task 2: Models and migration

**Files:**

- Create: `backend/packages/api/src/modules/packs/models/lucky-draw-event.ts`, `lucky-draw-prize.ts`, `lucky-draw-entry.ts`, `lucky-draw-ticket.ts`, `lucky-draw-result.ts`
- Modify: `backend/packages/api/src/modules/packs/models/task-definition.ts` (add `tickets`)
- Modify: `backend/packages/api/src/modules/packs/service.ts:837-882` (register the five models in `MedusaService({...})`)
- Create: `backend/packages/api/src/modules/packs/migrations/Migration20261024120000.ts`
- Test: `backend/packages/api/integration-tests/http/lucky-draw.spec.ts` (created here, grown in Tasks 3–7)

**Interfaces:**

- Produces (table → fields; every table also gets Medusa's `created_at/updated_at/deleted_at`):
  - `task_definition.tickets`: `model.number().default(0)` → `integer not null default 0`
  - `lucky_draw_event` (id prefix `ldev`): `name text`, `starts_at dateTime`, `ends_at dateTime`, `status enum('draft','published','cancelled') default 'draft'`, `created_by text`
  - `lucky_draw_prize` (`ldpz`): `event_id text`, `kind enum('card','credit')`, `card_handle text null`, `credit_myr bigNumber null` (+ `raw_credit_myr jsonb null`), `title text`, `image_url text null`, `sort number default 0`, `draw_at dateTime`, `seed_nonce text null`, `seed_hash text null`, `cancelled_at dateTime null` (no `seed` column on the prize — the seed is derived, see Global Constraints). Indexes: `(event_id)`, `(draw_at) WHERE cancelled_at IS NULL AND deleted_at IS NULL`.
  - `lucky_draw_entry` (`lden`): `prize_id text`, `customer_id text`, `tickets number`. Indexes: `(prize_id)`, `(customer_id)`.
  - `lucky_draw_ticket` (`ldtk`): `customer_id text`, `delta number` (negative = spent), `reason enum('task_claim','entry','refund')`, `ref text`. Indexes: `(customer_id)`, **unique** `(reason, ref) WHERE deleted_at IS NULL`.
  - `lucky_draw_result` (`ldrs`): `prize_id text`, `winner_customer_id text null`, `winner_tickets number default 0`, `total_tickets number default 0`, `entrant_count number default 0`, `ticket_index number null`, `seed text`, `entries json` (`DrawEntrant[]`, draw order), `excluded json` (customer ids refunded as disabled), `credit_transaction_id text null`, `pull_id text null`, `drawn_at dateTime`. Index: **unique** `(prize_id) WHERE deleted_at IS NULL`.
  - Generated service methods follow: `listLuckyDrawEvents`, `createLuckyDrawPrizes`, `createLuckyDrawTickets`, `listLuckyDrawResults`, etc.

- [ ] **Step 1: Write the failing HTTP integration spec skeleton**

In `integration-tests/http/lucky-draw.spec.ts` (copy the bootstrap of `lossless-schedule.spec.ts`: `medusaIntegrationTestRunner({ inApp: true, ... })`, publishable key, `mintSuperAdmin`), one test:

```ts
it('migrations create the lucky draw tables and task tickets column', async () => {
  const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
  const [ev] = await packs.createLuckyDrawEvents([
    {
      name: 'Nov',
      starts_at: new Date(),
      ends_at: new Date(Date.now() + 86400e3),
      created_by: 'user_t',
    },
  ]);
  expect(ev.status).toBe('draft');
  const [t] = await packs.createTaskDefinitions([
    {
      kind: 'daily',
      title: 'x',
      requirement: { type: 'checkin_days', days: 1 },
      reward: { type: 'credit', amount_myr: 1 },
    },
  ]);
  expect(t.tickets).toBe(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend/packages/api && node integration-tests/run-http-shards.mjs lucky-draw.spec`
Expected: FAIL (`createLuckyDrawEvents` is not a function / relation does not exist).

- [ ] **Step 3: Write the models, register them, write the migration**

Models follow `pack-gift.ts` / `challenge-payout.ts` style. Migration follows `Migration20261017120000.ts`: `set local lock_timeout = '5s'`, `create table if not exists` per table with `deleted_at` index, the indexes above, enum columns as `text check (... in (...))`, `credit_myr numeric null` + `raw_credit_myr jsonb null`, and `alter table "task_definition" add column if not exists "tickets" integer not null default 0;`. `down()` drops the five tables and the column.

- [ ] **Step 4: Run to verify it passes**

Run: same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src/modules/packs/models backend/packages/api/src/modules/packs/migrations/Migration20261024120000.ts backend/packages/api/src/modules/packs/service.ts backend/packages/api/integration-tests/http/lucky-draw.spec.ts
git commit -m "feat(lucky-draw): tables for events, prizes, entries, tickets, results + task tickets column"
```

---

### Task 3: Tickets on tasks

**Files:**

- Modify: `backend/packages/api/src/modules/packs/service.ts` — `claimTask` (~3007), `saveTaskDefinition` (~3218), `taskHubFor` (~2730); add `luckyDrawBalance`
- Modify: `backend/packages/api/src/api/admin/tasks/route.ts` (GET returns `tickets`; POST passes `tickets`)
- Modify: `backend/packages/api/src/api/admin/tasks/labels.ts` (+ `api/reports/growth/tasks/catalogue.ts` passes `tickets`)
- Test: `backend/packages/api/src/modules/packs/__tests__/task-engine.integration.spec.ts` (add `LuckyDrawTicket` to `moduleModels`), `backend/packages/api/src/api/admin/tasks/__tests__/labels.unit.spec.ts`

**Interfaces:**

- Consumes: `validateTaskTickets` (Task 1); `lucky_draw_ticket` (Task 2).
- Produces:
  - `saveTaskDefinition(input: { ...existing; tickets?: unknown })` stores `validateTaskTickets(input.tickets)`.
  - `claimTask(...)` success result gains `tickets: number`; claim's `reward_snapshot` = `{ ...reward, tickets }`.
  - `taskHubFor(...)` task rows gain `tickets: number`.
  - `luckyDrawBalance(customerId: string, sharedContext?): Promise<number>` — `SUM(delta)` of the customer's live `lucky_draw_ticket` rows (0 when none). `@InjectManager`.
  - `resolveTaskLabels` rows accept `tickets?: number`; when > 0 the reward label ends with ` + N Lucky Draw tickets` (`1 Lucky Draw ticket` singular).

- [ ] **Step 1: Write the failing tests**

In `task-engine.integration.spec.ts`:

```ts
it('a claim pays the task tickets once, in the same claim', async () => {
  // weekly checkin_days 1 task, credit RM 1, tickets 50; customer checked in today
  const first = await service.claimTask({ customerId: 'cus_t1', taskId });
  expect(first).toMatchObject({ claimed: true, tickets: 50 });
  expect(await service.luckyDrawBalance('cus_t1')).toBe(50);
  const again = await service.claimTask({ customerId: 'cus_t1', taskId });
  expect(again).toEqual({ claimed: false, reason: 'already_claimed' });
  expect(await service.luckyDrawBalance('cus_t1')).toBe(50);
});

it('editing tickets after a claim does not change what the claim paid', async () => {
  // claim at 50, then saveTaskDefinition(... tickets: 5)
  const [claim] = await service.listTaskClaims({
    customer_id: 'cus_t2',
    task_id: taskId,
  });
  expect((claim.reward_snapshot as { tickets: number }).tickets).toBe(50);
  expect(await service.luckyDrawBalance('cus_t2')).toBe(50);
});

it('a task with tickets 0 writes no ticket row', async () => {
  expect(
    await service.listLuckyDrawTickets({ customer_id: 'cus_t3' }),
  ).toHaveLength(0);
});

it('saveTaskDefinition refuses tickets above MAX_TASK_TICKETS', async () => {
  await expect(
    service.saveTaskDefinition({ ...valid, tickets: 10_001 }),
  ).rejects.toThrow(/tickets/);
});
```

In `labels.unit.spec.ts`: `reward` label for `{ reward: { type: 'credit', amount_myr: 5 }, tickets: 50 }` ends with `' + 50 Lucky Draw tickets'`; with `tickets: 1` ends `' + 1 Lucky Draw ticket'`; with `tickets: 0` is unchanged.

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend/packages/api && corepack yarn test:integration:modules src/modules/packs/__tests__/task-engine.integration.spec.ts` and `corepack yarn test:unit src/api/admin/tasks/__tests__/labels.unit.spec.ts`
Expected: FAIL (`tickets` undefined / `luckyDrawBalance` not a function).

- [ ] **Step 3: Implement**

In `claimTask`, right after `createTaskClaims` succeeds and before the reward branches: when `def.tickets > 0`, `createLuckyDrawTickets([{ customer_id, delta: def.tickets, reason: 'task_claim', ref: claimId }], sharedContext)`. Same transaction; the claim's unique index already makes it once-only and `(reason, ref)` is the backstop. Do not touch the reward `if/else` chain. Admin GET/POST and labels pass `tickets` through; `catalogue.ts` hands `tickets` to `resolveTaskLabels`.

- [ ] **Step 4: Run to verify they pass**

Run: same two commands. Expected: PASS. Then run the existing task suites, which may assert exact claim/hub shapes: `corepack yarn test:unit src/modules/packs/__tests__/tasks.unit.spec.ts src/modules/packs/__tests__/task-save-and-facts.unit.spec.ts "src/api/store/tasks"` and `node integration-tests/run-http-shards.mjs tasks.spec` → PASS (update any exact-shape assertion to include `tickets`).

- [ ] **Step 5: Commit**

```bash
git add -A backend/packages/api/src
git commit -m "feat(lucky-draw): tasks can pay Lucky Draw tickets with the normal reward"
```

---

### Task 4: Entering a prize

**Files:**

- Modify: `backend/packages/api/src/modules/packs/service.ts` (add `enterLuckyDraw`)
- Test: `backend/packages/api/src/modules/packs/__tests__/lucky-draw.integration.spec.ts` (new; `moduleIntegrationTestRunner`, `moduleModels`: the five Lucky Draw models + `CreditTransaction`, `CustomerAccountState`, `AdminActionAudit`)

**Interfaces:**

- Consumes: `validateEntryTickets`, `luckyDrawBalance`, `hasTopUp`, `assertNotFrozen` (existing).
- Produces:
  - `export type EnterRefusal = 'not_found' | 'not_open' | 'closed' | 'not_enough_tickets' | 'no_topup';` (in `lucky-draw.ts`)
  - `enterLuckyDraw(input: { customerId: string; prizeId: string; tickets: unknown; now?: Date }, sharedContext?): Promise<{ entered: true; entryId: string; balance: number; myTickets: number } | { entered: false; reason: EnterRefusal }>` — `@InjectTransactionManager`.
  - Rules, in this order: tickets valid (else throws INVALID_DATA) → shared prize lock `pg_advisory_xact_lock_shared(hashtextextended('luckydraw:<prizeId>', 0))` → `pg_advisory_xact_lock(hashtextextended('tickets:<customerId>', 0))` → `assertNotFrozen` (throws) → prize exists, not cancelled, its event `published` (else `not_found`) → `now >= event.starts_at` (else `not_open`) → `now < prize.draw_at` **and** no `lucky_draw_result` row for the prize (else `closed`) → `hasTopUp` (else `no_topup`) → balance ≥ tickets (else `not_enough_tickets`) → insert `lucky_draw_entry` + ticket row `{ delta: -tickets, reason: 'entry', ref: entryId }`. `myTickets` = this customer's total on that prize after the insert. Lock order is always prize lock, then customer lock (the draw takes only the prize lock), so no deadlock.

- [ ] **Step 1: Write the failing tests**

```ts
it('spends tickets and records the entry', async () => {
  // customer with top-up row, 100 tickets (task_claim ref 'c1'), live prize
  const r = await service.enterLuckyDraw({
    customerId: 'cus_e',
    prizeId,
    tickets: 30,
  });
  expect(r).toMatchObject({ entered: true, balance: 70, myTickets: 30 });
});

it('two parallel enters cannot overspend', async () => {
  // 100 tickets; enter 80 twice concurrently
  const rs = await Promise.all(
    [1, 2].map(() =>
      service.enterLuckyDraw({ customerId: 'cus_p', prizeId, tickets: 80 }),
    ),
  );
  expect(rs.filter((r) => r.entered)).toHaveLength(1);
  expect(rs.filter((r) => !r.entered)).toEqual([
    { entered: false, reason: 'not_enough_tickets' },
  ]);
  expect(await service.luckyDrawBalance('cus_p')).toBe(20);
});

it('refuses at exactly draw_at', async () => {
  expect(
    await service.enterLuckyDraw({
      customerId: 'cus_e',
      prizeId,
      tickets: 1,
      now: drawAt,
    }),
  ).toEqual({ entered: false, reason: 'closed' });
});

it('refuses before the event starts', async () => {
  /* now < starts_at → 'not_open' */
});
it('refuses an account that never topped up', async () => {
  /* → 'no_topup' */
});
it('refuses a cancelled prize and a draft event as not_found', async () => {
  /* → 'not_found' */
});
it('throws INVALID_DATA for 0, negative and fractional tickets', async () => {
  /* rejects */
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend/packages/api && corepack yarn test:integration:modules src/modules/packs/__tests__/lucky-draw.integration.spec.ts`
Expected: FAIL (`enterLuckyDraw` is not a function).

- [ ] **Step 3: Implement `enterLuckyDraw`** with the rule order above. The balance read happens under the advisory lock inside the transaction (use the transaction manager, not a fresh manager).

- [ ] **Step 4: Run to verify they pass.** Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src/modules/packs
git commit -m "feat(lucky-draw): enter a prize — locked balance check, top-up gate, draw-time cut-off"
```

---

### Task 5: Admin — events, prizes, publish, cancel

**Files:**

- Modify: `backend/packages/api/src/modules/packs/service.ts` (five methods below)
- Create: `backend/packages/api/src/api/admin/lucky-draw/route.ts` (GET overview), `events/route.ts` (POST), `events/[id]/publish/route.ts` (POST), `prizes/route.ts` (POST), `prizes/[id]/cancel/route.ts` (POST), `prizes/[id]/entries/route.ts` (GET), `tickets/route.ts` (GET `?customer_id=`)
- Modify: `backend/packages/api/src/api/admin-rbac.ts` (`'lucky-draw': 'lucky_draw'` in `CUSTOM_ADMIN_RESOURCES`), `backend/packages/api/src/api/middlewares.ts` (`adminActionRateLimit` on POST `/admin/lucky-draw/events`, `/admin/lucky-draw/events/*/publish`, `/admin/lucky-draw/prizes`, `/admin/lucky-draw/prizes/*/cancel`)
- Test: `lucky-draw.integration.spec.ts` (module), `integration-tests/http/lucky-draw.spec.ts` (routes)

**Interfaces:**

- Consumes: `newDrawSeed`, `drawSeedHash`, `MAX_PRIZE_CREDIT_MYR`; `reqReason` (`api/admin/rewards-settings/validate`).
- Produces (all `@InjectTransactionManager`, all audited):
  - `saveLuckyDrawEvent(input: { id?: string; name: string; startsAt: Date; endsAt: Date; adminId: string; reason: string }): Promise<{ id: string }>` — name 1–80 chars, `endsAt > startsAt`. Draft: everything editable. Published: only `name`. Cancelled: refused (NOT_ALLOWED).
  - `saveLuckyDrawPrize(input: { id?: string; eventId: string; kind: 'card' | 'credit'; cardHandle?: string | null; creditMyr?: number | null; title: string; imageUrl?: string | null; sort: number; drawAt?: Date | null; adminId: string; reason: string }): Promise<{ id: string }>` — card must exist (`listCards({ handle })`); credit `0 < x ≤ MAX_PRIZE_CREDIT_MYR`, whole sen; `drawAt` defaults to the event's `ends_at` and must satisfy `starts_at < drawAt ≤ ends_at`; a credit prize's `imageUrl` is optional (none = the storefront's credit coins, operator 2026-10-25). On a **published** event: a new prize gets `seed_nonce`/`seed_hash` at creation; an existing prize may change only `title`, `imageUrl`, `sort`.
  - `publishLuckyDrawEvent(input: { id: string; adminId: string; reason: string }): Promise<void>` — draft only; ≥ 1 live prize; on every prize without a nonce sets `seed_nonce = newDrawSeed()` and `seed_hash = drawSeedHash(deriveDrawSeed(secret, seed_nonce))` (secret = `process.env.LUCKY_DRAW_SEED_SECRET`; missing → NOT_ALLOWED `'LUCKY_DRAW_SEED_SECRET is not set'`); the seed itself is never written; `status = 'published'`.
  - `cancelLuckyDrawPrize(input: { id: string; adminId: string; reason: string }): Promise<{ refunded: number }>` — takes the exclusive `luckydraw:<prizeId>` advisory lock first, then refuses if a result exists (re-checked under the lock, so a cancel racing the draw cannot both pay and refund); sets `cancelled_at`; per entrant one ticket row `{ delta: +total, reason: 'refund', ref: '<prizeId>:<customerId>' }`; `refunded` = entrants refunded.
  - `adminLuckyDrawOverview(): Promise<AdminLuckyDrawEvent[]>` where each event carries its prizes with `seed_hash`, `total_tickets`, `entrant_count`, `result` (with `seed` only when drawn). **Never** the seed of an undrawn prize.
  - `luckyDrawTicketHistory(customerId: string, take: number): Promise<{ balance: number; rows: { delta: number; reason: string; ref: string; created_at: string }[] }>` — `@InjectManager`, newest first.
  - Admin routes map 1:1 to these; bodies use snake_case (`starts_at`, `card_handle`, `credit_myr`, `image_url`, `draw_at`, `reason`); `adminId` = `req.auth_context.actor_id`.

- [ ] **Step 1: Write the failing tests**

Module spec:

```ts
it('publish gives every prize a seed hash and moves the event to published', async () => {
  /* ... */
});
it('refuses publishing an event with no prizes', async () => {
  /* NOT_ALLOWED */
});
it('refuses a draw time outside the event window', async () => {
  /* INVALID_DATA */
});
it('a published prize keeps kind, card, credit and draw time; title/image/sort still save', async () => {
  /* ... */
});
it('cancel refunds every entrant their total on that prize, once', async () => {
  // a: 30+20 entries, b: 10 → balances back up by 50 and 10; second cancel throws
});
it('cancel is refused once the prize has a result', async () => {
  // draw it via drawLuckyDrawPrize, then cancelLuckyDrawPrize rejects NOT_ALLOWED and no refund rows exist
});
it('writes an audit row per admin action', async () => {
  /* listAdminActionAudits entity_type 'lucky_draw_event' / 'lucky_draw_prize' */
});
```

HTTP spec:

```ts
it('GET /admin/lucky-draw never returns an undrawn prize seed', async () => {
  const [row] = await packs.listLuckyDrawPrizes({ id: prizeId });
  expect(row).not.toHaveProperty('seed'); // the prize row holds only the nonce
  const seed = deriveDrawSeed(process.env.LUCKY_DRAW_SEED_SECRET!, row.seed_nonce!);
  expect(drawSeedHash(seed)).toBe(row.seed_hash);
  const res = await api.get('/admin/lucky-draw', adminHeaders);
  // Check the secret itself — `seed` is also a field name elsewhere.
  expect(JSON.stringify(res.data)).not.toContain(seed);
  expect(res.data.events[0].prizes[0].seed_hash).toBe(row.seed_hash);
});
```

Also extend the RBAC coverage unit spec run (`corepack yarn test:unit src/api/__tests__/admin-rbac-coverage.unit.spec.ts`) — it must stay green with the new resource.

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL (methods/routes missing).

- [ ] **Step 3: Implement** the methods, routes, RBAC entry and rate limits. Admin POST routes validate shapes and call `reqReason(req.body.reason)` like `api/admin/tasks/route.ts`.

- [ ] **Step 4: Run to verify they pass.** Expected: PASS, plus the RBAC coverage spec.

- [ ] **Step 5: Commit**

```bash
git add -A backend/packages/api
git commit -m "feat(lucky-draw): admin events and prizes — publish with seed commitments, cancel with refunds"
```

---

### Task 6: The draw job and payout

**Files:**

- Modify: `backend/packages/api/src/modules/packs/service.ts` (add `drawDueLuckyDrawPrizes`, `drawLuckyDrawPrize`, private `reserveLuckyDrawStock`)
- Create: `backend/packages/api/src/jobs/draw-lucky-draw.ts`
- Test: `lucky-draw.integration.spec.ts` (module; add `Pull`, `Card`, `LedgerEntry`, `LedgerSequence` to `moduleModels` as `challenge-settle.integration.spec.ts` does)

**Interfaces:**

- Consumes: `aggregateEntries`, `drawWinner`, `LUCKY_DRAW_PULL_PACK_ID` (Task 1); `disabledCustomerIds`, `mutateCreditAtomic`, `recordLedgerEntry`, `createPulls`, `BONUS_BP_FULL` (existing).
- Produces:
  - `export interface LuckyDrawOutcome { prizeId: string; winnerId: string | null; kind: 'card' | 'credit'; cardHandle: string | null; pullId: string | null }`
  - `drawLuckyDrawPrize(input: { prizeId: string; now: Date }, sharedContext?): Promise<LuckyDrawOutcome | null>` — `@InjectTransactionManager`. Steps: exclusive advisory lock `luckydraw:<prizeId>` (waits for in-flight entries holding the shared lock); result exists → `null`; prize not due / cancelled / event not published → `null`; entries → `aggregateEntries(rows)` over **every** entry on the prize (no `created_at` filter — clock skew between app and DB must never drop an accepted entry); drop `disabledCustomerIds` and refund each (`reason: 'refund'`, `ref: '<prizeId>:<customerId>'`), recording them in `excluded`; `seed = deriveDrawSeed(secret, prize.seed_nonce)` and, if `drawSeedHash(seed) !== prize.seed_hash`, throw (the job counts it `failed` and logs "LUCKY_DRAW_SEED_SECRET changed since publish" — never draw against a hash the public did not see); `drawWinner(entrants, seed, prize.id)`; the result row stores `seed`; pay (credit: bonus + WP ledger with `period: 'luckydraw:<prizeId>'`; card: one pull with `pack_id: LUCKY_DRAW_PULL_PACK_ID`, `card_id: card_handle`, `source: 'reward'`, `bonus_bp: BONUS_BP_FULL`, `stock_earmarked: false`); insert the result row (winner null + zeros when nobody entered). A card whose `Card` row is gone: result still written, `pull_id` null, logged by the job.
  - `drawDueLuckyDrawPrizes(deps: { now?: Date; decrementStock?: (handle: string, qty: number) => Promise<boolean> }): Promise<{ drawn: number; failed: number }>` — lists due prizes (`draw_at <= now`, not cancelled, event published, no result), calls `drawLuckyDrawPrize` one by one (sequential, own transaction each, a throw counts as `failed` and does not stop the loop), then `reserveLuckyDrawStock` for card outcomes after each commit (same failure handling as `reserveSettledStock`).
  - Job `draw-lucky-draw`: `config = { name: 'draw-lucky-draw', schedule: '* * * * *' }`; calls `drawDueLuckyDrawPrizes({ decrementStock: takeCardStock(container) })`; logs `failed > 0` with the logger like `settle-challenge-week.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
it('draws a due credit prize once, pays bonus credit, stores a checkable result', async () => {
  // entrants a:30 b:50 c:20 before draw_at; prize id 'ldpz_test' via direct create, published (seed_nonce + seed_hash set)
  const [prize] = await service.listLuckyDrawPrizes({ id: 'ldpz_test' });
  const seed = deriveDrawSeed(process.env.LUCKY_DRAW_SEED_SECRET!, prize.seed_nonce!);
  const expected = drawWinner(
    [{ customer_id: 'cus_a', tickets: 30 }, { customer_id: 'cus_b', tickets: 50 }, { customer_id: 'cus_c', tickets: 20 }],
    seed, 'ldpz_test',
  )!;
  const first = await service.drawDueLuckyDrawPrizes({ now: afterDraw });
  expect(first).toEqual({ drawn: 1, failed: 0 });
  const [res] = await service.listLuckyDrawResults({ prize_id: 'ldpz_test' });
  expect(res).toMatchObject({
    winner_customer_id: expected.winner.customer_id,
    ticket_index: expected.ticketIndex,
    total_tickets: 100,
    entrant_count: 3,
    seed,
  });
  expect(drawSeedHash(res.seed)).toBe(prize.seed_hash);
  // winner's credit row: reason reward_credit, bonus; WP ledger row exists
  expect(await service.drawDueLuckyDrawPrizes({ now: afterDraw })).toEqual({
    drawn: 0,
    failed: 0,
  });
});

it('a card prize mints one reward pull for the winner with full bonus bp and no earmark', async () => {
  /* pull.source 'reward', pack_id 'lucky-draw' */
});
it('an entry accepted before draw_at counts even though its row is written after draw_at', async () => {
  // draw_at is 1 hour in the REAL past; enter with now = draw_at - 1s, so the
  // gate accepts while created_at (real clock) lands after draw_at.
  await service.enterLuckyDraw({ customerId: 'cus_late', prizeId, tickets: 5, now: new Date(drawAt.getTime() - 1000) });
  await service.drawDueLuckyDrawPrizes({ now: new Date() });
  const [res] = await service.listLuckyDrawResults({ prize_id: prizeId });
  expect(res.entries).toContainEqual({ customer_id: 'cus_late', tickets: 5 });
});
it('an enter after the result exists is refused as closed and spends nothing', async () => {
  // drawn prize; enter with now = draw_at - 1s (gate time OK) → closed, balance unchanged
});
it('no entries → result with null winner, nothing paid, not drawn again', async () => {
  /* ... */
});
it('disabled entrants are excluded and refunded; all-disabled → null winner', async () => {
  /* ... */
});
it('a prize not yet due, cancelled, or on a draft event is not drawn', async () => {
  /* ... */
});
it('refuses to draw (failed: 1, no result) when the secret no longer matches the published hash', async () => {
  // publish with one secret, draw with process.env.LUCKY_DRAW_SEED_SECRET changed → failed 1, no lucky_draw_result row
});
it('a recompute from the stored result picks the same winner', async () => {
  const [res] = await service.listLuckyDrawResults({ prize_id: 'ldpz_test' });
  expect(
    drawWinner(res.entries as DrawEntrant[], res.seed, 'ldpz_test')?.winner
      .customer_id,
  ).toBe(res.winner_customer_id);
});
```

- [ ] **Step 2: Run to verify they fail.** Expected: FAIL (methods missing).

- [ ] **Step 3: Implement** the methods and the job.

- [ ] **Step 4: Run to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A backend/packages/api/src
git commit -m "feat(lucky-draw): once-a-minute draw job — seeded winner, bonus/card payout, refunds"
```

---

### Task 7: Store API

**Files:**

- Modify: `backend/packages/api/src/modules/packs/service.ts` (read methods below)
- Create: `backend/packages/api/src/api/store/lucky-draw/view.ts`, `route.ts`, `balance/route.ts`, `me/route.ts`, `results/route.ts`, `results/[prizeId]/route.ts`, `prizes/[id]/enter/route.ts`
- Modify: `backend/packages/api/src/api/middlewares.ts` (all `/store/lucky-draw*` GETs: `authenticate('customer', ['bearer'])` + `storeReadRateLimit`; POST `/store/lucky-draw/prizes/*/enter`: `authenticate('customer', ['bearer'])` + `taskActionRateLimit`)
- Test: `integration-tests/http/lucky-draw.spec.ts`

**Interfaces:**

- Consumes: `enterLuckyDraw` (Task 4), `luckyDrawBalance`, `luckyDrawTicketHistory` (Tasks 3, 5); `loadPullerProfiles` (`api/store/pulls/pullers.ts`) for every name shown.
- Produces — JSON contracts the storefront (Task 9) parses. `Person = { who: string; face_seed: number | null; avatar_url: string | null; frame_url: string | null }` (from `profileOf`, with its avatar `seed` renamed `face_seed` so it can never be confused with a draw seed; disabled → `ANONYMOUS_PULLER`):
  - `GET /store/lucky-draw` → `{ balance: number; event: { id; name; starts_at; ends_at } | null; prizes: PrizeView[] }` — the published event whose `starts_at ≤ now < ends_at`, else the most recent published event that ended within 7 days, else `null`. `PrizeView = { id; kind: 'card' | 'credit'; title; image: string | null; value_myr: number; draw_at; seed_hash: string; total_tickets; entrant_count; my_tickets; top: { person: Person; tickets: number }[] /* ≤10, most tickets first */; result: ResultView | null }`. `value_myr` = credit amount, or the card's current RM value (same source as `HubReward.card_value_myr`). `image` = `image_url ?? card image`.
  - `ResultView = { prize_id; title; image; value_myr; drawn_at; winner: Person | null; winner_tickets; total_tickets; entrant_count; seed; seed_hash }`
  - `GET /store/lucky-draw/results?before=<iso>&limit=<1..50, default 20>` → `{ results: ResultView[]; next_before: string | null }`, newest first, every event.
  - `GET /store/lucky-draw/results/:prizeId` → `{ result: ResultView; entries: { person: Person; tickets: number }[] /* stored draw order */; ticket_index: number | null }`; 404 when not drawn.
  - `GET /store/lucky-draw/me` → `{ balance; history: { delta; reason: 'task_claim' | 'entry' | 'refund'; created_at }[] /* last 100 */; entries: { prize_id; title; image; my_tickets; draw_at; status: 'open' | 'won' | 'lost' | 'cancelled' }[] }`
  - `GET /store/lucky-draw/balance` → `{ balance: number }`
  - `POST /store/lucky-draw/prizes/:id/enter` body `{ tickets: number }` → 200 with `enterLuckyDraw`'s result object (refusals are 200 `{ entered: false, reason }`, never 409 — Medusa rewrites CONFLICT messages); invalid tickets → 400.
  - **Caching (the draw moment is a synchronized read — see the 10-20 outage):** `view.ts` keeps an in-process cache of the shared part of `GET /store/lucky-draw` (event, prizes, totals, top 10, results) for 10 s, and of drawn `ResultView`s/entry lists by prize id with no expiry (results are immutable; cap 500 entries). Only `balance` and `my_tickets` are read per request. Export `clearLuckyDrawCache()` for tests (like `clearPackListCache`). An undrawn `results/:prizeId` 404 is not cached.

- [ ] **Step 1: Write the failing HTTP tests**

```ts
it('GET /store/lucky-draw lists live prizes with my tickets, top 10 and no draw seed', async () => {
  clearLuckyDrawCache();
  const [row] = await packs.listLuckyDrawPrizes({ id: prizeId });
  const seed = deriveDrawSeed(process.env.LUCKY_DRAW_SEED_SECRET!, row.seed_nonce!);
  const res = await api.get('/store/lucky-draw', customerHeaders);
  expect(res.data.balance).toBe(70);
  expect(res.data.prizes[0]).toMatchObject({
    my_tickets: 30,
    total_tickets: 30,
    entrant_count: 1,
    seed_hash: row.seed_hash,
  });
  expect(JSON.stringify(res.data)).not.toContain(seed);
  // the same secret must not appear on any other store route before the draw
  for (const path of ['/store/lucky-draw/me', '/store/lucky-draw/results'])
    expect(JSON.stringify((await api.get(path, customerHeaders)).data)).not.toContain(seed);
});
it('POST enter returns 200 { entered:false, reason:"no_topup" } for a never-topped-up account', async () => {
  /* ... */
});
it('POST enter with tickets 0 is a 400', async () => {
  /* ... */
});
it('after the draw, the result shows the seed and the full entry list', async () => {
  // run packs.drawDueLuckyDrawPrizes({ now: afterDraw }) then GET results/:prizeId
  expect(res.data.result.seed).toMatch(/^[0-9a-f]{64}$/);
  expect(res.data.entries).toHaveLength(1);
});
it('every /store/lucky-draw route is 401 without a customer bearer', async () => {
  /* ... */
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `node integration-tests/run-http-shards.mjs lucky-draw.spec` → FAIL (404s).

- [ ] **Step 3: Implement** service reads (`luckyDrawPage({ customerId, now })`, `luckyDrawResults({ before, limit })`, `luckyDrawResult(prizeId)`, `luckyDrawMine(customerId)` — returning raw ids/tickets) and the routes, which resolve names through `loadPullerProfiles` in `view.ts`. Reads stay sequential on one manager (repo rule: no parallel queries on one injected manager).

- [ ] **Step 4: Run to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A backend/packages/api
git commit -m "feat(lucky-draw): store API — prizes, enter, results, my tickets"
```

---

### Task 8: Admin SPA — Lucky Draw page and task Tickets field

**Files:**

- Create: `backend/apps/admin/src/routes/lucky-draw/page.tsx`, `backend/apps/admin/src/routes/lucky-draw/lucky-draw-draft.ts`, `lucky-draw-draft.test.ts`
- Modify: `backend/apps/admin/src/lib/admin-rest.ts` (types + calls for Task 5's routes; `AdminTaskDefinition.tickets: number`; `saveTaskDefinition` input `tickets: number`)
- Modify: `backend/apps/admin/src/routes/tasks/task-draft.ts` (`Draft.tickets: string`, `blankDraft` `'0'`, `draftFrom`, payload), `routes/tasks/page.tsx` (a "Tickets" number input beside the reward), `routes/tasks/task-draft.test.ts`
- Modify: `backend/apps/admin/src/i18n/en.json` + `zhCN.json` (`pcNav.luckyDraw`: "Lucky draw" / "幸运抽奖"), `backend/apps/admin/src/lib/nav-contract.test.ts` (Rewards children gain `{ path: '/lucky-draw', label: 'pcNav.luckyDraw' }` after Weekly challenge)

**Interfaces:**

- Consumes: Task 5 admin routes; `uploadImage(file, 'card')` for credit-prize art.
- Produces:
  - `page.tsx` `config: RouteConfig = { label: 'pcNav.luckyDraw', translationNs: 'translation', rank: 3, nested: '/rewards' }`
  - `lucky-draw-draft.ts`: `export interface PrizeDraft { id?: string; kind: 'card' | 'credit'; cardHandle: string; creditMyr: string; title: string; imageUrl: string; sort: string; drawAt: string /* datetime-local */ }`, `export const blankPrizeDraft: () => PrizeDraft`, `export function prizeDraftFrom(p: AdminLuckyDrawPrize): PrizeDraft`, `export function prizeDraftToPayload(d: PrizeDraft, eventId: string): AdminLuckyDrawPrizeInput | null` (null when the card/credit/title is missing or credit is not whole sen).
  - Page: event list (status, window, prize count) → create/edit event (name, start, end, reason) → prizes table (art, title, kind, value, draw time, tickets, entrants, result winner) → add/edit prize drawer (kind toggle, card picker or credit amount + image upload, title, sort, draw time) → Publish (confirm dialog) → Cancel prize (confirm + reason) → Entrants drawer (handle, tickets) → "Customer tickets" lookup (customer id → balance + history). Follow `routes/challenge/page.tsx` layout and `RowActionConfirm`.

- [ ] **Step 1: Write the failing tests**

`lucky-draw-draft.test.ts`: round-trip a card prize and a credit prize through `prizeDraftFrom` → `prizeDraftToPayload` and get back `{ kind, card_handle, credit_myr, title, image_url, sort, draw_at }`; `prizeDraftToPayload` returns null for credit `'12.345'`, empty title, card kind with empty handle.
`task-draft.test.ts`: `draftFrom({ ..., tickets: 50 }).tickets === '50'`; payload carries `tickets: 50`; blank draft payload carries `tickets: 0`; `'-1'` and `'1.5'` → payload null.
`nav-contract.test.ts`: updated expectation.

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend/apps/admin && npx vitest run src/routes/lucky-draw src/routes/tasks src/lib/nav-contract.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** draft helpers, REST calls, the page and the Tickets field.

- [ ] **Step 4: Run to verify they pass** (same command) → PASS. Then `cd backend/apps/admin && npm run build` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A backend/apps/admin/src
git commit -m "feat(admin): Lucky Draw page under Rewards and a Tickets field on tasks"
```

---

### Task 9: Storefront — the Lucky Draw page

**Files:**

- Modify: `src/lib/data/schemas.ts` (Lucky Draw schemas), `DESIGN.md` (Holo foil accent, Lucky Draw only)
- Create: `src/lib/actions/lucky-draw.ts`, `src/lib/lucky-draw.ts`, `src/lib/__tests__/lucky-draw.test.ts`, `src/lib/data/__tests__/lucky-draw-schema.test.ts`
- Create: `src/app/(account)/lucky-draw/page.tsx`, `LuckyDrawClient.tsx`, `PrizeCard.tsx`, `EnterSheet.tsx`, `SpinWheel.tsx`, `ResultsList.tsx`, `ResultDetail.tsx`, `MyTickets.tsx`, `TicketOpenIntro.tsx`

**Interfaces:**

- Consumes: Task 7 JSON contracts.
- Produces:
  - Schemas: `LuckyDrawPageSchema`, `LuckyDrawResultsSchema`, `LuckyDrawResultDetailSchema`, `LuckyDrawMineSchema`, `LuckyDrawBalanceSchema`, `LuckyDrawEnterSchema` — `z.looseObject`, numbers via the file's `finite`, arrays parsed row-by-row like `TaskHubSchema.tasks` so one bad row drops alone.
  - Actions (`'use server'`, via `store.get` / `store.post`): `getLuckyDraw(): Promise<LuckyDrawPage | null>`, `enterLuckyDraw(prizeId: string, tickets: number): Promise<{ ok: true; entered: true; balance: number; myTickets: number } | { ok: true; entered: false; reason: string } | { ok: false; error: string }>`, `getLuckyDrawResults(before?: string): Promise<LuckyDrawResults | null>`, `getLuckyDrawResult(prizeId: string): Promise<LuckyDrawResultDetail | null>`, `getMyLuckyDraw(): Promise<LuckyDrawMine | null>`, `getTicketBalance(): Promise<number | null>`.
  - Pure helpers in `src/lib/lucky-draw.ts`: `chancePercent(mine: number, total: number): string` (`'0%'` when total 0; one decimal under 10%, whole number otherwise; `'<0.1%'` for tiny non-zero), `drawCountdown(drawAtIso: string, nowMs: number): string` (`'2d 4h'`, `'3h 05m'`, `'4m 09s'`, `'Drawing…'` at ≤ 0), `ENTER_REFUSAL_COPY: Record<string, string>` with exactly: `not_found: 'This prize is no longer available.'`, `not_open: 'This Lucky Draw has not started yet.'`, `closed: 'Entries for this prize are closed.'`, `not_enough_tickets: 'You don\'t have that many tickets.'`, `no_topup: 'Top up at least once to enter the Lucky Draw.'`.
  - Page: server `page.tsx` (`metadata.title = 'Lucky Draw'`) loads `getLuckyDraw()`; client has three tabs — **Prizes** (grid of `PrizeCard`: art, title, RM value, countdown, total tickets, entrants, my tickets + `chancePercent`, top-10 list, Enter button → `EnterSheet` with stepper and Max, `seed_hash` under a "Fair draw" disclosure), **Results** (`ResultsList` paginated with `next_before`; tap → `ResultDetail`: winner, tickets, full entry list, seed + hash, and a plain "How to check" paragraph: sha256(seed) must equal the hash shown before the draw; HMAC-SHA256(seed, prize id) mod total tickets gives the winning ticket; count through the list in order), **My tickets** (`MyTickets`: balance, history, my entries with status).
  - Polling: from `draw_at` until its result appears or `draw_at + 5 min`, poll the cheap `getLuckyDrawResult(prizeId)` (not the whole page) every 5 s plus 0–2 s random jitter per tick; when the result appears, `SpinWheel` spins and lands on the stored winner (decoration only); reduced motion → show the winner directly.
  - `SpinWheel` (spec §10, style K Holo Foil, win effect "Holo dust + prize reveal"): port `docs/superpowers/specs/assets/lucky-draw-spin-prototype.html` into React — SVG segments sized by `entries` tickets (names on segments ≥ 7.5°), holo rim as a CSS conic-gradient ring, pointer spring kicked on each edge crossing, timing: 320 ms pull-back (−7°), 6.9 s quartic ease-out to target + 1.4°, 520 ms settle; landing point uniformly inside the middle 56% of the winner's segment; then dust (≈0.7 motes/frame for 1.6 s, 14% four-point glints) from the winning segment, wheel dims to 38% brightness and scales 0.86, prize frame (5:7, holo border, real prize image) rises from the hub after 900 ms with a 34-mote wave off its top edge; winner name + "N of M tickets" after 1 s. Drive animation with `requestAnimationFrame` and SVG `transform` attributes (CSS transform-origin on SVG groups is unreliable). Above 300 entrants, merge the smallest (never the winner) into one evenly striped filler arc so the wheel stays readable; the winner keeps its true span. Add the holo stops (`#c7f0ff #d8c8ff #ffc9e6 #e9ecf2 #b8f3ea #cfd6ff #ffd6f0`) to `DESIGN.md` as a Lucky-Draw-only "Holo foil" accent (rim, prize frame, dust — never chrome or buttons). After entering, update balance/my tickets/total locally from the enter response instead of re-fetching the page.
  - `?open=1` (from the vault row) plays `TicketOpenIntro` once (placeholder art: lucide `Ticket` icon + scale/fade); reduced motion → skipped.
  - No balance → empty state "Earn tickets from tasks" linking `/task`. No event → "The next Lucky Draw is coming soon." plus the Results tab.

- [ ] **Step 1: Write the failing tests**

`lucky-draw.test.ts`: `chancePercent(30, 100) === '30%'`, `chancePercent(1, 300) === '0.3%'`, `chancePercent(1, 5000) === '<0.1%'`, `chancePercent(0, 0) === '0%'`; `drawCountdown('2026-11-30T15:59:00Z', Date.parse('2026-11-28T11:59:00Z')) === '2d 4h'`, `… Date.parse('2026-11-30T12:54:00Z')) === '3h 05m'`, `… Date.parse('2026-11-30T15:54:51Z')) === '4m 09s'`, `… Date.parse('2026-11-30T16:00:00Z')) === 'Drawing…'`; every `EnterRefusal` key has copy.
`lucky-draw-schema.test.ts`: a page payload with one malformed prize parses with that prize dropped; a payload missing `top` on a prize parses with `top: []`; a payload with a `seed` field is still accepted (loose) — the UI never reads `seed` from `PrizeView`.

- [ ] **Step 2: Run to verify they fail.** Run: `npx vitest run src/lib/__tests__/lucky-draw.test.ts src/lib/data/__tests__/lucky-draw-schema.test.ts` → FAIL.

- [ ] **Step 3: Implement** schemas, actions, helpers and the page.

- [ ] **Step 4: Run to verify they pass** (same command) → PASS. Then `npm run typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "feat(storefront): Lucky Draw page — prizes, enter, results, my tickets"
```

---

### Task 10: Storefront — vault ticket row and task-hub tickets

**Files:**

- Modify: `src/app/(account)/vault/page.tsx` (load `getTicketBalance()` beside `getPackGifts()`), `src/app/(account)/vault/VaultClient.tsx` (ticket row above the Packs row)
- Modify: `src/lib/data/schemas.ts` (`TaskEntrySchema.tickets: finite.optional().catch(0)`), `src/app/task/TaskHubClient.tsx` (chip), `src/app/task/task-hub.ts` (`claimNotice` adds tickets)
- Test: `src/app/task/__tests__/task-hub.test.ts` (or the file's existing test), `src/lib/data/__tests__/task-hub-schema.test.ts`

**Interfaces:**

- Consumes: `getTicketBalance` (Task 9); `tickets` on task rows (Task 3).
- Produces:
  - Vault row (always shown when balance is readable): ticket art placeholder, "Lucky Draw Tickets ×N", sub-line "Put them on the prizes you want"; button **Open** → `/lucky-draw?open=1`; at 0: sub-line "Earn tickets from tasks", button **Tasks** → `/task`. Same markup family as the Packs row (rounded-2xl, border-white/10, `pillVariants({ size: 'sm' })`). `null` balance (unreadable) → row hidden.
  - Task row: when `task.tickets > 0`, a small pill "+N tickets" (lucide `Ticket` icon) next to the reward stub, linking `/lucky-draw`.
  - `claimNotice(reward, tickets?: number)`: appends `' + N Lucky Draw tickets'` (`ticket` singular) when tickets > 0; `useClaimTask` passes `task.tickets`.

- [ ] **Step 1: Write the failing tests**

`task-hub-schema.test.ts`: a task row without `tickets` parses with `tickets === 0`; with `tickets: 50` → 50; with `tickets: 'x'` → 0.
`task-hub` test: `claimNotice({ type: 'credit', amount_myr: 5 }, 50)` ends with `' + 50 Lucky Draw tickets'`; with `1` → `' + 1 Lucky Draw ticket'`; with `0` equals today's notice.

- [ ] **Step 2: Run to verify they fail.** Run: `npx vitest run src/lib/data/__tests__/task-hub-schema.test.ts src/app/task` → FAIL.

- [ ] **Step 3: Implement** the row, chip and notice.

- [ ] **Step 4: Run to verify they pass** → PASS. Then `npm run typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "feat(storefront): tickets in the vault and on task rewards"
```

---

### Task 11: End-to-end verification

**Files:**

- Create: `scripts/qa-lucky-draw.mjs` (Playwright; screenshots to `docs/research/lucky-draw-*.png`)

**Interfaces:**

- Consumes: everything above.

- [ ] **Step 1: Backend suites**

Run: `cd backend/packages/api && corepack yarn test:unit` → all PASS.
Run: `corepack yarn test:integration:modules src/modules/packs/__tests__/lucky-draw.integration.spec.ts src/modules/packs/__tests__/task-engine.integration.spec.ts` → PASS.
Run: `node integration-tests/run-http-shards.mjs lucky-draw.spec tasks.spec challenge.spec` → PASS.

- [ ] **Step 2: Storefront and admin**

Run (root): `npm run typecheck && npm test && npm run build` → exit 0.
Run: `cd backend/apps/admin && npx vitest run && npm run build` → exit 0.

- [ ] **Step 3: Visual check on the production build**

Build and serve the standalone storefront (`npm run build`, `pwsh scripts/serve-standalone.ps1 -Port 4000`, in the background) against a local backend seeded with one published event (one card prize, one credit prize, draw time 3 minutes ahead) and a customer with tickets and a top-up (see the `launching-pokenic-stack` skill; if the DB is gated, use the mock-backend route from memory `design-preview-mock-backend`). `scripts/qa-lucky-draw.mjs` logs in by cookie, then captures at 375×812 and 1440×900: vault ticket row, `/lucky-draw?open=1`, Prizes tab, Enter sheet, after entering (balance and chance updated), Results tab after the draw time passes, Result detail, My tickets, and `/task` with a "+N tickets" chip. Read each PNG back and check: no horizontal scroll at 375, no "seed" text before the draw, countdown and chance render, reduced-motion run (`reducedMotion: 'reduce'`) shows the winner without the reel.

- [ ] **Step 4: Commit**

```bash
git add scripts/qa-lucky-draw.mjs
git commit -m "test(lucky-draw): Playwright capture for the vault row, page, enter and results"
```

## Launch checklist (operator, after merge and deploy — not code)

1. Codex asset pass replaces the three placeholder slots (spec §11) before 2026-11-01.
2. Set `LUCKY_DRAW_SEED_SECRET` (random, ≥ 32 bytes) as an APP-LEVEL secret so it reaches both the backend service and the worker; put the value in the deploy env file used by do-apply (the repo spec only holds the placeholder) BEFORE publishing any event; never change it while a published prize is undrawn.
3. Admin → Rewards → Lucky draw: create "November 2026" (start 2026-11-01 00:00, end 2026-11-30 23:59 MYT), add prizes (~RM 100k total), publish.
4. Admin → Tasks: set Tickets on the tasks that should pay them (e.g. weekly top-up RM 500 → 50, weekly 7-day check-in → 2).
5. After 2026-11-30 23:59 MYT, confirm each prize shows a result within a minute; check the job log for `failed`.
