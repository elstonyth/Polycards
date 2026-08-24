import { model } from '@medusajs/framework/utils';

// Who referred whom. One row per referred customer, written once at signup
// (bindReferral) and never updated — attribution is permanent by spec
// (docs/superpowers/specs/2026-08-24-referral-tasks-rebuild-design.md).
// referrer_id is a customer id; the public referral code is the referrer's
// profile handle, resolved at bind time (utils/customer-by-handle.ts) in the
// route layer so this module never reaches into another module's tables.
export const ReferralAttribution = model
  .define('referral_attribution', {
    id: model.id().primaryKey(),
    customer_id: model.text().unique(),
    referrer_id: model.text(),
  })
  .indexes([
    {
      name: 'IDX_referral_attribution_referrer',
      on: ['referrer_id'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default ReferralAttribution;
