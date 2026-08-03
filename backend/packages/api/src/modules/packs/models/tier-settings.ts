import { model } from '@medusajs/framework/utils';

// tier_settings — singleton (same pattern as challenge_settings: one row,
// create-on-first-edit, fixed id 'global' with a DB CHECK). `ranges` holds the
// admin-configured RM display-price range per rarity tier
// (TierRangeMap-shaped: rarity → { min, max }, null bound = open side). The
// ranges are ADVISORY: the admin app uses them to default a tier when a card
// joins a prize pool and to flag price drift — the server never rejects or
// rewrites a rarity from them.
export const TierSettings = model.define('tier_settings', {
  id: model.id().primaryKey(),
  ranges: model.json(),
});

export default TierSettings;
