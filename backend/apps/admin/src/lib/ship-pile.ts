import type { DeliveryStatus } from './admin-rest';

// Ship pile (incident 2026-11-03): an order in Ready to ship or
// Pending ship may already be packed. Mirror of the backend rule in
// modules/packs/delivery.ts, which refuses a cancel from the pile unless the
// request says the parcel was pulled (pile_checked) and re-checks the status
// under the order's lock. This side only decides when to ask.
export const SHIP_PILE_STATUSES: readonly DeliveryStatus[] = [
  'ready_to_ship',
  'pending_ship',
];

export const isShipPileStatus = (status: string): boolean =>
  (SHIP_PILE_STATUSES as readonly string[]).includes(status);

/** How many of these orders a move to `to` would cancel out of the pile. */
export const pileCancelCount = (
  orders: readonly { status: string }[],
  to: DeliveryStatus,
): number =>
  to === 'canceled'
    ? orders.filter((o) => isShipPileStatus(o.status)).length
    : 0;

const AFTER =
  'Cancelling sends the cards back to the player’s vault and refunds the fee, so a parcel that still goes out is lost.';

/** The confirm shown before a cancel from the pile. `orderId` for one order. */
export function pilePrompt(
  count: number,
  orderId?: string,
): {
  title: string;
  description: string;
  confirmText: string;
  cancelText: string;
} {
  if (count === 1 && orderId) {
    return {
      title: 'This order may already be packed',
      description: `Order #${orderId.slice(-6)} is in the ship pile. Has the parcel been pulled from the pile? ${AFTER}`,
      confirmText: 'Parcel pulled, cancel it',
      cancelText: 'Keep order',
    };
  }
  return {
    title: `${count} of these orders may already be packed`,
    description: `They are in the ship pile. Have their parcels been pulled from the pile? ${AFTER}`,
    confirmText: 'Parcels pulled, cancel them',
    cancelText: 'Keep orders',
  };
}
