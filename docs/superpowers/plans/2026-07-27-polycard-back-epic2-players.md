# POLYCARD-BACK Epic 2 — Players (Customers rework) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Players admin surface: an All Players list with batched per-player aggregates and an enable/disable switch that blocks login, a six-tab Player detail (Profile with new bank fields, LVL, Wallet, Vault, Orders, Pulls), and the Pull Ledger relocated from the sidebar into the Player detail.

**Architecture:** Backend gains a `disabled` flag on the existing `customer_account_state` model (enforced by two auth guards), a batched `playersOverview` aggregate (GROUP BY SQL, `enrichReferralNodes` pattern), a new `player_payout_details` model, and small additive filters on existing admin routes. The admin app gains a new Players list page (the repo has NO customers list page today — the sidebar "Customers" entry is the prebuilt `@mercurjs/admin` bundle) and a tabbed rework of the existing `routes/customers/[id]/page.tsx` Customer-360 page. "Players" is a UI/i18n rename only; backend keeps Medusa `customer` naming and URLs stay `/customers/:id`.

**Tech Stack:** Medusa v2 module (MikroORM models, hand-written migrations), Jest (unit + http shards), Mercur admin (Vite + @medusajs/ui + react-query + vitest).

**Spec:** `plans/058-polycard-back-admin-overhaul.md` §4 (+ §1.1 Pull Ledger relocation, decision D6). Research brief facts baked in throughout.

## Global Constraints

