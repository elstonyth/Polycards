import { Text } from '@medusajs/ui';
import type {
  AdminDeliveryOrder,
  DeliveryStatus,
  DeliveryTrackingSnapshot,
} from '../lib/admin-rest';
import { timeAgo } from '../lib/format';

// A shipment's status colour and carrier line, shared by the All Orders page
// and the player page's Orders tab, so both say the same thing.

export const DELIVERY_TONE: Record<
  DeliveryStatus,
  'orange' | 'blue' | 'green' | 'grey'
> = {
  requested: 'orange',
  processed: 'orange',
  ready_to_ship: 'orange',
  shipped: 'blue',
  completed: 'green',
  canceled: 'grey',
};

export const CARRIER_NAME: Record<
  NonNullable<DeliveryTrackingSnapshot['carrier']>,
  string
> = {
  ninjavan: 'Ninja Van',
  poslaju: 'Pos Laju',
  dhl_ecommerce: 'DHL eCommerce',
};

// What the shipment tracker last heard from the carrier, under a shipped
// order's status. A snapshot for a different number (staff re-entered it
// since) is stale and reads as not checked yet.
export const TrackingLine = ({ order }: { order: AdminDeliveryOrder }) => {
  if (order.status !== 'shipped' || !order.tracking_number) return null;
  const snap = order.tracking_snapshot;
  if (!snap || snap.tracking_number !== order.tracking_number) {
    return (
      <Text size="xsmall" className="text-ui-fg-muted mt-1">
        Tracking not checked yet
      </Text>
    );
  }
  if (snap.state === 'unknown_carrier') {
    return (
      <Text size="xsmall" className="text-ui-fg-muted mt-1">
        Unknown carrier, complete by hand
      </Text>
    );
  }
  const carrier = snap.carrier ? CARRIER_NAME[snap.carrier] : 'Carrier';
  const what =
    snap.state === 'not_found'
      ? 'no record yet'
      : (snap.event ?? 'no events yet');
  return (
    <Text
      size="xsmall"
      className={
        snap.state === 'problem'
          ? 'text-ui-fg-error mt-1 line-clamp-2 max-w-64'
          : 'text-ui-fg-subtle mt-1 line-clamp-2 max-w-64'
      }
      title={`${snap.tracking_number}: ${what}`}
    >
      {snap.state === 'problem' ? 'Problem: ' : ''}
      {carrier}: {what} · checked {timeAgo(snap.checked_at)}
    </Text>
  );
};
