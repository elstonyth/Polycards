import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { PACKS_MODULE } from "../modules/packs";
import type PacksModuleService from "../modules/packs/service";
import { pcFetch } from "../api/admin/pricecharting/client";
import { fetchUsdMyr } from "../modules/packs/pricing";
import { refreshCardPrice, type CardRow } from "../modules/packs/sync-market-prices";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// pcFetch<T> is generic over the raw PriceCharting response shape; the real
// upstream product payload (see api/admin/pricecharting/product/route.ts) is
// integer-pennies fields keyed by PRICE_FIELDS (e.g. "manual-only-price").
// Typing T as a plain Record here yields exactly the raw penny fields
// refreshCardPrice expects — no reshaping needed, `pcFetch` already returns
// { kind: "ok", data: <raw penny fields> } | { kind: "no-token" } | { kind: "error", message }.
type PcProductRaw = { status: string; "error-message"?: string } & Record<string, unknown>;
const pcFetchRaw = (path: string, params: Record<string, string>) => pcFetch<PcProductRaw>(path, params);

export default async function syncMarketPricesJob(container: MedusaContainer): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const now = new Date();

  try {
    const rate = await fetchUsdMyr();
    const [row] = await packs.listFxRates({ pair: "USD_MYR" }, { take: 1 });
    if (row) await packs.updateFxRates([{ id: row.id, rate, source: "frankfurter", fetched_at: now }]);
    else await packs.createFxRates([{ pair: "USD_MYR", rate, source: "frankfurter", fetched_at: now }]);
    logger.info(`[sync-market-prices] FX USD->MYR = ${rate}`);
  } catch (e) {
    logger.warn(`[sync-market-prices] FX failed, keeping last-known: ${(e as Error).message}`);
  }

  const cards: CardRow[] = (await packs.listCards({}, { take: 10000 })).filter(
    (c: CardRow) => c.pc_product_id,
  );
  let changed = 0;
  for (const card of cards) {
    try {
      const r = await refreshCardPrice(card, { pcFetch: pcFetchRaw, updateCards: (u) => packs.updateCards(u), now });
      if (r.changed) {
        changed++;
        logger.info(`[sync-market-prices] ${r.handle} ${r.oldValue} -> ${r.newValue}`);
      } else if (r.skippedReason) {
        logger.warn(`[sync-market-prices] skip ${r.handle}: ${r.skippedReason}`);
      }
    } catch (e) {
      logger.error(`[sync-market-prices] card ${card.handle || card.id} failed: ${(e as Error).message}`);
    } finally {
      await sleep(1100);
    }
  }
  logger.info(`[sync-market-prices] done: ${changed}/${cards.length} updated`);
}

export const config = { name: "sync-market-prices", schedule: "0 3 * * *" };
