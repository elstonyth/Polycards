import type { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import { pcFetch } from '../api/admin/pricecharting/client';
import {
  recordPriceHistory,
  refreshCardPrice,
  type CardRow,
  type PricechartingFeed,
} from '../modules/packs/sync-market-prices';
import { pageAll } from '../api/utils/page-all';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// pcFetch<T> is generic over the raw PriceCharting response shape; the real
// upstream product payload (see api/admin/pricecharting/product/route.ts) is
// integer-pennies fields keyed by PRICE_FIELDS (e.g. "manual-only-price").
// Typing T as a plain Record here yields exactly the raw penny fields
// refreshCardPrice expects — no reshaping needed. The result is `PcResult` in
// api/admin/pricecharting/client.ts; its error `cause` ('auth' | 'unavailable')
// drives the outage handling below.
type PcProductRaw = { status: string; 'error-message'?: string } & Record<
  string,
  unknown
>;
const pcFetchRaw = (path: string, params: Record<string, string>) =>
  pcFetch<PcProductRaw>(path, params);

// The admin "token expired" alert (GET /admin/pricing/health). Touches only
// this column: the singleton also holds the payment gateway and withdrawal
// switches.
async function saveFeed(
  packs: PacksModuleService,
  feed: PricechartingFeed | null,
): Promise<void> {
  const [row] = await packs.listSiteSettings({}, { take: 1 });
  if (row)
    await packs.updateSiteSettings({
      selector: { id: row.id },
      data: { pricecharting_feed: feed },
    });
  else
    await packs.createSiteSettings([
      { id: 'global', pricecharting_feed: feed },
    ]);
}

// All scheduled jobs share ONE BullMQ slot (concurrency 1), and a full sweep
// takes ~1.1 s per linked card. Awaiting it here held up deposit-reconcile
// (the only path crediting TGPay top-ups) for the whole sweep (audit
// 2026-11-11), so the job starts the sweep and returns. A tick is handed to
// one worker only; `running` just stops a second sweep in the same process.
let running: Promise<void> | null = null;

export default async function syncMarketPricesJob(
  container: MedusaContainer,
): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  if (running) {
    logger.warn(
      '[sync-market-prices] skipped: the previous sweep is still running',
    );
    return;
  }
  running = runMarketPriceSync(container)
    .catch((e) =>
      logger.error(
        `[sync-market-prices] sweep failed: ${(e as Error).message}`,
      ),
    )
    .finally(() => {
      running = null;
    });
}

export async function runMarketPriceSync(
  container: MedusaContainer,
): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  // USD->MYR is refreshed hourly by sync-usd-myr, not here (audit 2026-11-11).

  // Paginate past linked cards beyond a single page — a `take: N` cap would
  // silently stop syncing cards past N as the catalog grows.
  const cards: CardRow[] = (
    await pageAll<CardRow>((opts) => packs.listCards({}, opts))
  ).filter((c: CardRow) => c.pc_product_id);
  // Least recently synced first (never-synced, failed and pending cards lead):
  // a deploy restarts the worker and ends the sweep early, and a fixed order
  // left the same tail unsynced on consecutive days until it went stale.
  const syncedAt = (c: CardRow) =>
    (c.pc_synced_at ? new Date(c.pc_synced_at).getTime() : 0) || 0;
  cards.sort((a, b) => syncedAt(a) - syncedAt(b));
  // A stored outage clears on the first ok reply (the only answer that proves
  // the token works), not at the end of the sweep: deploys cut sweeps short.
  // Unreadable settings count as flagged: worst case one harmless null write.
  let feedFlagged = true;
  try {
    const [settings] = await packs.listSiteSettings({}, { take: 1 });
    feedFlagged = Boolean(settings?.pricecharting_feed);
  } catch (e) {
    logger.error(
      `[sync-market-prices] could not read the feed alert: ${(e as Error).message}`,
    );
  }
  let feedAnswered = false;
  let clearErrorLogged = false;
  const fetchProduct: typeof pcFetchRaw = async (path, params) => {
    const res = await pcFetchRaw(path, params);
    if (res.kind === 'ok') feedAnswered = true;
    return res;
  };
  let outage: PricechartingFeed | undefined;
  let stoppedAt = '';
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
        pcFetch: fetchProduct,
        updateCards: ([update]) => packs.applyCardPriceSync(current, update),
        now: new Date(),
      });
      // Every remaining card would fail the same way: stop, alert once.
      if (r.outage) {
        outage = r.outage;
        stoppedAt = `${current.handle || current.id} (PriceCharting id ${current.pc_product_id})`;
        break;
      }
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
    if (feedFlagged && feedAnswered) {
      try {
        await saveFeed(packs, null);
        feedFlagged = false; // a failed clear stays flagged: the next card retries
      } catch (e) {
        // Logged once per sweep; the retry on every later card stays.
        if (!clearErrorLogged)
          logger.error(
            `[sync-market-prices] could not clear the feed alert: ${(e as Error).message}`,
          );
        clearErrorLogged = true;
      }
    }
  }
  if (outage) {
    logger.error(
      `[sync-market-prices] stopped at ${stoppedAt} after ${changed} updates, ${skipped} skipped, ${failed} failed: PriceCharting ${
        outage.status === 'no_token'
          ? `token is not set (${outage.message}); set PRICECHARTING_API_TOKEN`
          : `token rejected (${outage.message}); renew it and update PRICECHARTING_API_TOKEN`
      }`,
    );
    try {
      await saveFeed(packs, outage);
    } catch (e) {
      logger.error(
        `[sync-market-prices] feed outage NOT recorded — admin alert lost: ${(e as Error).message}`,
      );
    }
    return;
  }
  const summary = `[sync-market-prices] done: ${changed}/${cards.length} updated, ${skipped} skipped, ${failed} failed`;
  if (skipped > 0 || failed > 0) logger.warn(summary);
  else logger.info(summary);
}

export const config = { name: 'sync-market-prices', schedule: '0 3 * * *' };
