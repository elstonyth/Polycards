# Partner groups: group-level special accounts

**Date:** 2026-09-09 · **Status:** approved in chat by the operator · **Builds on:** `2026-08-24-referral-tasks-rebuild-design.md` (partner accounts), ADR 0005 (player groups / odds sets)

## Problem

Today a "special" (partner) account is a per-customer flag: `customer_account_state.partner_referral_bp`. The operator wants the same thing at the **customer group** level, with two extra controls that only make sense for a partner group, an unmistakable "this is a partner" indicator in the admin, and a fix for the prebuilt Customer Groups screen, which cannot rename a group.

## Decisions (locked with the operator, 2026-09-09)

| Question | Decision |
| --- | --- |
| Where does group-level partner config live? | `customer_group.metadata`, beside the existing `odds_set`. No new table. |
| Does a partner group carry a rate? | **Yes.** `partner_rate_bp` (int, basis points). Non-null = partner group. Members inherit it. Same bounds as the per-customer rate (`referral_settings.partner_min_bp/max_bp`). |
| Two group toggles | `withdrawals_blocked` (members cannot start a bank withdrawal) and `verification_exempt` (members skip the phone-verification gates). Both booleans, both cleared when the group stops being a partner group. |
| "All verifications" | Phone OTP is the only customer verification in this codebase: `requirePhoneVerified` on top-up, deposit, delivery-order create, withdraw; plus the storefront account-tree phone modal. Nothing else. |
| Withdraw block scope | Bank withdrawals (`POST /store/credits/withdraw`) only. Spending, buyback credit, pack opens, pending withdrawals created before the block: unaffected. |
| Precedence | **Group wins.** A customer in a partner group uses the group's rate. Their own `partner_referral_bp` stays stored, inert, and resurfaces when they leave the group. |
| Conflict rule | While a customer is in a partner group, the per-customer rate cannot be set: the admin card is disabled AND `setPartnerRate` refuses with 400. The operator moves the player out of the group first, then sets a per-customer rate. |
| DEFAULT group | Locked: cannot be a partner group, same reason its odds set is locked (ungrouped players must roll and behave exactly like DEFAULT members). |
| Rename bug | Mercur's Edit Customer Group form (`useExtendableForm`) always posts `additional_data: {}`; core Medusa 2.19's strict `AdminUpdateCustomerGroup` has no such field, so every rename 400s. Fix: a repo middleware strips `additional_data` from `POST /admin/customer-groups` and `POST /admin/customer-groups/:id` bodies. Project middlewares register before core route middlewares (framework `ApiLoader`: project api dir is scanned first and the sorter keeps insertion order), so the strip runs before the validator. |

## Data model

```
customer_group.metadata = {
  odds_set: 1 | 2 | 3,              // existing
  is_default: true,                 // existing marker on DEFAULT only
  partner_rate_bp: number | null,   // NEW  non-null ⇒ partner group
  withdrawals_blocked: boolean,     // NEW
  verification_exempt: boolean,     // NEW
}
```

Reading is defensive (untyped JSON): anything that is not a finite integer is `null`; anything that is not `true` is `false`.

Audit: `admin_action_audit` gains `entity_type: 'customer_group'` and `action: 'edit_group_policy'`. One migration widens both CHECKs (same drop/re-add recipe as `Migration20260906090000`).

## Backend

- `modules/packs/group-policy.ts`
  - `GroupPolicy = { partner_rate_bp: number | null; withdrawals_blocked: boolean; verification_exempt: boolean }`
  - `groupPolicyOf(group)` — pure, from metadata.
  - `isPartnerGroup(group)` — `partner_rate_bp !== null`.
  - `resolvePlayerGroup(container, customerId)` — the customer's effective group: oldest non-DEFAULT membership, or null. Extracted from `resolveOddsSetForCustomer`, which now calls it.
  - `resolveGroupPolicyForCustomer(container, customerId)` — `{ group: {id,name}, policy } | null`.
- `PacksModuleService`
  - `editGroupPolicy({ groupId, policy, adminId, reason })` — validates bounds when `partner_rate_bp` is non-null, refuses DEFAULT, forces both toggles false when not partner, merges metadata through the customer module, writes the audit row.
  - `setPartnerRate` — refuses (INVALID_DATA) when `resolveGroupPolicyForCustomer` says the customer is in a partner group.
  - `effectivePartnerBp` used by: close-week job (batched: list partner groups, then their member ids), `referralStorefrontSummary`, the admin referral card route.
- Routes
  - `POST /admin/customer-groups/:id/policy` body `{ partner_rate_bp: number|null, withdrawals_blocked: boolean, verification_exempt: boolean, reason: string }` → `{ customer_group }`. Registered with `adminActionRateLimit`.
  - `GET /admin/players` rows gain `partner: 'group' | 'manual' | null`.
  - `GET /admin/customers/:id/referral` gains `partner_group: { id, name, rate_bp } | null`.
  - `GET /store/customers/me/account` gains `policy: { partner: boolean, withdrawals_blocked: boolean, verification_exempt: boolean }`.
- Middleware
  - `stripAdditionalData` on `POST /admin/customer-groups` and `POST /admin/customer-groups/*`.
  - `blockGroupWithdrawals` on `POST /store/credits/withdraw` (after rate limit, before `requirePhoneVerified`): NOT_ALLOWED "Withdrawals are not available on this account."
  - `requirePhoneVerified`: an unverified customer passes when their group policy has `verification_exempt`. Fail-closed on read errors, as today.

## Admin UI

- **Odds Sets page becomes "Player Groups"** (same route `/odds-sets`). Per row: name, odds set, Partner switch, rate %, Withdrawals (Allowed / Blocked), Phone verification (Required / Off), members, Save (reason prompt, audited). DEFAULT row locked.
- **Players list:** purple "Partner" badge in the Status column; title attribute says "via group" or "manual".
- **Customer detail:** header badge "Partner" (with group name when group-sourced). Referral card: rate input, Set and Clear disabled with the note "Set by group ‹name›. Move the player out of the group to set a per-customer rate." when group-sourced.

## Storefront

- `shouldGatePhone` takes `exempt`; the account layout reads it from `getAccountInfo().policy.verificationExempt` and skips the phone modal.
- `/bank-withdrawal` renders "Withdrawals are not available on this account." instead of the form when `policy.withdrawalsBlocked`. The backend refusal remains the enforcement.

## Tests

- Unit: `group-policy.unit.spec.ts` (coercion, resolver, DEFAULT skip), `phone-verification-guard.unit.spec.ts` (exempt passes, non-exempt still refused, read error fails closed), `withdrawal-block-guard.unit.spec.ts`, `strip-additional-data.unit.spec.ts`, `odds-sets.unit.spec.ts` unchanged and green after the extraction.
- HTTP integration: `player-groups-policy.spec.ts` — policy route validates bounds / refuses DEFAULT / audits; rename with `additional_data` returns 200; `setPartnerRate` refused for a member of a partner group; players list `partner` field; account route `policy` block.
- Admin vitest: `player-groups.contract.test.ts` extended to the three new metadata keys; `player-groups.test.ts` for `groupPolicyOf`.
- Storefront vitest: `phone-gate.test.ts` exempt case.