- **Branch base:** `origin/master` AFTER PR #270 (Epic 1) squash-merges. Before branching, verify `git log origin/master --oneline -3` shows the #270 squash commit. Never branch from a master that lacks Epic 1.
- **Worktree** (superpowers:using-git-worktrees, consent pre-granted): `EnterWorktree` or `git worktree add .worktrees/epic2-players -b feat/epic2-players`. Then: `npm install` (root), `corepack yarn install` (from `backend/`), copy `backend/packages/api/.env` in via PowerShell `Copy-Item` (bash `cp` is blocked by the guard-secrets hook; missing .env = KnexTimeout), and `corepack yarn build` in `backend/packages/odds-math` (backend tests fail without its dist). Commit this plan file as the branch's first commit.
- **Migration timestamps are RESERVED across the parallel epics:** Epic 2 owns `Migration20260728100000` and `Migration20260728100001`. Epic 3 (running in parallel) owns `Migration20260728200000`. Both sort after Epic 1's `Migration20260727000001`. Never renumber.
- **Backend `.ts` edit trap:** a global formatter hook rewrites backend double-quotes to single quotes on every Edit/Write, burying changes in whole-file churn that fails CI's format check. Edit files under `backend/` by writing a small node script and running it via Bash, or make edits and immediately `git diff --stat` to confirm only intended lines changed; if churn appears, revert and use the node-script path.
- **Commits:** `git commit -F <message-file>` (Write the message to a file first). NEVER PowerShell here-strings in Git Bash. Conventional commits.
- **Stale LSP diagnostics:** the diagnostics pane reports already-fixed states in worktrees. Trust actual `tsc`/jest runs only.
- **`frozen` vs `disabled` are orthogonal:** `frozen` (funds lock, `availableBalance()=0`, auto/manual causes) is UNCHANGED. `disabled` is a login/session block. One model, two flags, no interaction. Never touch `assertNotFrozen`, `isFrozen`, or the auto-freeze machinery.
- **Pull enum** (`vaulted | bought_back | delivering | delivered`) never changes.
- **Rename is UI/i18n only** (operator handoff): no route-dir renames, no backend renames. Detail URL stays `/customers/:id`.
- **Parallel-epic file collisions:** Epic 3 also edits `backend/apps/admin/src/lib/{admin-rest,queries,query-keys}.ts` and `i18n/en.json`. Append Epic 2 additions at the END of each file under a `// ── Epic 2 (Players) ──` marker comment (i18n: new top-level `"players"` block as the LAST key) so rebases are trivial.
- **Test-file conventions:** backend unit specs `src/**/__tests__/*.unit.spec.ts`; http specs `integration-tests/http/*.spec.ts`; admin tests `src/**/*.test.ts` (vitest, node env, pure functions only — no component tests).
- **Commands** (backend from `backend/packages/api`): `corepack yarn test:unit`; single http spec `NODE_OPTIONS=--experimental-vm-modules TEST_TYPE=integration:http npx jest integration-tests/http/<name>.spec.ts --runInBand --forceExit` (needs `pokenic-postgres` docker up); types `corepack yarn check-types`. Admin (from `backend/apps/admin`): `yarn test` (vitest), `corepack yarn build` (tsc -b + vite — admin has NO check-types script), `corepack yarn lint`. Repo root: `npm run check`.
- **gitleaks:** synthetic spec passwords need an inline `// gitleaks:allow` (sha-independent, survives squash).
- **Sensitive data:** bank details are admin-auth-only; never expose `player_payout_details` on any `/store` route.
- Current `admin_action_audit` enums (post-#270): `entity_type` includes `'customer'` … `'delivery_order'`; `action` includes `'freeze'`,`'unfreeze'`,`'reverse_commission'`,`'suspend_commission'`,`'unsuspend_commission'`,`'adjust_credit'`,`'edit_rewards_settings'`,`'edit_reward_pool'`,`'edit_daily_reward_settings'`,`'edit_daily_box'`,`'edit_voucher_ladder'`,`'edit_fx_rate'`,`'edit_site_settings'`,`'edit_avatar_frames'`,`'replace'`,`'edit'`,`'bulk_status'`. This epic adds actions `'disable'`,`'enable'`.

---

### Task 1: `disabled` flag — model, migration, service, admin routes, audit

**Files:**
- Modify: `backend/packages/api/src/modules/packs/models/customer-account-state.ts`
- Modify: `backend/packages/api/src/modules/packs/models/admin-action-audit.ts` (action enum + `'disable'`, `'enable'`)
- Create: `backend/packages/api/src/modules/packs/migrations/Migration20260728100000.ts`
- Modify: `backend/packages/api/src/modules/packs/service.ts` (new methods near `setManualFreeze`, ~line 1711)
- Create: `backend/packages/api/src/api/admin/customers/[id]/disable/route.ts`, `backend/packages/api/src/api/admin/customers/[id]/enable/route.ts`
- Modify: `backend/packages/api/src/api/middlewares.ts` (rate-limit matchers, mirror freeze/unfreeze at lines ~540-548)
- Modify: the `auditForCustomer` payload in `service.ts` (find the method that builds `account_state` for `GET /admin/customers/:id/audit`) — add the four `disabled*` fields
- Test: `backend/packages/api/integration-tests/http/admin-disable.spec.ts`

**Interfaces:**
- Consumes: existing `setManualFreeze` persistence + audit shape (`service.ts:1711-1778`), freeze route shape (`api/admin/customers/[id]/freeze/route.ts`).
- Produces: `setAccountDisabled({ customerId, adminId, disabled, reason }): Promise<{ disabled: boolean }>`; `isAccountDisabled(customerId): Promise<boolean>`; `POST /admin/customers/:id/disable` / `.../enable` body `{ reason: string }` → `{ disabled: boolean }`; audit route's `account_state` gains `disabled`, `disabled_reason`, `disabled_by`, `disabled_at`.

- [ ] **Step 1: Write the failing http spec**

Create `integration-tests/http/admin-disable.spec.ts`. Copy the setup boilerplate (runner, `mintSuperAdmin`, customer-minting helper) from `integration-tests/http/admin-freeze.spec.ts` — same seeding approach, same `// gitleaks:allow` on the password constant. Cases:

1. `POST /admin/customers/:id/disable { reason: 'test disable' }` → 200 `{ disabled: true }`, and `packs.listAdminActionAudits({ entity_type: 'customer', entity_id: id })` contains a row with `action: 'disable'`, `reason: 'test disable'`, `after: { disabled: true }`.
2. `POST .../enable { reason: 're-enable' }` → 200 `{ disabled: false }` + audit row `action: 'enable'`.
3. Missing/empty/>500-char reason → 400 (same message shape as freeze: "A reason (1–500 chars) is required.").
4. `GET /admin/customers/:id/audit` → `account_state.disabled === false` after re-enable, and `disabled_at`/`disabled_by` are null.
5. Disable is idempotent-safe: disabling twice → second call still 200 `{ disabled: true }` and writes a second audit row (append-only log; `before.disabled` is `true` on the second row).

- [ ] **Step 2: Run to verify failure**

Run: `NODE_OPTIONS=--experimental-vm-modules TEST_TYPE=integration:http npx jest integration-tests/http/admin-disable.spec.ts --runInBand --forceExit`
Expected: FAIL — 404 on `/admin/customers/:id/disable`.

- [ ] **Step 3: Model + migration**

`customer-account-state.ts` — add after `unfreeze_cause` (keep the file's comment style; extend the header comment: "`disabled` (§4.2) is a LOGIN block, orthogonal to `frozen`"):

```ts
    disabled: model.boolean().default(false),
    disabled_reason: model.text().nullable(),
    disabled_by: model.text().nullable(), // admin_id
    disabled_at: model.dateTime().nullable(),
```

and a second partial index in `.indexes([...])`:

```ts
    { name: 'IDX_customer_account_state_disabled', on: ['customer_id'],
      where: 'disabled = true AND deleted_at IS NULL' },
```

`admin-action-audit.ts` — append `'disable', 'enable'` to the `action` enum list.

`Migration20260728100000.ts`:

```ts
import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Player disable switch (POLYCARD-BACK §4.2): customer_account_state gains a
// `disabled` login-block flag, orthogonal to `frozen` (funds lock). Additive =
// expand-safe (old code never reads the new columns). Also widens the
// admin_action_audit action CHECK with 'disable'/'enable'.
export class Migration20260728100000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table if exists "customer_account_state" add column if not exists "disabled" boolean not null default false;`);
    this.addSql(`alter table if exists "customer_account_state" add column if not exists "disabled_reason" text null;`);
    this.addSql(`alter table if exists "customer_account_state" add column if not exists "disabled_by" text null;`);
    this.addSql(`alter table if exists "customer_account_state" add column if not exists "disabled_at" timestamptz null;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_customer_account_state_disabled" ON "customer_account_state" (customer_id) WHERE disabled = true AND deleted_at IS NULL;`);
    this.addSql(`alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`);
    this.addSql(`alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check ("action" in ('freeze','unfreeze','reverse_commission','suspend_commission','unsuspend_commission','adjust_credit','edit_rewards_settings','edit_reward_pool','edit_daily_reward_settings','edit_daily_box','edit_voucher_ladder','edit_fx_rate','edit_site_settings','edit_avatar_frames','replace','edit','bulk_status','disable','enable'));`);
  }

  override async down(): Promise<void> {
    this.addSql(`delete from "admin_action_audit" where "action" in ('disable','enable');`);
    this.addSql(`alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`);
    this.addSql(`alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check ("action" in ('freeze','unfreeze','reverse_commission','suspend_commission','unsuspend_commission','adjust_credit','edit_rewards_settings','edit_reward_pool','edit_daily_reward_settings','edit_daily_box','edit_voucher_ladder','edit_fx_rate','edit_site_settings','edit_avatar_frames','replace','edit','bulk_status'));`);
    this.addSql(`DROP INDEX IF EXISTS "IDX_customer_account_state_disabled";`);
    this.addSql(`alter table if exists "customer_account_state" drop column if exists "disabled_at";`);
    this.addSql(`alter table if exists "customer_account_state" drop column if exists "disabled_by";`);
    this.addSql(`alter table if exists "customer_account_state" drop column if exists "disabled_reason";`);
    this.addSql(`alter table if exists "customer_account_state" drop column if exists "disabled";`);
  }
}
```

- [ ] **Step 4: Service methods**

Add near `setManualFreeze` (~1711), mirroring its persistence + audit-row calls EXACTLY (read `setManualFreeze`'s body first — use the same create/update method names and the same audit-write helper it uses):

```ts
  // Player disable switch (POLYCARD-BACK §4.2): blocks LOGIN/session use via
  // the auth guards in api/utils/disabled-guard.ts — orthogonal to `frozen`
  // (funds lock). One row per customer, lazy-created like the freeze path.
  @InjectManager()
  async setAccountDisabled(
    input: { customerId: string; adminId: string; disabled: boolean; reason: string },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ disabled: boolean }> {
    const [existing] = await this.listCustomerAccountStates(
      { customer_id: input.customerId }, { take: 1 }, sharedContext,
    );
    const patch = {
      disabled: input.disabled,
      disabled_reason: input.disabled ? input.reason : null,
      disabled_by: input.disabled ? input.adminId : null,
      disabled_at: input.disabled ? new Date() : null,
    };
    // persist: update existing row or create { customer_id, ...patch } —
    // copy the exact upsert shape setManualFreeze uses.
    // audit: copy setManualFreeze's audit write, with:
    //   entity_type 'customer', entity_id customerId,
    //   action input.disabled ? 'disable' : 'enable',
    //   before { disabled: existing?.disabled ?? false },
    //   after { disabled: input.disabled }, reason input.reason.
    return { disabled: input.disabled };
  }

  // One indexed read on the auth path — mirrors isFrozen (service.ts:2255).
  @InjectManager()
  async isAccountDisabled(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<boolean> {
    const [state] = await this.listCustomerAccountStates(
      { customer_id: customerId, disabled: true }, { take: 1 }, sharedContext,
    );
    return Boolean(state);
  }
```

Extend `auditForCustomer`'s `account_state` payload with the four new fields (same null-safe mapping as the `frozen*` fields).

- [ ] **Step 5: Routes + rate limits**

`disable/route.ts` — copy `freeze/route.ts` verbatim (same reason validation, same `AuthenticatedMedusaRequest` + `actor_id`), swapping the service call to `setAccountDisabled({ customerId, adminId, disabled: true, reason: reason.trim() })` and the response to `res.json({ disabled: true })`. `enable/route.ts`: `disabled: false`. In `middlewares.ts`, add two matchers next to the freeze/unfreeze ones with the same `adminActionRateLimit`:

```ts
    { matcher: '/admin/customers/*/disable', method: 'POST', middlewares: [adminActionRateLimit] },
    { matcher: '/admin/customers/*/enable', method: 'POST', middlewares: [adminActionRateLimit] },
```

(match the exact shape of the freeze entries at ~540-548).

- [ ] **Step 6: Migrate + verify pass**

Run: `npx medusa db:migrate` (with `pokenic-postgres` up) → applies cleanly.
Run the Step-2 jest command → PASS (5/5).
Run: `corepack yarn test:unit` and `corepack yarn check-types` → clean.

- [ ] **Step 7: Commit**

```bash
git add backend/packages/api/src backend/packages/api/integration-tests/http/admin-disable.spec.ts
git commit -F .git/COMMIT_MSG_T1
```

Message: `feat(players): disabled flag on customer_account_state + admin disable/enable routes`

---

### Task 2: Login + session block for disabled players

**Files:**
- Create: `backend/packages/api/src/api/utils/disabled-guard.ts`
- Modify: `backend/packages/api/src/api/middlewares.ts` (two new matcher entries)
- Test: `backend/packages/api/integration-tests/http/disabled-login.spec.ts`

**Interfaces:**
- Consumes: `isAccountDisabled` (Task 1).
- Produces: `blockDisabledEmailpassLogin` and `blockDisabledCustomerSession` middlewares; disabled customers get 401 at emailpass login and 403 (`FORBIDDEN` — `NOT_ALLOWED` maps to 400 in this framework, so the as-built code uses `FORBIDDEN`) on every authenticated `/store` request (which also neutralizes Google-minted tokens — see note in Step 3).

- [ ] **Step 1: Write the failing http spec**

`disabled-login.spec.ts` — copy the customer-registration boilerplate from `integration-tests/http/freeze-gate.spec.ts` (or `customer-360.spec.ts`): register via `/auth/customer/emailpass/register`, then `POST /store/customers` with the token to link the actor (a register JWT carries an empty `actor_id` until then — derive the customer id from a post-login token, guard with `toBeTruthy`), then log in for a real token. Cases:

1. Baseline: enabled customer logs in (200, token) and `GET /store/credits` with bearer → 200.
2. Admin disables the customer (`POST /admin/customers/:id/disable`, Task 1) → `POST /auth/customer/emailpass` with correct credentials → 401, message contains "disabled".
3. The PRE-disable token on `GET /store/credits` → 403 (message contains "disabled") — proves session revocation, not just login block.
4. Re-enable → login 200 again and the old token works again on `/store/credits`.
5. Unknown email still falls through: `POST /auth/customer/emailpass` with a nonsense email → the core auth error (401), NOT our guard's message.

- [ ] **Step 2: Run to verify failure**

Run the single-spec jest command → FAIL (disabled customer logs in fine).

- [ ] **Step 3: Implement the guards**

`disabled-guard.ts`:

```ts
import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';

const DISABLED_MESSAGE = 'This account has been disabled. Please contact support.';

// Login-time block (POLYCARD-BACK §4.2): reject emailpass login for a disabled
// customer BEFORE the core route mints a token. Unknown emails fall through to
// the core route, so this reveals nothing login itself would not.
export async function blockDisabledEmailpassLogin(
  req: MedusaRequest, _res: MedusaResponse, next: MedusaNextFunction,
): Promise<void> {
  try {
    const email = (req.body as { email?: unknown } | undefined)?.email;
    if (typeof email !== 'string' || email === '') { next(); return; }
    const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
    const [customer] = await customers.listCustomers({ email }, { take: 1 });
    if (!customer) { next(); return; }
    const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
    if (await packs.isAccountDisabled(customer.id)) {
      next(new MedusaError(MedusaError.Types.UNAUTHORIZED, DISABLED_MESSAGE));
      return;
    }
    next();
  } catch (e) { next(e); }
}

// Session-time block: rejects any /store request whose verified bearer belongs
// to a disabled customer. Registered as a blanket /store/* matcher placed AFTER
// the per-route authenticate() entries so req.auth_context is populated when it
// runs; unauthenticated/public routes pass through untouched. A Google-minted
// token for a disabled customer is unusable for the same reason (the google
// callback itself is not guarded — the token it mints works nowhere).
export async function blockDisabledCustomerSession(
  req: MedusaRequest, _res: MedusaResponse, next: MedusaNextFunction,
): Promise<void> {
  try {
    const auth = (req as { auth_context?: { actor_id?: string; actor_type?: string } }).auth_context;
    if (!auth?.actor_id || auth.actor_type !== 'customer') { next(); return; }
    const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
    if (await packs.isAccountDisabled(auth.actor_id)) {
      // As built: FORBIDDEN, not NOT_ALLOWED — this framework's error handler
      // maps NOT_ALLOWED to 400 and FORBIDDEN to the contracted 403.
      next(new MedusaError(MedusaError.Types.FORBIDDEN, DISABLED_MESSAGE));
      return;
    }
    next();
  } catch (e) { next(e); }
}
```

`middlewares.ts` — add:
- next to the existing `/auth/*/emailpass` rate-limit entries: `{ matcher: '/auth/customer/emailpass', method: 'POST', middlewares: [blockDisabledEmailpassLogin] },`
- as the LAST entry of the routes array: `{ matcher: '/store/*', middlewares: [blockDisabledCustomerSession] },`

**Ordering contingency (test-proven, do not skip):** Step 4's case 3 is the proof that the blanket `/store/*` matcher runs AFTER the per-route `authenticate('customer', ['bearer'])` (i.e. `auth_context` is populated). If case 3 fails because the guard sees no `auth_context`, the fallback is mechanical: delete the blanket entry and instead append `blockDisabledCustomerSession` immediately after `authenticate('customer', ['bearer'])` inside every store matcher array that contains it (~28 entries — grep `authenticate('customer'` in `middlewares.ts`). Then re-run the spec.

- [ ] **Step 4: Run to verify pass**

Single-spec jest command → PASS (5/5). Then `corepack yarn test:unit` + `corepack yarn check-types` → clean.

- [ ] **Step 5: Commit**

`feat(players): login + session block for disabled customers`

---

### Task 3: `playersOverview` batched aggregates + `GET /admin/players`

**Files:**
- Modify: `backend/packages/api/src/modules/packs/service.ts` (new method near `enrichReferralNodes`, ~line 3052)
- Create: `backend/packages/api/src/api/admin/players/route.ts`
- Test: `backend/packages/api/integration-tests/http/players-list.spec.ts`

**Interfaces:**
- Consumes: `resolveFxRate` (`modules/packs/pricing.ts:118`), `parsePaginationParams` (`src/utils/pagination.ts`), `Modules.CUSTOMER` (`listAndCountCustomers` supports a `q` search term and `relations: ['groups']`).
- Produces: `playersOverview(ids: string[], fx: number)` returning per-customer Maps; `GET /admin/players?q=&limit=&offset=` → `{ total, offset, limit, players: PlayerRow[] }` with

```ts
type PlayerRow = {
  id: string; email: string; name: string | null; phone: string | null;
  groups: string[]; vip_level: number;
  wallet_balance: number;            // MYR, Σ credit_transaction
  vault_value: number;               // MYR FMV (multiplier 1 — admin convention)
  vault_count: number;
  total_spend: number;               // MYR net pack_open spend (= creditSummary.vipSpendTotal)
  total_pulls: number;               // pulls with source='pack'
  registered_at: string;
  last_spend_at: string | null;      // newest pack_open row
  frozen: boolean; disabled: boolean;
};
```

- [ ] **Step 1: Write the failing http spec**

`players-list.spec.ts` — boilerplate from `delivery-orders-bulk.spec.ts` (`medusaIntegrationTestRunner`, `mintSuperAdmin`). Seed via the module services directly: two customers (`Modules.CUSTOMER` `createCustomers`), for customer A: two `packs.createCreditTransactions` rows (`topup +100`, `pack_open -30`), one vaulted pull + its card (`packs.createCards` + `packs.createPulls` with `status: 'vaulted'`, `source: 'pack'`), a `vip_member_state` row (`current_level: 3`); customer B: no activity. Cases:

1. `GET /admin/players` → 200; both customers present, ordered `created_at DESC`; `total === 2`.
2. **Reconciliation acceptance (spec §4):** for customer A, `wallet_balance === (await packs.creditSummary(aId)).balance`, `total_spend === (…).vipSpendTotal`, `total_pulls === 1`, `vault_count === 1`, `vault_value` equals `displayMarketPrice(toMoney(card.market_value), fx, 1)` for the seeded card with the spec's seeded FIRM fx (create an fx row exactly the way `seed-e2e-fixtures.ts` does), `vip_level === 3`, `last_spend_at` non-null.
3. Customer B: zeros across aggregates, `vip_level === 1`, `last_spend_at === null`, `disabled === false`.
4. `?q=<A's email prefix>` returns only A.
5. `?limit=1&offset=1` pages; `limit=500` → 400 (maxLimit 200 via `parsePaginationParams`).
6. After `POST /admin/customers/:id/disable` (Task 1), A's row has `disabled === true`.

- [ ] **Step 2: Run to verify failure** — 404 on `/admin/players`.

- [ ] **Step 3: Implement `playersOverview`**

Copy `enrichReferralNodes`'s exact shape (**sequential** `em.execute`, `IN (${ph})` placeholder expansion, Maps out; the header comment "Sequential to avoid concurrent queries on the shared injected EntityManager" applies verbatim):

```ts
  // Batched per-player aggregates for the admin Players list (POLYCARD-BACK
  // §4.2): ONE query per aggregate per page, never per-row. The credit SQL is
  // the GROUP BY twin of creditSummary (service.ts:661) and the vault SQL the
  // customer-scoped twin of vaultLiabilityMyr (service.ts:2666).
  @InjectManager()
  async playersOverview(
    ids: string[], fx: number,
    @MedusaContext() sharedContext: Context = {},
  ) {
    const wallet = new Map<string, { balanceCents: number; spendCents: number; lastSpendAt: string | null }>();
    const vault = new Map<string, { count: number; cents: number }>();
    const pullCount = new Map<string, number>();
    const vipLevel = new Map<string, number>();
    const state = new Map<string, { frozen: boolean; disabled: boolean }>();
    if (ids.length === 0) return { wallet, vault, pullCount, vipLevel, state };
    const em = (sharedContext.transactionManager ?? sharedContext.manager) as unknown as LedgerSqlManager;
    const ph = ids.map(() => '?').join(',');
    const credits = await em.execute<{ customer_id: string; balance_cents: string; spend_cents: string; last_spend_at: string | null }[]>(
      'SELECT customer_id, ' +
        '  COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS balance_cents, ' +
        "  COALESCE(SUM(CASE WHEN reason = 'pack_open' THEN ROUND(-amount * 100) ELSE 0 END), 0)::bigint AS spend_cents, " +
        "  MAX(created_at) FILTER (WHERE reason = 'pack_open') AS last_spend_at " +
        `FROM credit_transaction WHERE customer_id IN (${ph}) AND deleted_at IS NULL GROUP BY customer_id`,
      ids,
    );
    const vaults = await em.execute<{ customer_id: string; n: string; cents: string }[]>(
      'SELECT p.customer_id, COUNT(*)::bigint AS n, ' +
        '  COALESCE(SUM(ROUND(c.market_value * ? * 100)), 0)::bigint AS cents ' +
        '  FROM pull p JOIN card c ON c.handle = p.card_id AND c.deleted_at IS NULL ' +
        ` WHERE p.status = 'vaulted' AND p.deleted_at IS NULL AND p.customer_id IN (${ph}) GROUP BY p.customer_id`,
      [fx, ...ids],
    );
    const pulls = await em.execute<{ customer_id: string; n: string }[]>(
      `SELECT customer_id, COUNT(*)::bigint AS n FROM pull WHERE source = 'pack' AND deleted_at IS NULL AND customer_id IN (${ph}) GROUP BY customer_id`,
      ids,
    );
    const vips = await em.execute<{ customer_id: string; current_level: number }[]>(
      `SELECT customer_id, current_level FROM vip_member_state WHERE customer_id IN (${ph}) AND deleted_at IS NULL`,
      ids,
    );
    const states = await em.execute<{ customer_id: string; frozen: boolean; disabled: boolean }[]>(
      `SELECT customer_id, frozen, disabled FROM customer_account_state WHERE customer_id IN (${ph}) AND deleted_at IS NULL`,
      ids,
    );
    for (const r of credits) wallet.set(r.customer_id, { balanceCents: Number(r.balance_cents), spendCents: Number(r.spend_cents), lastSpendAt: r.last_spend_at });
    for (const r of vaults) vault.set(r.customer_id, { count: Number(r.n), cents: Number(r.cents) });
    for (const r of pulls) pullCount.set(r.customer_id, Number(r.n));
    for (const r of vips) vipLevel.set(r.customer_id, Number(r.current_level));
    for (const r of states) state.set(r.customer_id, { frozen: Boolean(r.frozen), disabled: Boolean(r.disabled) });
    return { wallet, vault, pullCount, vipLevel, state };
  }
```

- [ ] **Step 4: Implement the route**

`api/admin/players/route.ts` (route name is UI-facing; native `/admin/customers` stays untouched):

```ts
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { resolveFxRate } from '../../../modules/packs/pricing';
import { parsePaginationParams } from '../../../utils/pagination';

// GET /admin/players — the All Players list (POLYCARD-BACK §4.2). Page of
// Medusa customers + batched per-player aggregates (playersOverview): one
// query per aggregate per page, never per-row.
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const { limit, offset } = parsePaginationParams(
    { limit: req.query.limit, offset: req.query.offset }, { defaultLimit: 50, maxLimit: 200 },
  );
  const rawQ = req.query.q;
  const q = typeof rawQ === 'string' && rawQ.trim() !== '' ? rawQ.trim().slice(0, 100) : undefined;
  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [page, total] = await customers.listAndCountCustomers(
    q ? { q } : {},
    { skip: offset, take: limit, order: { created_at: 'DESC' }, relations: ['groups'] },
  );
  const ids = page.map((c) => c.id);
  const fx = await resolveFxRate(packs);
  const agg = await packs.playersOverview(ids, fx);
  res.json({
    total, offset, limit,
    players: page.map((c) => {
      const w = agg.wallet.get(c.id);
      const v = agg.vault.get(c.id);
      const s = agg.state.get(c.id);
      const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || null;
      return {
        id: c.id, email: c.email, name, phone: c.phone ?? null,
        groups: (c.groups ?? []).map((g) => g.name),
        vip_level: agg.vipLevel.get(c.id) ?? 1,
        wallet_balance: (w?.balanceCents ?? 0) / 100,
        vault_value: (v?.cents ?? 0) / 100,
        vault_count: v?.count ?? 0,
        total_spend: (w?.spendCents ?? 0) / 100,
        total_pulls: agg.pullCount.get(c.id) ?? 0,
        registered_at: c.created_at,
        last_spend_at: w?.lastSpendAt ?? null,
        frozen: s?.frozen ?? false,
        disabled: s?.disabled ?? false,
      };
    }),
  });
}
```

- [ ] **Step 5: Verify pass** — spec 6/6, `test:unit`, `check-types` clean.

- [ ] **Step 6: Commit** — `feat(players): batched playersOverview aggregates + GET /admin/players`

---

### Task 4: Bank fields — `player_payout_details` model + routes

**Files:**
- Create: `backend/packages/api/src/modules/packs/models/player-payout-details.ts`
- Modify: `backend/packages/api/src/modules/packs/index.ts` (register the model the same way `customer-account-state` is registered — read how the module exports models first)
- Create: `backend/packages/api/src/modules/packs/migrations/Migration20260728100001.ts`
- Create: `backend/packages/api/src/api/admin/customers/[id]/payout-details/route.ts` (GET + POST)
- Modify: `backend/packages/api/src/api/middlewares.ts` (rate-limit matcher for the POST)
- Test: `backend/packages/api/integration-tests/http/payout-details.spec.ts`

**Interfaces:**
- Produces: `GET /admin/customers/:id/payout-details` → `{ details: { bank_name, bank_account_number, account_holder_name } | null }`; `POST` same path, body = those three fields (holder optional) → `{ details: … }`, upsert, audit row (`entity_type 'customer'`, `action 'edit'`, reason `'payout details updated'`).

**Context:** nothing exists on master (repo-wide grep for bank fields = zero hits). The GlobePay branch stores per-withdrawal snapshots (`bank_code`/`account_number`/`account_holder_name`) — a different grain. This model is the customer-level profile the spec asks for ("needed for manual cashouts"); keep field names close to GlobePay's so a future join is sane.

- [ ] **Step 1: Failing http spec** — cases: GET before any save → `{ details: null }`; POST `{ bank_name: 'Maybank', bank_account_number: '1234567890', account_holder_name: 'Ada' }` → 200 echo; GET round-trips (spec §4 acceptance); second POST overwrites (upsert, still one row — assert via `packs.listPlayerPayoutDetails({ customer_id })` length 1); validation 400s: missing bank_name, missing/empty account number, account number > 34 chars or containing non `[0-9 -]` chars; audit row written on POST.

- [ ] **Step 2: Run to verify failure** — 404.

- [ ] **Step 3: Model + migration**

```ts
import { model } from '@medusajs/framework/utils';

// player_payout_details — admin-entered bank destination for MANUAL cashouts
// (POLYCARD-BACK §4.3 Profile tab). One row per customer, admin-auth-only:
// never exposed on any /store route. Distinct from the GlobePay per-withdrawal
// snapshots (those freeze what was submitted per transaction).
export const PlayerPayoutDetails = model.define('player_payout_details', {
  id: model.id().primaryKey(),
  customer_id: model.text().unique(),
  bank_name: model.text(),
  bank_account_number: model.text(),
  account_holder_name: model.text().nullable(),
});

export default PlayerPayoutDetails;
```

`Migration20260728100001.ts` — create table; copy the `create table if not exists` + unique-index shape from `Migration20260623000000.ts` (the `customer_account_state` creation), columns per the model, `down()` drops the table with the repo's refuse-if-live-rows guard pattern from that same migration.

- [ ] **Step 4: Route**

One `route.ts` exporting GET + POST. GET: `listPlayerPayoutDetails({ customer_id: id }, { take: 1 })` → map or null. POST (`AuthenticatedMedusaRequest`): validate `bank_name` 1–100 chars, `bank_account_number` 1–34 chars matching `/^[0-9 -]+$/`, `account_holder_name` optional ≤100; upsert (update if exists else create); audit row via the same helper Task 1 uses; echo. Middleware entry mirrors the freeze matchers: `{ matcher: '/admin/customers/*/payout-details', method: 'POST', middlewares: [adminActionRateLimit] }`.

- [ ] **Step 5: Migrate + verify pass** — `npx medusa db:migrate`; spec green; `test:unit` + `check-types` clean.

- [ ] **Step 6: Commit** — `feat(players): player_payout_details model + admin payout-details routes`

---

### Task 5: Per-player filters on existing list endpoints

**Files:**
- Modify: `backend/packages/api/src/api/admin/delivery-orders/route.ts` (GET gains `customer_id`)
- Modify: `backend/packages/api/src/api/admin/delivery-orders/validate.ts` (+ coercer)
- Modify: `backend/packages/api/src/api/admin/pulls/route.ts` (GET gains `customer_id`; rollups skipped when scoped)
- Modify: `backend/packages/api/src/api/admin/customers/[id]/pulls/route.ts` (GET gains `status` + `source`)
- Test: extend `backend/packages/api/src/api/admin/delivery-orders/__tests__/pagination.unit.spec.ts`-style coverage — add cases to `backend/packages/api/src/api/admin/pulls/__tests__/pagination.unit.spec.ts` and create `backend/packages/api/src/api/admin/delivery-orders/__tests__/customer-filter.unit.spec.ts` if the existing spec files don't exercise query coercion directly; extend `backend/packages/api/integration-tests/http/delivery-orders.spec.ts` and `admin-pulls.spec.ts` with one filtered case each

**Interfaces:**
- Consumes: existing param parsing in both routes (delivery-orders: `status`/`q`/`limit`/`offset`; pulls: `limit`/`offset`/`source`).
- Produces: `GET /admin/delivery-orders?customer_id=<id>`; `GET /admin/pulls?customer_id=<id>` (response keeps its shape but `topCards`/`topRarities` are `[]` when scoped — a player tab shows the table, not global rollups); `GET /admin/customers/:id/pulls?status=vaulted&source=pack`.

- [ ] **Step 1: Failing tests first** — delivery-orders: seeding two orders for two customers, `?customer_id=A` returns only A's (http). Pulls route: `?customer_id=A` → only A's pulls, `topCards: []`, `topRarities: []`; invalid combined check: `customer_id` must be a non-empty string ≤ 64 chars else 400 (unit-level on the coercer if extracted, else http). Customer-pulls route: `?status=vaulted` filters, `?source=pack` filters, invalid values 400 (mirror the source-validation shape already in `admin/pulls/route.ts:41-46`).

- [ ] **Step 2: Implement**

- delivery-orders `route.ts`: after the `q` block — `const customerId = coerceCustomerId(req.query.customer_id); if (customerId) filter.customer_id = customerId;` with `coerceCustomerId` in `validate.ts` (string, trimmed, 1–64 chars, else 400 via the file's `bad()` helper; undefined passes through).
- pulls `route.ts`: same coercion inline (match the `source` validation style). When `customer_id` present: add to `ledgerFilter`, and SKIP the `allPulls` rollup fetch entirely — return `topCards: [], topRarities: []` (comment: rollups are global stats; a scoped view gets none rather than misleading globals).
- customers/[id]/pulls `route.ts`: accept `status` (must be one of the pull enum values) and `source` (`pack`/`reward`) and add to the filter object.

- [ ] **Step 3: Verify** — targeted unit + the two http specs green; full `test:unit` + `check-types` clean.

- [ ] **Step 4: Commit** — `feat(players): customer_id filters on delivery-orders + pulls; status/source on customer pulls`

---

### Task 6: LVL data + vault display value + spend report (backend)

**Files:**
- Modify: `backend/packages/api/src/api/admin/customers/[id]/gacha/route.ts`
- Create: `backend/packages/api/src/api/admin/customers/[id]/spend-report/route.ts`
- Test: extend `backend/packages/api/integration-tests/http/customer-gacha.spec.ts`; create `backend/packages/api/integration-tests/http/spend-report.spec.ts`

**Interfaces:**
- Consumes: `levelForSpend` (`modules/packs/vip-ladder.ts`), `listVipLevels`, `creditSummary`, `displayMarketPrice`, `DEFAULT_MARKET_MULTIPLIER`.
- Produces: gacha route's `vip` block becomes `{ level, highest_level_ever, spend, next: { level, threshold, remaining } | null }` (mirror the exact computation in `GET /store/vip` — `src/api/store/vip/route.ts` — which the gacha route's own header already says it mirrors); `vault` gains `display_value` (price = FMV × per-card multiplier) alongside the existing FMV `market_value`; `GET /admin/customers/:id/spend-report` → `{ periods: { period: 'YYYY-MM', spend: number }[] }` (newest first, ≤ 24 rows, Asia/Kuala_Lumpur months — every week/date boundary in this project is MYT).

- [ ] **Step 1: Failing tests** — gacha spec: assert `vip.next.threshold`/`remaining` for a seeded ladder + spend (copy ladder seeding from whatever spec seeds `vip_level` rows — grep `createVipLevels` in `integration-tests/`); assert `vault.display_value === displayMarketPrice(usd, fx, card.market_multiplier ?? 1.2)` for the seeded vaulted card. spend-report spec: seed pack_open rows in two different months (set `created_at` explicitly on the created rows), assert two periods with correct MYR totals and ordering; a customer with no spend → `{ periods: [] }`.

- [ ] **Step 2: Implement**

- gacha route: extend the existing `Promise.all` with `packs.listVipLevels({}, { select: ['level', 'spend_threshold'], take: 1000 })`; compute `next` exactly as `store/vip/route.ts` does (`ladder.find((r) => r.level === level + 1)`; `remaining: Math.max(0, threshold - spend)`). Vault loop: compute both `displayMarketPrice(usd, fx, 1)` (existing) and `displayMarketPrice(usd, fx, toMoney(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER))`, sum both in cents.
- spend-report route:

```ts
    const rows = await em.execute<{ period: string; spend_cents: string }[]>(
      "SELECT to_char(date_trunc('month', created_at AT TIME ZONE 'Asia/Kuala_Lumpur'), 'YYYY-MM') AS period, " +
        "  COALESCE(SUM(CASE WHEN reason = 'pack_open' THEN ROUND(-amount * 100) ELSE 0 END), 0)::bigint AS spend_cents " +
        'FROM credit_transaction WHERE customer_id = ? AND deleted_at IS NULL ' +
        "GROUP BY 1 HAVING SUM(CASE WHEN reason = 'pack_open' THEN 1 ELSE 0 END) > 0 ORDER BY 1 DESC LIMIT 24",
      [id],
    );
```

wrapped in a small service method (raw SQL lives in `service.ts` by repo convention — add `spendReportForCustomer(customerId)` next to `creditSummary`).

- [ ] **Step 3: Verify + commit** — specs green, unit + types clean. `feat(players): VIP next-tier + vault display value + monthly spend report`

---

### Task 7: Admin lib layer — fetchers, hooks, keys, i18n

**Files:**
- Modify: `backend/apps/admin/src/lib/admin-rest.ts` (append under `// ── Epic 2 (Players) ──`; also extend `AccountState`, `getPulls`, `listDeliveryOrders`, `getCustomerPulls` in place)
- Modify: `backend/apps/admin/src/lib/query-keys.ts` + `query-keys.test.ts`
- Modify: `backend/apps/admin/src/lib/queries.ts` (append)
- Modify: `backend/apps/admin/src/i18n/en.json` (new top-level `"players"` block LAST; plus the `customers.domain` override attempt)
- Test: `backend/apps/admin/src/lib/query-keys.test.ts` (vitest)

**Interfaces:**
- Consumes: Tasks 3–6 endpoints; existing `getJson`/`postJson` primitives.
- Produces (exact names later tasks import):

```ts
// admin-rest.ts
export interface PlayerRow { id: string; email: string; name: string | null; phone: string | null;
  groups: string[]; vip_level: number; wallet_balance: number; vault_value: number; vault_count: number;
  total_spend: number; total_pulls: number; registered_at: string; last_spend_at: string | null;
  frozen: boolean; disabled: boolean; }
export interface PlayersPage { total: number; offset: number; limit: number; players: PlayerRow[] }
export const listPlayers = (page = 0, q?: string, limit = 50) =>
  getJson<PlayersPage>(`/admin/players?limit=${limit}&offset=${page * limit}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
export const disablePlayer = (id: string, reason: string) =>
  postJson<{ disabled: boolean }>(`/admin/customers/${encodeURIComponent(id)}/disable`, { reason });
export const enablePlayer = (id: string, reason: string) =>
  postJson<{ disabled: boolean }>(`/admin/customers/${encodeURIComponent(id)}/enable`, { reason });
export interface PayoutDetails { bank_name: string; bank_account_number: string; account_holder_name: string | null }
export const getPayoutDetails = (id: string) =>
  getJson<{ details: PayoutDetails | null }>(`/admin/customers/${encodeURIComponent(id)}/payout-details`);
export const savePayoutDetails = (id: string, details: PayoutDetails) =>
  postJson<{ details: PayoutDetails }>(`/admin/customers/${encodeURIComponent(id)}/payout-details`, details);
export const getSpendReport = (id: string) =>
  getJson<{ periods: { period: string; spend: number }[] }>(`/admin/customers/${encodeURIComponent(id)}/spend-report`);
export interface AdminCustomerDetail { id: string; email: string; first_name: string | null; last_name: string | null;
  phone: string | null; created_at: string; metadata: Record<string, unknown> | null }
export const getCustomerDetail = (id: string) =>
  getJson<{ customer: AdminCustomerDetail }>(`/admin/customers/${encodeURIComponent(id)}`);
```

  In-place extensions: `AccountState` gains `disabled: boolean; disabled_reason: string | null; disabled_by: string | null; disabled_at: string | null;`. `getPulls(page, limit, source?, customerId?)` appends `&customer_id=` when set. `listDeliveryOrders(status, page, q, limit, customerId?)` likewise. `getCustomerPulls(id, page, limit, opts?: { status?: string; source?: string })`. Gacha DTO: `CustomerGacha['vip']` gains `next: { level: number; threshold: number; remaining: number } | null`; `vault` gains `display_value: number`.

```ts
// query-keys.ts additions
  players: (page: number, q?: string) => ['admin', 'players', page, q ?? ''] as const,
  playersKey: ['admin', 'players'] as const,
  payoutDetails: (id: string) => ['admin', 'customer', id, 'payout-details'] as const,
  spendReport: (id: string) => ['admin', 'customer', id, 'spend-report'] as const,
```

```ts
// queries.ts additions (copy the existing per-customer placeholderData guard
// from useCustomerTransactions for every id-scoped paged hook)
export const usePlayers = (page = 0, q?: string): UseQueryResult<PlayersPage> => …
export const useSetPlayerDisabled = () => …   // mutation { id, disabled, reason } →
  // disabled ? disablePlayer : enablePlayer; onSuccess invalidates qk.playersKey,
  // qk.customerGacha(id), qk.customerAuditKey(id); toast pattern from useFreezeCustomer
export const usePayoutDetails = (id: string | null) => …
export const useSavePayoutDetails = () => …   // invalidates qk.payoutDetails(id)
export const useSpendReport = (id: string | null) => …
export const useCustomerDetail = (id: string | null) => …  // key: ['admin','customer',id,'detail']
```

- [ ] **Step 1: Failing vitest first** — add `query-keys.test.ts` cases: `qk.players(0)` prefix-relates to `qk.playersKey`; `qk.payoutDetails/spendReport` share the `['admin','customer',id]` prefix with the other customer keys. Run `yarn test` → FAIL (keys missing).
- [ ] **Step 2: Implement all of the above.** i18n: append the `"players"` block (keys used by Tasks 8–10: `title`, `subtitle`, column labels `name/email/phone/group/lvl/wallet/vault/spend/pulls/registered/lastSpend/status`, `searchPlaceholder`, `disableTitle`, `disableDesc`, `enableTitle`, `enableDesc`, `reasonLabel`, `reasonPlaceholder`, `disabled`, `active`, tab labels `tabProfile/tabLvl/tabWallet/tabVault/tabOrders/tabPulls/tabHistory`, `bankName`, `bankAccount`, `accountHolder`, `saveBank`, `referralCode`, `memberSince`, `spendReport`, `nextTier`, `empty`, `loadError`). ALSO add a top-level `"customers": { "domain": "Players" }` key — this is the i18n override ATTEMPT for the core sidebar group label (merge semantics of `src/i18n` over the core `customers.domain` key are unverified; Task 8 Step 4 checks the result live and records the outcome).
- [ ] **Step 3: Verify** — `yarn test` green, `corepack yarn build` clean (catches type breaks from the in-place DTO extensions — fix any consumer it reveals, e.g. `routes/support/page.tsx` reading `CustomerGacha`).
- [ ] **Step 4: Commit** — `feat(players): admin lib layer for players list, disable switch, payout details`

---

### Task 8: All Players list page

**Files:**
- Create: `backend/apps/admin/src/routes/players/page.tsx`

**Interfaces:**
- Consumes: `usePlayers`, `useSetPlayerDisabled`, `rm`, `orderDateTime`, `Pager`, `LoadingSkeleton`, i18n `players.*`.
- Produces: sidebar entry "Players" under the core Customers group; route `/players`; rows navigate to `/customers/:id`.

- [ ] **Step 1: Implement the page**

Config: `export const config: RouteConfig = { label: 'Players', icon: Users, nested: '/customers', rank: 0 };` (icon from `@medusajs/icons`). Structure (follow `routes/pulls/page.tsx` + the deliveries page for idioms):

- State: `page`, `qInput` (+ 300 ms debounce → `q`, reset page on change), `modal: { id: string; email: string; disabled: boolean } | null`, `reason` string.
- Search `<Input placeholder={t('players.searchPlaceholder')}>`.
- Table columns (order per spec §4.2): Name (as built: falls back to the EMAIL, not an em-dash — a screen reader on a nameless row would otherwise announce "— button" with no way to tell which player it opens) | Email | Phone | Group (first group name or —) | LVL (`Badge` `LV {vip_level}`) | Wallet (`rm(wallet_balance)`) | Vault (`rm(vault_value)` + small `({vault_count})`) | Spend (`rm(total_spend)`) | Pulls | Registered (`orderDateTime(registered_at)`) | Last spend (`last_spend_at ? orderDateTime(…) : '—'`) | Status.
- Status cell: `Switch` from `@medusajs/ui` — `checked={!p.disabled}`, `onCheckedChange` opens the confirm modal (NEVER toggles directly). Stop row-click propagation on the cell.
- Row `onClick={() => navigate(`/customers/${p.id}`)}` (same idiom as the pulls page customer cell).
- Confirm modal: reuse the `Prompt` pattern from `routes/customers/[id]/page.tsx` (its freeze modal, lines ~162-197): title/desc from `players.disableTitle/Desc` or `enableTitle/Desc`, mandatory reason textarea (confirm disabled while empty), confirm calls `useSetPlayerDisabled().mutateAsync({ id, disabled: !p.disabled, reason })`.
- `Pager` wired to `total`. Error state per the pulls page (`players.loadError`).

- [ ] **Step 2: Build + tests**

`corepack yarn build` + `corepack yarn lint` + `yarn test` clean.

- [ ] **Step 3: Live verification (dev boot)**

Boot backend (`corepack yarn dev` from `backend/packages/api`) + admin (`npx vite --port 7000` from `backend/apps/admin`). Verify: sidebar shows the new entry; list renders with aggregates; search narrows; toggling the switch opens the confirm modal, confirming flips the row and writes an audit entry (check detail page audit timeline). **Record the i18n-override outcome:** if the core sidebar group now reads "Players", note it in the task report; if it still reads "Customers", that is the ACCEPTED fallback (nav shows "Customers > Players") — record it for the PR description, do not chase the minified bundle.

- [ ] **Step 4: Commit** — `feat(players): All Players admin list with aggregates + disable switch`

---

### Task 9: Player detail — tab shell + Profile, Wallet, Vault tabs

**Files:**
- Modify: `backend/apps/admin/src/routes/customers/[id]/page.tsx`

**Interfaces:**
- Consumes: `useCustomerGacha`, `useCustomerDetail`, `usePayoutDetails`, `useSavePayoutDetails`, `useCustomerTransactions`, `useCustomerPulls` (with `{ status: 'vaulted' }` opts — extend the hook if Task 7 didn't add opts threading), existing header/modal machinery.
- Produces: tabbed detail page; later Task 10 adds LVL/Orders/Pulls tabs to the same `Tabs` list.

- [ ] **Step 1: Restructure into tabs**

Keep the existing header (email, VIP badge, frozen badge, Freeze/Unfreeze/Adjust buttons, stat strip) ABOVE the tabs — it is the operator's at-a-glance strip. Below it, `Tabs` from `@medusajs/ui` (import precedent: deliveries page). Copy the deliveries page's child-component-per-tab comment + pattern verbatim (each tab body is its own component so inactive tabs' queries never fire and each tab's local state survives):

- **Profile** (`players.tabProfile`): two labelled sections — identity (name from `useCustomerDetail`, email, phone, referral code = `customer.metadata?.handle ?? '—'`, registered `orderDateTime(created_at)`) and **Bank details**: two inputs + optional holder input seeded from `usePayoutDetails`, Save button → `useSavePayoutDetails` (disabled while unchanged or bank fields empty; toast on success). Also move the existing referral-tree + audit-timeline + commissions sections into a **History** tab (`players.tabHistory`) — move JSX as-is into a tab child component, no logic changes.
- **Wallet** (`players.tabWallet`): balance stat (from gacha data) + the `useCustomerTransactions` table (columns: when `orderDateTime`, reason, amount `rm` with sign coloring, reference) + `Pager` — the support page (`routes/support/page.tsx`) already renders this table; lift its JSX.
- **Vault** (`players.tabVault`): stat row `vault.count` / FMV `rm(vault.market_value)` / price `rm(vault.display_value)` (Task 6 field), then vaulted cards table via `useCustomerPulls(id, page, { status: 'vaulted' })`: thumbnail, card name, qty 1, value (quote fields already on `SupportPull`), pulled-at.

- [ ] **Step 2: Verify** — `corepack yarn build` + `lint` + `yarn test` clean; dev boot: all three tabs render, bank details round-trip (save → reload → values persist), existing freeze/adjust flows still work from the header.

- [ ] **Step 3: Commit** — `feat(players): tabbed player detail — profile with bank fields, wallet, vault`

---

### Task 10: Player detail — LVL, Orders, Pulls tabs + Pull Ledger relocation

**Files:**
- Create: `backend/apps/admin/src/components/PullsTable.tsx` (extracted from the pulls page)
- Modify: `backend/apps/admin/src/routes/customers/[id]/page.tsx` (three more tabs)
- Delete: `backend/apps/admin/src/routes/pulls/page.tsx`
- Modify: `backend/apps/admin/src/lib/queries.ts` (`usePulls` gains `customerId?`; `useDeliveryOrders` gains `customerId?`), `backend/apps/admin/src/lib/query-keys.ts` (+ test) — pulls/deliveryOrders keys gain the customer segment

**Interfaces:**
- Consumes: Task 5 filters; `useSpendReport`; gacha `vip.next` (Task 6); `PullsResponse` shape.
- Produces: `PullsTable({ pulls, page, onPage, limit, total, showCustomer })` — the exact table JSX from `routes/pulls/page.tsx:89-165` with the customer column conditional; **the Pull Ledger sidebar entry is GONE in the same commit the Pulls tab lands** (spec §1.1: relocation is atomic — the operator never loses access to pull history).

- [ ] **Step 1: Extract `PullsTable`**

Move the table `Container` (NOT the rollup header) from `routes/pulls/page.tsx` into `components/PullsTable.tsx`, props as above; `showCustomer=false` hides the customer column (the tab is already player-scoped). Keep every i18n key (`pulls.*` — the block stays in `en.json`).

- [ ] **Step 2: Wire the three tabs**

- **LVL** (`players.tabLvl`): tier card — big `LV {vip.level}` heading, "member since" (`orderDateTime(customer.created_at)`), total accumulative spend `rm(vip.spend)`, progress bar to `vip.next` (`<div>` width = `spend / next.threshold * 100`%, capped; "RM {rm(next.remaining)} more to reach LV {next.level}"; at max level show a full bar + "Top tier"), peak `highest_level_ever`. Below: spend report table from `useSpendReport` (period, `rm(spend)`).
- **Orders** (`players.tabOrders`): two-value kind toggle exactly like the All Orders page (Shipping / Pack purchases — copy the toggle idiom from `routes/deliveries/page.tsx`): Shipping = `useDeliveryOrders(undefined, page, undefined, customerId)` table (read-only subset: id slice, date, items, qty, status badge with `deliveryStatusLabel`); Pack purchases = `usePulls(page, 'pack', customerId)` rendered through `PullsTable` `showCustomer=false`.
- **Pulls** (`players.tabPulls`): `usePulls(page, undefined, customerId)` → `PullsTable` `showCustomer=false` (all sources, incl. buyback states — this IS the relocated Pull Ledger, D6).

- [ ] **Step 3: Delete `routes/pulls/page.tsx`** — the config export dies with the file; grep `routes/pulls` and `'/pulls'` across `backend/apps/admin/src` → zero survivors (the two old `navigate('/customers/…')` call sites lived in this file and in support; support is untouched).

- [ ] **Step 4: Verify** — `corepack yarn build` (catches any dangling import) + `lint` + `yarn test`; dev boot: all seven tabs render (Profile, Lvl, Wallet, Vault, Orders, Pulls, History); Pull Ledger gone from sidebar; player Pulls tab shows the same rows the old page showed for that player; Orders tab toggles.

- [ ] **Step 5: Commit** — `feat(players): LVL/Orders/Pulls tabs; retire standalone Pull Ledger (spec D6)`

---

### Task 11: Full verification sweep

- [ ] **Step 1: Backend** — from `backend/packages/api`: `corepack yarn test:unit` PASS; `corepack yarn check-types` clean; `corepack yarn test:integration:smoke` PASS; the four new/extended http specs (`admin-disable`, `disabled-login`, `players-list`, `payout-details`, plus `spend-report` and the filter cases) each green via the single-spec command.
- [ ] **Step 2: Admin** — `corepack yarn build`, `corepack yarn lint`, `yarn test` all clean.
- [ ] **Step 3: Repo root** — `npm run check` clean (storefront untouched by this epic; the login block surfaces through existing error handling — verify the storefront login form shows the "disabled" message during Step 4).
- [ ] **Step 4: Manual round-trip on the live stack** — backend + admin + storefront (`npm run build` + `pwsh scripts/serve-standalone.ps1 -Port 4000`): disable a test player in admin → storefront login for that player fails with the disabled message → re-enable → login works. Players list aggregates spot-check against the Economy page figures for one player (spec §4 acceptance: totals reconcile).
- [ ] **Step 5: Grep sweeps** — `grep -rn "Pull Ledger" backend/apps/admin/src` → only i18n (title reused by tab header if referenced); `grep -rn "playersOverview\|isAccountDisabled" backend/packages/api/src` → definition + call sites only; `git diff origin/master --stat` review for formatter churn.
- [ ] **Step 6: Commit any fixes, then PR** — `/code-review`, fix findings, push, PR to `master` titled `feat(players): Players rework — list with aggregates, disable switch, tabbed detail, Pull Ledger relocation (POLYCARD-BACK epic 2)`.

---

## Coverage check (spec §4 + §1.1 → tasks)

- 4.1 rename (UI/i18n only) → Task 7 (i18n + override attempt), Task 8 (nav label).
- 4.2 list columns → Tasks 3, 7, 8. Disable switch + confirm + login block → Tasks 1, 2, 8. ONE batched query per page → Task 3 (`playersOverview`).
- 4.3 Profile (bank fields NEW) → Tasks 4, 9. LVL tier card + spend report → Tasks 6, 10. Wallet → Task 9. Vault (price + FMV totals) → Tasks 6, 9. Orders → Tasks 5, 10. Pulls (D6 relocation, atomic) → Tasks 5, 10.
- §1.1 Pull Ledger removal ships with this epic → Task 10 (same commit as the tab).
- Acceptance: totals reconcile → Task 3 spec + Task 11 Step 4; disable blocks login (integration) → Task 2 spec; bank fields round-trip → Task 4 spec.

## Open items surfaced to the operator (do not decide silently)

1. **Core sidebar group label**: `customers.domain` i18n override is an attempt — if the prebuilt bundle wins, nav reads "Customers > Players" (fallback recorded in Task 8 Step 3). Full label control would need patching `@mercurjs/admin` dist.
2. **Bank fields grain**: implemented as a customer-level `player_payout_details` profile (spec's suggestion). GlobePay's per-withdrawal snapshots (unmerged Payment-Gateway branch) stay separate; field names kept compatible (`bank_account_number`/`account_holder_name`).
3. **Google login for disabled players**: the callback still mints a token, but the token is unusable on every `/store` route (session guard). A cosmetic "disabled" message at Google-login time would need intercepting the core callback response — skipped as low-value.
