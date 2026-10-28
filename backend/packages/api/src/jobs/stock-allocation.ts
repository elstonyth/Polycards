import { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import {
  runStockAllocation,
  stockAutoAllocationEnabled,
} from '../modules/packs/stock-allocation-run';
import {
  lastMidnightCutoff,
  takeProcurementSnapshot,
} from '../modules/packs/procurement-view';

// The 12am cutoff (spec 2026-10-28; owner 2026-10-28): at 00:00 Malaysia time,
// orders whose cards are all on hand become ready_to_ship (oldest first) and
// the rest of the requested ones become processed — they are on that night's
// to-buy list. Then the to-buy list is frozen for the day
// (GET /admin/procurement/to-buy). Statuses move nowhere else.
//
// Once per day: the day is done once its snapshot exists, so a redelivered or
// repeated run neither moves orders placed since 12am nor swaps the list
// mid-day. A status run that throws takes no snapshot: the page keeps showing
// the live list (procurement-view.ts) and a rerun is still allowed.
export async function runMidnightCutoff(
  container: MedusaContainer,
  now: Date = new Date(),
): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  if (!stockAutoAllocationEnabled()) {
    logger.info('[stock-allocation] skipped: STOCK_AUTO_ALLOCATION is not true');
    return;
  }
  const [done] = await container
    .resolve<PacksModuleService>(PACKS_MODULE)
    .listProcurementSnapshots(
      { taken_at: { $gte: lastMidnightCutoff(now) } },
      { take: 1 },
    );
  if (done) {
    logger.info(
      "[stock-allocation] skipped: today's 12am run already froze the list",
    );
    return;
  }
  const run = await runStockAllocation(container, { nightly: true });
  logger.info(
    `[stock-allocation] nightly: ${run.ready.length} ready to ship, ${run.processed.length} processed, ${run.failed.length} failed`,
  );
  const rows = await takeProcurementSnapshot(container, now);
  logger.info(`[stock-allocation] to-buy list frozen: ${rows} card(s)`);
}

export default async function stockAllocationJob(container: MedusaContainer) {
  await runMidnightCutoff(container);
}

export const config = {
  name: 'stock-allocation',
  schedule: '0 16 * * *', // 16:00 UTC = 00:00 MYT (UTC+8, no DST)
};
