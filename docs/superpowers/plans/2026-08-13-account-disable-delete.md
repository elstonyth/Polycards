# Customer Self-Service Disable & Delete Account — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a logged-in customer disable their own account (reversible by logging back in) or delete it permanently (personal data purged, login impossible forever, money records retained anonymously).

**Architecture:** Extends the existing `customer_account_state` machinery rather than adding a parallel flag. One new column (`disabled_cause`) splits admin disables from self disables; the two existing guards in `disabled-guard.ts` branch on it. Four new `/store/customers/me/*` routes (disable, reactivate, delete, account-info) sit behind the blanket `/store/*` session guard that already exists. The storefront adds a Danger-zone panel to the Settings page and a reactivate prompt to the login flow.

**Tech Stack:** Medusa v2 (backend, `backend/packages/api`), MikroORM migrations, Jest + `@medusajs/test-utils` (backend tests), Next.js App Router + React 19 (storefront, `src/`), Vitest (storefront tests), Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-08-13-account-disable-delete-design.md`

## Global Constraints

- TypeScript strict mode, no `any`. Named exports, 2-space indentation.
- Backend commands run from `backend/packages/api` with **`corepack yarn`**, never plain `yarn` or `npm`.
- Storefront commands run from the repo root with **`npm`**.
- A backend route unit spec MUST live at `src/**/__tests__/*.unit.spec.ts` — that exact glob is what `TEST_TYPE=unit` matches.
- A backend HTTP integration spec MUST be **flat** in `integration-tests/http/` and end in `.spec.ts`. No subdirectories.
- A storefront test MUST end in **`.test.ts`** — `vitest.config.ts` includes `src/**/*.test.ts` only, so a `.test.tsx` file is silently never collected.
- Migration files: `import { Migration } from '@mikro-orm/migrations';` (the newest convention in this repo — older files use the `@medusajs/framework/mikro-orm/migrations` path; follow the newest). Class name `Migration<YYYYMMDDHHMMSS>` matching the filename. `override async up()` / `override async down()`. Lowercase SQL keywords, double-quoted identifiers, idempotent DDL (`if exists` / `if not exists`), one statement per `this.addSql(...)`, `down()` mirroring `up()` in reverse.
- Money is computed in **integer cents** in SQL (`ROUND(amount * 100)::bigint`) and divided at the return boundary. Raw driver numerics come back as `string | null` — always `Number(rows[0]?.x ?? 0)`.
- Service methods take `@MedusaContext() sharedContext: Context = {}` as the **last** parameter with the `= {}` default. `@InjectManager()` for reads, `@InjectTransactionManager()` for writes.
- A fake-service unit test that calls an `@InjectManager()` method MUST pass a **non-empty** context (`{ manager: … }`). The decorator throws unless `this.baseRepository_` or `context.manager` is present, and `isPresent({})` is **false** — a bare `{}` still throws. `@InjectTransactionManager()` behaves differently: it short-circuits when `context.transactionManager` is set, which is why this repo's existing fake-service specs get away with less. And when the method under test resolves the manager and runs SQL on it, that manager has to be the fake `em` itself, not a placeholder.
- Backend `.ts` files: a global formatter hook rewrites double quotes to single quotes on Edit/Write and can bury a small change in whole-file churn. If that happens, edit backend `.ts` via a node script through the Bash tool instead.
- Never write `metadata` through `POST /store/customers/me` — `rejectCustomerMetadata` refuses it by design. Metadata writes go through `PacksModuleService.mutateCustomerMetadata`.
- Error codes returned to the storefront are the machine-readable contract. Exact strings: `ACCOUNT_SELF_DISABLED`, `BALANCE_NOT_ZERO`, `WITHDRAWAL_PENDING`, `DEPOSIT_PENDING`, `CARDS_UNSETTLED`, `DELIVERY_IN_FLIGHT`, `PASSWORD_REQUIRED`, `PASSWORD_INCORRECT`.
- The admin-disabled copy stays exactly `This account has been disabled. Please contact support.` — it is asserted in existing specs on both sides.

---

## File Structure

**Backend — created:**

- `src/modules/packs/migrations/Migration20260813100000.ts` — `disabled_cause` column + backfill.
- `src/modules/packs/migrations/Migration20260813110000.ts` — widen `admin_action_audit.action` with `delete_account`.
- `src/api/store/customers/me/disable/route.ts` — POST self-disable.
- `src/api/store/customers/me/reactivate/route.ts` — POST reactivate.
- `src/api/store/customers/me/delete/route.ts` — POST delete.
- `src/api/store/customers/me/account/route.ts` — GET `{ hasPassword }`.
- `src/api/store/customers/me/__tests__/self-service.unit.spec.ts` — unit spec for all four routes.
- `src/api/utils/__tests__/disabled-guard.unit.spec.ts` — unit spec for the guard cause-split (create if absent; extend if present).
- `src/modules/packs/__tests__/account-lifecycle.unit.spec.ts` — the service reads, the preflight, the purge and the settle skip.
- `integration-tests/http/account-self-service.spec.ts` — the end-to-end loops.

**Backend — modified:**

- `src/modules/packs/models/customer-account-state.ts` — `disabled_cause` field.
- `src/modules/packs/models/admin-action-audit.ts` — `delete_account` action.
- `src/modules/packs/service.ts` — `setAccountDisabled` gains `cause`; new `accountDisabledCause`, `rawLedgerBalanceCents`, `deleteAccountPreflight`, `purgeAccountPacksData`, `deletedCustomerIds`; `settleChallengeWeek` skips deleted winners; `isAccountDisabled` deleted.
- `src/api/utils/disabled-guard.ts` — cause-split + reactivate carve-out + `ACCOUNT_SELF_DISABLED`.
- `src/api/utils/rate-limit.ts` — `createAccountDeleteRateLimit`, the delete route's own tier.
- `src/api/admin/customers/[id]/disable/route.ts` and `.../enable/route.ts` — pass `cause: 'admin'`.
- `src/api/middlewares.ts` — register the four new routes.
- `integration-tests/http/admin-disable.spec.ts` — two `toEqual` audit assertions widened to `toMatchObject`.

**Storefront — created:**

- `src/lib/actions/account-lifecycle.ts` — `disableAccount`, `reactivateAccount`, `deleteAccount` server actions, plus the `DELETE_COPY` / `DELETE_LINK` maps.
- `src/lib/actions/__tests__/account-lifecycle.test.ts` — Vitest coverage.
- `src/components/account/DangerZone.tsx` — the panel plus its two modals.
- `src/components/auth/ReactivatePrompt.tsx` — the post-login reactivate offer, shared by the form and the Google callback.

**Storefront — modified:**

- `src/app/(account)/settings/page.tsx` — render `<DangerZone />`.
- `src/lib/data/customer.ts` — `getAccountInfo()` reading `{ hasPassword }`.
- `src/lib/actions/auth.ts` — surface `ACCOUNT_SELF_DISABLED` from `login` and `googleCallback`.
- `src/components/AuthForm.tsx` / `src/components/AuthModal.tsx` — the reactivate sub-view and its `?auth=reactivate` trigger.
- `src/app/auth/google/callback/route.ts` and `src/app/reset-password/ResetPasswordClient.tsx` — the consumers the `AuthResult` widening reddens.

---

## Task 1: `disabled_cause` column, migrations, and the admin write path

**Files:**

- Modify: `backend/packages/api/src/modules/packs/models/customer-account-state.ts:29-33`
- Modify: `backend/packages/api/src/modules/packs/models/admin-action-audit.ts:30-54`
- Create: `backend/packages/api/src/modules/packs/migrations/Migration20260813100000.ts`
- Create: `backend/packages/api/src/modules/packs/migrations/Migration20260813110000.ts`
- Modify: `backend/packages/api/src/modules/packs/service.ts:2686-2736` (`setAccountDisabled`)
- Modify: `backend/packages/api/src/api/admin/customers/[id]/disable/route.ts:26-31`
- Modify: `backend/packages/api/src/api/admin/customers/[id]/enable/route.ts` (same call)
- Test: `backend/packages/api/integration-tests/http/admin-disable.spec.ts` (extend)

**Interfaces:**

- Consumes: nothing (first task).
- Produces:
  - `CustomerAccountState.disabled_cause: 'admin' | 'self' | null`
  - `AdminActionAudit.action` now includes `'delete_account'`
  - `PacksModuleService.setAccountDisabled(input: { customerId: string; adminId: string; disabled: boolean; reason: string; cause: 'admin' | 'self' }, sharedContext?): Promise<{ disabled: boolean }>` — **`cause` is required**, so every existing call site must be updated and the compiler finds them all.

- [ ] **Step 1: Add the model field**

In `src/modules/packs/models/customer-account-state.ts`, after the `disabled_at` line (`:32`), add:

```ts
    // Who disabled this account. 'admin' is the §4.2 support lever; 'self' is
    // the customer's own reversible disable. NULL means "written before this
    // column existed" and every guard MUST treat it as 'admin' — see
    // disabled-guard.ts. Deliberately a separate column from `cause` (which
    // belongs to `frozen`): the two flags are orthogonal and share no history.
    disabled_cause: model.enum(['admin', 'self']).nullable(),
```

- [ ] **Step 2: Add the audit action**

In `src/modules/packs/models/admin-action-audit.ts`, add `'delete_account'` to the `action` enum after `'reveal'` (`:53`):

```ts
      'reveal',
      // Customer self-service account deletion. admin_id carries the
      // CUSTOMER's own id for this action — see service.purgeAccountPacksData.
      'delete_account',
```

- [ ] **Step 3: Write the column migration**

Create `src/modules/packs/migrations/Migration20260813100000.ts`:

```ts
import { Migration } from '@mikro-orm/migrations';

// Adds customer_account_state.disabled_cause, which splits an admin disable
// (the §4.2 support lever) from a customer's own reversible self-disable.
//
// The backfill is the security-relevant half: every disable that exists today
// was made by an admin, and a NULL cause reaching the login guard would look
// like "not an admin disable" to a naive `cause === 'admin'` test. The guards
// are written to fail closed regardless (they test `cause === 'self'`), but a
// correct backfill means that fallback never has to carry a live account.
export class Migration20260813100000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "customer_account_state" add column if not exists "disabled_cause" text null;`,
    );
    this.addSql(
      `alter table if exists "customer_account_state" drop constraint if exists "customer_account_state_disabled_cause_check";`,
    );
    this.addSql(
      `alter table if exists "customer_account_state" add constraint "customer_account_state_disabled_cause_check" check ("disabled_cause" in ('admin','self'));`,
    );
    this.addSql(
      `update "customer_account_state" set "disabled_cause" = 'admin' where "disabled" = true and "disabled_cause" is null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "customer_account_state" drop constraint if exists "customer_account_state_disabled_cause_check";`,
    );
    this.addSql(
      `alter table if exists "customer_account_state" drop column if exists "disabled_cause";`,
    );
  }
}
```

- [ ] **Step 4: Write the audit-enum migration**

Create `src/modules/packs/migrations/Migration20260813110000.ts`. Copy the full value list from `Migration20260812000000.ts:18` and append `'delete_account'`:

```ts
import { Migration } from '@mikro-orm/migrations';

// Adds the 'delete_account' audit action for customer self-service deletion.
//
// Reuses admin_action_audit rather than adding a customer-side table: the row
// shape (actor, entity, before/after, reason) is already exactly right, and
// GET /admin/customers/:id/audit — which support reads when a customer asks
// what happened — then shows the deletion in the same timeline as everything
// else. The only stretch is that `admin_id` carries a customer id here; the
// action name makes that unambiguous.
export class Migration20260813110000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "admin_action_audit" drop constraint if exists "admin_action_audit_action_check";`,
    );
    this.addSql(
      `alter table if exists "admin_action_audit" add constraint "admin_action_audit_action_check" check ("action" in ('freeze','unfreeze','reverse_commission','suspend_commission','unsuspend_commission','adjust_credit','edit_rewards_settings','edit_reward_pool','edit_daily_reward_settings','edit_daily_box','edit_voucher_ladder','edit_fx_rate','edit_site_settings','edit_avatar_frames','replace','edit','bulk_status','disable','enable','create','reveal','delete_account'));`,
    );
  }

  // No-op for the same reason Migration20260812000000's down() is: narrowing
  // the constraint again would mean deleting the delete_account rows, and those
  // rows ARE the record of an irreversible action. The widened constraint is a
  // superset, so leaving it is harmless.
  override async down(): Promise<void> {}
}
```

- [ ] **Step 5: Thread `cause` through `setAccountDisabled`**

In `src/modules/packs/service.ts`, change the `setAccountDisabled` input type (`:2687-2692`) to add `cause: 'admin' | 'self';`, and the `patch` object (`:2704-2709`) to:

```ts
const patch = {
  disabled: input.disabled,
  disabled_cause: input.disabled ? input.cause : null,
  disabled_reason: input.disabled ? input.reason : null,
  disabled_by: input.disabled ? input.adminId : null,
  disabled_at: input.disabled ? new Date() : null,
};
```

Extend the audit `before`/`after` payloads (`:2728-2729`) so the cause is in the trail:

```ts
          before: {
            disabled: existing?.disabled ?? false,
            disabled_cause: existing?.disabled_cause ?? null,
          },
          after: {
            disabled: input.disabled,
            disabled_cause: input.disabled ? input.cause : null,
          },
```

- [ ] **Step 6: Update the two admin call sites**

In `src/api/admin/customers/[id]/disable/route.ts:26-31` add `cause: 'admin',` to the `setAccountDisabled` call. Do the same in `.../enable/route.ts` (it passes `disabled: false`, where `cause` is ignored, but the field is required so it must be present — pass `cause: 'admin'`).

- [ ] **Step 7: Refresh the ORM snapshot**

`src/modules/packs/migrations/.snapshot-packs.json` is git-tracked and already describes `customer_account_state`. A hand-written migration does not update it, so the next `db:generate` would diff the model against a stale snapshot and emit a **second, duplicate** `disabled_cause` migration. (The `Migration20260812000000` precedent avoided this only because a CHECK-constraint change touches no column.)

```bash
cd backend/packages/api && corepack yarn medusa db:generate packs
```

That regenerates the snapshot. It may also emit its own migration for `disabled_cause` — if it does, **delete the generated file** and keep the hand-written `Migration20260813100000.ts`, which is the only one carrying the backfill `UPDATE`. Keep the regenerated `.snapshot-packs.json`.

Then prove the drift is gone by running it a second time:

```bash
cd backend/packages/api && corepack yarn medusa db:generate packs
```

Expected: no new migration file. If one still appears the snapshot did not take — resolve that before continuing, or every later `db:generate` in this repo emits spurious migrations.

- [ ] **Step 8: Run the migrations and typecheck**

```bash
cd backend/packages/api && corepack yarn medusa db:migrate
```

Expected: both migrations apply with no error.

```bash
cd backend/packages/api && ./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

Expected: no errors. (Call the local `tsc` directly — a global TypeScript 7 install shadows the pinned 5.9.3 and produces a bogus TS5102/baseUrl failure.)

- [ ] **Step 9: Repair the two assertions Step 5 just reddened**

Step 5 widened the audit `after` payload with `disabled_cause`, which breaks two SHIPPED assertions in `integration-tests/http/admin-disable.spec.ts` (`:46` and `:75`) that compare the whole object:

```ts
expect(aud.after).toEqual({ disabled: true });
```

Change both to `toMatchObject`, which asserts the field that case is about and ignores the new one:

```ts
expect(aud.after).toMatchObject({ disabled: true });
```

(`:75` asserts `{ disabled: false }` — same change.) Do this before running anything, or Step 11 reports a failure that is this step's, not the migration's.

- [ ] **Step 10: Extend the existing admin integration spec**

In `integration-tests/http/admin-disable.spec.ts`, inside the existing `describe`, add:

```ts
it('an admin disable stamps disabled_cause = admin', async () => {
  const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
  const cid = 'cust_disable_cause_1';

  await unwrapResponse(
    api.post(
      `/admin/customers/${cid}/disable`,
      { reason: 'cause test' },
      { headers: adminHeaders() },
    ),
  );

  const [state] = await packs.listCustomerAccountStates(
    { customer_id: cid },
    { take: 1 },
  );
  expect(state.disabled).toBe(true);
  expect(state.disabled_cause).toBe('admin');

  await unwrapResponse(
    api.post(
      `/admin/customers/${cid}/enable`,
      { reason: 'lift' },
      { headers: adminHeaders() },
    ),
  );
  const [after] = await packs.listCustomerAccountStates(
    { customer_id: cid },
    { take: 1 },
  );
  expect(after.disabled).toBe(false);
  expect(after.disabled_cause).toBeNull();
});
```

- [ ] **Step 11: Run it**

```bash
cd backend/packages/api && corepack yarn test:integration:http admin-disable.spec
```

Expected: PASS — the new case AND the two repaired assertions from Step 9.

- [ ] **Step 12: Commit**

Include the regenerated snapshot — leaving it out is what reintroduces the drift Step 7 removed.

```bash
git add backend/packages/api/src/modules/packs backend/packages/api/src/api/admin backend/packages/api/integration-tests/http/admin-disable.spec.ts
git commit -m "feat(account): split admin and self disables with disabled_cause"
```

---

## Task 2: Service reads — `accountDisabledCause` and `rawLedgerBalanceCents`

**Files:**

- Modify: `backend/packages/api/src/modules/packs/service.ts` (near `isAccountDisabled` at `:2797` and `availableBalance` at `:3634`)
- Test: `backend/packages/api/src/modules/packs/__tests__/account-lifecycle.unit.spec.ts` (create)

**Interfaces:**

- Consumes: `disabled_cause` from Task 1.
- Produces:
  - `PacksModuleService.accountDisabledCause(customerId: string, sharedContext?): Promise<'admin' | 'self' | null>` — `null` means not disabled. A disabled row with a NULL cause resolves to `'admin'`.
  - `PacksModuleService.rawLedgerBalanceCents(customerId: string, sharedContext?): Promise<number>` — signed integer cents, freeze-blind and lock-blind.

- [ ] **Step 1: Write the failing unit test**

Create `src/modules/packs/__tests__/account-lifecycle.unit.spec.ts`:

