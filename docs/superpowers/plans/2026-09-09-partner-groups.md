# Partner Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a customer group be a partner group (own commission rate, withdrawals blocked, phone verification off), show partner status everywhere in the admin, and fix the prebuilt Customer Groups rename.

**Architecture:** Group policy is three keys on `customer_group.metadata`, read by one resolver (`group-policy.ts`) that the money gates, the referral engine and the admin routes all share. Group config beats per-customer config, and the per-customer setter refuses while the group applies. One repo route writes the policy with bounds validation and an audit row.

**Tech Stack:** Medusa 2.19 (backend), Mercur admin (Vite + @medusajs/ui), Next.js storefront, jest (backend), vitest (admin + storefront).

**Spec:** `docs/superpowers/specs/2026-09-09-partner-groups-design.md`

## Global Constraints

- Partner rate bounds come from `referral_settings.partner_min_bp/partner_max_bp` (default 300–500). Never hardcode.
- DEFAULT group (marker `is_default`) can never be a partner group.
- Every admin mutation route is registered with `adminActionRateLimit` in `middlewares.ts` (coverage guard `admin-rate-limit-coverage.unit.spec.ts`).
- Backend unit tests: `cd backend/packages/api && TEST_TYPE=unit NODE_OPTIONS=--experimental-vm-modules node node_modules/jest/bin/jest.js --runInBand --forceExit <pattern>`.
- Backend HTTP tests: `node integration-tests/run-http-shards.mjs <spec-name>` from `backend/packages/api`.
- Admin constants are COPIED, not imported; the contract test reads backend source.
- Backend + admin code style: single quotes, 2-space, no `any`.

---

### Task 1: group-policy resolver (backend, pure + container)

**Files:**

- Create: `backend/packages/api/src/modules/packs/group-policy.ts`
- Modify: `backend/packages/api/src/modules/packs/odds-sets.ts:152-165` (extract `resolvePlayerGroup`)
- Test: `backend/packages/api/src/modules/packs/__tests__/group-policy.unit.spec.ts`

**Interfaces:**

- Produces:

  ```ts
  export type GroupPolicy = { partner_rate_bp: number | null; withdrawals_blocked: boolean; verification_exempt: boolean };
  export const EMPTY_GROUP_POLICY: GroupPolicy;
  export const groupPolicyOf = (g: { metadata?: Record<string, unknown> | null }): GroupPolicy;
  export const isPartnerGroup = (g): boolean;
  export async function resolvePlayerGroup(container, customerId?: string): Promise<CustomerGroupDTO | null>; // in odds-sets.ts
  export async function resolveGroupPolicyForCustomer(container, customerId?: string): Promise<{ group: { id: string; name: string }; policy: GroupPolicy } | null>;
  ```

- [ ] Write failing unit tests: coercion (`'400'` → 400, `4.5` → null, `-1` → null, missing → null; toggles only `true` is true), resolver skips DEFAULT, returns null for no group, oldest-wins.
- [ ] Implement; `resolveOddsSetForCustomer` now = `coerceOddsSet((await resolvePlayerGroup(...))?.metadata?.odds_set)`.
- [ ] Run `odds-sets.unit.spec.ts` + new spec green. Commit.

### Task 2: audit enum + migration

**Files:**

- Modify: `backend/packages/api/src/modules/packs/models/admin-action-audit.ts` (add `'customer_group'` entity_type, `'edit_group_policy'` action)
- Create: `backend/packages/api/src/modules/packs/migrations/Migration20260909090000.ts` (drop/re-add both CHECKs, guarded down)

- [ ] Copy the recipe from `Migration20260906090000.ts`, include the full current lists plus the two new values. Commit.

### Task 3: `editGroupPolicy` + `setPartnerRate` refusal + effective rate (service)

**Files:**

- Modify: `backend/packages/api/src/modules/packs/service.ts` (`setPartnerRate` ~1010, close-week ~1178, `referralStorefrontSummary` ~1812)
- Test: `backend/packages/api/integration-tests/http/player-groups-policy.spec.ts` (Task 5 exercises these end-to-end)

**Interfaces:**

- Produces:
  ```ts
  editGroupPolicy(input: { groupId: string; policy: GroupPolicy; adminId: string; reason?: string }): Promise<CustomerGroupDTO>
  partnerBpForCustomers(ids: string[]): Promise<Map<string, number | null>> // group rate wins, then state row
  ```
