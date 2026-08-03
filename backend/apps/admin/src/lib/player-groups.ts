// Player-group rules the admin has to agree with the backend about.
//
// COPIED, not imported: this app builds standalone and cannot reach
// packages/api. `player-groups.contract.test.ts` reads the backend source and
// fails if these drift — without that, the Profile tab could name a different
// group (or a different odds set) than the spin actually rolls, which is a lie
// the operator would act on.

/** Mirrors DEFAULT_PLAYER_GROUP_NAME in packs/odds-sets.ts. */
export const DEFAULT_PLAYER_GROUP_NAME = 'DEFAULT';

/** Mirrors DEFAULT_PLAYER_GROUP_FLAG in packs/odds-sets.ts. The metadata
 *  marker, not the name, is identity: the prebuilt /customer-groups screen can
 *  rename the group. */
export const DEFAULT_PLAYER_GROUP_FLAG = 'is_default';

export const isDefaultPlayerGroup = (g: {
  name?: string | null;
  metadata?: Record<string, unknown> | null;
}): boolean =>
  g.metadata?.[DEFAULT_PLAYER_GROUP_FLAG] === true ||
  g.name === DEFAULT_PLAYER_GROUP_NAME;

/** Mirrors coerceOddsSet in packs/odds-sets.ts — group metadata is untyped
 *  JSON, so anything that is not exactly 2 or 3 (including a missing key) is
 *  set 1. */
export const oddsSetOf = (v: unknown): 1 | 2 | 3 =>
  v === 2 || v === '2' ? 2 : v === 3 || v === '3' ? 3 : 1;

/** The odds set a group's members actually roll.
 *
 *  The default group is pinned to 1 no matter what its row says: its members
 *  and customers with NO group must roll identically (resolveOddsSetForCustomer
 *  returns 1 for both), and ungrouped customers do exist — the assignment
 *  subscriber is fail-soft and the seed script bypasses it. Showing this row's
 *  stored value would tell the operator two identical-looking players roll the
 *  same odds when they do not. */
export const effectiveOddsSet = (g: {
  name?: string | null;
  metadata?: Record<string, unknown> | null;
}): 1 | 2 | 3 =>
  isDefaultPlayerGroup(g) ? 1 : oddsSetOf(g.metadata?.odds_set);
