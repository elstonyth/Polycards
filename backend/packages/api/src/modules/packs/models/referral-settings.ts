import { model } from '@medusajs/framework/utils';

// Singleton (id='global'), same pattern as tier_settings. `tiers` is the
// whole-amount commission tier table [{ min_cents, rate_bp }], sorted
// ascending by min_cents; resolveRateBp (referral.ts) picks the last row
// whose min_cents <= the referrer's downline weekly turnover. NOT marginal
// brackets — the matched rate applies to the whole amount.
// partner_min_bp / partner_max_bp bound the manual partner override rate
// (customer_account_state.partner_referral_bp).
export const ReferralSettings = model.define('referral_settings', {
  id: model.id().primaryKey(),
  tiers: model.json(),
  partner_min_bp: model.number().default(300),
  partner_max_bp: model.number().default(500),
});

export default ReferralSettings;
