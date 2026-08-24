import { model } from '@medusajs/framework/utils';

// One row per VIP rung (1..100). Admin-editable config; seeded from
// src/scripts/vip-levels.data.ts (canonical Workbook1.xlsx ladder). spend_threshold is
// cumulative MYR to REACH this level (strictly increasing, 0 at L1, 3,000,000 at L100).
export const VipLevel = model
  .define('vip_level', {
    id: model.id().primaryKey(),
    level: model.number().unique(),
    spend_threshold: model.bigNumber(),
    voucher_amount: model.bigNumber(),
    box_tier: model.text(),
    frame_unlock: model.boolean().default(false),
    // Referral rebuild (spec 2026-08-24): weekly personal rebate (回水) on the
    // member's OWN pack turnover, in basis points. 0 = no rebate at this rung.
    // NOT the removed direct_referral_pct (that paid commission on DOWNLINE
    // spend); this pays the spender themself, on the Tue-close/Wed-pay cycle.
    rebate_bp: model.number().default(0),
    prizes: model.json().nullable(),
  })
  .indexes([
    {
      name: 'IDX_vip_level_level',
      on: ['level'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default VipLevel;
