import type { DeliveryStatus } from './admin-rest';

// Ship pile (incident 2026-11-03): an order in Ready to ship or Pending ship
// may already be packed. Mirror of the backend rule in
// modules/packs/delivery.ts, which refuses a move out of the pile other than
// shipping (a cancel, or the step back to processed) unless the request says
// the parcel was pulled, and re-checks the status under the order's lock.
// This side decides when to ask and which orders to send as checked.
export const SHIP_PILE_STATUSES: readonly DeliveryStatus[] = [
  'ready_to_ship',
  'pending_ship',
];
export const SHIP_PILE_EXITS: readonly DeliveryStatus[] = [
  'canceled',
  'processed',
];

export const isShipPileStatus = (status: string): boolean =>
  (SHIP_PILE_STATUSES as readonly string[]).includes(status);

export const isShipPileExit = (from: string, to: DeliveryStatus): boolean =>
  isShipPileStatus(from) && SHIP_PILE_EXITS.includes(to);

export type PilePrompt = {
  title: string;
  description: string;
  confirmText: string;
  cancelText: string;
};

/** The confirm shown before a move out of the pile. */
export function pilePrompt(ids: readonly string[], to: DeliveryStatus): PilePrompt {
  const cancel = to === 'canceled';
  const after = cancel
    ? 'Cancelling sends the cards back to the player’s vault and refunds the fee, so a parcel that still goes out is lost.'
    : 'Moving it back takes it off Ready to ship, so a parcel left in the pile can still go out by mistake.';
  if (ids.length === 1) {
    return {
      title: 'This order may already be packed',
      description: `Order #${ids[0].slice(-6)} is in the ship pile. Has the parcel been pulled from the pile? ${after}`,
      confirmText: cancel
        ? 'Parcel pulled, cancel it'
        : 'Parcel pulled, move it back',
      cancelText: 'Keep order',
    };
  }
  return {
    title: `${ids.length} of these orders may already be packed`,
    description: `They are in the ship pile. Have their parcels been pulled from the pile? ${after}`,
    confirmText: cancel
      ? 'Parcels pulled, cancel them'
      : 'Parcels pulled, move them back',
    cancelText: 'Keep orders',
  };
}

/**
 * What a status change asks before it goes: the orders it would take out of
 * the pile, which are the only ones sent as checked, and the confirm to show
 * (null = no question). The Manage modal and the bulk bar both use it, so
 * neither can send a check the admin was never asked for.
 */
export function pileCheckPlan(
  orders: readonly { id: string; status: string }[],
  to: DeliveryStatus,
): { ids: string[]; prompt: PilePrompt | null } {
  const ids = orders.filter((o) => isShipPileExit(o.status, to)).map((o) => o.id);
  return { ids, prompt: ids.length > 0 ? pilePrompt(ids, to) : null };
}
