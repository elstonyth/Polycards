// The JSON body of GET /admin/delivery-orders/ship-pile, and the `ship_pile`
// mark on GET /admin/delivery-orders rows, written once (ADR 0017): the
// handlers are checked against them and the admin imports them as
// `@acme/api/admin/delivery-orders/ship-pile`. Types only: the admin
// typecheck reads this file and everything it imports, so import only the
// small modules that work out the shape, never service.ts. Dates are ISO
// strings, as sent.
import type { DeliveryStatus } from '../../../../modules/packs/delivery';

/** An order that left the ship pile without shipping and whose parcel is not
 *  marked pulled yet. */
export type ShipPileEntry = {
  order_id: string;
  /** The name and city on the packing slip, to find the parcel by. */
  ship_name: string | null;
  ship_city: string | null;
  /** ready_to_ship or pending_ship: where the order sat. */
  from_status: DeliveryStatus;
  /** canceled, or processed for a step back. */
  to_status: DeliveryStatus;
  moved_at: string;
  /** Staff email; 'automatic' for a system actor; the raw id for a deleted login. */
  moved_by: string;
};

export type ShipPileResponse = {
  open: ShipPileEntry[];
  /** More open entries exist than `open` lists. */
  truncated: boolean;
};

/** A row's newest move out of the pile on GET /admin/delivery-orders. */
export type ShipPileMark = {
  from_status: DeliveryStatus;
  to_status: DeliveryStatus;
  moved_at: string;
  cleared_at: string | null;
};