```ts
import PacksModuleService from '../service';

type Svc = PacksModuleService & {
  listCustomerAccountStates: jest.Mock;
};

// Non-empty on purpose. @InjectManager throws unless the context carries a
// manager, and `isPresent({})` is FALSE (it tests Object.keys().length > 0), so
// a bare `{}` still throws — every method under test here is @InjectManager.
// @InjectTransactionManager is the one that short-circuits on
// `context.transactionManager`, which is why this repo's other fake-service
// specs get away with less. Precedent: credit-balance.unit.spec.ts:21-37.
const CTX = { manager: { probe: true } } as never;

const mkService = (): Svc => {
  const svc = Object.create(PacksModuleService.prototype) as Svc;
  svc.listCustomerAccountStates = jest.fn();
  return svc;
};

describe('accountDisabledCause', () => {
  it('returns null when the account is not disabled', async () => {
    const svc = mkService();
    svc.listCustomerAccountStates.mockResolvedValue([]);
    await expect(svc.accountDisabledCause('cus_1', CTX)).resolves.toBeNull();
  });

  it('returns self for a customer self-disable', async () => {
    const svc = mkService();
    svc.listCustomerAccountStates.mockResolvedValue([
      { disabled: true, disabled_cause: 'self' },
    ]);
    await expect(svc.accountDisabledCause('cus_1', CTX)).resolves.toBe('self');
  });

  // The fail-closed property: a disabled row whose cause predates the column
  // must behave as an admin disable, never as a self-disable (which would let
  // it through the login guard).
  it('treats a NULL cause on a disabled row as admin', async () => {
    const svc = mkService();
    svc.listCustomerAccountStates.mockResolvedValue([
      { disabled: true, disabled_cause: null },
    ]);
    await expect(svc.accountDisabledCause('cus_1', CTX)).resolves.toBe('admin');
  });
});

// rawLedgerBalanceCents RESOLVES the manager out of the context and calls
// .execute() on it, so it needs a context whose manager IS the fake em — CTX's
// probe object would only get as far as "em.execute is not a function". Two
// context shapes in one file, deliberately; do not collapse them.
const mkBalance = (balanceCents: string | null) => {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  const em = {
    execute: jest.fn().mockResolvedValue([{ balance_cents: balanceCents }]),
  };
  return { svc, em, ctx: { manager: em } as never };
};

describe('rawLedgerBalanceCents', () => {
  it('returns integer cents, and scans credit_transaction for this customer', async () => {
    const f = mkBalance('2500');
    await expect(f.svc.rawLedgerBalanceCents('cus_1', f.ctx)).resolves.toBe(
      2500,
    );
    const [sql, params] = f.em.execute.mock.calls[0];
    expect(sql).toContain('credit_transaction');
    expect(sql).toContain('deleted_at IS NULL');
    expect(params).toEqual(['cus_1']);
  });

  // The security-relevant direction, and the one that never touched Postgres
  // before this test existed: a clawback-negative account OWES money. A read
  // that clamped it at 0 would let it delete its way out of the debt.
  it('returns a NEGATIVE number for a clawback-negative account', async () => {
    const f = mkBalance('-500');
    await expect(f.svc.rawLedgerBalanceCents('cus_1', f.ctx)).resolves.toBe(
      -500,
    );
  });

  it('reads an empty ledger as 0', async () => {
    const f = mkBalance(null);
    await expect(f.svc.rawLedgerBalanceCents('cus_1', f.ctx)).resolves.toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd backend/packages/api && corepack yarn test:unit -- account-lifecycle
```

Expected: FAIL — `svc.accountDisabledCause is not a function`.

- [ ] **Step 3: Implement both reads**

In `src/modules/packs/service.ts`, directly after `isAccountDisabled` (which ends at `:2807`), add:

```ts
  // The disable's CAUSE, or null when the account is not disabled. Fails closed
  // on purpose: a disabled row whose `disabled_cause` is NULL (written before
  // the column existed, or by a future writer that forgets it) resolves to
  // 'admin', the more restrictive of the two. Callers must branch on
  // `=== 'self'` to GRANT the self-service behaviour, never on `=== 'admin'`
  // to deny it — that inversion is what makes a NULL a login bypass.
  @InjectManager()
  async accountDisabledCause(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<'admin' | 'self' | null> {
    const [state] = await this.listCustomerAccountStates(
      { customer_id: customerId, disabled: true },
      { take: 1 },
      sharedContext,
    );
    if (!state) return null;
    return state.disabled_cause === 'self' ? 'self' : 'admin';
  }
```

Then directly after `availableBalance` (ends `:3649`), add:

```ts
  // The raw signed ledger balance, in INTEGER CENTS.
  //
  // Two deliberate divergences from this file's conventions, both required by
  // the account-deletion gate that is its only caller:
  //
  //  - Cents, not the MYR decimals every sibling returns. The gate tests for
  //    exact zero, and a float RM comparison is the wrong instrument for that.
  //  - Freeze-blind and lock-blind. availableBalance() returns 0 for a frozen
  //    account and subtracts lockedCommissionCents, so a frozen account still
  //    holding funds — or one whose balance happens to equal its locked
  //    commission — reads as 0 there. Deleting either would strand real money.
  //
  // Signed, so a clawback-negative account (which owes us) is also non-zero and
  // is therefore refused by the same `!== 0` test.
  @InjectManager()
  async rawLedgerBalanceCents(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<number> {
    const em = (sharedContext.transactionManager ??
      sharedContext.manager) as unknown as LedgerSqlManager;
    const rows = await em.execute<{ balance_cents: string | null }[]>(
      'SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::bigint AS balance_cents ' +
        'FROM credit_transaction WHERE customer_id = ? AND deleted_at IS NULL',
      [customerId],
    );
    return Number(rows[0]?.balance_cents ?? 0);
  }
```

- [ ] **Step 4: Run the tests**

```bash
cd backend/packages/api && corepack yarn test:unit -- account-lifecycle
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/packages/api/src/modules/packs
git commit -m "feat(account): add cause-aware disable read and raw ledger balance"
```

---

## Task 3: Guard cause-split and the reactivate carve-out

**Files:**

- Modify: `backend/packages/api/src/api/utils/disabled-guard.ts` (whole file)
- Modify: `backend/packages/api/src/modules/packs/service.ts:2797-2807` (delete `isAccountDisabled`)
- Test: `backend/packages/api/src/api/utils/__tests__/disabled-guard.unit.spec.ts` (create if absent)

**Interfaces:**

- Consumes: `accountDisabledCause` from Task 2.
- Produces:
  - `SELF_DISABLED_CODE = 'ACCOUNT_SELF_DISABLED'` exported from `disabled-guard.ts`.
  - `REACTIVATE_PATH = '/store/customers/me/reactivate'` exported from the same file.
  - Behaviour: login guard blocks admin-disabled only; session guard blocks everything except `POST /store/customers/me/reactivate` for a self-disabled customer, and its 403 message for a self-disable is exactly `ACCOUNT_SELF_DISABLED`.

- [ ] **Step 1: Write the failing unit test**

Create `src/api/utils/__tests__/disabled-guard.unit.spec.ts`:

```ts
import {
  blockDisabledCustomerSession,
  blockDisabledEmailpassLogin,
  SELF_DISABLED_CODE,
} from '../disabled-guard';

const accountDisabledCause = jest.fn();
const listAuthIdentities = jest.fn();

const scope = {
  resolve: jest.fn((key: string) => {
    if (key === 'packs') return { accountDisabledCause };
    return { listAuthIdentities };
  }),
};

const mkNext = () => jest.fn();

// `originalUrl`, NOT `path`. The guard is registered method-less, so Express
// takes the `app.use(matcher, handler)` branch and has already stripped the
// matched prefix by the time the handler runs: `req.path` is '/' in there.
// Setting `path` here would make the test assert on itself.
const mkSessionReq = (originalUrl: string) =>
  ({
    auth_context: { actor_id: 'cus_1', actor_type: 'customer' },
    originalUrl,
    method: 'POST',
    scope,
  }) as never;

beforeEach(() => {
  accountDisabledCause.mockReset();
  listAuthIdentities.mockReset();
  listAuthIdentities.mockResolvedValue([
    { app_metadata: { customer_id: 'cus_1' } },
  ]);
});

describe('blockDisabledEmailpassLogin', () => {
  it('blocks an admin-disabled account', async () => {
    accountDisabledCause.mockResolvedValue('admin');
    const next = mkNext();
    await blockDisabledEmailpassLogin(
      { body: { email: 'a@b.dev' }, scope } as never,
      {} as never,
      next,
    );
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(String(next.mock.calls[0][0].message)).toMatch(/has been disabled/i);
  });

  // A row whose disabled_cause is NULL reaches the guard as 'admin' — the
  // service collapses it. Pinned at the guard as well, because the guard is
  // where an inverted test (`=== 'admin'` to deny) would turn any OTHER value
  // into a silent login bypass.
  it('blocks a disabled account whose cause is NULL in the database', async () => {
    accountDisabledCause.mockResolvedValue('admin'); // what NULL resolves to
    const next = mkNext();
    await blockDisabledEmailpassLogin(
      { body: { email: 'a@b.dev' }, scope } as never,
      {} as never,
      next,
    );
    expect(String(next.mock.calls[0][0].message)).toMatch(/has been disabled/i);
  });

  // The inversion guard itself: an unexpected third cause must BLOCK, not pass.
  it('blocks an unexpected cause value', async () => {
    accountDisabledCause.mockResolvedValue('suspended');
    const next = mkNext();
    await blockDisabledEmailpassLogin(
      { body: { email: 'a@b.dev' }, scope } as never,
      {} as never,
      next,
    );
    expect(String(next.mock.calls[0][0].message)).toMatch(/has been disabled/i);
  });

  it('lets a self-disabled account log in so it can be reactivated', async () => {
    accountDisabledCause.mockResolvedValue('self');
    const next = mkNext();
    await blockDisabledEmailpassLogin(
      { body: { email: 'a@b.dev' }, scope } as never,
      {} as never,
      next,
    );
    expect(next).toHaveBeenCalledWith();
  });
});

describe('blockDisabledCustomerSession', () => {
  it('blocks an admin-disabled session on every path', async () => {
    accountDisabledCause.mockResolvedValue('admin');
    const next = mkNext();
    await blockDisabledCustomerSession(
      mkSessionReq('/store/customers/me/reactivate'),
      {} as never,
      next,
    );
    expect(String(next.mock.calls[0][0].message)).toMatch(/has been disabled/i);
  });

  it('blocks a self-disabled session everywhere except reactivate', async () => {
    accountDisabledCause.mockResolvedValue('self');
    const next = mkNext();
    await blockDisabledCustomerSession(
      mkSessionReq('/store/credits'),
      {} as never,
      next,
    );
    expect(String(next.mock.calls[0][0].message)).toBe(SELF_DISABLED_CODE);
  });

  it('lets a self-disabled session through to reactivate', async () => {
    accountDisabledCause.mockResolvedValue('self');
    const next = mkNext();
    await blockDisabledCustomerSession(
      mkSessionReq('/store/customers/me/reactivate'),
      {} as never,
      next,
    );
    expect(next).toHaveBeenCalledWith();
  });

  // originalUrl carries whatever the client sent, so the two shapes a browser
  // or fetch wrapper produces for the SAME route must not lock the customer
  // out of the one path they are allowed to use.
  it('lets the reactivate path through with a query string', async () => {
    accountDisabledCause.mockResolvedValue('self');
    const next = mkNext();
    await blockDisabledCustomerSession(
      mkSessionReq('/store/customers/me/reactivate?from=login'),
      {} as never,
      next,
    );
    expect(next).toHaveBeenCalledWith();
  });

  it('lets the reactivate path through with a trailing slash', async () => {
    accountDisabledCause.mockResolvedValue('self');
    const next = mkNext();
    await blockDisabledCustomerSession(
      mkSessionReq('/store/customers/me/reactivate/'),
      {} as never,
      next,
    );
    expect(next).toHaveBeenCalledWith();
  });

  it('passes anonymous traffic straight through', async () => {
    const next = mkNext();
    await blockDisabledCustomerSession(
      { originalUrl: '/store/packs', scope } as never,
      {} as never,
      next,
    );
    expect(next).toHaveBeenCalledWith();
    expect(accountDisabledCause).not.toHaveBeenCalled();
  });
});
```

**This spec fabricates the request, so it cannot prove what Express actually puts on it.** It pins the guard's logic against a request shaped the way the guard expects — nothing more. The only check that proves the carve-out fires against the real framework is Task 7's `POST /store/customers/me/reactivate → 200` on a self-disabled session. That case is load-bearing: do not defer it, skip it, or let it be the one that gets cut for time. If it is red, the customer cannot recover their account and `/disable` (which takes no password) becomes a permanent brick from a stolen token.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd backend/packages/api && corepack yarn test:unit -- disabled-guard
```

Expected: FAIL — `SELF_DISABLED_CODE` is not exported.

- [ ] **Step 3: Update the guards**

In `src/api/utils/disabled-guard.ts`, add the two exports below the existing `DISABLED_MESSAGE` (`:11`):

```ts
/**
 * The self-disable 403 body. A CODE, not prose: the storefront must be able to
 * tell a self-disable from an admin disable to decide whether to offer
 * reactivation, and `src/lib/actions/auth.ts` already shows what regex-matching
 * human copy costs (a pattern deliberately kept tight so it cannot hijack
 * unrelated text). A code has no such failure mode.
 */
export const SELF_DISABLED_CODE = 'ACCOUNT_SELF_DISABLED';

/**
 * The one path a self-disabled session may reach. Exported so the route, the
 * guard and the specs all name it once.
 */
export const REACTIVATE_PATH = '/store/customers/me/reactivate';
```

Replace the `isAccountDisabled` call in `blockDisabledEmailpassLogin` (`:57-60`) with:

```ts
// Only a SELF disable is let through at the token exchange, and the test is
// written that way round on purpose: `=== 'self'` to GRANT, never
// `=== 'admin'` to deny. The inverted form is safe only for exactly the two
// values that exist today — any third one (a future writer, a bad backfill)
// would fall through it as a silent login bypass. A self-disabled customer
// must be able to mint a token, because reactivation is offered only after
// the password is proven: refusing here would announce the account's state to
// anyone who guessed the email, and would leave the customer no way back in.
const cause = await packs.accountDisabledCause(customerId);
if (cause !== null && cause !== 'self') {
  next(new MedusaError(MedusaError.Types.UNAUTHORIZED, DISABLED_MESSAGE));
  return;
}
```

Replace the body check in `blockDisabledCustomerSession` (`:95-99`) with:

```ts
const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
const cause = await packs.accountDisabledCause(auth.actor_id);
if (cause === null) {
  next();
  return;
}
if (cause === 'self') {
  // The single carve-out. It lives HERE, inside the existing guard, rather
  // than as a separate middleware entry: this guard is registered as a
  // blanket method-less '/store/*' matcher, which the routes sorter hoists
  // into the `global` bucket AHEAD of every per-route entry. A
  // separately-registered exception would simply never run.
  //
  // It reads `originalUrl`, NOT `req.path`. Method-less registration takes
  // the framework's `app.use(matcher, handler)` branch, and Express strips
  // the matched prefix there: `req.path` is '/' inside this handler, so a
  // `req.path === REACTIVATE_PATH` test is ALWAYS false and the one path a
  // self-disabled customer is allowed to use would 403 like everything else.
  // The repo's other `req.path` readers all sit on entries carrying
  // `method:`, which does not strip — the difference is the registration.
  // Normalized the same way rate-limit.ts:569 already does it.
  const reqPath = (req.originalUrl ?? '')
    .split('?')[0]
    .toLowerCase()
    .replace(/\/+$/, '');
  if (reqPath === REACTIVATE_PATH) {
    next();
    return;
  }
  next(new MedusaError(MedusaError.Types.FORBIDDEN, SELF_DISABLED_CODE));
  return;
}
next(new MedusaError(MedusaError.Types.FORBIDDEN, DISABLED_MESSAGE));
return;
```

- [ ] **Step 4: Delete `isAccountDisabled`**

Step 3 replaced both of its callers, so `PacksModuleService.isAccountDisabled` (`service.ts:2797-2807`) now has none. Delete it. A boolean that cannot express the cause is precisely the read this task exists to remove, and leaving it means the next writer picks the one that fails open. The typecheck in Task 4 Step 7 is what proves nothing else calls it; if something does, that call site wants `accountDisabledCause` too.

- [ ] **Step 5: Run the test**

```bash
cd backend/packages/api && corepack yarn test:unit -- disabled-guard
```

Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/packages/api/src/api/utils backend/packages/api/src/modules/packs
git commit -m "feat(account): branch the disable guards on cause and allow reactivate"
```

---

## Task 4: Self-disable and reactivate routes

**Files:**

- Create: `backend/packages/api/src/api/store/customers/me/disable/route.ts`
- Create: `backend/packages/api/src/api/store/customers/me/reactivate/route.ts`
- Modify: `backend/packages/api/src/api/middlewares.ts` (new entries near the other `/store/customers/me` ones at `:410-438`)
- Test: `backend/packages/api/src/api/store/customers/me/__tests__/self-service.unit.spec.ts` (create)

**Interfaces:**

- Consumes: `setAccountDisabled` with `cause` (Task 1), `accountDisabledCause` (Task 2), `REACTIVATE_PATH` (Task 3).
- Produces: `POST /store/customers/me/disable` → `{ disabled: true }`; `POST /store/customers/me/reactivate` → `{ disabled: false }`.

- [ ] **Step 1: Write the failing unit test**

Create `src/api/store/customers/me/__tests__/self-service.unit.spec.ts`:

```ts
import { POST as disablePOST } from '../disable/route';
import { POST as reactivatePOST } from '../reactivate/route';

const setAccountDisabled = jest.fn();
const accountDisabledCause = jest.fn();

const scope = {
  resolve: jest.fn(() => ({ setAccountDisabled, accountDisabledCause })),
};

const mkRes = () => {
  const res = { json: jest.fn(), status: jest.fn(), setHeader: jest.fn() };
  res.status.mockReturnValue(res);
  return res as never;
};

const mkReq = (actorId = 'cus_1') =>
  ({ auth_context: { actor_id: actorId }, body: null, scope }) as never;

beforeEach(() => {
  setAccountDisabled.mockReset().mockResolvedValue({ disabled: true });
  accountDisabledCause.mockReset();
});

describe('POST /store/customers/me/disable', () => {
  it('self-disables with cause=self and the customer as actor', async () => {
    const res = mkRes();
    await disablePOST(mkReq(), res);
    expect(setAccountDisabled).toHaveBeenCalledWith({
      customerId: 'cus_1',
      adminId: 'cus_1',
      disabled: true,
      reason: 'Customer disabled their own account.',
      cause: 'self',
    });
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      disabled: true,
    });
  });

  it('401s a register-phase token (empty actor_id) before writing', async () => {
    await expect(disablePOST(mkReq(''), mkRes())).rejects.toThrow(
      /unauthorized/i,
    );
    expect(setAccountDisabled).not.toHaveBeenCalled();
  });
});

describe('POST /store/customers/me/reactivate', () => {
  it('reactivates a self-disabled account', async () => {
    accountDisabledCause.mockResolvedValue('self');
    setAccountDisabled.mockResolvedValue({ disabled: false });
    const res = mkRes();
    await reactivatePOST(mkReq(), res);
    expect(setAccountDisabled).toHaveBeenCalledWith({
      customerId: 'cus_1',
      adminId: 'cus_1',
      disabled: false,
      reason: 'Customer reactivated their own account.',
      cause: 'self',
    });
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      disabled: false,
    });
  });

  // The guard already blocks an admin-disabled session before this route runs;
  // this asserts the route refuses on its own too, so correctness does not
  // depend on middleware ordering.
  it('403s an admin-disabled account without writing', async () => {
    accountDisabledCause.mockResolvedValue('admin');
    await expect(reactivatePOST(mkReq(), mkRes())).rejects.toThrow(
      /has been disabled/i,
    );
    expect(setAccountDisabled).not.toHaveBeenCalled();
  });

  it('is a no-op success when the account is not disabled', async () => {
    accountDisabledCause.mockResolvedValue(null);
    const res = mkRes();
    await reactivatePOST(mkReq(), res);
    expect(setAccountDisabled).not.toHaveBeenCalled();
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      disabled: false,
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd backend/packages/api && corepack yarn test:unit -- self-service
```

