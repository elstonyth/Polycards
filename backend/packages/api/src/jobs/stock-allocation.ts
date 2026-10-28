import { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import {
  runStockAllocation,
  stockAutoAllocationEnabled,
} from '../modules/packs/stock-allocation-run';

// Nightly stock allocation (spec 2026-10-28): at 00:00 Malaysia time, orders
// whose cards are all on hand become ready_to_ship (oldest first) and the
// rest of the requested ones become processed — they are on that night's
// to-buy list (GET /admin/procurement/to-buy).
export default async function stockAllocationJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  if (!stockAutoAllocationEnabled()) {
    logger.info('[stock-allocation] skipped: STOCK_AUTO_ALLOCATION is not true');
    return;
  }
  const run = await runStockAllocation(container, { nightly: true });
  logger.info(
    `[stock-allocation] nightly: ${run.ready.length} ready to ship, ${run.processed.length} processed, ${run.failed.length} failed`,
  );
}

export const config = {
  name: 'stock-allocation',
  schedule: '0 16 * * *', // 16:00 UTC = 00:00 MYT (UTC+8, no DST)
};