- `editGroupPolicy`: refuse DEFAULT (`isDefaultPlayerGroup`), validate `partner_rate_bp` integer within bounds when non-null, force toggles false when null, `updateCustomerGroups(id, { metadata })` (Medusa merges per key), audit `{ entity_type: 'customer_group', action: 'edit_group_policy', before, after }`.
- `setPartnerRate`: before writing, `resolveGroupPolicyForCustomer`; if partner group → INVALID_DATA `Customer is in partner group "<name>". Move them out of the group to set a per-customer rate.`
- Close-week + storefront summary use `partnerBpForCustomers`.

- [ ] Implement; typecheck. Commit.

### Task 4: routes + middlewares

**Files:**

- Create: `backend/packages/api/src/api/admin/customer-groups/[id]/policy/route.ts` (POST)
- Create: `backend/packages/api/src/api/utils/customer-group-guards.ts` (`stripAdditionalData`, `blockGroupWithdrawals`)
- Modify: `backend/packages/api/src/api/utils/phone-verification-guard.ts:requirePhoneVerified` (exempt branch)
- Modify: `backend/packages/api/src/api/middlewares.ts` (register strip on `/admin/customer-groups` + `/admin/customer-groups/*` POST; policy route with `adminActionRateLimit`; `blockGroupWithdrawals` on `/store/credits/withdraw`)
- Modify: `backend/packages/api/src/api/admin/players/route.ts` (`partner`), `backend/packages/api/src/api/admin/customers/[id]/referral/route.ts` (`partner_group`), `backend/packages/api/src/api/store/customers/me/account/route.ts` (`policy`)
- Test: `backend/packages/api/src/api/utils/__tests__/customer-group-guards.unit.spec.ts`, extend `phone-verification-guard.unit.spec.ts`

- [ ] Unit tests first (strip removes key only; withdraw block 403s member of blocked group, passes otherwise, fails closed on read error; phone gate passes exempt unverified customer, still refuses non-exempt).
- [ ] Implement. Run `admin-rate-limit-coverage.unit.spec.ts`. Commit.

### Task 5: HTTP integration spec

**Files:**

- Create: `backend/packages/api/integration-tests/http/player-groups-policy.spec.ts`

Cases: policy route validates bounds (400 at 250 bp with default 300–500), refuses DEFAULT, writes audit row; rename via `POST /admin/customer-groups/:id { name, additional_data: {} }` → 200; `POST /admin/customers/:id/partner-rate` → 400 for a member of a partner group; `GET /admin/players` row `partner: 'group'`; `GET /store/customers/me/account` → `policy.withdrawals_blocked: true`; `POST /store/credits/withdraw` → 403 for the member.

- [ ] Write, run `node integration-tests/run-http-shards.mjs player-groups-policy`. Commit.

### Task 6: admin — Player Groups page

**Files:**

- Modify: `backend/apps/admin/src/lib/player-groups.ts` (+ `GroupPolicy`, `groupPolicyOf`, `isPartnerGroup` copies), `player-groups.contract.test.ts` (new keys), `lib/admin-rest.ts` (`setGroupPolicy`), `lib/queries.ts` (`useSetGroupPolicy`), `routes/odds-sets/page.tsx` (columns), `i18n/en.json`.

- [ ] Contract test: assert backend `group-policy.ts` literals `'partner_rate_bp'`, `'withdrawals_blocked'`, `'verification_exempt'`.
- [ ] Row UI: Partner switch → rate input (%), Withdrawals select, Verification select, Save (window.prompt reason). DEFAULT locked. Commit.

### Task 7: admin — players list badge + customer detail

**Files:**

- Modify: `backend/apps/admin/src/lib/admin-rest.ts` (`AdminPlayer.partner`, `CustomerReferralCard.partner_group`), `routes/players/page.tsx` (badge), `routes/customers/[id]/page.tsx` (header badge, Referral card lock), `i18n/en.json`.

- [ ] Commit.

### Task 8: storefront

**Files:**

- Modify: `src/lib/data/schemas.ts` (`AccountInfoSchema.policy` optional), `src/lib/data/customer.ts` (`AccountInfo.policy`), `src/lib/phone-gate.ts` (`exempt`), `src/app/(account)/layout.tsx`, `src/app/bank-withdrawal/page.tsx`
- Test: `src/lib/__tests__/phone-gate.test.ts` (or existing gate test) exempt case.

- [ ] Commit.

### Task 9: verify + screenshots

- [ ] `corepack yarn check-types` (backend), admin `tsc -b`, `npm run check` storefront, unit suites.
- [ ] Run the stack from the worktree (backend :9000 from worktree, admin :7000, storefront build :4100), create a partner group in the admin, move a player in, capture: Player Groups page, Players list badge, customer detail lock, rename success, storefront withdraw notice.