Expected: FAIL — cannot resolve `../disable/route`.

- [ ] **Step 3: Write the disable route**

Create `src/api/store/customers/me/disable/route.ts`:

```ts
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';

// POST /store/customers/me/disable — the customer's own reversible disable.
//
// Orthogonal to the admin §4.2 lever and to `frozen`: this touches no funds and
// no admin state, it only blocks the account until the customer logs back in
// and reactivates. Idempotent — disabling an already-self-disabled account is a
// no-op success, because a double-submit must not be an error.
//
// An ADMIN-disabled customer never reaches this handler: the blanket /store/*
// session guard rejects their request first.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  // adminId carries the customer's own id: the audit row records who acted, and
  // for a self-service action that is the customer. The reason string is what
  // support sees in the audit timeline, so it says plainly that this was not an
  // operator action.
  await packs.setAccountDisabled({
    customerId,
    adminId: customerId,
    disabled: true,
    reason: 'Customer disabled their own account.',
    cause: 'self',
  });
  res.json({ disabled: true });
}
```

- [ ] **Step 4: Write the reactivate route**

Create `src/api/store/customers/me/reactivate/route.ts`:

```ts
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';

const DISABLED_MESSAGE =
  'This account has been disabled. Please contact support.';

// POST /store/customers/me/reactivate — lifts a customer's OWN disable.
//
// The one path the session guard lets a self-disabled bearer reach. It
// re-checks the cause itself rather than trusting that carve-out, so an admin
// disable can never be lifted here even if the guard were rewired: an admin
// block is a support decision and only /admin/customers/:id/enable undoes it.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const cause = await packs.accountDisabledCause(customerId);
  if (cause === 'admin') {
    throw new MedusaError(MedusaError.Types.FORBIDDEN, DISABLED_MESSAGE);
  }
  // Already active — idempotent success, so a retry or a double-submit from the
  // login prompt is not an error.
  if (cause === null) {
    res.json({ disabled: false });
    return;
  }
  await packs.setAccountDisabled({
    customerId,
    adminId: customerId,
    disabled: false,
    reason: 'Customer reactivated their own account.',
    cause: 'self',
  });
  res.json({ disabled: false });
}
```

- [ ] **Step 5: Run the tests**

```bash
cd backend/packages/api && corepack yarn test:unit -- self-service
```

Expected: PASS (5 tests).

- [ ] **Step 6: Register both routes in middlewares**

In `src/api/middlewares.ts`, immediately after the `/store/customers/me/addresses/*` entry (ends `:438`), add:

```ts
    // Customer self-service account lifecycle. Rate-limited on the delivery
    // write tier — rare, deliberate mutations, same class as saving a payout
    // destination. authenticate() FIRST: the array is the execution order, and
    // the limiter keys on auth_context.actor_id, so an unauthenticated request
    // must 401 before it consumes anyone's budget.
    //
    // No disabled-session guard and no Cache-Control entry here: the blanket
    // '/store/*' entry at the end of this array already applies both.
    //
    // The authenticate() call DOES duplicate Medusa's own registration for
    // ALL /store/customers/me* — deliberately, not by oversight. Restricting
    // to ['bearer'] is stricter than the framework default and matches this
    // repo's policy at middlewares.ts:58-64, so it stays; a future reader
    // must not delete it as dead.
    {
      matcher: '/store/customers/me/disable',
      method: 'POST',
      middlewares: [
        authenticate('customer', ['bearer']),
        deliveryWriteRateLimit,
      ],
    },
    {
      matcher: '/store/customers/me/reactivate',
      method: 'POST',
      middlewares: [
        authenticate('customer', ['bearer']),
        deliveryWriteRateLimit,
      ],
    },
```

- [ ] **Step 7: Typecheck**

```bash
cd backend/packages/api && ./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add backend/packages/api/src/api
git commit -m "feat(account): add customer self-disable and reactivate routes"
```

---

## Task 5: Delete preflight — the settlement guards

**Files:**

- Modify: `backend/packages/api/src/modules/packs/service.ts` (append near `rawLedgerBalanceCents`)
- Test: `backend/packages/api/src/modules/packs/__tests__/account-lifecycle.unit.spec.ts` (extend)

**Interfaces:**

- Consumes: `rawLedgerBalanceCents` (Task 2).
- Produces:
  - `export type DeleteBlockReason = 'BALANCE_NOT_ZERO' | 'WITHDRAWAL_PENDING' | 'DEPOSIT_PENDING' | 'CARDS_UNSETTLED' | 'DELIVERY_IN_FLIGHT';`
  - `PacksModuleService.deleteAccountPreflight(customerId: string, sharedContext?): Promise<{ ok: true } | { ok: false; reason: DeleteBlockReason; detail: string }>`

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/packs/__tests__/account-lifecycle.unit.spec.ts`:

```ts
type PreflightSvc = PacksModuleService & {
  rawLedgerBalanceCents: jest.Mock;
  listGlobePayWithdrawals: jest.Mock;
  listGlobePayDeposits: jest.Mock;
  listPulls: jest.Mock;
  listDeliveryOrders: jest.Mock;
};

const mkPreflight = (): PreflightSvc => {
  const svc = Object.create(PacksModuleService.prototype) as PreflightSvc;
  svc.rawLedgerBalanceCents = jest.fn().mockResolvedValue(0);
  svc.listGlobePayWithdrawals = jest.fn().mockResolvedValue([]);
  svc.listGlobePayDeposits = jest.fn().mockResolvedValue([]);
  svc.listPulls = jest.fn().mockResolvedValue([]);
  svc.listDeliveryOrders = jest.fn().mockResolvedValue([]);
  return svc;
};

// @InjectManager forwards a COPY of the context, stamped with its own marker —
// the observed third argument is {"manager":{…},"__type":"MedusaContext"}, so a
// literal `{}` here could never match. objectContaining keeps the assertion
// discriminating: it still proves the context was threaded through.
const CTX_ARG = expect.objectContaining({ __type: 'MedusaContext' });

describe('deleteAccountPreflight', () => {
  it('passes a fully settled account', async () => {
    const svc = mkPreflight();
    await expect(svc.deleteAccountPreflight('cus_1', CTX)).resolves.toEqual({
      ok: true,
    });
  });

  it('blocks a positive balance', async () => {
    const svc = mkPreflight();
    svc.rawLedgerBalanceCents.mockResolvedValue(1250);
    const r = await svc.deleteAccountPreflight('cus_1', CTX);
    expect(r).toMatchObject({ ok: false, reason: 'BALANCE_NOT_ZERO' });
  });

  // The debt case. A clawback-negative account owes us money, and `> 0` would
  // have let it delete its way out.
  it('blocks a NEGATIVE balance', async () => {
    const svc = mkPreflight();
    svc.rawLedgerBalanceCents.mockResolvedValue(-500);
    const r = await svc.deleteAccountPreflight('cus_1', CTX);
    expect(r).toMatchObject({ ok: false, reason: 'BALANCE_NOT_ZERO' });
  });

  it('blocks a held withdrawal', async () => {
    const svc = mkPreflight();
    svc.listGlobePayWithdrawals.mockResolvedValue([{ id: 'w1' }]);
    const r = await svc.deleteAccountPreflight('cus_1', CTX);
    expect(r).toMatchObject({ ok: false, reason: 'WITHDRAWAL_PENDING' });
    expect(svc.listGlobePayWithdrawals).toHaveBeenCalledWith(
      { customer_id: 'cus_1', status: ['pending', 'held'] },
      { take: 1 },
      CTX_ARG,
    );
  });

  // The filter is asserted, not just the outcome: an `expired` deposit can
  // still settle (the reconcile sweep re-reads those rows and credits them),
  // so narrowing this back to 'pending' alone is a live money bug that no
  // outcome-only assertion would catch.
  it('blocks an in-flight deposit, including an expired one', async () => {
    const svc = mkPreflight();
    svc.listGlobePayDeposits.mockResolvedValue([{ id: 'd1' }]);
    const r = await svc.deleteAccountPreflight('cus_1', CTX);
    expect(r).toMatchObject({ ok: false, reason: 'DEPOSIT_PENDING' });
    expect(svc.listGlobePayDeposits).toHaveBeenCalledWith(
      { customer_id: 'cus_1', status: ['pending', 'expired'] },
      { take: 1 },
      CTX_ARG,
    );
  });

  it('blocks unsettled vault cards', async () => {
    const svc = mkPreflight();
    svc.listPulls.mockResolvedValue([{ id: 'p1' }]);
    const r = await svc.deleteAccountPreflight('cus_1', CTX);
    expect(r).toMatchObject({ ok: false, reason: 'CARDS_UNSETTLED' });
    expect(svc.listPulls).toHaveBeenCalledWith(
      { customer_id: 'cus_1', status: ['vaulted', 'delivering'] },
      { take: 1 },
      CTX_ARG,
    );
  });

  it('blocks a delivery that has not reached a terminal status', async () => {
    const svc = mkPreflight();
    svc.listDeliveryOrders.mockResolvedValue([{ id: 'do1' }]);
    const r = await svc.deleteAccountPreflight('cus_1', CTX);
    expect(r).toMatchObject({ ok: false, reason: 'DELIVERY_IN_FLIGHT' });
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd backend/packages/api && corepack yarn test:unit -- account-lifecycle
```

Expected: FAIL — `svc.deleteAccountPreflight is not a function`.

- [ ] **Step 3: Implement the preflight**

Add near the top of `src/modules/packs/service.ts`, beside the other exported types:

```ts
/** Why an account may not be deleted yet. The storefront switches on these. */
export type DeleteBlockReason =
  | 'BALANCE_NOT_ZERO'
  | 'WITHDRAWAL_PENDING'
  | 'DEPOSIT_PENDING'
  | 'CARDS_UNSETTLED'
  | 'DELIVERY_IN_FLIGHT';
```

Then, after `rawLedgerBalanceCents`:

```ts
  // Everything that must be settled before an account may be deleted.
  //
  // A PLAIN READ, holding no lock and running in no transaction — it is
  // @InjectManager, and the delete route calls it bare. Its job is the fast,
  // friendly rejection that hands the customer one actionable reason. The
  // authoritative check is this same method re-run INSIDE
  // purgeAccountPacksData's advisory lock; do not read this comment as a
  // guarantee that the two are one atomic step, because they are not.
  //
  // Order is cheapest-first, and each check returns immediately: the customer
  // gets ONE actionable instruction rather than a list, and a blocked delete
  // costs one query in the common case.
  @InjectManager()
  async deleteAccountPreflight(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<
    { ok: true } | { ok: false; reason: DeleteBlockReason; detail: string }
  > {
    const balanceCents = await this.rawLedgerBalanceCents(
      customerId,
      sharedContext,
    );
    if (balanceCents !== 0) {
      return {
        ok: false,
        reason: 'BALANCE_NOT_ZERO',
        // Negative means the account owes us (a clawback). Both directions are
        // refused; the copy just has to be honest about which one it is.
        detail:
          balanceCents > 0
            ? `Wallet balance is RM ${(balanceCents / 100).toFixed(2)}.`
            : `Account owes RM ${(Math.abs(balanceCents) / 100).toFixed(2)}.`,
      };
    }

    const [withdrawal] = await this.listGlobePayWithdrawals(
      { customer_id: customerId, status: ['pending', 'held'] },
      { take: 1 },
      sharedContext,
    );
    if (withdrawal) {
      return {
        ok: false,
        reason: 'WITHDRAWAL_PENDING',
        detail: 'A withdrawal is still being processed.',
      };
    }

    // Production credits deposits through the reconcile sweep, not the callback,
    // so an in-flight deposit can land hours later and credit an account that
    // no longer has an owner.
    //
    // 'expired' is in this list because it is NOT terminal: the sweep selects
    // expired rows and flips them to 'settled', crediting the customer. The
    // failure it prevents is concrete — the transfer doesn't land, the row
    // expires, the customer deletes at balance 0, the transfer arrives, and
    // the sweep credits an ownerless account.
    const [deposit] = await this.listGlobePayDeposits(
      { customer_id: customerId, status: ['pending', 'expired'] },
      { take: 1 },
      sharedContext,
    );
    if (deposit) {
      return {
        ok: false,
        reason: 'DEPOSIT_PENDING',
        detail: 'A deposit is still being processed.',
      };
    }

    // A vaulted pull is an owned asset the customer can still sell for credits;
    // a delivering one is already on its way out. Either is unsettled value.
    const [pull] = await this.listPulls(
      { customer_id: customerId, status: ['vaulted', 'delivering'] },
      { take: 1 },
      sharedContext,
    );
    if (pull) {
      return {
        ok: false,
        reason: 'CARDS_UNSETTLED',
        detail: 'You still have cards in your vault.',
      };
    }

    // Nothing may still be shipping to an address this purge is about to erase.
    //
    // Expressed as "not terminal" rather than as the list of in-flight
    // statuses: the enumeration is an exact complement TODAY, so a status
    // added later would silently pass the guard — a delete that fails open.
    // The terminal set is the half that does not grow.
    const [delivery] = await this.listDeliveryOrders(
      {
        customer_id: customerId,
        status: { $nin: ['completed', 'canceled'] },
      },
      { take: 1 },
      sharedContext,
    );
    if (delivery) {
      return {
        ok: false,
        reason: 'DELIVERY_IN_FLIGHT',
        detail: 'A delivery is still on its way.',
      };
    }

    return { ok: true };
  }
```

- [ ] **Step 4: Enumerate every NON-TERMINAL deposit status from the model**

Read `src/modules/packs/models/globepay-deposit.ts`, list the full `status` enum, and confirm the filter covers **every** status that is not terminal — not just that `'pending'` exists. The enum today is `['pending','settled','failed','expired']` and the model's own comment says an `expired` row can still settle, which is why the filter is `['pending','expired']`. Cross-check against `jobs/globepay-reconcile.ts` (`:103-129` selects `status: 'expired'`, `:266-268` flips it to `'settled'`) — the sweep is the authority on what "still in flight" means here. If the enum has grown, add the new non-terminal values to BOTH the implementation and the test.

- [ ] **Step 5: Verify `$nin` is supported before relying on it**

The delivery filter uses `status: { $nin: ['completed', 'canceled'] }`. Confirm the generated `list*` filter builder accepts `$nin` — grep `buildWhere` in `@medusajs/utils` (or any existing `$nin`/`$ne` usage in this repo) and, if in doubt, run the one query against the local database. If it is NOT supported, revert to the explicit in-flight enumeration `['requested','processed','ready_to_ship','shipped']` and add a comment tying that list to the `delivery_order` model enum, so the next person who adds a status knows this list must grow with it. Do not leave an unsupported operator in place — it would match nothing and the guard would pass everything.

- [ ] **Step 6: Run the tests**

```bash
cd backend/packages/api && corepack yarn test:unit -- account-lifecycle
```

Expected: PASS (13 tests total in the file).

- [ ] **Step 7: Commit**

```bash
git add backend/packages/api/src/modules/packs
git commit -m "feat(account): add the pre-delete settlement preflight"
```

---

## Task 6: The delete route, the purge, and the account-info read

**Files:**

- Modify: `backend/packages/api/src/modules/packs/service.ts` (add `purgeAccountPacksData`)
- Create: `backend/packages/api/src/api/store/customers/me/delete/route.ts`
- Create: `backend/packages/api/src/api/store/customers/me/account/route.ts`
- Modify: `backend/packages/api/src/api/utils/rate-limit.ts` (a dedicated delete-route limiter)
- Modify: `backend/packages/api/src/api/middlewares.ts`
- Test: `backend/packages/api/src/modules/packs/__tests__/account-lifecycle.unit.spec.ts` (extend — the purge)
- Test: `backend/packages/api/src/api/store/customers/me/__tests__/self-service.unit.spec.ts` (extend — the routes)

**Interfaces:**

- Consumes: `deleteAccountPreflight` (Task 5), `mutateCustomerMetadata` (existing, `service.ts:2983`).
- Produces:
  - `PacksModuleService.purgeAccountPacksData(customerId: string, sharedContext?): Promise<void>`
  - `createAccountDeleteRateLimit(): MiddlewareHandler` exported from `src/api/utils/rate-limit.ts`.
  - `POST /store/customers/me/delete` → `{ deleted: true }`, or on a refusal **400 `{ message: <REASON_CODE> }`** — that is the whole body. The framework's error handler (`framework/dist/http/middlewares/error-handler.js:23-27,86`) serialises only `{ code, type, message }`, so a custom `detail` property on the error is computed and then dropped on the floor. The reason code travels as `message`; Task 8's `DELETE_COPY[reason]` is where the human sentence comes from.
  - `GET /store/customers/me/account` → `{ hasPassword: boolean }`.

- [ ] **Step 1: Write the failing specs**

Test first here as everywhere else — the purge deletes personal data permanently, which is the last place to find out afterwards that a step never ran.

Append the purge spec to `src/modules/packs/__tests__/account-lifecycle.unit.spec.ts`:

```ts
// purgeAccountPacksData is @InjectTransactionManager, which REUSES a provided
// sharedContext.transactionManager and calls the real method — so a bare
// prototype plus a fake `em` drives the whole purge with no database. Idiom:
// customer-metadata-lock.unit.spec.ts:28-51.
type PurgeSvc = PacksModuleService & {
  deleteAccountPreflight: jest.Mock;
  listCustomerAccountStates: jest.Mock;
  createCustomerAccountStates: jest.Mock;
  updateCustomerAccountStates: jest.Mock;
  listAdminActionAudits: jest.Mock;
  createAdminActionAudits: jest.Mock;
};

const mkPurge = () => {
  const svc = Object.create(PacksModuleService.prototype) as PurgeSvc;
  const sql: string[] = [];
  const em = {
    execute: jest.fn(async (query: string) => {
      sql.push(query);
      return [];
    }),
  };
  // The in-lock re-check is part of the method under test, so the fake has to
  // answer it — without this the purge refuses before it scrubs anything.
  svc.deleteAccountPreflight = jest.fn().mockResolvedValue({ ok: true });
  svc.listCustomerAccountStates = jest
    .fn()
    .mockResolvedValue([{ id: 'cas_1' }]);
  svc.createCustomerAccountStates = jest.fn().mockResolvedValue([]);
  svc.updateCustomerAccountStates = jest.fn().mockResolvedValue([]);
  svc.listAdminActionAudits = jest.fn().mockResolvedValue([]);
  svc.createAdminActionAudits = jest.fn().mockResolvedValue([]);
  return { svc, em, sql, ctx: { transactionManager: em } as never };
};

const writesIn = (sql: string[]) =>
  sql.filter((q) => /^\s*(update|delete)/i.test(q));

describe('purgeAccountPacksData', () => {
  it('takes the credit advisory lock FIRST, then re-runs the preflight inside it', async () => {
    const f = mkPurge();
    await f.svc.purgeAccountPacksData('cus_1', f.ctx);
    expect(f.sql[0]).toContain('pg_advisory_xact_lock');
    expect(f.svc.deleteAccountPreflight).toHaveBeenCalled();
    expect(
      f.svc.deleteAccountPreflight.mock.invocationCallOrder[0],
    ).toBeGreaterThan(f.em.execute.mock.invocationCallOrder[0]);
  });

  // The route's preflight runs in no transaction and holds no lock, so on its
  // own it leaves a window — minutes wide in production, because deposits are
  // credited by the reconcile sweep — in which a spin, sell, deposit credit or
  // withdrawal can land and be purged straight through. This re-check is what
  // closes it, so it gets its own test rather than riding on the happy path.
  it('refuses and writes NOTHING when the in-lock re-check fails', async () => {
    const f = mkPurge();
    f.svc.deleteAccountPreflight.mockResolvedValue({
      ok: false,
      reason: 'BALANCE_NOT_ZERO',
      detail: 'Wallet balance is RM 12.50.',
    });
    await expect(f.svc.purgeAccountPacksData('cus_1', f.ctx)).rejects.toThrow(
      /BALANCE_NOT_ZERO/,
    );
    expect(writesIn(f.sql)).toHaveLength(0);
    expect(f.svc.createAdminActionAudits).not.toHaveBeenCalled();
  });

  it('scrubs the retained financial rows and deletes the pure-PII ones', async () => {
    const f = mkPurge();
    await f.svc.purgeAccountPacksData('cus_1', f.ctx);
    const all = f.sql.join('\n');
    expect(all).toContain('globepay_withdrawal');
    expect(all).toContain('right("account_number", 4)');
    // NOT NULL columns, so '' rather than null — a null here is a constraint
    // violation that fails the whole purge on the first real delete.
    expect(all).toContain(`"account_holder_name" = ''`);
    expect(all).toContain('delivery_order');
    expect(all).toContain('"proof_images" = null');
    expect(writesIn(f.sql).join('\n')).toContain(
      'delete from "player_payout_details"',
    );
    expect(writesIn(f.sql).join('\n')).toContain(
      'delete from "notification_read"',
    );
  });

  // The row IS the tombstone. Soft-deleting it re-opens the account:
  // accountDisabledCause reads through listCustomerAccountStates, which
  // excludes soft-deleted rows, so it would return null and the session guard
  // would wave a still-valid bearer straight through.
  it('tombstones the account-state row instead of soft-deleting it', async () => {
    const f = mkPurge();
    await f.svc.purgeAccountPacksData('cus_1', f.ctx);
    expect(f.svc.updateCustomerAccountStates).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          disabled: true,
          disabled_cause: 'admin',
          disabled_reason: 'Account deleted by the customer.',
        }),
      }),
      expect.anything(),
    );
    expect(f.sql.join('\n')).not.toMatch(
      /customer_account_state[\s\S]*deleted_at/i,
    );
  });

  // Most customers have never been disabled or frozen, so they have NO
  // account-state row at all — setAccountDisabled creates it lazily. An update
  // that no-ops for them would leave the commonest account with no tombstone
  // and a bearer that keeps working for the rest of its TTL.
  it('CREATES the tombstone when the customer has no account-state row', async () => {
    const f = mkPurge();
    f.svc.listCustomerAccountStates.mockResolvedValue([]);
    await f.svc.purgeAccountPacksData('cus_1', f.ctx);
    expect(f.svc.createCustomerAccountStates).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          customer_id: 'cus_1',
          disabled: true,
          disabled_cause: 'admin',
        }),
      ],
      expect.anything(),
    );
    expect(f.svc.updateCustomerAccountStates).not.toHaveBeenCalled();
  });

  it('writes the delete_account audit row', async () => {
    const f = mkPurge();
    await f.svc.purgeAccountPacksData('cus_1', f.ctx);
    expect(f.svc.createAdminActionAudits).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          admin_id: 'cus_1',
          entity_id: 'cus_1',
          action: 'delete_account',
        }),
      ],
      expect.anything(),
    );
  });

  // The route is re-runnable after a partial failure, so the audit write has
  // to be too: a trail that grows a row per retry reports one deletion as
  // several.
  it('does not stack a second audit row on a retry', async () => {
    const f = mkPurge();
    f.svc.listAdminActionAudits.mockResolvedValue([{ id: 'aud_1' }]);
    await f.svc.purgeAccountPacksData('cus_1', f.ctx);
    expect(f.svc.createAdminActionAudits).not.toHaveBeenCalled();
  });
});
```

Then extend `src/api/store/customers/me/__tests__/self-service.unit.spec.ts`. The `jest.mock` call and the two `import`s below belong at the TOP of that file, beside Task 4's imports — jest hoists the mock either way, but a mid-file `import` trips the lint rule and reads as an accident:

```ts
// delete/route.ts imports deleteFilesWorkflow at MODULE scope, which pulls the
// whole core-flows barrel into a unit run. Mocked, per the repo's precedent at
// admin/media/__tests__/bake-slab-rebake.unit.spec.ts:23. The run handle is
// hoisted out so the avatar assertion below can read it — jest allows a
// factory to close over a variable whose name starts with `mock`.
const mockRunWorkflow = jest.fn().mockResolvedValue({});
jest.mock('@medusajs/medusa/core-flows', () => ({
  deleteFilesWorkflow: jest.fn(() => ({ run: mockRunWorkflow })),
}));

