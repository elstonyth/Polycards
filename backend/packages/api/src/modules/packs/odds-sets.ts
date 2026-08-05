import { Modules } from '@medusajs/framework/utils';
import type {
  ICustomerModuleService,
  MedusaContainer,
} from '@medusajs/framework/types';

export type OddsSet = 1 | 2 | 3;
export type SetWeights = {
  weight: number;
  weight_2?: number | null;
  weight_3?: number | null;
};

/** Name given to the group every player lands in on sign-up. Matches the group
 *  that already exists in production; changing this string would orphan that
 *  row and create a duplicate. */
export const DEFAULT_PLAYER_GROUP_NAME = 'DEFAULT';

/** Marker written on that group's metadata at creation. The NAME is not a safe
 *  identity: the prebuilt /customer-groups screen (which this codebase cannot
 *  extend) can rename it, and a rename would turn the default group into a
 *  "real" one — the oldest one, so its odds would then win for every member —
 *  while ensureDefaultPlayerGroup created a second DEFAULT beside it. The
 *  marker survives a rename; the name check below is the fallback that adopts
 *  the pre-existing production row on first read. */
export const DEFAULT_PLAYER_GROUP_FLAG = 'is_default';

/** Is this the default (ungrouped-equivalent) player group? */
export const isDefaultPlayerGroup = (g: {
  name?: string | null;
  metadata?: Record<string, unknown> | null;
}): boolean =>
  g.metadata?.[DEFAULT_PLAYER_GROUP_FLAG] === true ||
  g.name === DEFAULT_PLAYER_GROUP_NAME;

/** One card's draw weight under a given odds set.
 *
 *  D2 fallback chain, per card: set 2 empty → set 1; set 3 empty → set 2. */
export const weightForSet = (o: SetWeights, set: OddsSet): number =>
  set === 1
    ? o.weight
    : set === 2
      ? (o.weight_2 ?? o.weight)
      : (o.weight_3 ?? o.weight_2 ?? o.weight);

/**
 * A pack's per-card weights aggregated into a per-rarity % split for one set.
 *
 * The ONLY odds grain that may leave the backend (per-card weights are secret):
 * the store pack-detail route publishes this for set 3, which the guest demo
 * spin samples on. Percentages are 2dp and sum to ~100 over the rows given —
 * pass exactly the rows the caller considers drawable (a 0-weight card is
 * unpullable, so it is skipped rather than counted into its tier). Null when
 * nothing is pullable.
 */
export function tierSplitForSet(
  rows: readonly (SetWeights & { rarity?: string | null })[],
  set: OddsSet,
): Record<string, number> | null {
  const tally = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    const w = weightForSet(row, set);
    if (!(w > 0)) continue;
    const rarity = row.rarity ?? 'Common';
    tally.set(rarity, (tally.get(rarity) ?? 0) + w);
    total += w;
  }
  if (total === 0) return null;
  return Object.fromEntries(
    [...tally].map(([rarity, w]) => [
      rarity,
      Math.round((w / total) * 10_000) / 100,
    ]),
  );
}

/** Narrow an untyped `metadata.odds_set` to a real odds set.
 *
 *  Defensive: anything that is not exactly set 2 or 3 rolls to set 1 (the
 *  default group's set). Group metadata is admin-written but untyped JSON. */
export const coerceOddsSet = (v: unknown): OddsSet =>
  v === 2 || v === '2' ? 2 : v === 3 || v === '3' ? 3 : 1;

/**
 * The odds set a customer's spin rolls on. Customer → group → `odds_set`,
 * resolved SERVER-SIDE at spin time (§2.5).
 *
 * No group (or an anonymous/demo roll) → set 1. A customer in several groups
 * gets the OLDEST group's set (created_at ASC — deterministic, documented),
 * EXCEPT the default group, which is skipped whenever the player also belongs
 * to a real one.
 *
 * That exception is the whole reason this reads every group instead of taking
 * one: the default group is created on the first sign-up, so on any fresh
 * install it is OLDER than every group an operator makes afterwards. Under
 * plain oldest-wins, its set 1 would then shadow "pro" forever and moving a
 * player into a group would silently change nothing — a money bug with no
 * visible symptom. Admin moves are exclusive (POST /admin/customers/:id/group
 * clears the others), so multi-group only happens via the prebuilt
 * /customer-groups screen; this keeps that harmless.
 *
 * The default group ALWAYS resolves to set 1, never to whatever `odds_set` its
 * row happens to carry: a member of it and a customer with no group at all
 * must roll identically, or two players the admin shows the same way would
 * silently play different odds (the subscriber is fail-soft, and seeded
 * customers bypass it entirely, so ungrouped players do exist). The admin
 * enforces the same rule by locking that row's odds-set control.
 */
export async function resolveOddsSetForCustomer(
  container: MedusaContainer,
  customerId?: string,
): Promise<OddsSet> {
  if (!customerId) return 1;
  const customers = container.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const groups = await customers.listCustomerGroups(
    { customers: customerId },
    { order: { created_at: 'ASC' } },
  );
  const group = groups.find((g) => !isDefaultPlayerGroup(g));
  return group ? coerceOddsSet(group.metadata?.odds_set) : 1;
}
