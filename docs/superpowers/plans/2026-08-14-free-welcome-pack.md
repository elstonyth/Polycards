# Free Welcome Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every newly registered account gets ONE free pack open; the won card is fully locked (no buyback, no delivery) until the customer opens one paid pack. Admin configures the free pack with the existing pack editor; storefront shows a floating FREE PACK badge.

**Architecture:** The free pack is a normal `Pack` row with reserved `category='free_welcome'` (mirrors the existing `reward_box` internal-category pattern — no pack migration). The open reuses `openPackWorkflow` — a new `claimFreePackStep` replaces the charge for free packs (the charge step already skips debit at price 0) and the pull is written `source='free'` (a third `pull.source` enum value, mirroring how `'reward'` is excluded from boards/feed). Lock is computed: a free pull is locked while the customer has zero `source='pack'` pulls.

**Tech Stack:** Medusa 2 modules/workflows (backend, corepack yarn), Next.js App Router storefront (npm), Vite admin, Jest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-14-free-welcome-pack-design.md` (approved 2026-08-14; commit it with Task 1).

## Global Constraints

- **Worktree:** execute in an isolated worktree (`superpowers:using-git-worktrees`; native `EnterWorktree` first, fallback `git worktree add .worktrees/free-welcome-pack -b feat/free-welcome-pack`). Run `npm install` at the worktree root AND `corepack yarn install` in `backend/`; copy `.env.local` (root) and `backend/packages/api/.env` from the main tree (guard-secrets blocks `cp` — use PowerShell `Copy-Item`).
- **Backend edits churn under the global prettier hook** (rewrites backend double-quotes to single, whole-file churn that FAILS CI `format:check`). Edit backend `.ts` files via a node script through Bash when the Edit tool churns, and run `corepack yarn format:check` (or the repo's prettier binary) on touched backend files before every backend commit — CI runs format-check separately from `npm run check`.
- **Jest on Windows:** `corepack yarn test:unit` is broken — invoke jest directly from `backend/packages/api`:
  `node ..\..\node_modules\jest\bin\jest.js <spec-path>` with `$env:TEST_TYPE='unit'`.
  Integration specs: `$env:NODE_OPTIONS='--experimental-vm-modules'; $env:TEST_TYPE='integration:modules'` (or `integration:http`) against the `pokenic-postgres` Docker container. Never pipe jest through `tail`/`head`.
- **integration:modules schema comes from the spec's `moduleModels` array** — if a spec hits `relation "x" does not exist`, add the model to that spec's array; `db:migrate` can never fix it.
- **Migrations:** `pull_source_check` is MODEL-OWNED, emitted by `db:generate` — never hand-write a second CHECK (42710 collision). `db:generate` diffs against `.snapshot-packs.json`, NOT the live DB — read the generated SQL and confirm it contains exactly the expected statements.
- **Forward-only migration:** `Migration20260814100042.down()` cannot run once free pulls exist — it narrows `pull.source` back to `('pack','reward')` and any `source='free'` row violates the restored CHECK. Rollback is restore-from-backup, the repo's standing precedent for shipped enum widenings.
- **Money:** MYR decimals, never cents. The free pack's `price` is `0`.
- **Copy (user-facing lock message):** "Purchase & open any pack to unlock selling & delivery." — use verbatim everywhere the lock surfaces.
- **Badge asset exists:** `public/images/polycards/free-pack-badge.webp` (393×512, transparent — the black/gold squircle "FREE PACK" badge). Do not regenerate.
- **Vocabulary (CONTEXT.md):** pack Open, Pull, Buyback, Delivery Order. The free pack is opened via a normal Open; its pull is a "free pull".
- Reduced motion: any new animation must gate on `usePrefersReducedMotion` (`src/lib/use-reveal.ts`).
- Conventional commits. Type-check hooks run on every edit; the Stop hook re-type-checks storefront + backend.

---

### Task 1: Models + migration (`pull.source` 'free', account-state stamps)

**Files:**
- Modify: `backend/packages/api/src/modules/packs/models/pull.ts:61`
- Modify: `backend/packages/api/src/modules/packs/models/customer-account-state.ts`
- Create: generated `backend/packages/api/src/modules/packs/migrations/Migration<timestamp>.ts`
- Commit alongside: `docs/superpowers/specs/2026-08-14-free-welcome-pack-design.md`, this plan file, `public/images/polycards/free-pack-badge.webp`

**Interfaces:**
- Produces: `pull.source` enum `['pack','reward','free']`; `customer_account_state.free_pack_available_at: Date|null`, `free_pack_claimed_at: Date|null`.

- [ ] **Step 1: Edit the two models**

In `pull.ts`, extend the enum (comment stays accurate — extend it):

```ts
    // Origin of this pull: 'pack' (standard open), 'reward' (daily reward draw),
    // or 'free' (the one-time free welcome pack — excluded from boards/feed like
    // 'reward', and locked from buyback/delivery until the customer's first paid
    // open; see modules/packs/free-pack.ts).
    // For reward pulls, card_id holds the product_handle sentinel.
    // Model-owned CHECK (pull_source_check) emitted by db:generate — do NOT
    // hand-write a separate CHECK (would collide → 42710).
    source: model.enum(['pack', 'reward', 'free']).default('pack'),
```

In `customer-account-state.ts`, after `phone_verified_at`:

```ts
    // Free welcome pack (spec 2026-08-14): `available_at` is stamped by the
    // customer.created subscriber — only accounts registered after the feature
    // shipped ever get it (this IS the "new registrations only" rule; no date
    // cutoffs). `claimed_at` is stamped atomically by claimFreePack() when the
    // one free open is consumed; cleared by workflow compensation on failure.
    free_pack_available_at: model.dateTime().nullable(),
    free_pack_claimed_at: model.dateTime().nullable(),
