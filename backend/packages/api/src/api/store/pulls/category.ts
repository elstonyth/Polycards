import { MedusaRequest } from '@medusajs/framework/http';
import PacksModuleService from '../../../modules/packs/service';

// The categories with a feed of their own. A fixed list, not any value: these
// routes are public and unlimited, and a garbage value must neither cost a pack
// lookup nor take a slot in their caches and evict the real feeds.
const FEED_CATEGORIES: readonly string[] = ['poly'];

/** ?category=<key> on a pull-history route, or null: anything else reads as the
 *  global feed. pack_id wins when both are sent. */
export function categoryParam(
  query: MedusaRequest['query'],
  packId: string | null,
): string | null {
  return !packId &&
    typeof query.category === 'string' &&
    FEED_CATEGORIES.includes(query.category)
    ? query.category
    : null;
}

/** The packs a category's history reads: its ticket packs, active only, so a
 *  Draft capsule's test spins stay out. One pack lookup, run before any ledger
 *  work. Empty answers the route's empty body. */
export function liveTicketPacks(packs: PacksModuleService, category: string) {
  return packs.listPacks(
    { category, status: 'active', prize_type: 'tickets' },
    { take: 1000 },
  );
}
