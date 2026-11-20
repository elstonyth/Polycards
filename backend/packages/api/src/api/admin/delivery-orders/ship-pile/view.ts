import type {
  DeliveryStatus,
  ShipPileExitRow,
} from '../../../../modules/packs/delivery';
import { wireDate, wireDateOrNull } from '../../../utils/wire-date';
import type { ShipPileEntry, ShipPileMark } from './types';

/** The open moves out of the pile as the Orders page's alert shows them:
 *  the parcel's slip name and city, never the player's email or the staff
 *  member's free-text reason. */
export function shipPileView(
  entries: ShipPileExitRow[],
  lookups: {
    orders: Map<
      string,
      { ship_name?: string | null; ship_city?: string | null }
    >;
    staffEmails: Map<string, string | null | undefined>;
  },
): ShipPileEntry[] {
  return entries.map((e) => {
    const order = lookups.orders.get(e.order_id);
    return {
      order_id: e.order_id,
      ship_name: order?.ship_name ?? null,
      ship_city: order?.ship_city ?? null,
      from_status: e.from_status as DeliveryStatus,
      to_status: e.to_status as DeliveryStatus,
      moved_at: wireDate(e.moved_at),
      moved_by: e.moved_by.startsWith('system:')
        ? 'automatic'
        : (lookups.staffEmails.get(e.moved_by) ?? e.moved_by),
    };
  });
}

/** The `ship_pile` mark a row of the Orders table carries. */
export const shipPileMark = (e: ShipPileExitRow): ShipPileMark => ({
  from_status: e.from_status as DeliveryStatus,
  to_status: e.to_status as DeliveryStatus,
  moved_at: wireDate(e.moved_at),
  cleared_at: wireDateOrNull(e.cleared_at),
});