import { POST as deletePOST } from '../delete/route';
import { GET as accountGET } from '../account/route';

const listAuthIdentities = jest.fn();
const deleteAuthIdentities = jest.fn();
const authenticate = jest.fn();
const deleteAccountPreflight = jest.fn();
const purgeAccountPacksData = jest.fn();
const mutateCustomerMetadata = jest.fn();
const retrieveCustomer = jest.fn();
const listCustomerAddresses = jest.fn();
const deleteCustomerAddresses = jest.fn();
const updateCustomers = jest.fn();
const softDeleteCustomers = jest.fn();
const listNotifications = jest.fn();
const deleteNotifications = jest.fn();

const deleteScope = {
  resolve: jest.fn((key: string) => {
    if (key === 'packs')
      return {
        deleteAccountPreflight,
        purgeAccountPacksData,
        mutateCustomerMetadata,
      };
    if (key === 'auth')
      return { listAuthIdentities, deleteAuthIdentities, authenticate };
    if (key === 'notification')
      return { listNotifications, deleteNotifications };
    if (key === 'logger')
      return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    return {
      retrieveCustomer,
      listCustomerAddresses,
      deleteCustomerAddresses,
      updateCustomers,
      softDeleteCustomers,
    };
  }),
};

const mkDeleteReq = (body: Record<string, unknown> | null = null) =>
  ({
    auth_context: { actor_id: 'cus_1' },
    body,
    scope: deleteScope,
  }) as never;

const withEmailpass = () =>
  listAuthIdentities.mockResolvedValue([
    {
      id: 'authid_1',
      provider_identities: [{ provider: 'emailpass', entity_id: 'a@b.dev' }],
    },
  ]);

describe('POST /store/customers/me/delete', () => {
  beforeEach(() => {
    mockRunWorkflow.mockClear();
    listAuthIdentities.mockReset();
    deleteAuthIdentities.mockReset().mockResolvedValue(undefined);
    authenticate.mockReset().mockResolvedValue({ success: true });
    deleteAccountPreflight.mockReset().mockResolvedValue({ ok: true });
    purgeAccountPacksData.mockReset().mockResolvedValue(undefined);
    mutateCustomerMetadata
      .mockReset()
      .mockImplementation(async ({ mutate }) => mutate({}));
    retrieveCustomer.mockReset().mockResolvedValue({
      id: 'cus_1',
      email: 'a@b.dev',
    });
    listCustomerAddresses.mockReset().mockResolvedValue([]);
    deleteCustomerAddresses.mockReset().mockResolvedValue(undefined);
    updateCustomers.mockReset().mockResolvedValue({});
    softDeleteCustomers.mockReset().mockResolvedValue(undefined);
    listNotifications.mockReset().mockResolvedValue([]);
    deleteNotifications.mockReset().mockResolvedValue(undefined);
  });

  it('requires a password when the account has one', async () => {
    withEmailpass();
    await expect(deletePOST(mkDeleteReq({}), mkRes())).rejects.toThrow(
      /PASSWORD_REQUIRED/,
    );
    expect(purgeAccountPacksData).not.toHaveBeenCalled();
  });

  it('refuses a wrong password before touching any data', async () => {
    withEmailpass();
    authenticate.mockResolvedValue({ success: false });
    await expect(
      deletePOST(mkDeleteReq({ password: 'nope' }), mkRes()),
    ).rejects.toThrow(/PASSWORD_INCORRECT/);
    expect(deleteAccountPreflight).not.toHaveBeenCalled();
    expect(purgeAccountPacksData).not.toHaveBeenCalled();
  });

  // The reason code has to survive as the error MESSAGE, because that is the
  // only field the framework's error handler serialises — the storefront
  // matches on it.
  it('surfaces the preflight reason and purges nothing', async () => {
    withEmailpass();
    deleteAccountPreflight.mockResolvedValue({
      ok: false,
      reason: 'BALANCE_NOT_ZERO',
      detail: 'Wallet balance is RM 12.50.',
    });
    await expect(
      deletePOST(mkDeleteReq({ password: 'right' }), mkRes()),
    ).rejects.toThrow(/BALANCE_NOT_ZERO/);
    expect(purgeAccountPacksData).not.toHaveBeenCalled();
    expect(deleteAuthIdentities).not.toHaveBeenCalled();
  });

  it('skips the password step for a Google-only account', async () => {
    listAuthIdentities.mockResolvedValue([
      { id: 'authid_g', provider_identities: [{ provider: 'google' }] },
    ]);
    const res = mkRes();
    await deletePOST(mkDeleteReq({}), res);
    expect(authenticate).not.toHaveBeenCalled();
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      deleted: true,
    });
  });

  // Ordering IS the retry story, so it gets pinned rather than left to the
  // reader. Everything that can still fail runs while the row is live and
  // loginable; the soft delete — which would make a re-run impossible, because
  // mutateCustomerMetadata cannot see a soft-deleted row — goes last.
  it('soft-deletes the customer only after every step that can fail', async () => {
    withEmailpass();
    await deletePOST(mkDeleteReq({ password: 'right' }), mkRes());
    const softDelete = softDeleteCustomers.mock.invocationCallOrder[0];
    expect(purgeAccountPacksData.mock.invocationCallOrder[0]).toBeLessThan(
      softDelete,
    );
    expect(mutateCustomerMetadata.mock.invocationCallOrder[0]).toBeLessThan(
      softDelete,
    );
    expect(updateCustomers.mock.invocationCallOrder[0]).toBeLessThan(
      softDelete,
    );
    expect(deleteAuthIdentities.mock.invocationCallOrder[0]).toBeLessThan(
      softDelete,
    );
  });

  it('clears the metadata blob while the row is still live', async () => {
    withEmailpass();
    await deletePOST(mkDeleteReq({ password: 'right' }), mkRes());
    expect(mutateCustomerMetadata.mock.invocationCallOrder[0]).toBeLessThan(
      softDeleteCustomers.mock.invocationCallOrder[0],
    );
    // The mutator must return an EMPTY blob — bank accounts, handle, avatar
    // and frame all live in it.
    const { mutate } = mutateCustomerMetadata.mock.calls[0][0];
    expect(mutate({ bank_accounts: [{}], handle: 'x' })).toEqual({});
  });

  it('scrubs the email to the tombstone address', async () => {
    withEmailpass();
    await deletePOST(mkDeleteReq({ password: 'right' }), mkRes());
    expect(updateCustomers).toHaveBeenCalledWith('cus_1', {
      email: 'deleted_cus_1@removed.invalid',
      first_name: null,
      last_name: null,
      phone: null,
    });
  });

  // notification rows are keyed by EMAIL, not customer_id, and `to` holds the
  // address verbatim — so they are personal data in their own right, and they
  // have to go before the scrub above overwrites the address that finds them.
  it('deletes the notification rows addressed to the customer, before the email scrub', async () => {
    withEmailpass();
    listNotifications.mockResolvedValue([{ id: 'noti_1' }, { id: 'noti_2' }]);
    await deletePOST(mkDeleteReq({ password: 'right' }), mkRes());
    expect(listNotifications).toHaveBeenCalledWith({ to: 'a@b.dev' });
    expect(deleteNotifications).toHaveBeenCalledWith(['noti_1', 'noti_2']);
    expect(deleteNotifications.mock.invocationCallOrder[0]).toBeLessThan(
      updateCustomers.mock.invocationCallOrder[0],
    );
  });

  // The avatar id is read inside the SAME callback that empties the blob, so
  // it has to be captured out of it — on a retry the blob is already {} and
  // the Spaces object would never be deleted at all.
  it('deletes the avatar object with the id captured from the blob', async () => {
    withEmailpass();
    mutateCustomerMetadata.mockImplementation(async ({ mutate }) =>
      mutate({ avatar_file_id: 'file_1', handle: 'x' }),
    );
    await deletePOST(mkDeleteReq({ password: 'right' }), mkRes());
    expect(mockRunWorkflow).toHaveBeenCalledWith({
      input: { ids: ['file_1'] },
    });
  });

  it('does not call the file workflow when there is no avatar', async () => {
    withEmailpass();
    await deletePOST(mkDeleteReq({ password: 'right' }), mkRes());
    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });
});

describe('GET /store/customers/me/account', () => {
  it('reports hasPassword true for an emailpass account', async () => {
    withEmailpass();
    const res = mkRes();
    await accountGET(mkDeleteReq(), res);
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      hasPassword: true,
    });
  });

  it('reports hasPassword false for a Google-only account', async () => {
    listAuthIdentities.mockResolvedValue([
      { id: 'authid_g', provider_identities: [{ provider: 'google' }] },
    ]);
    const res = mkRes();
    await accountGET(mkDeleteReq(), res);
    expect((res as { json: jest.Mock }).json).toHaveBeenCalledWith({
      hasPassword: false,
    });
  });
});
```

- [ ] **Step 2: Run both and watch them fail**

```bash
cd backend/packages/api && corepack yarn test:unit -- account-lifecycle
```

```bash
cd backend/packages/api && corepack yarn test:unit -- self-service
```

Expected: FAIL — `svc.purgeAccountPacksData is not a function`, and `cannot resolve '../delete/route'`.

- [ ] **Step 3: Verify the two scrubbed tables' NOT NULL columns**

Read `src/modules/packs/models/globepay-withdrawal.ts` and `models/delivery-order.ts` and confirm which scrubbed columns are non-nullable. `account_holder_name`, `ship_name`, `ship_address_1`, `ship_city` and `ship_postal_code` are non-nullable, which is why the SQL below writes `''` rather than `null` for them; `ship_address_2`, `ship_province`, `ship_phone` and `proof_images` are nullable and get `null`. If a column's nullability differs from that, fix the SQL — a NOT NULL violation here fails the whole purge.

- [ ] **Step 4: Verify the notification module's method names and address column**

Read `INotificationModuleService` in `@medusajs/types` (and `subscribers/password-reset.ts:118-123` for a real write) and confirm that `listNotifications({ to })` and `deleteNotifications(ids)` are the real names and that `to` is the column holding the address. If either differs, fix the CALL in Step 6 and the assertion in Step 1 to the real names — do not leave them disagreeing, and do not skip the deletion because the API is shaped differently than expected.

- [ ] **Step 5: Implement the packs-side purge**

In `src/modules/packs/service.ts`, after `deleteAccountPreflight`:

```ts
  // The packs-module half of an account deletion: scrub the personal data out
  // of the rows we KEEP, and delete the rows that are pure personal data.
  //
  // Transactional within this module. The rest of the purge (customer row,
  // notifications, auth identities, avatar object) lives in other modules and
  // cannot join this transaction — see the route for the ordering that makes a
  // partial failure recoverable.
  //
  // What is deliberately NOT touched: credit_transaction, ledger_entry,
  // globepay_deposit, pull, commission, vip_member_state and
  // referral_relationship. Those are the business books. They carry only a
  // customer_id that no longer resolves to a person, and the referral rows in
  // particular must survive or a downline's upline dangles.
  @InjectTransactionManager()
  async purgeAccountPacksData(
    customerId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<void> {
    const em = sharedContext.transactionManager as unknown as LedgerSqlManager;
    await em.execute('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `credit:${customerId}`,
    ]);
    // Re-check INSIDE the lock. The route's earlier preflight is the fast,
    // friendly rejection that gives the customer an actionable reason; THIS one
    // is the correctness gate. Without it a spin, sell, deposit credit or
    // withdrawal landing between the two calls would be purged straight
    // through — and that window is minutes wide in production, because
    // deposits are credited by the reconcile sweep rather than the callback.
    const check = await this.deleteAccountPreflight(customerId, sharedContext);
    if (!check.ok) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, check.reason);
    }

    // Retained financial rows, scrubbed to the operator-chosen minimum: the
    // amounts, statuses, gateway ids and timestamps that make the books
    // reconcile stay; the counterparty identity goes. Last 4 of the account
    // number is kept for the same reason setPayoutDetails keeps it in its audit
    // row — a same-bank redirect is otherwise indistinguishable from a no-op.
    await em.execute(
      `update "globepay_withdrawal"
          set "account_number" = right("account_number", 4),
              "account_holder_name" = ''
        where "customer_id" = ?`,
      [customerId],
    );
    // proof_images goes with the address fields, not with the tracking number:
    // a doorstep photo can show the label or the recipient, which re-exposes
    // exactly what the ship_* scrub removes. NOTE the column holds admin-typed
    // http(s) URLs, not file-provider ids (admin/delivery-orders/validate.ts:126),
    // so nulling it removes our copy of the reference — an object hosted in our
    // own bucket still needs an operator sweep, and there is no id to hand the
    // file workflow.
    await em.execute(
      `update "delivery_order"
          set "ship_name" = '', "ship_address_1" = '', "ship_address_2" = null,
              "ship_city" = '', "ship_province" = null, "ship_postal_code" = '',
              "ship_phone" = null, "proof_images" = null
        where "customer_id" = ?`,
      [customerId],
    );

    // Pure personal data, no business value — deleted outright.
    await em.execute(
      `delete from "player_payout_details" where "customer_id" = ?`,
      [customerId],
    );
    await em.execute(`delete from "notification_read" where "customer_id" = ?`, [
      customerId,
    ]);

    // The account-state row is the TOMBSTONE, not garbage. Soft-deleting it is
    // what would re-open the account: accountDisabledCause reads through
    // listCustomerAccountStates, which excludes soft-deleted rows, so it would
    // return null and the session guard would wave requests through — and a
    // bearer minted before the delete keeps verifying for up to a day (JWT auth
    // does no DB lookup and medusa-config.ts sets no jwtExpiresIn, so the
    // framework default "1d" applies). Cause 'admin', never 'self', so the
    // reactivate carve-out can never apply to a deleted account.
    //
    // Upsert, not a bare UPDATE: most customers have never been disabled or
    // frozen and therefore have NO row at all (setAccountDisabled creates it
    // lazily, service.ts:2699-2718), and an update that no-ops for them would
    // leave the commonest account with no tombstone at all.
    const tombstone = {
      disabled: true,
      disabled_cause: 'admin' as const,
      disabled_reason: 'Account deleted by the customer.',
      disabled_at: new Date(),
    };
    const [state] = await this.listCustomerAccountStates(
      { customer_id: customerId },
      { take: 1 },
      sharedContext,
    );
    if (state) {
      await this.updateCustomerAccountStates(
        { selector: { id: state.id }, data: tombstone },
        sharedContext,
      );
    } else {
      await this.createCustomerAccountStates(
        [{ customer_id: customerId, ...tombstone }],
        sharedContext,
      );
    }

    // Idempotent: the route is re-runnable after a partial failure, and an
    // audit trail that grows a row per retry reports one deletion as several.
    const [existingAudit] = await this.listAdminActionAudits(
      { entity_id: customerId, action: 'delete_account' },
      { take: 1 },
      sharedContext,
    );
    if (!existingAudit) {
      await this.createAdminActionAudits(
        [
          {
            admin_id: customerId,
            entity_type: 'customer',
            entity_id: customerId,
            action: 'delete_account',
            before: { deleted: false },
            after: { deleted: true },
            reason: 'Customer deleted their own account.',
          },
        ],
        sharedContext,
      );
    }
  }
