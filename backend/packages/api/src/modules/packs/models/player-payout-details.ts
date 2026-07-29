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
