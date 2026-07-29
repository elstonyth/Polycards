import type PacksModuleService from './service';
import { pageAll } from '../../api/utils/page-all';

// A pack is openable only when its prize pool has at least one CARD odds row
// with positive weight — the exact precondition roll-pack's fetchPackData
// enforces at spin time. The activation guards (create/update pack,
// set-pack-members) check this BEFORE a pack can go/stay active, so a customer
// can never see a spinnable pack whose every spin would fail.
//
// Checks set 1 only — sufficient because every save re-balances all sets to
// Σ=10000 bps (computeSetWeights), so a pack rollable on set 1 is rollable on
// every set.
//
// Paged (not take:1000): a pack may hold 2000+ card rows, and a bare cap could
// scan only rows that are all zero-weight/locked and wrongly report the pool
// unrollable. Short-circuit is impossible through pageAll, but the pool read is
// small and infrequent.
export async function hasRollablePool(
  packs: PacksModuleService,
  slug: string,
): Promise<boolean> {
  const odds = await pageAll((opts) =>
    packs.listPackOdds({ pack_id: slug }, opts),
  );
  return odds.some((o) => o.card_id != null && o.weight > 0);
}
