import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { pageAll } from '../../../utils/page-all';

// GET /admin/pricing/health — staleness dashboard for the two money feeds
// (audit 2026-07-07 #3b): the FX row's age and how many PriceCharting-linked
// cards have not synced recently. Pure reads.
const STALE_MS = 48 * 60 * 60 * 1000;

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const now = Date.now();

  const [fxRow] = await packs.listFxRates({ pair: 'USD_MYR' }, { take: 1 });
  const fetchedAt = fxRow?.fetched_at ? new Date(fxRow.fetched_at) : null;

  // Paged to exhaustion like /admin/economy's card load and the sync job — a
  // flat cap would silently under-report exactly the staleness this endpoint
  // exists to surface.
  const allCards = await pageAll((opts) => packs.listCards({}, opts));
  const linkedCards = allCards.filter((c) => c.pc_product_id);
  let neverSynced = 0;
  let stale = 0;
  for (const c of linkedCards) {
    const at = c.pc_synced_at ? new Date(c.pc_synced_at).getTime() : null;
    if (at === null) neverSynced++;
    else if (now - at > STALE_MS) stale++;
  }

  // Card↔Product coupling is a handle-string CONVENTION (src/links is empty) —
  // a renamed product handle silently breaks stock earmarks, buyback restock,
  // and the reward-box stock gate (audit 2026-07-07 #8). Detect the break here
  // since we can't prevent it in Medusa's generic product admin.
  const productModule = req.scope.resolve(Modules.PRODUCT);
  const cardHandles = allCards.map((c) => c.handle);
  const products = cardHandles.length
    ? await productModule.listProducts(
        { handle: cardHandles },
        { take: cardHandles.length, select: ['handle'] },
      )
    : [];
  const productHandles = new Set(products.map((p) => p.handle));
  const unlinkedProducts = cardHandles.filter((h) => !productHandles.has(h));

  res.json({
    fx: fxRow
      ? {
          rate: Number(fxRow.rate),
          source: fxRow.source,
          manual_override: fxRow.manual_override,
          fetched_at: fxRow.fetched_at,
          age_hours: fetchedAt
            ? Math.round((now - fetchedAt.getTime()) / 36e5)
            : null,
        }
      : null,
    cards: {
      linked: linkedCards.length,
      never_synced: neverSynced,
      stale_48h: stale,
      // Card handles with NO matching Product — broken handle coupling.
      missing_product: unlinkedProducts,
    },
  });
}
