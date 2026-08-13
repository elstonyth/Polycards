import { model } from '@medusajs/framework/utils';

// customer_account_state — per-customer freeze flag (Phase 3a). One row per
// customer (lazy-created on first freeze). `frozen ⇒ availableBalance()=0`
// inside the money lock. `cause` distinguishes an auto (clawback-negative,
// auto-clears on repayment) freeze from a manual (admin, sticky) one.
// `disabled` (§4.2) is a LOGIN block, orthogonal to `frozen`: an admin can
// disable an account without touching its funds, and vice versa. Always
// manual — there is no auto-disable path.
//
// `phone_verified_at` is the PERSISTED half of phone verification. The OTP
// proof tokens (utils/phone-verification.ts) are stateless and expire in 10
// minutes, so they can answer "did this caller just prove a number?" but never
// "has this account ever verified?" — which is what the topup/delivery gates
// need. Deliberately NOT inferred from `customer.phone`: a phone written before
// PHONE_VERIFICATION_REQUIRED was flipped on was never proven, and Google
// signups carry no phone at all.
export const CustomerAccountState = model
  .define('customer_account_state', {
    id: model.id().primaryKey(),
    customer_id: model.text().unique(), // one row per customer
    frozen: model.boolean().default(false),
    cause: model.enum(['auto', 'manual']).nullable(),
    frozen_reason: model.text().nullable(),
    frozen_by: model.text().nullable(), // admin_id; null for auto
    frozen_at: model.dateTime().nullable(),
    unfrozen_at: model.dateTime().nullable(),
    unfreeze_cause: model.enum(['repaid', 'admin']).nullable(),
    disabled: model.boolean().default(false),
    disabled_reason: model.text().nullable(),
    // Who performed the disable, NOT necessarily an admin: the self-disable
    // route passes the customer's own id (store/customers/me/disable/route.ts:52)
    // so the audit row records the real actor. Read it together with
    // `disabled_cause` — that column is what says which kind of actor this is.
    disabled_by: model.text().nullable(),
    disabled_at: model.dateTime().nullable(),
    // Who disabled this account. 'admin' is the §4.2 support lever; 'self' is
    // the customer's own reversible disable. NULL means "written before this
    // column existed" and every guard MUST treat it as 'admin' — see
    // disabled-guard.ts. Deliberately a separate column from `cause` (which
    // belongs to `frozen`): the two flags are orthogonal and share no history.
    disabled_cause: model.enum(['admin', 'self']).nullable(),
    phone_verified_at: model.dateTime().nullable(),
  })
  .indexes([
    {
      name: 'IDX_customer_account_state_frozen',
      on: ['customer_id'],
      where: 'frozen = true AND deleted_at IS NULL',
    },
    {
      name: 'IDX_customer_account_state_disabled',
      on: ['customer_id'],
      where: 'disabled = true AND deleted_at IS NULL',
    },
  ]);

export default CustomerAccountState;
