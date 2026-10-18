import type { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import { pcFetch } from '../api/admin/pricecharting/client';
import { fetchUsdMyr } from '../modules/packs/pricing';
import {
  recordPriceHistory,
  refreshCardPrice,
  type CardRow,
} from '../modules/packs/sync-market-prices';
import { pageAll } from '../api/utils/page-all';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// pcFetch<T> is generic over the raw PriceCharting response shape; the real
// upstream product payload (see api/admin/pricecharting/product/route.ts) is
// integer-pennies fields keyed by PRICE_FIELDS (e.g. "manual-only-price").
// Typing T as a plain Record here yields exactly the raw penny fields
// refreshCardPrice expects — no reshaping needed, `pcFetch` already returns
// { kind: "ok", data: <raw penny fields> } | { kind: "no-token" } | { kind: "error", message }.
type PcProductRaw = { status: string; 'error-message'?: string } & Record<
  string,
  unknown
>;
const pcFetchRaw = (path: string, params: Record<string, string>) =>
  pcFetch<PcProductRaw>(path, params);

export default async function syncMarketPricesJob(
  container: MedusaContainer,
): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const now = new Date();

  try {
    const rate = await fetchUsdMyr();
    const [row] = await packs.listFxRates({ pair: 'USD_MYR' }, { take: 1 });
    if (row)
      await packs.updateFxRates([
        { id: row.id, rate, source: 'frankfurter', fetched_at: now },
      ]);
    else
      await packs.createFxRates([
        { pair: 'USD_MYR', rate, source: 'frankfurter', fetched_at: now },
      ]);
    logger.info(`[sync-market-prices] FX USD->MYR = ${rate}`);
  } catch (e) {
    logger.warn(
      `[sync-market-prices] FX failed, keeping last-known: ${(e as Error).message}`,
    );
  }

  // Paginate past linked cards beyond a single page — a `take: N` cap would
  // silently stop syncing cards past N as the catalog grows.
  const cards: CardRow[] = (
    await pageAll<CardRow>((opts) => packs.listCards({}, opts))
  ).filter((c: CardRow) => c.pc_product_id);
  let changed = 0;
  let skipped = 0;
  let failed = 0;
  for (const card of cards) {
    let observed: CardRow = card;
    try {
      // A catalog sweep takes minutes; honor edits/unlinks made since its first read.
      const [current] = await packs.listCards({ id: card.id }, { take: 1 });
      if (!current?.pc_product_id) {
        skipped++;
        continue;
      }
      observed = current;
      const r = await refreshCardPrice(current, {
        pcFetch: pcFetchRaw,
        updateCards: ([update]) => packs.applyCardPriceSync(current, update),
        now: new Date(),
      });
      if (r.changed) {
        changed++;
        logger.info(
          `[sync-market-prices] ${r.handle} ${r.oldValue} -> ${r.newValue}`,
        );
      } else if (r.skippedReason) {
        skipped++;
        logger.warn(
          `[sync-market-prices] skip ${r.handle}: ${r.skippedReason}`,
        );
      }
      await recordPriceHistory(packs, card.id, r);
    } catch (e) {
      failed++;
      logger.error(
        `[sync-market-prices] card ${card.handle || card.id} failed: ${(e as Error).message}`,
      );
      try {
        // Unexpected errors may contain upstream URLs; store only safe operator copy.
        await packs.applyCardPriceSync(observed, {
          id: card.id,
          pc_pending_price: null,
          pc_sync_error: 'Price sync failed; retry on the next scheduled sync.',
        });
      } catch {
        logger.error(
          `[sync-market-prices] could not persist failure for ${card.handle || card.id}`,
        );
      }
    } finally {
      await sleep(1100);
    }
  }
  const summary = `[sync-market-prices] done: ${changed}/${cards.length} updated, ${skipped} skipped, ${failed} failed`;
  if (skipped > 0 || failed > 0) logger.warn(summary);
  else logger.info(summary);
}

export const config = { name: 'sync-market-prices', schedule: '0 3 * * *' };
