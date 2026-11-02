import { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import {
  ShipmentTrackerBusy,
  runShipmentTracker,
} from '../api/admin/delivery-orders/track-run';

// Shipment tracker (2026-10-30): every 2 hours, check each shipped order with
// Ninja Van / Pos Laju / DHL eCommerce and complete the delivered ones
// (track-run.ts).
export default async function trackShipmentsJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  try {
    const run = await runShipmentTracker(container);
    logger.info(
      `[shipment-tracker] ${run.checked} checked, ${run.completed.length} completed, ${run.problems.length} flagged, ${run.failed.length} failed`,
    );
  } catch (e) {
    if (!(e instanceof ShipmentTrackerBusy)) throw e;
    logger.info('[shipment-tracker] skipped: a "Check tracking" run is going');
  }
}

export const config = {
  name: 'track-shipments',
  schedule: '15 */2 * * *', // every 2 hours, at :15
};
