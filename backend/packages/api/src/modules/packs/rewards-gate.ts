// Global fail-closed redemption gate (spec §13). Default OFF: redemption stays
// dark until REWARDS_REDEMPTION_ENABLED is explicitly set to the string 'true'.
// Guards CLAIM (which mints value), at both the route and the service boundary
// (defense-in-depth). It used to guard WITHDRAW too, on the premise that no
// legitimate prize could exist to ship before launch — false since /task claims
// started minting source='reward' pulls, so withdraw is ungated (2026-10-08).
export const rewardsRedemptionEnabled = (): boolean =>
  process.env.REWARDS_REDEMPTION_ENABLED === 'true';