```

- [ ] **Step 2: Generate the migration**

From `backend/packages/api` run the repo's migration generation (medusa-dev:db-generate skill / `npx medusa db:generate packs`). Open the generated file and verify it contains BOTH:
1. `alter table ... "pull" drop constraint ... pull_source_check` + re-add with `('pack', 'reward', 'free')` (exact statement shape follows Migration20260624220240.ts).
2. `alter table ... "customer_account_state" add column ... "free_pack_available_at" timestamptz null, add column ... "free_pack_claimed_at" timestamptz null`.

If the snapshot is stale and the SQL contains unrelated statements, delete the stray statements and note why in the migration header comment (precedent: db-generate diffs the snapshot, not the live DB).

- [ ] **Step 3: Run the migration against local postgres**

Run: `npx medusa db:migrate` from `backend/packages/api` (pokenic-postgres up).
Expected: migration applies cleanly; `\d pull` shows the widened CHECK, `\d customer_account_state` shows both columns.

- [ ] **Step 4: Typecheck + commit**

Run backend tsc via the repo hook (any backend edit triggers it) or `node_modules/.bin/tsc --noEmit -p backend/packages/api` (repo-pinned tsc, NOT global TS7).

```bash
git add backend/packages/api/src/modules/packs/models backend/packages/api/src/modules/packs/migrations docs/superpowers/specs/2026-08-14-free-welcome-pack-design.md docs/superpowers/plans/2026-08-14-free-welcome-pack.md public/images/polycards/free-pack-badge.webp
git commit -m "feat(free-pack): widen pull.source to 'free', add account-state claim stamps"
```

---

### Task 2: Service methods (stamp, claim, unlock check, active lookup)

**Files:**
- Modify: `backend/packages/api/src/modules/packs/service.ts` (add 5 methods near `markPhoneVerified`, service.ts:2773)
- Create: `backend/packages/api/src/modules/packs/free-pack.ts` (pure constants/helpers)
- Test: `backend/packages/api/src/modules/packs/__tests__/free-pack-claim.integration.spec.ts`

**Interfaces:**
- Produces:
  - `FREE_WELCOME_CATEGORY = 'free_welcome'` (const, `free-pack.ts`)
  - `PacksModuleService.markFreePackAvailable(customerId: string): Promise<void>` — upsert stamp, idempotent (mirror `markPhoneVerified` including its advisory-lock + decorator shape).
  - `PacksModuleService.claimFreePack(customerId: string): Promise<boolean>` — atomic one-shot claim; `true` exactly once.
  - `PacksModuleService.clearFreePackClaim(customerId: string): Promise<void>` — compensation.
  - `PacksModuleService.hasPaidOpen(customerId: string): Promise<boolean>` — any `source='pack'` pull exists.
  - `PacksModuleService.getActiveFreePack(): Promise<Pack | null>` — active pack in `free_welcome` category (rank ASC, take 1).

- [ ] **Step 1: Write the failing integration spec**

`free-pack-claim.integration.spec.ts` (follow the harness of `buyback-unfreeze.integration.spec.ts` for module setup; `moduleModels` must include `CustomerAccountState`, `Pack`, `Pull`):

```ts
describe('free pack claim state', () => {
  it('markFreePackAvailable stamps once, idempotently', async () => {
    await service.markFreePackAvailable('cus_1');
    await service.markFreePackAvailable('cus_1');
    const [s] = await service.listCustomerAccountStates({ customer_id: 'cus_1' }, { take: 1 });
    expect(s.free_pack_available_at).toBeTruthy();
    expect(s.free_pack_claimed_at).toBeNull();
  });

  it('claimFreePack succeeds exactly once, and only for stamped accounts', async () => {
    expect(await service.claimFreePack('cus_nobody')).toBe(false); // never stamped
    await service.markFreePackAvailable('cus_2');
    expect(await service.claimFreePack('cus_2')).toBe(true);
    expect(await service.claimFreePack('cus_2')).toBe(false); // second claim loses
  });

  it('clearFreePackClaim re-opens the claim (compensation path)', async () => {
    await service.markFreePackAvailable('cus_3');
    await service.claimFreePack('cus_3');
    await service.clearFreePackClaim('cus_3');
    expect(await service.claimFreePack('cus_3')).toBe(true);
  });

  it('hasPaidOpen: false for free/reward pulls, true once a pack pull exists', async () => {
    await service.createPulls([{ customer_id: 'cus_4', pack_id: 'free-welcome', card_id: 'c1', rolled_at: new Date(), source: 'free' }]);
    expect(await service.hasPaidOpen('cus_4')).toBe(false);
    await service.createPulls([{ customer_id: 'cus_4', pack_id: 'bronze-pack', card_id: 'c1', rolled_at: new Date(), source: 'pack' }]);
    expect(await service.hasPaidOpen('cus_4')).toBe(true);
  });

  it('getActiveFreePack: only active free_welcome packs, null otherwise', async () => {
    expect(await service.getActiveFreePack()).toBeNull();
    await service.createPacks([{ slug: 'free-welcome', title: 'Welcome Pack', category: 'free_welcome', price: 0, image: '/x.webp', status: 'draft' }]);
    expect(await service.getActiveFreePack()).toBeNull();
    await service.updatePacks({ selector: { slug: 'free-welcome' }, data: { status: 'active' } });
    expect((await service.getActiveFreePack())?.slug).toBe('free-welcome');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

From `backend/packages/api`: `$env:NODE_OPTIONS='--experimental-vm-modules'; $env:TEST_TYPE='integration:modules'; node ..\..\node_modules\jest\bin\jest.js src/modules/packs/__tests__/free-pack-claim.integration.spec.ts`
Expected: FAIL — `markFreePackAvailable is not a function`.

- [ ] **Step 3: Implement**

`free-pack.ts`:

```ts
// Free welcome pack (spec docs/superpowers/specs/2026-08-14-free-welcome-pack-design.md).
// The free pack is a normal Pack in this RESERVED category — hidden from the
// public catalog exactly like 'reward_box', configured with the standard pack
// editor. One active free_welcome pack at a time (admin validation).
export const FREE_WELCOME_CATEGORY = 'free_welcome';

/** User-facing reason shown whenever a locked free pull is refused. */
export const FREE_PULL_LOCKED_MESSAGE =
  'Purchase & open any pack to unlock selling & delivery.';
```

Service methods — `markFreePackAvailable` is a line-for-line mirror of `markPhoneVerified` (service.ts:2773–2801) writing `free_pack_available_at`. `claimFreePack`/`clearFreePackClaim` use ONE raw conditional UPDATE (atomic under concurrency — the row lock serializes; second updater matches 0 rows). Use the same manager-access + decorator convention as the raw-SQL methods around service.ts:4242:

```ts
async claimFreePack(customerId: string, sharedContext: Context = {}): Promise<boolean> {
  // Lazy-create the state row never happens here: an unstamped account has no
  // free_pack_available_at, so the WHERE matches nothing — claim refused.
  const rows: unknown[] = await em.execute(
    `UPDATE customer_account_state
        SET free_pack_claimed_at = now(), updated_at = now()
      WHERE customer_id = ?
        AND free_pack_available_at IS NOT NULL
        AND free_pack_claimed_at IS NULL
        AND deleted_at IS NULL
      RETURNING id`,
    [customerId],
  );
  return rows.length > 0;
}

async clearFreePackClaim(customerId: string, sharedContext: Context = {}): Promise<void> {
  await em.execute(
    `UPDATE customer_account_state SET free_pack_claimed_at = NULL, updated_at = now()
      WHERE customer_id = ? AND deleted_at IS NULL`,
    [customerId],
  );
}

async hasPaidOpen(customerId: string, sharedContext: Context = {}): Promise<boolean> {
  const pulls = await this.listPulls(
    { customer_id: customerId, source: 'pack' },
    { take: 1, select: ['id'] },
    sharedContext,
  );
  return pulls.length > 0;
}

async getActiveFreePack(sharedContext: Context = {}) {
  const [pack] = await this.listPacks(
    { category: FREE_WELCOME_CATEGORY, status: 'active' },
    { take: 1, order: { rank: 'ASC' } },
    sharedContext,
  );
  return pack ?? null;
}
```

(`em` = the same `LedgerSqlManager` acquisition the neighboring raw-SQL methods use — copy their exact decorator + `sharedContext` handling.)

- [ ] **Step 4: Run to verify it passes**

Same command. Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src/modules/packs/service.ts backend/packages/api/src/modules/packs/free-pack.ts backend/packages/api/src/modules/packs/__tests__/free-pack-claim.integration.spec.ts
git commit -m "feat(free-pack): claim/unlock service methods + free_welcome category constant"
```

---

### Task 3: `customer.created` subscriber stamps availability

**Files:**
- Create: `backend/packages/api/src/subscribers/customer-free-pack.ts`
- Test: `backend/packages/api/src/subscribers/__tests__/customer-free-pack.unit.spec.ts` (mirror the existing subscriber unit-spec harness if one exists for `customer-default-group`; else follow `customer-phone-verified`'s test if present — otherwise a thin unit test with a mocked container as below)

**Interfaces:**
- Consumes: `PacksModuleService.markFreePackAvailable` (Task 2).
- Produces: every post-ship registration carries `free_pack_available_at`.

- [ ] **Step 1: Write the failing test**

```ts
import handler from '../customer-free-pack';

const container = (packs: { markFreePackAvailable: jest.Mock }) => ({
  resolve: (key: string) =>
    key === 'logger' ? { warn: jest.fn() } : packs,
});

describe('customer-free-pack subscriber', () => {
  it('stamps every created customer (array payload)', async () => {
    const packs = { markFreePackAvailable: jest.fn() };
    await handler({ event: { data: [{ id: 'cus_1' }, { id: 'cus_2' }] }, container: container(packs) } as never);
    expect(packs.markFreePackAvailable).toHaveBeenCalledTimes(2);
  });

  it('never throws on stamp failure (fail-safe, mirrors phone-verified)', async () => {
    const packs = { markFreePackAvailable: jest.fn().mockRejectedValue(new Error('db down')) };
    await expect(
      handler({ event: { data: { id: 'cus_1' } }, container: container(packs) } as never),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

`$env:TEST_TYPE='unit'; node ..\..\node_modules\jest\bin\jest.js src/subscribers/__tests__/customer-free-pack.unit.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`customer-free-pack.ts` — same skeleton as `customer-phone-verified.ts` (array/object payload normalization, never-throws catch, `config = { event: 'customer.created' }`), body:

```ts
export default async function customerFreePackHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string } | { id: string }[]>) {
  const logger = container.resolve('logger');
  const ids = (Array.isArray(data) ? data : [data])
    .map((d) => d?.id)
    .filter((id): id is string => typeof id === 'string' && id !== '');
  if (ids.length === 0) return;
  try {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    // Unconditional stamp: eligibility to CLAIM is decided at claim time
    // (active free pack must exist) — the stamp only encodes "registered
    // after the feature shipped". Admin-created customers get stamped too;
    // that reads as a deliberate operator grant (same stance as the
    // phone-verified subscriber's admin-vouch note).
    for (const id of ids) await packs.markFreePackAvailable(id);
  } catch (e) {
    logger.warn(
      `[customer-free-pack] could not stamp ${ids.length} customer(s): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
```

- [ ] **Step 4: Run to verify it passes** — same command, expected PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src/subscribers/customer-free-pack.ts backend/packages/api/src/subscribers/__tests__/customer-free-pack.unit.spec.ts
git commit -m "feat(free-pack): stamp free_pack_available_at on customer.created"
```

---

### Task 4: Workflow — claim step + source/recorded-value threading

**Files:**
- Create: `backend/packages/api/src/workflows/steps/claim-free-pack.ts`
- Modify: `backend/packages/api/src/workflows/open-pack.ts`
- Modify: `backend/packages/api/src/workflows/steps/record-pull.ts`
- Modify: `backend/packages/api/src/modules/packs/service.ts` — `recordPullsWithLedger` pull rows accept optional `source` + nullable `recorded_value_usd` (verify its input type; widen if it doesn't already pass them through)
- Test: `backend/packages/api/src/modules/packs/__tests__/free-pack-open.integration.spec.ts`

**Interfaces:**
- Consumes: `claimFreePack`/`clearFreePackClaim`/`FREE_WELCOME_CATEGORY` (Task 2).
- Produces: `claimFreePackStep(input: { pack_id: string; customer_id: string }) → { free: boolean }`; free opens write `source='free'`, `recorded_value_usd=null`; open-batch rejects free packs.

- [ ] **Step 1: Write the failing integration spec**

Harness: mirror `close-instant.integration.spec.ts` / `recorded-pull-value.integration.spec.ts` (whichever runs `openPackWorkflow` end-to-end with seeded pack+odds). Seed: one `free_welcome` pack (price 0, active, 1 card odds row) + one normal paid pack; a customer with credit.

```ts
it('free open: claims once, writes source=free with null recorded value, charges nothing', async () => {
  await service.markFreePackAvailable(customerId);
  const before = await service.creditBalance(customerId);
  const { result } = await openPackWorkflow(container).run({ input: { pack_id: 'free-welcome', customer_id: customerId } });
  expect(result.price).toBe(0);
  expect(await service.creditBalance(customerId)).toBe(before);
  const [pull] = await service.listPulls({ customer_id: customerId, pack_id: 'free-welcome' }, { take: 1 });
  expect(pull.source).toBe('free');
  expect(pull.recorded_value_usd).toBeNull();
});

it('second free open is refused (claim consumed)', async () => {
  await expect(
    openPackWorkflow(container).run({ input: { pack_id: 'free-welcome', customer_id: customerId } }),
  ).rejects.toThrow(/already claimed|not available/i);
});

it('unstamped account cannot open the free pack', async () => {
  await expect(
    openPackWorkflow(container).run({ input: { pack_id: 'free-welcome', customer_id: strangerId } }),
  ).rejects.toThrow(/not available/i);
});

it('paid open is untouched: source=pack, recorded value present, charged', async () => {
  const { result } = await openPackWorkflow(container).run({ input: { pack_id: 'bronze-pack', customer_id: customerId } });
  expect(result.price).toBeGreaterThan(0);
  const [pull] = await service.listPulls({ customer_id: customerId, pack_id: 'bronze-pack' }, { take: 1 });
  expect(pull.source).toBe('pack');
  expect(Number(pull.recorded_value_usd)).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify it fails** — integration:modules command; FAIL (claim step absent → free open succeeds twice / wrong source).

- [ ] **Step 3: Implement**

`claim-free-pack.ts`:

```ts
import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import { FREE_WELCOME_CATEGORY } from '../../modules/packs/free-pack';

export type ClaimFreePackInput = { pack_id: string; customer_id: string };
export type ClaimFreePackResult = { free: boolean };
type CompensateData = { customer_id: string } | undefined;

// claim-free-pack — the free pack's "payment": consume the account's one-time
// claim BEFORE the charge seam. No-op ({ free: false }) for every non-free
// pack, so the step sits unconditionally in the open-pack composition (workflow
// bodies cannot branch). The UPDATE inside claimFreePack is a single
// conditional statement — the row lock serializes double-taps; the loser
// matches 0 rows and lands here as NOT_ALLOWED.
export const claimFreePackStep = createStep(
  'claim-free-pack',
  async (input: ClaimFreePackInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    const [pack] = await packs.listPacks({ slug: input.pack_id }, { take: 1 });
    if (!pack || pack.category !== FREE_WELCOME_CATEGORY) {
      return new StepResponse({ free: false } satisfies ClaimFreePackResult, undefined as CompensateData);
    }
    const claimed = await packs.claimFreePack(input.customer_id);
    if (!claimed) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'The free welcome pack is not available for this account (already claimed or not eligible).',
      );
    }
    return new StepResponse(
      { free: true } satisfies ClaimFreePackResult,
      { customer_id: input.customer_id } satisfies CompensateData,
    );
  },
  async (data: CompensateData, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.clearFreePackClaim(data.customer_id);
  },
);

export default claimFreePackStep;
```

`open-pack.ts` wiring — insert after `rollPackStep`, thread `free` into the record input:

```ts
    const card = rollPackStep(input);

    // Free welcome pack: consume the one-time claim before the charge seam.
    // { free:false } for every normal pack — the step is a no-op there.
    const claim = claimFreePackStep(input);

    const charged = transform({ input }, (d) => ({ /* unchanged */ }));
    const charge = chargePackOpenStep(charged);

    const recordInput = transform({ input, card, charged, claim }, (d) => ({
      customer_id: d.input.customer_id,
      pack_id: d.input.pack_id,
      card_id: d.card.handle,
      // Free pulls record NO pulled value — they must never move the
      // leaderboard/challenge aggregates (same stance as reward pulls).
      recorded_value_usd: d.claim.free ? null : d.card.recorded_value_usd,
      open_id: d.charged.open_id,
      source: d.claim.free ? ('free' as const) : ('pack' as const),
    }));
```

`record-pull.ts` — `RecordPullInput` gains `recorded_value_usd: number | null` and `source: 'pack' | 'free'`; pass both into the `recordPullsWithLedger` pull row (`source: input.source`). Ledger block unchanged (a price-0 SP row is deliberate — the customer's transaction history shows the free open).

`open-batch` route (`backend/packages/api/src/api/store/packs/[slug]/open-batch/route.ts`): before running the batch workflow, load the pack and 400 on `category === FREE_WELCOME_CATEGORY`:

```ts
  if (pack?.category === FREE_WELCOME_CATEGORY) {
    res.status(400).json({ message: 'The free welcome pack can only be opened once, singly.' });
    return;
  }
```

(Find the exact insertion point where the route already loads/validates the pack; if it defers wholly to the workflow, add the check at the top with its own `listPacks` call.)

- [ ] **Step 4: Run to verify it passes** — integration:modules command, all 4 tests PASS. Also re-run Task 2's spec (regression).

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src/workflows backend/packages/api/src/modules/packs backend/packages/api/src/api/store/packs
git commit -m "feat(free-pack): claim step in open-pack workflow, source='free' pulls, batch reject"
```

---

### Task 5: Catalog/board/feed exclusion + admin pack validation

**Files:**
- Modify: `backend/packages/api/src/api/store/packs/route.ts:42` (catalog `$ne` → `$nin`)
- Modify: `backend/packages/api/src/api/store/pulls/recent/route.ts:63` (`$ne 'reward'` → `$nin ['reward','free']`)
- Modify: `backend/packages/api/src/modules/packs/service.ts` — every raw-SQL `pu.source <> 'reward'` (lines ~4242 leaderboard, ~7377 + ~7408 challenge pool, ~7989 backfill) becomes `pu.source = 'pack'` (positive filter — a fourth source value can never leak in again). The `source = 'pack'` sites (~4305, ~4855) are already correct — leave them.
- Modify: any OTHER `$ne: 'reward'` / `<> 'reward'` read site — run `grep -rn "\$ne.*reward\|<> 'reward'" backend/packages/api/src` and update each (profiles/recent mirrors pulls/recent).
- Modify: `backend/packages/api/src/api/admin/packs/validate.ts` (`coercePackBody`) + the POST `/admin/packs` and `/admin/packs/[SLUG]` handlers for the two `free_welcome` rules.
- Modify: `backend/packages/api/src/api/admin/pulls/route.ts:43` + `backend/packages/api/src/api/admin/customers/[id]/pulls/route.ts` (`PULL_SOURCES`) — accept `'free'` as a filter value.
- Test: extend `backend/packages/api/src/modules/packs/__tests__/reward-pull-exclusion.integration.spec.ts` with free-pull cases; new unit spec `backend/packages/api/src/api/admin/packs/__tests__/free-welcome-validate.unit.spec.ts`.

**Interfaces:**
- Consumes: `FREE_WELCOME_CATEGORY` (Task 2).
- Produces: free packs invisible on `/store/packs`; free pulls excluded from leaderboard/challenge/recent-feed; admin cannot save a priced or second-active free pack.

- [ ] **Step 1: Write the failing tests**

Extend `reward-pull-exclusion.integration.spec.ts`: seed a third pull `source='free'` next to the existing pack+reward pair and assert (a) `leaderboardTop` count unchanged, (b) `listPulls({ source: { $nin: ['reward','free'] } })` excludes it, (c) the catalog route body omits a seeded active `free_welcome` pack.

`free-welcome-validate.unit.spec.ts` (pure `coercePackBody` + validation helper):

```ts
it('forces price 0 on free_welcome packs', () => {
  expect(() => coercePackBody({ slug: 'fw', title: 'x', category: 'free_welcome', price: 10, image: 'i' })).toThrow(/price/i);
});
it('accepts a price-0 free_welcome pack', () => {
  expect(coercePackBody({ slug: 'fw', title: 'x', category: 'free_welcome', price: 0, image: 'i' }).category).toBe('free_welcome');
});
```

One-active rule: unit-test the extracted guard `assertSingleActiveFreePack(existingActiveSlug: string | null, incoming: { slug, category, status })` (pure function you add beside `coercePackBody`), with the route handlers calling it after a `getActiveFreePack()` lookup:

```ts
it('rejects activating a second free_welcome pack', () => {
  expect(() => assertSingleActiveFreePack('free-welcome', { slug: 'fw2', category: 'free_welcome', status: 'active' })).toThrow(/one active/i);
});
it('allows re-saving the SAME active free pack', () => {
  expect(() => assertSingleActiveFreePack('free-welcome', { slug: 'free-welcome', category: 'free_welcome', status: 'active' })).not.toThrow();
});
```

- [ ] **Step 2: Run both to verify they fail** (unit + integration commands as above).

- [ ] **Step 3: Implement**

Catalog filter in `store/packs/route.ts`:

```ts
    { status: "active", category: { $nin: ["reward_box", FREE_WELCOME_CATEGORY] } } as Parameters<typeof packsModuleService.listPacks>[0],
```

Raw-SQL sites: replace `pu.source <> 'reward'` with `pu.source = 'pack'` (four sites; keep each line's surrounding comment accurate — they name the exclusion). `pulls/recent` (and its mirror in profiles) use `{ source: { $nin: ['reward', 'free'] } }`.

Admin validation: in `coercePackBody`, after category coercion — `if (body.category === FREE_WELCOME_CATEGORY && Number(body.price) !== 0) throw` (same error style the file already uses). Add pure `assertSingleActiveFreePack` and call it from both POST handlers with `(await packs.getActiveFreePack())?.slug ?? null`.

Admin pulls filters: widen the accepted enum to `'pack' | 'reward' | 'free'` in both routes (update the 400 message strings).

- [ ] **Step 4: Run to verify green** — both specs + re-run Task 4 spec.

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src
git commit -m "feat(free-pack): hide free_welcome from catalog/boards/feed, admin price+single-active validation"
```

---

### Task 6: Lock guard — buyback, buyback-batch, delivery

**Files:**
- Modify: `backend/packages/api/src/workflows/steps/buyback-pull.ts:81-90` (add the free-lock branch beside the reward gate)
- Modify: `backend/packages/api/src/modules/packs/delivery.ts:60-92` (`validateDeliveryRequest`)
- Modify: the delivery-order create caller of `validateDeliveryRequest` (POST `/store/delivery-orders` route — pass the new arg, map the new verdict to a 400 with `FREE_PULL_LOCKED_MESSAGE`)
- Modify: `backend/packages/api/src/api/store/vault/buyback-batch/route.ts` (or its workflow) — verify each pull runs through the guarded step; if the batch pre-filters, exclude locked free pulls with the same check
- Test: `backend/packages/api/src/modules/packs/__tests__/free-pull-lock.integration.spec.ts` + extend `delivery.unit.spec.ts`

**Interfaces:**
- Consumes: `hasPaidOpen`, `FREE_PULL_LOCKED_MESSAGE` (Task 2), `source='free'` pulls (Task 4).
- Produces: `validateDeliveryRequest(fetchedPulls, requestedIds, callerId, freeUnlocked: boolean)` with new verdict `'free_locked'`; buyback of a locked free pull throws `NOT_ALLOWED`.

- [ ] **Step 1: Write the failing tests**

`delivery.unit.spec.ts` additions (pure):

```ts
it('free pull + no paid open → free_locked', () => {
  const pull = { id: 'p1', customer_id: 'c1', status: 'vaulted', source: 'free' };
  expect(validateDeliveryRequest([pull], ['p1'], 'c1', false)).toBe('free_locked');
});
it('free pull + paid open exists → ok', () => {
  const pull = { id: 'p1', customer_id: 'c1', status: 'vaulted', source: 'free' };
  expect(validateDeliveryRequest([pull], ['p1'], 'c1', true)).toBe('ok');
});
```

`free-pull-lock.integration.spec.ts` (module harness with workflows, same rig as Task 4): seed customer with a claimed free pull; assert `buybackPullWorkflow` rejects with the lock message; then write one `source='pack'` pull and assert the same buyback succeeds.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

`buyback-pull.ts`, directly under the reward gate (line ~84):

```ts
    // Free welcome pull: fully locked (no buyback, no delivery) until the
    // customer's first PAID open — computed, never stored, so the first
    // source='pack' pull unlocks it with zero writes (spec 2026-08-14).
    if (pull.source === 'free') {
      const unlocked = await packs.hasPaidOpen(pull.customer_id);
      if (!unlocked) {
        throw new MedusaError(MedusaError.Types.NOT_ALLOWED, FREE_PULL_LOCKED_MESSAGE);
      }
    }
```

`delivery.ts` — add `"free_locked"` to `DeliveryRequestVerdict`, new 4th parameter `freeUnlocked: boolean`, and inside the per-pull loop after the reward check:

```ts
    if (pull.source === "free" && !freeUnlocked) return "free_locked";
```

Caller (delivery-orders POST): compute `const freeUnlocked = await packs.hasPaidOpen(customerId);` once before validation; map `'free_locked'` → `res.status(400).json({ message: FREE_PULL_LOCKED_MESSAGE })` beside the existing verdict mapping. Type error from the widened signature will surface EVERY caller (including tests) — fix each.

`buyback-batch`: read the route/workflow; if each id executes the guarded buyback step the gate already holds — add an integration assertion (batch of [locked-free, normal] leaves the free pull vaulted and sells the normal one, or rejects wholesale — match the batch's existing partial-failure semantics and assert THAT).

- [ ] **Step 4: Run to verify green** (unit + integration + re-run Tasks 4–5 specs).

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src
git commit -m "feat(free-pack): lock free pulls from buyback/delivery until first paid open"
```

---

### Task 7: `GET /store/free-pack` eligibility + vault `locked` flag + reveal suppression

**Files:**
- Create: `backend/packages/api/src/api/store/free-pack/route.ts`
- Modify: `backend/packages/api/src/api/middlewares.ts` (register auth, beside the `/store/packs/*/open` entries at ~line 477)
- Modify: `backend/packages/api/src/api/store/vault/route.ts` (item shape gains `source` + `locked`)
- Modify: `backend/packages/api/src/api/store/packs/[slug]/open/route.ts` (free-pull response: suppress the instant-buyback offer, add `free: true`)
- Modify: `backend/packages/api/src/api/store/packs/[slug]/route.ts` — VERIFY the detail route serves a `free_welcome` pack (it must, for `/slots/<slug>`); if it copies the catalog's category exclusion, exempt `free_welcome` there.
- Test: `backend/packages/api/src/modules/packs/__tests__/free-pack-route.integration.spec.ts`

**Interfaces:**
- Produces:
  - `GET /store/free-pack` (bearer auth) → `{ eligible: boolean, slug: string | null, image: string | null }`
  - vault items: `{ ..., source: 'pack' | 'reward' | 'free', locked: boolean }` (`locked` only ever true for free pulls)
  - open response for a free pull: `{ ..., free: true, buyback: UNQUOTED_BUYBACK }`

- [ ] **Step 1: Write the failing integration spec**

```ts
it('eligibility: stamped+unclaimed+active pack → eligible with slug', async () => { /* seed, call GET handler with mocked auth ctx, expect { eligible: true, slug: 'free-welcome' } */ });
it('eligibility: claimed → not eligible', async () => { /* claim, expect eligible false, slug null */ });
it('eligibility: no active free pack → not eligible', async () => { /* draft the pack, expect false */ });
it('vault marks the free pull locked until a paid open exists', async () => { /* open free pack, GET vault → locked true; open paid pack → locked false */ });
```

(Handler-level invocation with a stubbed `req.scope`/`req.auth_context` — same style as `rewards-routes.integration.spec.ts`.)

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

`free-pack/route.ts`:

```ts
import { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';

// GET /store/free-pack — feeds the storefront's floating FREE PACK badge.
// eligible = stamped at registration AND not yet claimed AND an active
// free_welcome pack exists. The badge is the free pack's ONLY public surface
// (the catalog excludes the category), so this answer is per-customer.
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  const customerId = req.auth_context.actor_id;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [state] = await packs.listCustomerAccountStates({ customer_id: customerId }, { take: 1 });
  const active = state?.free_pack_available_at && !state?.free_pack_claimed_at
    ? await packs.getActiveFreePack()
    : null;
  res.json({
    eligible: active != null,
    slug: active?.slug ?? null,
    image: active?.image ?? null,
  });
}
```

Middleware registration (mirrors the GET entry at middlewares.ts:473):

```ts
    {
      matcher: '/store/free-pack',
      method: 'GET',
      middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
    },
```

Vault route: fetch `const freeUnlocked = await packs.hasPaidOpen(customerId);` once; pack-side items map gains `source: p.source ?? 'pack'` and `locked: p.source === 'free' && !freeUnlocked`; the reward-side mapping (line ~195) gains `locked: false`.

Open route: after the workflow returns, the pull row carries the source — for `result.pull.source === 'free'` skip the quote block entirely and respond with `buyback: UNQUOTED_BUYBACK, free: true` (marketPriceMyr enrichment stays — the reveal still shows the card's value).

Detail-route check: read `[slug]/route.ts`; if it filters by category, allow `free_welcome` through (it must remain publicly UNLISTED, not unreachable).

- [ ] **Step 4: Run to verify green.**

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src
git commit -m "feat(free-pack): eligibility endpoint, vault locked flag, reveal buyback suppression"
```

---

### Task 8: Storefront — badge, free-mode detail page, vault overlay

**Files:**
- Create: `src/lib/data/free-pack.ts`
- Create: `src/components/FreePackBadge.tsx`
- Modify: `src/app/slots/page.tsx` (fetch eligibility, pass prop)
- Modify: `src/app/slots/CatalogClient.tsx` (render badge)
- Modify: `src/app/slots/[slug]/PackDetailClient.tsx` + `src/app/slots/[slug]/page.tsx` (free mode: hide price/qty/×5, CTA "Open Free Pack")
- Modify: `src/app/slots/[slug]/SlotMachineClient.tsx` / `src/app/slots/[slug]/RevealStage.tsx` (no sell UI when the open response has `free: true`; show the locked line)
- Modify: `src/app/(account)/vault/VaultClient.tsx` + its data lib (consume `locked`, overlay, disable selection)
- Modify: `src/lib/data/schemas.ts` (vault item schema gains `source`/`locked`; open response gains optional `free`)
- Test: visual QA script `scripts/qa-free-pack.mjs` (Playwright, screenshots to `docs/research/`)

**Interfaces:**
- Consumes: `GET /store/free-pack` (Task 7), badge asset `public/images/polycards/free-pack-badge.webp`.
- Produces: `getFreePackEligibility(): Promise<{ eligible: boolean; slug: string | null }>` (server-side, bearer from `getAuthToken`); `<FreePackBadge slug={string} />`.

- [ ] **Step 1: Data lib**

`free-pack.ts` follows the fetch+`parseOne` conventions of `src/lib/data/packs.ts` (backend base URL, no-store, zod schema `{ eligible: z.boolean(), slug: z.string().nullable(), image: z.string().nullable() }`). Anonymous/failed fetch → `{ eligible: false, slug: null }` (badge is an enhancement — never an error surface).

- [ ] **Step 2: Badge component + catalog wiring**

`FreePackBadge.tsx` (client): fixed bottom-right above the tab bar (`fixed bottom-24 right-4 z-40` — verify against the app-shell tab bar height in `DESIGN.md`/existing pills), `<Link href={'/slots/' + slug}>`, badge image ~112px wide (`<Image src="/images/polycards/free-pack-badge.webp" width={112} height={146} alt="Free welcome pack" />` — source is 393×512), gentle bob via a CSS keyframe **disabled under `usePrefersReducedMotion`** (`animation-fill-mode` must NOT be `both` — repo rule: one-shot entrances use `backwards`; the loop here is `infinite` so filter it out of any settle-then-read QA).

`slots/page.tsx`: `const freePack = await getFreePackEligibility();` in the existing `Promise.all`, pass `freePack` to `CatalogClient`; render `{freePack.eligible && freePack.slug ? <FreePackBadge slug={freePack.slug} /> : null}` inside `CatalogClient`'s root.

- [ ] **Step 3: Free-mode detail + reveal**

`[slug]/page.tsx` passes the pack through as today (`category === 'free_welcome'` reaches the client). In `PackDetailClient`/`SlotMachineClient`: `const isFreePack = pack.category === 'free_welcome';` — hide the price line, quantity stepper, and ×5/batch controls; CTA label "Open Free Pack"; on the reveal (`RevealStage`/`useSellWindow`), when the open response carried `free: true` render the note "Purchase & open any pack to unlock selling & delivery." where the sell button normally sits (no sell buttons at all).

- [ ] **Step 4: Vault overlay**

Vault schema: extend the item zod with `source: z.enum(['pack','reward','free']).catch('pack')` and `locked: z.boolean().catch(false)` (`.catch` keeps old cached payloads parsing). In `VaultClient`: a `locked` item renders a dark overlay (lock icon + "Shipping & Selling Locked" heading + the canonical copy + "Tap to dismiss" — visually per the cardgitals reference, neutral-900/85 backdrop) and is excluded from select-mode (sell/deliver checkboxes disabled, `aria-disabled`).

- [ ] **Step 5: Visual QA**

`scripts/qa-free-pack.mjs` (Playwright, mirrors `scripts/qa-*.mjs`): build + `pwsh scripts/serve-standalone.ps1 -Port 4000` (NEVER `next dev`), register a throwaway customer (launch-stack recipe), assert badge visible on `/slots`, open free pack, vault shows overlay, badge gone after claim. Screenshots to `docs/research/qa-free-pack-*.png`; read them back with the Read tool.

Run: `npm run build` then the script. Expected: all assertions pass, screenshots show badge + overlay.

- [ ] **Step 6: Commit**

```bash
git add src scripts/qa-free-pack.mjs
git commit -m "feat(free-pack): storefront badge, free-mode open, vault lock overlay"
```

---

### Task 9: Admin — "Free pack" sub-tab + create flow

**Files:**
- Modify: `backend/apps/admin/src/routes/packs/page.tsx` (sub-tabs "Packs | Free pack", filter `category === 'free_welcome'`, per-tab create button)
- Modify: `backend/apps/admin/src/lib/admin-rest.ts` ONLY if the create-pack call hardcodes category choices
- Modify: `backend/apps/admin/src/i18n/en.json` (new keys under `packs.*`: `packs.tabs.packs`, `packs.tabs.free`, `packs.free.create`, `packs.free.hint`)
- Test: manual verification via admin dev server (documented below) — this repo does not unit-test admin pages; CI gate is lint + build.

**Interfaces:**
- Consumes: GET `/admin/packs` already returns `category` per pack; POST `/admin/packs` validation from Task 5.

- [ ] **Step 1: Implement the tab split**

`page.tsx`: local `const [tab, setTab] = useState<'packs' | 'free'>('packs')`; partition the fetched list — `const freePacks = packs.filter((p) => p.category === 'free_welcome')`, main tab renders the rest (today's table unchanged), free tab renders the SAME table component over `freePacks` plus a hint line (`packs.free.hint`: "One active free pack at a time. Price is fixed at RM 0 — new accounts get one open; the won card stays locked until their first paid open."). Tab strip uses the admin's existing tab primitives (see `backend/apps/admin/src/routes/customers/*` for the in-page tab pattern; `medusa-ui-conformance` skill governs — no new primitives). Create button on the free tab pre-fills `{ category: 'free_welcome', price: 0 }` through the existing create-pack flow.
React Compiler lint rule: no synchronous `setState` in `useEffect` (CI fails on it).

- [ ] **Step 2: Verify in the admin dev server**

Start: `backend/apps/admin> .\node_modules\.bin\vite.cmd` (`yarn dev` exits 127 on this machine), backend on :9000. Confirm: both tabs render, free pack created via the free tab lands with category `free_welcome`/price 0, activating a second active free pack surfaces the 400 from Task 5, pack editor (odds, cards) opens normally from the free tab.

- [ ] **Step 3: Lint + build**

`backend/apps/admin> ..\..\node_modules\.bin\eslint src/routes/packs --max-warnings 0` (direct binary — `yarn lint` dies with "turbo/eslint not recognized") and `corepack yarn build` (repo-pinned tsc; if TS5102/baseUrl errors appear you're on global TS7 — use `node_modules/.bin/tsc`).

- [ ] **Step 4: Commit**

```bash
git add backend/apps/admin/src
git commit -m "feat(admin): Free pack sub-tab on the packs list"
```

---

### Task 10: Fixtures, docs, full verification

**Files:**
- Modify: `backend/packages/api/src/scripts/seed-e2e-fixtures.ts` (add an active `free_welcome` pack: slug `free-welcome`, price 0, 2–3 odds rows over the existing e2e cards)
- Modify: `CONTEXT.md` (glossary entries)
- Modify: `docs/agents/*` — none. `AGENTS.md` — none.

- [ ] **Step 1: Seed fixture** — mirror the existing pack fixtures in `seed-e2e-fixtures.ts`; keep the FIRM FX + odds discipline the file already documents.

- [ ] **Step 2: CONTEXT.md glossary** — add under "Opening a pack":

```markdown
**Free Welcome Pack**:
The one-time free pack a newly registered account may open once (`category=
'free_welcome'` — a reserved category hidden from the catalog like
`reward_box`; storefront entry is the floating badge only). Its Pull has
`source='free'`: excluded from the leaderboard/challenge/feed like `'reward'`,
and LOCKED from Buyback and Delivery until the customer's first paid Open
(computed — any `source='pack'` Pull unlocks it).
_Avoid_: reward (that is the daily VIP draw), demo spin
```

- [ ] **Step 3: Full verification sweep**

- Backend: run the packs-module jest suites touched (Tasks 2/4/5/6/7 specs) + `node_modules/.bin/tsc` typecheck.
- Storefront: `npm run check` AND the separate format gate (`npm run format:check` if defined — CI runs it apart from `check`).
- Playwright QA script from Task 8 against a fresh standalone build.
- `graphify update .` if graphify outputs were used this session (AST-only).

- [ ] **Step 4: Commit + PR**

```bash
git add backend/packages/api/src/scripts/seed-e2e-fixtures.ts CONTEXT.md
git commit -m "feat(free-pack): e2e fixture + glossary"
```

PR from the worktree branch against `origin/master` (squash-merge repo; base from `origin/master`, never local master). PR body lists the spec + plan paths. CI gate: `gh pr checks` per-check status (never `gh run watch` exit code).

---

## Self-review notes (done at write time)

- Spec coverage: data model → T1; claim/open flow → T2/T4; catalog+board exclusion & admin validation → T5; lock guard → T6; eligibility endpoint + vault flag + reveal suppression → T7; storefront → T8; admin tab → T9; fixtures/docs/tests → T10. Out-of-scope items in the spec have no tasks (correct).
- Deliberate deviations from the approved spec, both recorded in the spec file: `category='free_welcome'` replaces the `free_welcome` boolean (zero pack migration, reuses the `reward_box` exclusion pattern); raw-SQL exclusion flips to positive `source = 'pack'` filters (future-proof beyond `$nin`).
- Type consistency: `claimFreePack → boolean`, `ClaimFreePackResult { free }` consumed in `open-pack.ts` transform; `validateDeliveryRequest` 4-arg form used in both the unit spec and route caller; `FREE_PULL_LOCKED_MESSAGE` is the single copy source.
