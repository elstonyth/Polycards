import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import type { MedusaContainer } from '@medusajs/framework/types';
import { PACKS_MODULE } from './index';
import type PacksModuleService from './service';
import type { DeliveryStatus } from './delivery';
import { allocateStock } from './stock-allocation';

export type StockAllocationRun = {
  /** Orders moved to ready_to_ship. */
  ready: string[];
  /** requested orders moved to processed (nightly run only). */
  processed: string[];
  /** Orders whose move threw — logged, left for the next run. */
  failed: string[];
};

const ACTOR = 'system:stock-allocation';

// Off until the operator turns it on (decision 2026-10-28): the boss checks the
// new Stock numbers against the shelf before orders start moving by
// themselves. STOCK_AUTO_ALLOCATION=true enables the 12am run and freezes the
// to-buy list it leaves behind (procurement-snapshot.ts); runStockAllocation
// itself and the live to-buy / to-ship lists work either way.
export const stockAutoAllocationEnabled = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => env.STOCK_AUTO_ALLOCATION?.trim().toLowerCase() === 'true';

// Moves delivery orders by themselves (spec 2026-10-28):
//  - an open order whose every card is on hand, oldest first, becomes
//    ready_to_ship (from requested or legacy 'packing' it passes through
//    processed, the only legal path — delivery.ts ALLOWED);
//  - on the nightly run, every requested order still short of cards becomes
//    processed: it is on that night's to-buy list.
// Runs only from the 00:00 MYT job (owner, 2026-10-28: the 12am cutoff — a
// GRN / invoice save no longer moves anything). Never ships, never moves an
// order backwards.
//
// Every move goes through transitionDeliveryOrderStatus, which re-reads the
// status under the order's own lock, so a second run racing this one fails
// that order's move cleanly (counted in `failed`) instead of moving it twice.
// shortcut: no lock across a whole run, so a run that read stock just before
// a GRN reversal can still mark one order ready on stock that has since
// gone; add a run-wide advisory lock if reversals ever race saves in practice.
//
// No customer notification: processed and ready_to_ship are not notifiable
// statuses (feed-events.ts), the same as when staff move an order by hand.
export async function runStockAllocation(
  container: MedusaContainer,
  opts: { nightly: boolean },
): Promise<StockAllocationRun> {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

  const orders = await packs.openDeliveryOrdersForAllocation();
  const handles = [...new Set(orders.flatMap((o) => o.handles))];
  // Sequential — the module's pool rule (inventory-view.ts).
  const received = await packs.receivedQtyByHandle(handles);
  const buckets = await packs.inventoryLifecycleBuckets(handles);
  const onHand = new Map(
    handles.map((h) => [
      h,
      (received.get(h) ?? 0) - (buckets.get(h)?.shipped ?? 0),
    ]),
  );
  const { ready, short } = allocateStock(onHand, orders);
  const statusOf = new Map(orders.map((o) => [o.id, o.status]));
  const why = 'stock allocation (nightly)';

  const run: StockAllocationRun = { ready: [], processed: [], failed: [] };
  const move = async (orderId: string, to: DeliveryStatus, reason: string) =>
    packs.transitionDeliveryOrderStatus({
      orderId,
      to,
      // No trackingNumber: the seam keeps the one it reads under the order's
      // lock, so a number staff entered after this run's read survives.
      pullIds: [],
      audit: { adminId: ACTOR, action: 'bulk_status', reason },
    });

  for (const id of ready) {
    try {
      // requested and the legacy 'packing' token may only step to
      // processed first (delivery.ts ALLOWED).
      const from = statusOf.get(id);
      if (from === 'requested' || from === 'packing') {
        await move(id, 'processed', `${why}: all cards on hand`);
      }
      await move(id, 'ready_to_ship', `${why}: all cards on hand`);
      run.ready.push(id);
    } catch (e) {
      run.failed.push(id);
      logger.warn(
        `[stock-allocation] could not move ${id} to ready_to_ship: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (opts.nightly) {
    for (const id of short) {
      if (statusOf.get(id) !== 'requested') continue;
      try {
        await move(id, 'processed', `${why}: on the to-buy list`);
        run.processed.push(id);
      } catch (e) {
        run.failed.push(id);
        logger.warn(
          `[stock-allocation] could not move ${id} to processed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
  return run;
}
