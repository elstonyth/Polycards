import { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import {
  ShipmentTrackerBusy,
  runShipmentTracker,
} from '../api/admin/delivery-orders/track-run';

// Shipment tracker (2026-10-30): every 2 hours, check each shipped order with
// Ninja Van / Pos Laju / DHL eCommerce and complete the delivered ones
// (track-run.ts).
//
// Not awaited: all scheduled jobs share ONE BullMQ slot and a run may take up
// to its 10-minute budget, which held up deposit-reconcile (the only path
// crediting TGPay top-ups) (audit 2026-11-11). The tracker's Redis lock still
// keeps runs from overlapping.
export default async function trackShipmentsJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  void runShipmentTracker(container).then(
    (run) =>
      logger.info(
        `[shipment-tracker] ${run.checked} checked, ${run.completed.length} completed, ${run.problems.length} flagged, ${run.failed.length} failed`,
      ),
    (e) => {
      if (e instanceof ShipmentTrackerBusy)
        logger.info('[shipment-tracker] skipped: a "Check tracking" run is going');
      else logger.error(`[shipment-tracker] run failed: ${(e as Error).message}`);
    },
  );
}

export const config = {
  name: 'track-shipments',
  schedule: '15 */2 * * *', // every 2 hours, at :15
};