```

- [ ] **Step 6: Write the delete route**

Create `src/api/store/customers/me/delete/route.ts`:

```ts
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from '@medusajs/framework/utils';
import type {
  IAuthModuleService,
  ICustomerModuleService,
  INotificationModuleService,
  Logger,
} from '@medusajs/framework/types';
import { deleteFilesWorkflow } from '@medusajs/medusa/core-flows';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';

/**
 * The emailpass identity for a customer, or null when they signed up with
 * Google only. Resolved through the AUTH IDENTITY rather than customer.email
 * for the same reason the login guard does it: nothing reconciles the customer
 * row's email column with provider_identities.entity_id.
 */
async function emailpassEntityId(
  auth: IAuthModuleService,
  customerId: string,
): Promise<string | null> {
  const identities = await auth.listAuthIdentities(
    { app_metadata: { customer_id: customerId } },
    { relations: ['provider_identities'] },
  );
  for (const identity of identities) {
    for (const provider of identity.provider_identities ?? []) {
      if (provider.provider === 'emailpass') return provider.entity_id;
    }
  }
  return null;
}

// POST /store/customers/me/delete — permanent, customer-initiated deletion.
//
// Personal data is destroyed and login becomes impossible forever; the money
// records survive as anonymous books (see purgeAccountPacksData).
//
// This is NOT one transaction, and pretending otherwise would mislead whoever
// reads it next: the purge spans the packs module, the customer module, the
// notification module, the auth module and the file provider, and a Medusa
// sharedContext covers one module only. What holds instead is ordering plus
// idempotency — the handler can simply be re-run after a partial failure, and
// the auth identities (the point of no return for logging in) are destroyed
// only after everything that could still fail has succeeded.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const logger = req.scope.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  const auth = req.scope.resolve<IAuthModuleService>(Modules.AUTH);
  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const notifications = req.scope.resolve<INotificationModuleService>(
    Modules.NOTIFICATION,
  );
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  // 1. Proof of intent. An account with a password must prove it; a Google-only
  //    account has none to prove, and the typed-DELETE confirmation in the UI is
  //    its only gate (accepted risk, recorded in the spec).
  const entityId = await emailpassEntityId(auth, customerId);
  if (entityId) {
    const password = (req.body as { password?: unknown } | null)?.password;
    if (typeof password !== 'string' || password === '') {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'PASSWORD_REQUIRED',
      );
    }
    // No cast: every field of AuthenticationInput is optional, so the body-only
    // shape typechecks as it stands — the same call the phone-change route
    // already makes at phone-verification/change/route.ts:151-153.
    const attempt = await auth.authenticate('emailpass', {
      body: { email: entityId, password },
    });
    if (!attempt.success) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'PASSWORD_INCORRECT',
      );
    }
  }

  // 2. Settlement guards. `reason` is the whole client-facing contract: the
  //    framework's error handler sends only { code, type, message }, so a
  //    `detail` property on the error would be silently dropped. The sentence
  //    the customer reads comes from the storefront's DELETE_COPY map; the
  //    numbers live in the log line below, where support can find them.
  const preflight = await packs.deleteAccountPreflight(customerId);
  if (!preflight.ok) {
    logger.info(
      `[account-delete] refused ${customerId}: ${preflight.reason} — ${preflight.detail}`,
    );
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, preflight.reason);
  }

  // 3. Packs-side scrub + delete + audit (one packs transaction, which re-runs
  //    the guards above under the credit advisory lock).
  await packs.purgeAccountPacksData(customerId);
  logger.info(`[account-delete] packs data purged for ${customerId}`);

  // 4. Notification rows. Keyed by EMAIL, not customer_id — `notification.to`
  //    stores the address verbatim, and the payloads carry reset URLs, bank
  //    names and last4 — so these are personal data in their own right and the
  //    "anonymous books" rationale does not reach them. Read the address and
  //    delete them BEFORE the scrub below overwrites it. If this step fails the
  //    address is still intact, so a re-run finds the rows again.
  const { email } = await customers.retrieveCustomer(customerId);
  const addressed = await notifications.listNotifications({ to: email });
  if (addressed.length > 0) {
    await notifications.deleteNotifications(addressed.map((n) => n.id));
  }
  logger.info(
    `[account-delete] ${addressed.length} notification(s) removed for ${customerId}`,
  );

  // 5. Customer-side. Addresses first, then the metadata blob — which holds the
  //    saved bank accounts, the public handle and the avatar — then the row's
  //    own identity columns.
  //
  //    The metadata clear MUST precede the soft delete: mutateCustomerMetadata
  //    is scoped `AND deleted_at IS NULL` and raises NOT_FOUND against an
  //    already-soft-deleted row.
  const addresses = await customers.listCustomerAddresses({
    customer_id: customerId,
  });
  if (addresses.length > 0) {
    await customers.deleteCustomerAddresses(addresses.map((a) => a.id));
  }
  // Boxed because the id is read inside the SAME callback that empties the
  // blob: a plain `let` assigned only in a callback narrows to `never` at the
  // `if` below, and re-reading the blob afterwards would find {} — on a retry
  // the avatar object would then never be deleted at all. The repo's own idiom
  // returns the previous id alongside the new blob
  // (store/profile/avatar/route.ts:43-58).
  const captured: { avatarFileId: string | null } = { avatarFileId: null };
  await packs.mutateCustomerMetadata({
    customerId,
    mutate: (metadata) => {
      captured.avatarFileId =
        typeof metadata.avatar_file_id === 'string'
          ? metadata.avatar_file_id
          : null;
      return {};
    },
  });
  await customers.updateCustomers(customerId, {
    // The scrub is required because the email IS personal data. It is NOT what
    // frees the address for a future signup — IDX_customer_email_has_account_
    // unique is partial (WHERE deleted_at IS NULL), so the soft delete below
    // already releases that slot.
    email: `deleted_${customerId}@removed.invalid`,
    first_name: null,
    last_name: null,
    phone: null,
  });
  logger.info(`[account-delete] customer row scrubbed for ${customerId}`);

  // 6. Auth identities — the point of no return, and last among the steps that
  //    can still fail.
  //
  //    HARD delete, never softDeleteAuthIdentities:
  //    IDX_provider_identity_provider_entity_id on (entity_id, provider) has NO
  //    deleted_at predicate, so a soft-deleted identity would keep occupying
  //    the (email, 'emailpass') slot forever and lock this person out of ever
  //    signing up again. No deleteProviderIdentities follow-up is needed:
  //    provider_identity.auth_identity_id is ON DELETE CASCADE
  //    (@medusajs/auth Migration20240529080336), so the child rows go with it.
  //
  //    This is also why we do NOT use Medusa's own removeCustomerAccountWorkflow
  //    (core-flows/customer/workflows/remove-customer-account). That workflow
  //    only UNLINKS the identity — setAuthAppMetadataStep(value: null) — and
  //    leaves the provider_identity row, and with it the customer's email
  //    address, in the database permanently. For a flow whose entire purpose is
  //    erasing personal data that is the wrong outcome twice over: the email
  //    survives as PII, and its unique slot stays taken so the person can never
  //    register again.
  const identities = await auth.listAuthIdentities({
    app_metadata: { customer_id: customerId },
  });
  if (identities.length > 0) {
    await auth.deleteAuthIdentities(identities.map((i) => i.id));
  }
  logger.info(`[account-delete] auth identities removed for ${customerId}`);

  // 7. Soft-delete the customer row — AFTER the identities, and this order is
  //    load-bearing for the retry story.
  //
  //    mutateCustomerMetadata (step 5) is scoped `AND deleted_at IS NULL`, so it
  //    raises NOT_FOUND against an already-soft-deleted row. Soft-deleting
  //    before the identity delete would therefore make a failure at step 6
  //    unrecoverable: the re-run would die at step 5, and the customer could not
  //    even reach the page to trigger it, because getCustomer() cannot read a
  //    soft-deleted row. With the soft delete last, every step that can fail
  //    runs against a live row and the whole route is re-runnable — though once
  //    step 6 has run, only for as long as the already-minted bearer lives.
  await customers.softDeleteCustomers([customerId]);
  logger.info(`[account-delete] customer soft-deleted: ${customerId}`);

  // 8. Best-effort avatar cleanup. A file-provider outage must never be what
  //    fails an account deletion — same discipline as the avatar-replace path.
  if (captured.avatarFileId) {
    await deleteFilesWorkflow(req.scope)
      .run({ input: { ids: [captured.avatarFileId] } })
      .catch(() => undefined);
  }

  res.json({ deleted: true });
}
```

- [ ] **Step 7: Write the account-info route**

Create `src/api/store/customers/me/account/route.ts`:

```ts
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { IAuthModuleService } from '@medusajs/framework/types';

// GET /store/customers/me/account — what the Settings page needs to render the
// Danger zone correctly before the customer clicks anything.
//
// `hasPassword` is false for a Google-only signup, which changes the delete
// modal: there is no password to ask for. Answering it up front is the
// difference between a correct form and a Delete button that always fails.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const auth = req.scope.resolve<IAuthModuleService>(Modules.AUTH);
  const identities = await auth.listAuthIdentities(
    { app_metadata: { customer_id: customerId } },
    { relations: ['provider_identities'] },
  );
  const hasPassword = identities.some((identity) =>
    (identity.provider_identities ?? []).some(
      (provider) => provider.provider === 'emailpass',
    ),
  );
  res.json({ hasPassword });
}
```

- [ ] **Step 8: Give the delete route its own rate-limit tier**

In `src/api/utils/rate-limit.ts`, beside the other factories, add:

```ts
/**
 * The account-delete limiter. The route takes a password, so an unthrottled
 * one is a password oracle — but the generic `createAuthRateLimit` is the
 * WRONG throttle for it: with no `keyOf` it keys on `auth_context.actor_id`
 * (already populated by authenticate()), giving a per-customer 50/10s + 300/60s
 * budget. That is looser than the write tier it would stack with, so stacking
 * adds nothing, and ~90× looser than the login path that guards the same
 * secret. These numbers mirror createAuthIdentifierRateLimit instead, because
 * that is the tier bounding password guesses per account. Env-tunable:
 * ACCOUNT_DELETE_RATE_BURST_LIMIT / _BURST_WINDOW_MS (default 3/60s)
 * ACCOUNT_DELETE_RATE_LIMIT / _WINDOW_MS (default 20/1h)
 */
export function createAccountDeleteRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'account-delete',
    message: 'Too many delete attempts for this account.',
    defaults: {
      burstLimit: 3,
      burstWindowMs: 60_000,
      limit: 20,
      windowMs: 3_600_000,
    },
  });
}
```

- [ ] **Step 9: Register both routes in middlewares**

In `src/api/middlewares.ts`, beside the Task 4 entries — and add `createAccountDeleteRateLimit` to the rate-limit import plus an `accountDeleteRateLimit` handle where the other limiters are instantiated:

```ts
    {
      matcher: '/store/customers/me/delete',
      method: 'POST',
      // The delete tier ONLY — not authRateLimit as well. That limiter keys on
      // actor_id here, which makes it strictly weaker than the write tier and
      // no throttle at all on a password field; see its comment in
      // rate-limit.ts. authenticate() stays first so an unauthenticated request
      // 401s before it consumes anyone's budget.
      middlewares: [
        authenticate('customer', ['bearer']),
        accountDeleteRateLimit,
      ],
    },
    {
      matcher: '/store/customers/me/account',
      method: 'GET',
      middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
    },
```

- [ ] **Step 10: Run both unit specs**

```bash
cd backend/packages/api && corepack yarn test:unit -- account-lifecycle
```

Expected: PASS (20 tests in the file).

```bash
cd backend/packages/api && corepack yarn test:unit -- self-service
```

Expected: PASS (17 tests in the file). If `auth.authenticate`'s second argument trips the type checker, fix the call shape — do not weaken it to `any`.

- [ ] **Step 11: Typecheck**

```bash
cd backend/packages/api && ./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add backend/packages/api/src
git commit -m "feat(account): add the customer account deletion route and purge"
```

---

## Task 6b: Stop value accruing to a deleted account

**Two independent paths can pay a customer who no longer exists.** Both mint value AFTER the deletion, so no delete-time preflight can cover either — a guard cannot see a payment that has not happened yet. Both are fixed at the paying end.

**Path 1 — the weekly challenge.** It is LIVE, and `pull` rows are retained by design, so a deleted customer stays in the week's top-10 and `settleChallengeWeek` mints them real balance and a real card at settle. The spec excluded `vip_reward_grant` because those surfaces are SUSPENDED; nothing excluded this one, because nothing looked at it.

**Path 2 — referral commission.** The purge deliberately RETAINS `referral_relationship` rows, because deleting one dangles a downline's upline. But the commission fan-out in `settleOpen` is gated on exactly that lookup (`service.ts:3316-3320`), so every time a surviving recruit opens a pack, commission credits land on the deleted sponsor's ownerless account — indefinitely, and invisibly to any preflight, because at preflight time the row does not exist yet.

The fan-out is SUSPENDED in the sense that `linkSponsor`, its only writer, was removed, so no NEW edge can form. That bounds the blast radius; it does not close it. The code's own comment says surviving production edges "still pay, which is deliberate", and the 2026-07-25 referral investigation confirmed real edges exist in production. So this is reachable today, just rare.

Note what is NOT being changed: the retention decision stands. Severing referral edges at purge would dangle the downline's upline and rewrite commission attribution — a money change disguised as a cleanup, which is exactly what `settleOpen`'s comment warns against. Skipping the payment is the smaller, reversible fix.

**Files:**

- Modify: `backend/packages/api/src/modules/packs/service.ts` — `settleChallengeWeek`'s winner loop (`:7221`) AND the commission fan-out in `settleOpen` (`:3316-3320`)
- Test: `backend/packages/api/src/modules/packs/__tests__/account-lifecycle.unit.spec.ts` (extend)

**Be careful in `settleOpen`.** It is the atomic open-settlement seam — debit plus fan-out under ONE advisory lock — and its own comment asks that changes to it not be folded into a cleanup commit. Add the guard, change nothing else, and thread the caller's `sharedContext` so the read joins the existing transaction rather than opening a second connection.

Note `src/jobs/settle-challenge-week.ts` is NOT touched: it only wires `getStock`/`decrementStock`/`onSettled` and its `onSettled` runs after each winner's transaction has already committed, which is far too late to skip anyone. The loop that decides who gets paid is in the service.

**Interfaces:**

- Consumes: the `delete_account` audit row written by `purgeAccountPacksData` (Task 6).
- Produces: `PacksModuleService.deletedCustomerIds(customerIds: string[], sharedContext?): Promise<Set<string>>`, and a `settleChallengeWeek` that pays nobody in that set.

- [ ] **Step 1: Write the failing test**

Append to `src/modules/packs/__tests__/account-lifecycle.unit.spec.ts`:

```ts
describe('deletedCustomerIds', () => {
  it('returns the ids that have a delete_account audit row', async () => {
    const svc = Object.create(
      PacksModuleService.prototype,
    ) as PacksModuleService & { listAdminActionAudits: jest.Mock };
    svc.listAdminActionAudits = jest
      .fn()
      .mockResolvedValue([{ entity_id: 'cus_2' }]);
    await expect(
      svc.deletedCustomerIds(['cus_1', 'cus_2'], CTX),
    ).resolves.toEqual(new Set(['cus_2']));
    expect(svc.listAdminActionAudits).toHaveBeenCalledWith(
      { entity_id: ['cus_1', 'cus_2'], action: 'delete_account' },
      { take: 2 },
      CTX_ARG,
    );
  });

  it('does not query at all for an empty ranking', async () => {
    const svc = Object.create(
      PacksModuleService.prototype,
    ) as PacksModuleService & { listAdminActionAudits: jest.Mock };
    svc.listAdminActionAudits = jest.fn();
    await expect(svc.deletedCustomerIds([], CTX)).resolves.toEqual(new Set());
    expect(svc.listAdminActionAudits).not.toHaveBeenCalled();
  });
});

