import type { ShipPileCancelRow } from '../../../../modules/packs/delivery';

/** One open ship-pile cancel as the Orders page shows it. */
export type ShipPileEntryView = {
  order_id: string;
  customer_id: string;
  customer_email: string | null;
  /** The name and city on the packing slip, to find the parcel by. */
  ship_name: string | null;
  ship_city: string | null;
  /** ready_to_ship or pending_ship: where the order sat when cancelled. */
  from_status: string;
  canceled_at: Date;
  /** Staff email; 'automatic' for a system actor; the raw id for a deleted login. */
  canceled_by: string;
  reason: string;
};

export function shipPileView(
  entries: ShipPileCancelRow[],
  lookups: {
    orders: Map<string, { ship_name?: string | null; ship_city?: string | null }>;
    customerEmails: Map<string, string | null | undefined>;
    staffEmails: Map<string, string | null | undefined>;
  },
): ShipPileEntryView[] {
  return entries.map((e) => {
    const order = lookups.orders.get(e.order_id);
    return {
      order_id: e.order_id,
      customer_id: e.customer_id,
      customer_email: lookups.customerEmails.get(e.customer_id) ?? null,
      ship_name: order?.ship_name ?? null,
      ship_city: order?.ship_city ?? null,
      from_status: e.from_status,
      canceled_at: e.canceled_at,
      canceled_by: e.canceled_by.startsWith('system:')
        ? 'automatic'
        : (lookups.staffEmails.get(e.canceled_by) ?? e.canceled_by),
      reason: e.reason,
    };
  });
}
