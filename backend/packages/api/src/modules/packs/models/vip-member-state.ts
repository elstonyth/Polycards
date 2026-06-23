import { model } from '@medusajs/framework/utils';

// VIP projection (spec §5a/§9). Rebuildable from the ledger; money is NEVER read
// from here. lifetime is monotonic (rank basis); current_level is display only.
export const VipMemberState = model.define('vip_member_state', {
  id: model.id().primaryKey(),
  customer_id: model.text().unique(),
  lifetime_external_spend_sen: model.bigNumber().default(0), // SEN, monotonic
  highest_level_ever: model.number().default(1), // L1 entry-tier floor
  current_level: model.number().default(1),
});

export default VipMemberState;