describe('settleChallengeWeek — deleted winners', () => {
  // Enough of the enumerator to reach the loop: everything it reads before
  // paying anyone, stubbed with the smallest shape that satisfies it.
  const mkSettle = (deleted: string[]) => {
    const svc = Object.create(
      PacksModuleService.prototype,
    ) as PacksModuleService & Record<string, jest.Mock>;
    svc.challengeSettings = jest.fn().mockResolvedValue({
      timezone: 'Asia/Kuala_Lumpur',
      reset_day: 1,
      reset_hour: 0,
    });
    svc.challengeWeekBounds = jest.fn().mockResolvedValue({
      startUtc: new Date('2026-08-03T00:00:00Z'),
      endUtc: new Date('2026-08-10T00:00:00Z'),
    });
    svc.listChallengePayouts = jest.fn().mockResolvedValue([]);
    svc.listChallengeStages = jest.fn().mockResolvedValue([
      {
        stage_number: 1,
        threshold_myr: 0,
        rank_rewards: [{ rank: 1, credits: 100, cardIds: [] }],
      },
    ]);
    svc.challengeWeekPool = jest.fn().mockResolvedValue(9_999);
    svc.challengeWeekTop = jest
      .fn()
      .mockResolvedValue([{ customer_id: 'cus_gone' }]);
    svc.listCards = jest.fn().mockResolvedValue([]);
    svc.deletedCustomerIds = jest.fn().mockResolvedValue(new Set(deleted));
    svc.settleChallengeWinner = jest.fn().mockResolvedValue(null);
    svc.reserveSettledStock = jest.fn().mockResolvedValue(undefined);
    return svc;
  };

  // Real balance and a real card, minted to an account with no owner.
  it('pays nothing to a deleted winner', async () => {
    const svc = mkSettle(['cus_gone']);
    const result = await svc.settleChallengeWeek({ getStock: jest.fn() }, CTX);
    expect(svc.settleChallengeWinner).not.toHaveBeenCalled();
    expect(result.winners).toEqual([]);
  });

  it('still pays a live winner', async () => {
    const svc = mkSettle([]);
    await svc.settleChallengeWeek({ getStock: jest.fn() }, CTX);
    expect(svc.settleChallengeWinner).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd backend/packages/api && corepack yarn test:unit -- account-lifecycle
```

Expected: FAIL — `svc.deletedCustomerIds is not a function`.

The stubs above are the smallest shapes that get `settleChallengeWeek` to its loop, not verified copies of the real ones. If `challengeSettings`, `challengeWeekBounds`, `listChallengeStages`' `rank_rewards` or `SettleDeps` disagree, fix the STUBS to match `service.ts` — not the assertions. The load-bearing assertion is `settleChallengeWinner` not being called; `result.winners` is a smoke check only, since the winner call is mocked away.

- [ ] **Step 3: Add the read**

In `src/modules/packs/service.ts`, beside `deleteAccountPreflight`:

```ts
  // Which of these customers no longer have an owner.
  //
  // The `delete_account` audit row is the signal, rather than the account-state
  // tombstone or the customer row's deleted_at: it is written inside the same
  // packs transaction as the rest of the purge, it is purpose-built for this
  // (an admin cannot produce one by typing a disable reason), and it is written
  // BEFORE the customer soft delete, so it covers a half-finished purge too.
  // The customer module is not reachable from this service anyway.
  //
  // One query for the whole list — the caller's ranking is at most ten ids, and
  // the audit write is idempotent, so `take` can be the id count.
  @InjectManager()
  async deletedCustomerIds(
    customerIds: string[],
    @MedusaContext() sharedContext: Context = {},
  ): Promise<Set<string>> {
    if (customerIds.length === 0) return new Set();
    const rows = await this.listAdminActionAudits(
      { entity_id: customerIds, action: 'delete_account' },
      { take: customerIds.length },
      sharedContext,
    );
    return new Set(rows.map((r) => r.entity_id));
  }
```

- [ ] **Step 4: Skip them in the settle loop**

In `settleChallengeWeek`, after `ranking` is resolved and before the `for (const [i, customerId] of ranking.entries())` loop (`:7221`), add:

```ts
// A deleted customer keeps their `pull` rows — the books are retained on
// purpose — so they stay ranked, and settlement would mint real balance and
// a real card to an account with no owner. Read once for the whole ranking,
// outside the per-winner transactions.
const deleted = await this.deletedCustomerIds(ranking, sharedContext);
```

and as the second line of the loop body, immediately after the already-settled gate:

```ts
if (deleted.has(customerId)) continue; // account deleted; nobody to pay
```

- [ ] **Step 5: Write the failing test for the commission path**

Append to the same spec file. The point of this test is the sponsor, not the recruit — a deleted SPONSOR must earn nothing from a live recruit's pack open:

```ts
describe('settleOpen — commission to a deleted sponsor', () => {
  it('pays no commission when the sponsor account is deleted', async () => {
    const svc = Object.create(
      PacksModuleService.prototype,
    ) as PacksModuleService & Record<string, jest.Mock>;
    svc.listReferralRelationships = jest
      .fn()
      .mockResolvedValue([{ sponsor_id: 'cus_sponsor' }]);
    svc.deletedCustomerIds = jest
      .fn()
      .mockResolvedValue(new Set(['cus_sponsor']));
    // Any of the fan-out's own writers standing in for "commission was paid".
    svc.createCommissions = jest.fn();

    await settleOpenCommissionFanOut(svc, {
      customerId: 'cus_recruit',
      externalFundedCents: -5000,
    });

    expect(svc.createCommissions).not.toHaveBeenCalled();
    expect(svc.deletedCustomerIds).toHaveBeenCalledWith(
      ['cus_sponsor'],
      expect.anything(),
    );
  });

  it('still pays a live sponsor', async () => {
    /* same fixture, deletedCustomerIds -> new Set(), assert the fan-out ran */
  });
});
```

**Read `settleOpen` before writing this.** It is a large method and the fan-out is a block inside it, not a separate function — so the harness above (`settleOpenCommissionFanOut`) may not exist. Choose whichever of these fits what you find, in this order of preference: drive the real `settleOpen` if its other dependencies can be stubbed cheaply; otherwise extract the fan-out block into a private method and test that; otherwise test the guard's own predicate. **Do not** restructure `settleOpen` beyond a mechanical extraction — it is the atomic open-settlement seam and its comment explicitly asks that changes to it stay reviewable on their own. Report which route you took and why.

- [ ] **Step 6: Run it and watch it fail**

```bash
cd backend/packages/api && corepack yarn test:unit -- account-lifecycle
```

Expected: FAIL — a deleted sponsor is still paid.

- [ ] **Step 7: Gate the commission fan-out**

In `settleOpen`, immediately after `rel?.sponsor_id` is resolved (`service.ts:3316-3320`) and before any commission is computed or written:

```ts
        // A purged sponsor keeps their referral edges — severing them would
        // dangle the recruit's upline and silently rewrite attribution — so the
        // edge still resolves here long after the account is gone. Paying it
        // would mint credits onto an account with no owner and no login, every
        // time this recruit opens a pack, forever. The preflight cannot cover
        // this: at delete time the commission row does not exist yet.
        if ((await this.deletedCustomerIds([sponsorId], sharedContext)).size > 0) {
          return;
        }
```

Thread the caller's `sharedContext` so this read joins `settleOpen`'s existing advisory-locked transaction rather than opening a second connection — the file warns about exactly that at `:2358-2362`. Adjust `return` to whatever correctly skips just the fan-out in the surrounding control flow; do not abort the open itself, because the debit must still stand.

- [ ] **Step 8: Run the tests**

```bash
cd backend/packages/api && corepack yarn test:unit -- account-lifecycle
```

Expected: PASS.

```bash
cd backend/packages/api && corepack yarn test:unit
```

Expected: PASS. Run the full tier here, not just the file — `settleOpen` is the most load-bearing money function in the module and it has coverage elsewhere.

- [ ] **Step 9: Commit**

```bash
git add backend/packages/api/src/modules/packs
git commit -m "fix(payouts): stop value accruing to a deleted account"
```

---

## Task 7: End-to-end integration spec

**Files:**

- Create: `backend/packages/api/integration-tests/http/account-self-service.spec.ts`

**Interfaces:**

- Consumes: every backend route from Tasks 1–6.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Write the spec**

Create `integration-tests/http/account-self-service.spec.ts`:

```ts
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'account-self-service-pw-1'; // gitleaks:allow

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('customer self-service disable / delete', () => {
      let storeHeaders: Record<string, string>;

      const register = async (
        email: string,
      ): Promise<{ id: string; token: string }> => {
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        const created = await postStoreCustomer(
          api,
          getContainer(),
          { email },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${reg.data.token}`,
            },
          },
        );
        const login = await api.post('/auth/customer/emailpass', {
          email,
          password: PASSWORD,
        });
        return { id: created.data.customer.id, token: login.data.token };
      };

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      beforeEach(async () => {
        const apiKeyModule = getContainer().resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'account-self-service-test',
          type: 'publishable',
          created_by: 'account-self-service-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
      });

      it('disable → login still works → other routes 403 → reactivate → normal', async () => {
        const { id, token } = await register('self-disable@test.dev');

        const disabled = await unwrapResponse(
          api.post(
            '/store/customers/me/disable',
            {},
            { headers: authed(token) },
          ),
        );
        expect(disabled.status).toBe(200);

        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        expect(await packs.accountDisabledCause(id)).toBe('self');

        // A self-disable must NOT block the token exchange — the password has to
        // be provable before reactivation is offered.
        const relogin = await unwrapResponse(
          api.post('/auth/customer/emailpass', {
            email: 'self-disable@test.dev',
            password: PASSWORD,
          }),
        );
        expect(relogin.status).toBe(200);
        const freshToken = relogin.data.token;

        // Everything else is closed, with the machine-readable code.
        const blocked = await unwrapResponse(
          api.get('/store/credits', { headers: authed(freshToken) }),
        );
        expect(blocked.status).toBe(403);
        expect(blocked.data.message).toBe('ACCOUNT_SELF_DISABLED');

        const reactivated = await unwrapResponse(
          api.post(
            '/store/customers/me/reactivate',
            {},
            { headers: authed(freshToken) },
          ),
        );
        expect(reactivated.status).toBe(200);
        expect(await packs.accountDisabledCause(id)).toBeNull();

        const open = await unwrapResponse(
          api.get('/store/credits', { headers: authed(freshToken) }),
        );
        expect(open.status).toBe(200);
      });

      it('an admin-disabled account cannot self-reactivate', async () => {
        const { id, token } = await register('admin-disabled@test.dev');
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await packs.setAccountDisabled({
          customerId: id,
          adminId: 'admin_test',
          disabled: true,
          reason: 'support hold',
          cause: 'admin',
        });

        const res = await unwrapResponse(
          api.post(
            '/store/customers/me/reactivate',
            {},
            { headers: authed(token) },
          ),
        );
        expect(res.status).toBe(403);
        expect(res.data.message).toBe(
          'This account has been disabled. Please contact support.',
        );
        expect(await packs.accountDisabledCause(id)).toBe('admin');
      });

      it('delete refuses a wrong password and a non-zero balance', async () => {
        const { id, token } = await register('delete-guards@test.dev');
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);

        const wrongPw = await unwrapResponse(
          api.post(
            '/store/customers/me/delete',
            { password: 'not-the-password' },
            { headers: authed(token) },
          ),
        );
        expect(wrongPw.status).toBe(400);
        expect(wrongPw.data.message).toBe('PASSWORD_INCORRECT');

        await packs.mutateCreditAtomic({
          customerId: id,
          amount: 25,
          reason: 'adjustment',
        });
        const withBalance = await unwrapResponse(
          api.post(
            '/store/customers/me/delete',
            { password: PASSWORD },
            { headers: authed(token) },
          ),
        );
        expect(withBalance.status).toBe(400);
        expect(withBalance.data.message).toBe('BALANCE_NOT_ZERO');

        // Still fully usable — a refused delete must change nothing.
        const stillThere = await unwrapResponse(
          api.get('/store/credits', { headers: authed(token) }),
        );
        expect(stillThere.status).toBe(200);
      });

      // The ONLY assertion that catches a future "simplification" of the
      // balance read back to availableBalance(): that helper returns 0 for a
      // frozen account, so this account — frozen, holding RM 25 — would sail
      // through a naive guard and strand real money.
      it('refuses a FROZEN account that still holds funds', async () => {
        const { id, token } = await register('delete-frozen@test.dev');
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);

        await packs.mutateCreditAtomic({
          customerId: id,
          amount: 25,
          reason: 'adjustment',
        });
        await packs.setManualFreeze({
          customerId: id,
          adminId: 'admin_test',
          reason: 'fraud review',
        });

        const res = await unwrapResponse(
          api.post(
            '/store/customers/me/delete',
            { password: PASSWORD },
            { headers: authed(token) },
          ),
        );
        expect(res.status).toBe(400);
        expect(res.data.message).toBe('BALANCE_NOT_ZERO');
      });

      it('delete purges the person, keeps the books, and frees the email', async () => {
        const email = 'delete-happy@test.dev';
        const { id, token } = await register(email);
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);

        // A settled withdrawal so there IS a retained financial row to inspect.
        await packs.createGlobePayWithdrawals([
          {
            merchant_transaction_id: `mt-delete-${id}`,
            customer_id: id,
            amount: 10,
            bank_code: 'MBB',
            account_number: '1234567890',
            account_holder_name: 'Real Person',
            status: 'settled',
          },
        ]);
        // A TERMINAL delivery (the guard forbids any other kind at this point),
        // plus the two pure-PII tables, so the purge has something of each kind
        // to act on. Net-zero credit movement so the balance guard still passes
        // while leaving two credit_transaction rows that must SURVIVE.
        await packs.createDeliveryOrders([
          {
            customer_id: id,
            status: 'completed',
            ship_name: 'Real Person',
            ship_address_1: '1 Real Road',
            ship_city: 'KL',
            ship_postal_code: '50000',
            ship_phone: '+60123456789',
            proof_images: ['https://example.test/doorstep.jpg'],
          },
        ]);
        await packs.createPlayerPayoutDetails([
          { customer_id: id, bank_code: 'MBB', account_number: '1234567890' },
        ]);
        await packs.createNotificationReads([
          { customer_id: id, notification_id: 'noti_x' },
        ]);
        await packs.mutateCreditAtomic({
          customerId: id,
          amount: 25,
          reason: 'adjustment',
        });
        await packs.mutateCreditAtomic({
          customerId: id,
          amount: -25,
          reason: 'adjustment',
        });

        const res = await unwrapResponse(
          api.post(
            '/store/customers/me/delete',
            { password: PASSWORD },
            { headers: authed(token) },
          ),
        );
        expect(res.status).toBe(200);
        expect(res.data.deleted).toBe(true);

        // Login is gone for good — and reads as bad credentials, not "disabled".
        const relogin = await unwrapResponse(
          api.post('/auth/customer/emailpass', { email, password: PASSWORD }),
        );
        expect(relogin.status).toBe(401);

        // The bearer minted BEFORE the delete is still cryptographically valid
        // — JWT auth is pure verification with no DB lookup, and no
        // jwtExpiresIn is configured, so the framework default of a day
        // applies. The account-state tombstone is the only thing refusing it;
        // soft-deleting that row instead would make this 200.
        const zombie = await unwrapResponse(
          api.get('/store/credits', { headers: authed(token) }),
        );
        expect(zombie.status).toBe(403);

        // The books survive, scrubbed to the minimum.
        const [wd] = await packs.listGlobePayWithdrawals(
          { customer_id: id },
          { take: 1 },
        );
        expect(wd).toBeDefined();
        expect(Number(wd.amount)).toBe(10);
        expect(wd.status).toBe('settled');
        expect(wd.account_number).toBe('7890');
        expect(wd.account_holder_name).toBe('');

        const [delivery] = await packs.listDeliveryOrders(
          { customer_id: id },
          { take: 1 },
        );
        expect(delivery.status).toBe('completed'); // status is a book fact
        expect(delivery.ship_name).toBe('');
        expect(delivery.ship_address_1).toBe('');
        expect(delivery.ship_phone).toBeNull();
        // A doorstep photo can show the label or the recipient — the same PII
        // the ship_* scrub above removes.
        expect(delivery.proof_images).toBeNull();

        // Pure PII: gone outright.
        expect(
          await packs.listPlayerPayoutDetails({ customer_id: id }, { take: 1 }),
        ).toHaveLength(0);
        expect(
          await packs.listNotificationReads({ customer_id: id }, { take: 1 }),
        ).toHaveLength(0);

        // Retained untouched — the anonymous books.
        expect(
          await packs.listCreditTransactions({ customer_id: id }, { take: 10 }),
        ).toHaveLength(2);
        const audits = await packs.listAdminActionAudits(
          { entity_id: id },
          { take: 10 },
        );
        expect(audits.some((a) => a.action === 'delete_account')).toBe(true);

        // The email is reusable — this is what proves the auth identities were
        // HARD-deleted. (provider_identity's unique index has no deleted_at
        // predicate, so a soft delete would 23505 here forever.)
        const again = await unwrapResponse(
          api.post('/auth/customer/emailpass/register', {
            email,
            password: PASSWORD,
          }),
        );
        expect(again.status).toBe(200);
      });

      // Spec §4. The `pull` rows are retained by design, so a deleted customer
      // can still be ranked on a PUBLIC board. `publicProfileFields` is already
      // undefined-safe, which is exactly why this needs a test: nothing else
      // would stop a future refactor turning the first real delete into a 500
      // on the leaderboard, and that page is the one nobody is logged in to.
      it('renders a deleted-but-ranked player anonymously on the public boards', async () => {
        const email = 'delete-ranked@test.dev';
        const { id, token } = await register(email);
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);

        // A SOLD pull: it still counts toward the week's pulled value but does
        // not trip CARDS_UNSETTLED, which blocks only 'vaulted' / 'delivering'.
        await packs.createPulls([
          {
            customer_id: id,
            card_id: 'db-charizard',
            status: 'sold',
            value_myr: 42,
          },
        ]);

        const del = await unwrapResponse(
          api.post(
            '/store/customers/me/delete',
            { password: PASSWORD },
            { headers: authed(token) },
          ),
        );
        expect(del.status).toBe(200);

        // No auth header: these are the anonymous surfaces.
        for (const path of [
          '/store/leaderboard?period=weekly',
          '/store/challenge',
        ]) {
          const page = await unwrapResponse(
            api.get(path, { headers: storeHeaders }),
          );
          expect(page.status).toBe(200);
          expect(JSON.stringify(page.data)).not.toContain(email);
        }

        const board = await unwrapResponse(
          api.get('/store/leaderboard?period=weekly', {
            headers: storeHeaders,
          }),
        );
        const entry = (
          board.data.entries as { seed: number; name: string }[]
        ).find((e) => e.seed === seedOf(id));
        expect(entry).toBeDefined();
        expect(entry?.name).toMatch(/^Collector \d{4}$/);
      });
    });
  },
});
```

`seedOf` comes from `../../src/utils/profile-handle` — add it to the imports at the top of the file.

- [ ] **Step 2: Run it**

```bash
cd backend/packages/api && corepack yarn test:integration:http account-self-service.spec
```

Expected: PASS, 6 tests.

**The reactivate case in test 1 is the load-bearing one.** Task 3's unit spec fabricates its request, so it can only prove the guard's logic against a shape the guard already agrees with; this is the only check that proves the carve-out fires against real Express, where `req.path` is `'/'` inside a method-less `app.use` entry. If it is red, a self-disabled customer can never get back in — and `/disable` needs no password, so a stolen token bricks the account permanently. Do not skip it, and do not "fix" it by loosening the guard.

If `mutateCreditAtomic`, `createGlobePayWithdrawals`, `createDeliveryOrders`, `createPlayerPayoutDetails`, `createNotificationReads`, `createPulls` or `setManualFreeze` reject the argument shapes above, read their real signatures in `src/modules/packs/service.ts` and correct the CALL, not the assertion. Same rule for the leaderboard response shape. If `amount` is a `bigNumber` field, remember it needs its `raw_amount` companion when inserted by hand — check whether `createGlobePayWithdrawals` fills it for you before adding it.

- [ ] **Step 3: Run the whole unit suite for regressions**

```bash
cd backend/packages/api && corepack yarn test:unit
```

Expected: PASS. `setAccountDisabled`'s new required `cause` will have broken any spec that calls it — fix those call sites.

- [ ] **Step 4: Commit**

The `git add` covers `src` as well as `integration-tests`: Step 3 may have edited specs under `src/**/__tests__/`, and a commit that leaves those out is a red suite on the next checkout.

```bash
git add backend/packages/api/integration-tests backend/packages/api/src
git commit -m "test(account): cover the disable, reactivate and delete loops end to end"
```

---

## Task 8: Storefront server actions

**Files:**

- Create: `src/lib/actions/account-lifecycle.ts`
- Modify: `src/lib/data/customer.ts` (append `getAccountInfo`)
- Test: `src/lib/actions/__tests__/account-lifecycle.test.ts` (create)

**Interfaces:**

- Consumes: the four backend routes.
- Produces:
  - `getAccountInfo(): Promise<{ hasPassword: boolean }>` from `src/lib/data/customer.ts`
  - `disableAccount(): Promise<LifecycleResult>`
  - `reactivateAccount(): Promise<LifecycleResult>`
  - `deleteAccount(password: string | null): Promise<DeleteResult>`
  - `export type LifecycleResult = { ok: true } | { ok: false; error: string };`
  - `export type DeleteResult = { ok: true } | { ok: false; error: string; reason: string | null };`
  - `export const DELETE_LINK: Record<string, { href: string; label: string }>` — the page that clears each blocker, consumed by Task 9's modal.

- [ ] **Step 1: Write the failing test**

Create `src/lib/actions/__tests__/account-lifecycle.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAuthToken: vi.fn(),
  clearAuthToken: vi.fn(),
  clientFetch: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/data/customer', () => ({
  getAuthToken: mocks.getAuthToken,
  clearAuthToken: mocks.clearAuthToken,
}));
vi.mock('@/lib/logger', () => ({
  logger: {
    error: mocks.logError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('@/lib/medusa', () => ({
  sdk: { client: { fetch: mocks.clientFetch } },
}));

import {
  disableAccount,
  reactivateAccount,
  deleteAccount,
} from '../account-lifecycle';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthToken.mockResolvedValue('tok');
  mocks.clientFetch.mockResolvedValue({});
});

describe('disableAccount', () => {
  it('calls the route and clears the session cookie', async () => {
    await expect(disableAccount()).resolves.toEqual({ ok: true });
    expect(mocks.clientFetch).toHaveBeenCalledWith(
      '/store/customers/me/disable',
      { method: 'POST', headers: { Authorization: 'Bearer tok' } },
    );
    expect(mocks.clearAuthToken).toHaveBeenCalled();
  });

  // The cookie must survive a failure, or a customer whose disable errored is
  // logged out with the account still active and no way to see what happened.
  it('keeps the cookie when the backend refuses', async () => {
    mocks.clientFetch.mockRejectedValue(new Error('boom'));
    const r = await disableAccount();
    expect(r.ok).toBe(false);
    expect(mocks.clearAuthToken).not.toHaveBeenCalled();
  });

  it('refuses when logged out', async () => {
    mocks.getAuthToken.mockResolvedValue(undefined);
    await expect(disableAccount()).resolves.toEqual({
      ok: false,
      error: 'Please log in first.',
    });
    expect(mocks.clientFetch).not.toHaveBeenCalled();
  });
});

describe('reactivateAccount', () => {
  it('posts to the reactivate route', async () => {
    await expect(reactivateAccount()).resolves.toEqual({ ok: true });
    expect(mocks.clientFetch).toHaveBeenCalledWith(
      '/store/customers/me/reactivate',
      { method: 'POST', headers: { Authorization: 'Bearer tok' } },
    );
  });

  // The branch the login prompt actually depends on: a failed reactivation has
  // to come back as a message the prompt can show, not as a thrown action.
  it('reports a failure instead of throwing', async () => {
    mocks.clientFetch.mockRejectedValue(new Error('boom'));
    const r = await reactivateAccount();
    expect(r.ok).toBe(false);
    expect(mocks.logError).toHaveBeenCalled();
  });

  it('refuses when logged out', async () => {
    mocks.getAuthToken.mockResolvedValue(undefined);
    await expect(reactivateAccount()).resolves.toEqual({
      ok: false,
      error: 'Please log in first.',
    });
    expect(mocks.clientFetch).not.toHaveBeenCalled();
  });
});

describe('deleteAccount', () => {
  it('sends the password and clears the cookie on success', async () => {
    await expect(deleteAccount('pw')).resolves.toEqual({ ok: true });
    expect(mocks.clientFetch).toHaveBeenCalledWith(
      '/store/customers/me/delete',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer tok' },
        body: { password: 'pw' },
      },
    );
    expect(mocks.clearAuthToken).toHaveBeenCalled();
  });

  it('omits the password entirely for a Google-only account', async () => {
    await deleteAccount(null);
    expect(mocks.clientFetch).toHaveBeenCalledWith(
      '/store/customers/me/delete',
      { method: 'POST', headers: { Authorization: 'Bearer tok' }, body: {} },
    );
  });

  it('surfaces the machine-readable reason and keeps the cookie', async () => {
    mocks.clientFetch.mockRejectedValue(new Error('BALANCE_NOT_ZERO'));
    const r = await deleteAccount('pw');
    expect(r).toEqual({
      ok: false,
      reason: 'BALANCE_NOT_ZERO',
      error: 'Withdraw your remaining balance before deleting your account.',
    });
    expect(mocks.clearAuthToken).not.toHaveBeenCalled();
  });

  it('maps a wrong password to its own copy', async () => {
    mocks.clientFetch.mockRejectedValue(new Error('PASSWORD_INCORRECT'));
    const r = await deleteAccount('pw');
    expect(r).toMatchObject({
      ok: false,
      reason: 'PASSWORD_INCORRECT',
      error: 'That password is incorrect.',
    });
  });

  it('falls back cleanly on an unrecognised failure', async () => {
    mocks.clientFetch.mockRejectedValue(new Error('kaboom'));
    const r = await deleteAccount('pw');
    expect(r).toMatchObject({ ok: false, reason: null });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- src/lib/actions/__tests__/account-lifecycle.test.ts
```

Expected: FAIL — cannot resolve `../account-lifecycle`.

- [ ] **Step 3: Add the data-layer read**

Append to `src/lib/data/customer.ts`:

```ts
/**
 * Account facts the Settings page needs before rendering the Danger zone.
 * `hasPassword` is false for a Google-only signup, which removes the password
 * field from the delete confirmation. Defaults to `true` on any failure — the
 * safer shape, since it asks for MORE proof rather than less.
 */
export async function getAccountInfo(): Promise<{ hasPassword: boolean }> {
  const token = await getAuthToken();
  if (!token) return { hasPassword: true };
  try {
    return await sdk.client.fetch<{ hasPassword: boolean }>(
      '/store/customers/me/account',
      { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
    );
  } catch {
    return { hasPassword: true };
  }
}
```

- [ ] **Step 4: Write the actions**

Create `src/lib/actions/account-lifecycle.ts`:

```ts
'use server';

import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { clearAuthToken, getAuthToken } from '@/lib/data/customer';

export type LifecycleResult = { ok: true } | { ok: false; error: string };
export type DeleteResult =
  | { ok: true }
  | { ok: false; error: string; reason: string | null };

const GENERIC = 'Something went wrong. Please try again.';

/**
 * Backend delete-refusal codes → the sentence the modal shows. These are CODES,
 * not prose, precisely so this mapping is exact rather than a regex over
 * human copy that changes.
 */
const DELETE_COPY: Record<string, string> = {
  PASSWORD_REQUIRED: 'Enter your password to confirm.',
  PASSWORD_INCORRECT: 'That password is incorrect.',
  BALANCE_NOT_ZERO:
    'Withdraw your remaining balance before deleting your account.',
  WITHDRAWAL_PENDING:
    'A withdrawal is still processing. Try again once it completes.',
  DEPOSIT_PENDING:
    'A deposit is still processing. Try again once it completes.',
  CARDS_UNSETTLED:
    'Your vault still has cards. Sell or ship them before deleting.',
  DELIVERY_IN_FLIGHT:
    'A delivery is still on its way. Try again once it arrives.',
};

/**
 * Where the customer has to go to clear each blocker. An instruction without a
 * route is a dead end — every reason here is something they can only fix on
 * another page. Password failures are fixed in the modal itself, so they have
 * no entry and the UI renders copy alone.
 */
export const DELETE_LINK: Record<string, { href: string; label: string }> = {
  BALANCE_NOT_ZERO: { href: '/wallet', label: 'Go to wallet' },
  WITHDRAWAL_PENDING: { href: '/transactions', label: 'View withdrawals' },
  DEPOSIT_PENDING: { href: '/transactions', label: 'View deposits' },
  CARDS_UNSETTLED: { href: '/vault', label: 'Open vault' },
  DELIVERY_IN_FLIGHT: { href: '/orders', label: 'Track delivery' },
};

const codeOf = (error: unknown): string | null => {
  const text = error instanceof Error ? error.message : String(error);
  for (const code of Object.keys(DELETE_COPY)) {
    if (text.includes(code)) return code;
  }
  return null;
};

/** Disable the caller's own account, then drop the session cookie. */
export async function disableAccount(): Promise<LifecycleResult> {
  const token = await getAuthToken();
  if (!token) return { ok: false, error: 'Please log in first.' };
  try {
    await sdk.client.fetch('/store/customers/me/disable', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    logger.error('[account] disable failed:', error);
    // Cookie deliberately untouched: a customer whose disable failed is still
    // active, and logging them out would hide that from them.
    return { ok: false, error: GENERIC };
  }
  await clearAuthToken();
  return { ok: true };
}

/** Lift the caller's own disable. The session cookie stays — they continue in. */
export async function reactivateAccount(): Promise<LifecycleResult> {
  const token = await getAuthToken();
  if (!token) return { ok: false, error: 'Please log in first.' };
  try {
    await sdk.client.fetch('/store/customers/me/reactivate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    return { ok: true };
  } catch (error) {
    logger.error('[account] reactivate failed:', error);
    return { ok: false, error: GENERIC };
  }
}

/**
 * Delete the caller's own account, permanently. `password` is null for a
 * Google-only account, where the backend skips the password check entirely.
 */
export async function deleteAccount(
  password: string | null,
): Promise<DeleteResult> {
  const token = await getAuthToken();
  if (!token) return { ok: false, error: 'Please log in first.', reason: null };
  try {
    await sdk.client.fetch('/store/customers/me/delete', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: password === null ? {} : { password },
    });
  } catch (error) {
    logger.error('[account] delete failed:', error);
    const reason = codeOf(error);
    return {
      ok: false,
      reason,
      error: reason ? DELETE_COPY[reason] : GENERIC,
    };
  }
  await clearAuthToken();
  return { ok: true };
}
```

- [ ] **Step 5: Run the test**

```bash
npm test -- src/lib/actions/__tests__/account-lifecycle.test.ts
```

Expected: PASS (11 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib
git commit -m "feat(account): add disable, reactivate and delete server actions"
```

---

## Task 9: The Danger zone UI

**Files:**

- Create: `src/components/account/DangerZone.tsx`
- Modify: `src/app/(account)/settings/page.tsx`

**Interfaces:**

- Consumes: `disableAccount`, `deleteAccount`, `DELETE_LINK` (Task 8), `getAccountInfo` (Task 8).
- Produces: `<DangerZone hasPassword={boolean} />`.

- [ ] **Step 1: Build the component**

Create `src/components/account/DangerZone.tsx`. Follow `RequestDeliveryModal.tsx` for the dialog shell (it uses the shared `useModalA11y` hook — `SellConfirmModal` predates that hook and hand-rolls its own trap, so take its layout only, not its effect):

```tsx
'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { useAuth } from '@/components/auth/AuthProvider';
import { INPUT_CLASS, Panel } from '@/components/account/ui';
import {
  disableAccount,
  deleteAccount,
  DELETE_LINK,
} from '@/lib/actions/account-lifecycle';

const CONFIRM_WORD = 'DELETE';

function Modal({
  open,
  label,
  busy,
  onClose,
  children,
}: {
  open: boolean;
  label: string;
  busy: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, open, onClose);
  if (!open) return null;
  return (
    <div className="glass-stage fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-busy={busy}
        tabIndex={-1}
        className="glass-panel max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border p-5 outline-none"
      >
        {children}
      </div>
    </div>
  );
}

export default function DangerZone({ hasPassword }: { hasPassword: boolean }) {
  const router = useRouter();
  const { setCustomer } = useAuth();
  const [mode, setMode] = useState<'none' | 'disable' | 'delete'>('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The machine-readable refusal code, kept beside the copy so the modal can
  // offer the page that CLEARS the blocker. Every delete refusal is something
  // the customer can only fix somewhere else, so an instruction with no route
  // is a dead end.
  const [reason, setReason] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirmWord, setConfirmWord] = useState('');

  const close = () => {
    if (busy) return;
    setMode('none');
    setError(null);
    setReason(null);
    setPassword('');
    setConfirmWord('');
  };

  // Post-action navigation is client-side: no server action in this repo calls
  // redirect(). Mirrors MeActions.tsx's LogoutButton. This IS the goodbye —
  // there is no separate goodbye screen, because it would be a route that
  // exists to be seen once by someone who has just left; the logged-out home
  // page already says it.
  const leave = () => {
    setCustomer(null);
    router.push('/');
    router.refresh();
  };

  async function onDisable() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await disableAccount();
      if (r.ok) {
        leave();
        return;
      }
      setError(r.error);
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setReason(null);
    try {
      const r = await deleteAccount(hasPassword ? password : null);
      if (r.ok) {
        leave();
        return;
      }
      setError(r.error);
      setReason(r.reason);
    } finally {
      setBusy(false);
    }
  }

  const deleteReady =
    confirmWord === CONFIRM_WORD && (!hasPassword || password.length > 0);

  return (
    <Panel className="border-red-500/25">
      <h2 className="mb-1 font-heading text-lg font-bold text-white">
        Danger zone
      </h2>
      <p className="mb-4 text-[13px] text-white/55">
        Disabling is reversible — log back in any time to reactivate. Deleting
        is not.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={() => setMode('disable')}
          className="h-11 shrink-0 rounded-xl border border-white/10 bg-white/[0.05] px-4 text-sm font-medium text-white transition-colors hover:bg-white/[0.1]"
        >
          Disable account
        </button>
        <button
          type="button"
          onClick={() => setMode('delete')}
          className="h-11 shrink-0 rounded-xl border border-red-500/30 bg-red-500/10 px-4 text-sm font-semibold text-red-300 transition-colors hover:bg-red-500/20"
        >
          Delete account
        </button>
      </div>

      <Modal
        open={mode === 'disable'}
        label="Disable account"
        busy={busy}
        onClose={close}
      >
        <h3 className="font-heading text-lg font-bold text-white">
          Disable your account?
        </h3>
        <p className="mt-2 text-[13px] text-white/60">
          You&rsquo;ll be signed out and your account stays closed until you log
          back in and reactivate it. Your cards, balance and history are
          untouched.
        </p>
        {error && (
          <p role="alert" className="mt-3 text-[12px] text-red-400">
            {error}
          </p>
        )}
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="inline-flex h-11 flex-1 items-center justify-center rounded-xl border border-white/15 bg-white/5 text-sm font-semibold text-white/80 transition-colors hover:bg-white/10 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onDisable}
            disabled={busy}
            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-white text-sm font-bold text-neutral-950 transition-colors hover:bg-white/90 disabled:opacity-60"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {busy ? 'Disabling…' : 'Disable'}
          </button>
        </div>
      </Modal>

      <Modal
        open={mode === 'delete'}
        label="Delete account"
        busy={busy}
        onClose={close}
      >
        <h3 className="font-heading text-lg font-bold text-white">
          Delete your account permanently?
        </h3>
        <p className="mt-2 text-[13px] text-white/60">
          This cannot be undone. Your profile, saved bank accounts and personal
          details are erased and you will not be able to log in again — not even
          with support&rsquo;s help.
        </p>
        {hasPassword ? (
          <label className="mt-4 block">
            <span className="mb-1.5 block text-[12px] font-medium text-white/55">
              Your password
            </span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              className={INPUT_CLASS}
            />
          </label>
        ) : (
          <p className="mt-4 text-[12px] text-white/55">
            You sign in with Google, so there&rsquo;s no password to enter —
            type {CONFIRM_WORD} below to confirm.
          </p>
        )}
        <label className="mt-3 block">
          <span className="mb-1.5 block text-[12px] font-medium text-white/55">
            Type {CONFIRM_WORD} to confirm
          </span>
          <input
            type="text"
            autoComplete="off"
            value={confirmWord}
            onChange={(e) => setConfirmWord(e.target.value)}
            disabled={busy}
            className={INPUT_CLASS}
          />
        </label>
        {error && (
          <div role="alert" className="mt-3 text-[12px] text-red-400">
            <p>{error}</p>
            {/* Every settlement refusal is fixed on another page, so the copy
                ships with the route that fixes it. Password failures have no
                entry in the map and correctly render copy alone. */}
            {reason && DELETE_LINK[reason] && (
              <Link
                href={DELETE_LINK[reason].href}
                className="mt-1 inline-block font-semibold text-red-300 underline underline-offset-2 hover:text-red-200"
              >
                {DELETE_LINK[reason].label}
              </Link>
            )}
          </div>
        )}
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="inline-flex h-11 flex-1 items-center justify-center rounded-xl border border-white/15 bg-white/5 text-sm font-semibold text-white/80 transition-colors hover:bg-white/10 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={busy || !deleteReady}
            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-red-600 text-sm font-bold text-white transition-colors hover:bg-red-500 disabled:opacity-40"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {busy ? 'Deleting…' : 'Delete forever'}
          </button>
        </div>
      </Modal>
    </Panel>
  );
}
```

- [ ] **Step 2: Confirm the hook's real signature**

Read `src/lib/use-modal-a11y.ts` and check that `useModalA11y(panelRef, open, onClose)` matches. If the argument order or name differs, correct the component — do not adapt the hook.

- [ ] **Step 3: Render it on the Settings page**

In `src/app/(account)/settings/page.tsx`: add `getAccountInfo` to the existing `@/lib/data/customer` import, add `import DangerZone from '@/components/account/DangerZone';`, fetch alongside the customer, and render the panel after the quiet copy line (`:46-49`):

```tsx
const [customer, accountInfo] = await Promise.all([
  getCustomer(),
  getAccountInfo(),
]);
```

```tsx
<DangerZone hasPassword={accountInfo.hasPassword} />
```

- [ ] **Step 4: Typecheck and build**

```bash
npm run build
```

Expected: build succeeds. If it fails with `Cannot read properties of undefined (reading 'length')` right after the build starts, that is a stale `.next` — stop any standalone server, delete `.next`, and rebuild.

- [ ] **Step 5: Verify it renders**

```bash
pwsh scripts/serve-standalone.ps1 -Port 4000
```

Log in as a test customer, open `/settings`, and confirm the Danger zone renders, both modals open and close, Escape closes them, and the delete confirm stays disabled until `DELETE` is typed (and, for a password account, a password entered). Then trigger one real refusal — the easiest is a non-zero balance — and confirm the modal shows the specific copy AND the link that clears it, and that the link goes somewhere real. Do NOT verify on `next dev` — it serves images slowly on this machine and makes a correct build look broken.

- [ ] **Step 6: Commit**

```bash
git add src/components/account/DangerZone.tsx src/app/(account)/settings/page.tsx
git commit -m "feat(account): add the settings danger zone"
```

---

## Task 10: The login reactivate prompt

**Files:**

- Modify: `src/lib/actions/auth.ts` (`login`, `googleCallback`, the `AuthResult` type)
- Create: `src/components/auth/ReactivatePrompt.tsx`
- Modify: `src/components/AuthForm.tsx`
- Modify: `src/components/AuthModal.tsx`
- Modify: `src/app/auth/google/callback/route.ts`
- Modify: `src/app/reset-password/ResetPasswordClient.tsx` (and any other consumer the `AuthResult` widening reddens)
- Test: `src/lib/actions/__tests__/auth.test.ts` (extend)

**Interfaces:**

- Consumes: `ACCOUNT_SELF_DISABLED` from the backend (Task 3), `reactivateAccount` (Task 8).
- Produces: `AuthResult` gains a third variant — `{ ok: false; selfDisabled: true }`; `<ReactivatePrompt onDone={(reactivated: boolean) => void} />`.

**Two things about this task that are bigger than they look.**

_Widening `AuthResult` breaks every consumer that reads `result.error` on the failure branch_ — deliberately, so the compiler enumerates them. `login`, `signup`, `googleLoginStart`, `googleCallback`, `requestPasswordReset` and `resetPassword` all return this type. Expect to touch `src/components/AuthForm.tsx`, `src/app/auth/google/callback/route.ts:70` and `src/app/reset-password/ResetPasswordClient.tsx`, plus any other `else { setError(result.error) }` site the build surfaces. Narrow with `'selfDisabled' in result`, never a cast. Only `login` and `googleCallback` can actually produce the new variant, so everywhere else the right handling is a generic fallback message.

_Google-only customers can self-disable too, so they need the same way back._ Google OAuth is live in production, the Google callback is not covered by the login guard, and a self-disabled Google customer would otherwise mint a token, get `ACCOUNT_SELF_DISABLED` on every `/store` call, and bounce between the account gate and the login modal forever. That is why the prompt is extracted as `ReactivatePrompt` rather than written inline in `AuthForm`: both entry points render the same component.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/actions/__tests__/auth.test.ts`:

```ts
describe('login — self-disabled account', () => {
  it('reports selfDisabled and KEEPS the session cookie', async () => {
    mocks.clientFetch.mockResolvedValueOnce({ token: 'tok' });
    mocks.customerRetrieve.mockRejectedValueOnce(
      new Error('ACCOUNT_SELF_DISABLED'),
    );

    const r = await login({
      email: 'off@polycards.app',
      password: 'PolycardsTest123!',
    });

    expect(r).toEqual({ ok: false, selfDisabled: true });
    // The cookie is what the reactivate call authenticates with — clearing it
    // here would make the prompt impossible to act on.
    expect(mocks.setAuthToken).toHaveBeenCalledWith('tok');
    expect(mocks.clearAuthToken).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- src/lib/actions/__tests__/auth.test.ts
```

Expected: FAIL — the result is the generic `{ ok: false, error: … }`.

- [ ] **Step 3: Widen `AuthResult` and branch in `login`**

In `src/lib/actions/auth.ts`, change the exported result type (`:39-40`):

```ts
export type AuthResult =
  | { ok: true; customer: AuthCustomer }
  | { ok: false; error: string }
  // The customer disabled their OWN account. Not an error to display: the UI
  // offers reactivation instead. Carries no `error` so a caller cannot render
  // it as a failure by accident.
  | { ok: false; selfDisabled: true };
```

In `login`, replace the inner `catch` (`:113-117`) so the self-disable case does not roll the cookie back:

```ts
    } catch (error) {
      // ACCOUNT_SELF_DISABLED is not an auth failure — the password was right.
      // Keep the cookie: it is what POST /store/customers/me/reactivate
      // authenticates with, and the prompt is useless without it.
      if (
        error instanceof Error &&
        error.message.includes('ACCOUNT_SELF_DISABLED')
      ) {
        return { ok: false, selfDisabled: true };
      }
      // Don't leave a cookie we couldn't validate.
      await clearAuthToken();
      throw error;
    }
```

- [ ] **Step 4: Run the test**

```bash
npm test -- src/lib/actions/__tests__/auth.test.ts
```

Expected: PASS, including every pre-existing case.

- [ ] **Step 5: Extract the prompt as its own component**

Create `src/components/auth/ReactivatePrompt.tsx`. It is a component rather than inline markup because two entry points need it — the emailpass form and the Google callback — and a Google-only customer who self-disabled has no other way back in.

```tsx
'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { logout } from '@/lib/actions/auth';
import { reactivateAccount } from '@/lib/actions/account-lifecycle';

/**
 * Offered after a successful login when the account turns out to be
 * self-disabled. The session cookie is already set at this point — that is what
 * the reactivate call authenticates with — so declining must log out explicitly
 * rather than just closing the prompt.
 *
 * `onDone(true)` means reactivated and the caller should continue into the
 * account; `onDone(false)` means the customer declined and is now logged out.
 */
export default function ReactivatePrompt({
  onDone,
}: {
  onDone: (reactivated: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <h3 className="font-heading text-lg font-bold text-white">
        Your account is disabled
      </h3>
      <p className="mt-2 text-[13px] text-white/60">
        You disabled this account. Reactivate it to pick up where you left off —
        your cards, balance and history are all still here.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-[12px] text-red-400">
          {error}
        </p>
      )}
      <div className="mt-5 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await logout();
              onDone(false);
            } finally {
              setBusy(false);
            }
          }}
          className="inline-flex h-11 flex-1 items-center justify-center rounded-xl border border-white/15 bg-white/5 text-sm font-semibold text-white/80 transition-colors hover:bg-white/10 disabled:opacity-50"
        >
          Not now
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const r = await reactivateAccount();
              if (r.ok) {
                onDone(true);
                return;
              }
              setError(r.error);
            } finally {
              setBusy(false);
            }
          }}
          className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-white text-sm font-bold text-neutral-950 transition-colors hover:bg-white/90 disabled:opacity-60"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {busy ? 'Reactivating…' : 'Reactivate'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Wire it into the emailpass form**

`src/components/AuthForm.tsx` already funnels both login and signup through one tail, `finishAuth(result)`, so the whole wiring is one state flag, one branch there, and one sub-view.

Add the import beside the existing ones (the form lives in `src/components/`, the prompt in `src/components/auth/`):

```tsx
import ReactivatePrompt from './auth/ReactivatePrompt';
```

Add the flag next to the other `useState` calls (`:50-51`):

```tsx
const [selfDisabled, setSelfDisabled] = useState(false);
```

Branch in `finishAuth` (`:148-157`):

```tsx
function finishAuth(result: AuthResult) {
  if (result.ok) {
    setCustomer(result.customer);
    onSuccess?.();
    router.refresh();
    return;
  }
  // The new variant carries no `error`, so narrow with `in` rather than a
  // cast — and never render it through setNote: the password was CORRECT,
  // and showing it as a failure is what would leave the customer stuck.
  if ('selfDisabled' in result) {
    setSelfDisabled(true);
    return;
  }
  setNote({ text: result.error });
}
```

Render it as a sub-view, next to the existing `if (isSignup && otp)` early return and above the main `return` — the file's established shape for "this modal is showing something else now":

```tsx
if (selfDisabled) {
  return (
    <div className="w-full">
      <ReactivatePrompt
        onDone={(reactivated) => {
          setSelfDisabled(false);
          if (reactivated) {
            // No customer object on this path — login returned the failure
            // variant, so context was never populated. The refresh is what
            // repopulates it; onSuccess closes the modal.
            onSuccess?.();
            router.refresh();
          }
        }}
      />
    </div>
  );
}
```

If `AuthProvider` does not pick the customer up from the refresh, call its own fetch/refresh helper here — do not hand-build an `AuthCustomer` to stuff into context.

- [ ] **Step 7: Give Google logins the same way back**

`googleCallback` must recognise the code too, and its inner try/catch (`auth.ts:333-344`) is identical to `login`'s — so this is the same edit twice, not a new design. Replace that catch:

```ts
await setAuthToken(sessionToken);
try {
  const { customer } = await sdk.store.customer.retrieve(
    {},
    { Authorization: `Bearer ${sessionToken}` },
  );
  const handle = await fetchProfileHandle(sessionToken);
  return { ok: true, customer: toAuthCustomer(customer, handle) };
} catch (error) {
  // Same branch as login's, and this one matters more: the Google callback
  // is NOT covered by the login guard, so a self-disabled Google customer
  // has no other signal at all. Keep the cookie — it is what the reactivate
  // call authenticates with.
  if (
    error instanceof Error &&
    error.message.includes('ACCOUNT_SELF_DISABLED')
  ) {
    return { ok: false, selfDisabled: true };
  }
  await clearAuthToken();
  throw error;
}
```

Then in `src/app/auth/google/callback/route.ts`, handle the variant before the existing `failed(result.error)` line (`:70`) — which will no longer typecheck, since the new variant has no `error`:

```ts
if (result.ok) {
  return NextResponse.redirect(new URL('/me', origin));
}
// Self-disabled: the cookie is set and valid, so send them somewhere the
// reactivate prompt can render. Redirecting to /me instead would bounce off
// the account gate — getCustomer() sees the 403 and reads as logged out.
if ('selfDisabled' in result) {
  return NextResponse.redirect(new URL('/?auth=reactivate', origin));
}
return failed(result.error);
```

Finally, `src/components/AuthModal.tsx` has to answer `?auth=reactivate`. It already has the machinery: a `mode` state, a `polycards:auth` CustomEvent, and a mount effect that turns `?auth=…` into that event. Widen all three rather than adding a second path.

```tsx
import ReactivatePrompt from './auth/ReactivatePrompt';

type AuthMode = 'login' | 'signup' | 'reactivate';

const [mode, setMode] = useState<AuthMode>('login');
```

In the event listener, widen the detail type (`detail?.mode ?? 'login'` needs no other change):

```tsx
const detail = (e as CustomEvent<{ mode?: AuthMode }>).detail;
```

In the `?auth=` effect, accept the third value. Keep dispatching the event rather than calling `setOpen` here — that indirection is deliberate (a synchronous `setState` in an effect is what the React Compiler lint fails CI on):

```tsx
const requested = params.get('auth');
if (
  requested !== 'login' &&
  requested !== 'signup' &&
  requested !== 'reactivate'
) {
  return;
}
```

And in the panel, swap the body. `mode` narrows to `'login' | 'signup'` in the false branch, so `AuthForm` still gets exactly its own union and `onSwitchMode={setMode}` still typechecks (a setter accepting the wider union is assignable where the narrower one is expected):

```tsx
        aria-label={
          mode === 'reactivate'
            ? 'Reactivate account'
            : mode === 'signup'
              ? 'Create account'
              : 'Log in'
        }
```

```tsx
<div ref={panelRef} role="dialog" aria-modal="true" tabIndex={-1}>
  {/* the existing close button, unchanged */}
  {mode === 'reactivate' ? (
    <ReactivatePrompt
      onDone={(reactivated) => {
        setOpen(false);
        // Nothing behind this modal knows the account came back: the callback
        // landed on the home page holding a cookie the guard was refusing.
        if (reactivated) router.refresh();
      }}
    />
  ) : (
    <AuthForm
      mode={mode}
      onSwitchMode={setMode}
      onSuccess={() => setOpen(false)}
    />
  )}
</div>
```

That needs `const router = useRouter();` from `next/navigation` in this component — it does not have one yet. The prompt closes the modal on both answers: on "Reactivate" the customer is back in, on "Not now" it has already logged them out.

- [ ] **Step 8: Verify the whole loop in the browser**

```bash
npm run build
```

```bash
pwsh scripts/serve-standalone.ps1 -Port 4000
```

Log in as a test customer, disable from `/settings`, then log in again with the same credentials: the reactivate prompt must appear, "Reactivate" must land you in the account, and "Not now" must return you to a logged-out state.

Then repeat the loop with a **Google** account — disable from `/settings`, sign in again with Google, and confirm the callback lands on the reactivate prompt rather than bouncing between the account gate and the login modal. This is the path that has no other way back in, so it is the one worth checking by hand.

- [ ] **Step 9: Run every suite**

```bash
npm test
```

```bash
cd backend/packages/api && corepack yarn test:unit
```

```bash
cd backend/packages/api && corepack yarn test:integration:http account-self-service.spec
```

Expected: all PASS.

- [ ] **Step 10: Commit**

`src/app` broadly, not just `src/app/auth`: the `AuthResult` widening reddens `reset-password/ResetPasswordClient.tsx` and any other consumer the build surfaced, and a commit that leaves those out does not build.

```bash
git add src/lib/actions src/components src/app
git commit -m "feat(account): offer reactivation when a self-disabled customer logs in"
```

---

## Self-Review

**Spec coverage.** §1 data model → Task 1. §2 routes: disable/reactivate → Task 4, delete → Task 6, preflight → Task 5, purge ordering → Task 6 Step 6, the notification sweep → Task 6 Steps 4 and 6. §3 guards → Task 3 (the carve-out reads a normalized `req.originalUrl`; Task 7's reactivate case is the only thing that proves it against real Express). §4 storefront: Settings danger zone → Task 9, per-reason links → Tasks 8 and 9, login reactivate → Task 10, public surfaces → Task 7's deleted-but-ranked case. §5 error handling: the fast preflight → Task 5, the authoritative in-lock re-check → Task 6 Step 5. §6 testing → Tasks 2, 3, 4, 5, 6, 6b, 7, 8, 10. The challenge half of "out of scope" → Task 6b.

**Type consistency.** `setAccountDisabled` takes a required `cause` from Task 1 and is called that way in Tasks 4 and 7. `accountDisabledCause` returns `'admin' | 'self' | null` in Task 2 and is consumed with that exact union in Tasks 3 and 4 — and `isAccountDisabled`, whose last callers Task 3 replaces, is deleted in the same task. `DeleteBlockReason` is defined in Task 5 and its members are the keys of both `DELETE_COPY` and `DELETE_LINK` in Task 8. `purgeAccountPacksData` re-enters `deleteAccountPreflight` in Task 6, so the fast check and the authoritative one share a single definition of "settled". `deletedCustomerIds` (Task 6b) reads the `delete_account` audit row Task 6 writes and Task 1's migration authorises. `LifecycleResult` / `DeleteResult` are defined in Task 8 and consumed in Tasks 9 and 10. `AuthResult`'s third variant is added in Task 10; only `login` and `googleCallback` produce it, and Task 10 lists the consumers the widening will break.

**Known verification points** (each has a step that checks reality rather than assuming it): every non-terminal `globepay_deposit` status, enumerated from the model instead of assumed (Task 5 Step 4); `$nin` support in the generated filter builder, with the fallback to use if it is absent (Task 5 Step 5); the nullability of the scrubbed columns (Task 6 Step 3); the notification module's method names and address column (Task 6 Step 4); the `mutateCreditAtomic` / `createGlobePayWithdrawals` / `createDeliveryOrders` / `createPulls` / `setManualFreeze` argument shapes and the leaderboard response shape (Task 7 Step 2); `useModalA11y`'s signature (Task 9 Step 2); and `AuthForm.tsx` / `AuthModal.tsx` internals (Task 10 Steps 6 and 7).

**Three things that were verified against the installed packages during planning, rather than assumed**, because getting any of them wrong is silent and serious:

- `listAuthIdentities({ app_metadata: { customer_id } })` is the officially supported filter shape — Medusa's own `removeCustomerAccountWorkflow` uses exactly it (present at `node_modules/@medusajs/core-flows/dist/customer/workflows/remove-customer-account.js` in the **backend workspace**, not the repo root) — and independently it is sound by construction: `model.json()` → jsonb → MikroORM `JsonType` → `processJsonCondition`. Had it not worked, `emailpassEntityId` would have returned null for every account, silently skipping the password check and leaving login working after a "successful" delete, and every mocked unit test in Task 6 would still have passed.
- `deleteAuthIdentities` is the hard delete; `softDeleteAuthIdentities` is a separate generated method. `IDX_provider_identity_provider_entity_id` carries no `deleted_at` predicate, so the soft variant would permanently block re-signup with that email. Task 7's re-registration assertion is what pins this. The `ON DELETE CASCADE` on `provider_identity.auth_identity_id` (`@medusajs/auth` `Migration20240529080336`) is why no `deleteProviderIdentities` follow-up is needed.
- A method-less middleware entry takes Express's `app.use(matcher, handler)` branch, which strips the matched prefix: `req.path` is `'/'` inside the session guard while `req.originalUrl` still carries the real path. Every other `req.path` reader in this repo sits on an entry carrying `method:`, which does not strip — the difference is the registration, not the matcher. Getting this backwards 403s the one route a self-disabled customer is allowed to call, which locks them out of their own account permanently.
