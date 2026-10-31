import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Container,
  StatusBadge,
  Table,
  Tabs,
  Text,
} from '@medusajs/ui';
import type { Permission } from '@mercurjs/dashboard-sdk';
import { usePermissions } from '@mercurjs/admin';
import { useDeliveryOrders } from '../../../lib/queries';
import type { AdminDeliveryOrder } from '../../../lib/admin-rest';
import {
  CARRIER_NAME,
  DELIVERY_TONE,
  deliveryStatusLabel,
  rm,
} from '../../../lib/format';
import { resolveImageUrl } from '../../../lib/image-url';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { Pager } from '../../../components/Pager';
import { TrackingLine } from '../../../components/DeliveryTracking';
import { PullsList } from './PullsTab';
import {
  CardLine,
  DetailDrawer,
  DetailRow,
  DetailRows,
  TableState,
  When,
} from './bits';
import { openableRow, whenText } from './row-helpers';

const orderFee = (o: AdminDeliveryOrder): number | null =>
  o.shipping_fee == null ? null : o.shipping_fee + (o.insurance_fee ?? 0);

const OrderDrawer = ({
  order,
  onClose,
}: {
  order: AdminDeliveryOrder;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canManage = usePermissions().hasPermission(
    'delivery_order:update' as Permission,
  );
  const a = order.address;
  const snap =
    order.tracking_snapshot?.tracking_number === order.tracking_number
      ? order.tracking_snapshot
      : null;
  return (
    <DetailDrawer
      title={t('playerDetail.orderRef', { id: order.id.slice(-6) })}
      onClose={onClose}
    >
      <DetailRows>
        <DetailRow
          label={t('players.status')}
          value={
            <>
              <StatusBadge color={DELIVERY_TONE[order.status] ?? 'grey'}>
                {deliveryStatusLabel(order.status)}
              </StatusBadge>
              <TrackingLine order={order} />
            </>
          }
        />
        <DetailRow
          label={t('playerDetail.requested')}
          value={whenText(order.created_at)}
        />
        <DetailRow
          label={t('playerDetail.shippedAt')}
          value={whenText(order.shipped_at)}
        />
        <DetailRow
          label={t('playerDetail.deliveredAt')}
          value={whenText(order.delivered_at)}
        />
      </DetailRows>

      {order.tracking_number && (
        <DetailRows>
          <DetailRow
            label={t('playerDetail.trackingNumber')}
            code={order.tracking_number}
          />
          <DetailRow
            label={t('playerDetail.carrier')}
            value={snap?.carrier ? CARRIER_NAME[snap.carrier] : null}
          />
          <DetailRow label={t('playerDetail.lastEvent')} value={snap?.event} />
          <DetailRow
            label={t('playerDetail.eventAt')}
            value={whenText(snap?.event_at)}
          />
          <DetailRow
            label={t('playerDetail.checkedAt')}
            value={whenText(snap?.checked_at)}
          />
        </DetailRows>
      )}

      <DetailRows>
        <DetailRow label={t('playerDetail.shipTo')} value={a.name} />
        <DetailRow label={t('players.phone')} value={a.phone} />
        <DetailRow
          label={t('playerDetail.address')}
          value={
            <>
              <div>{a.address_1}</div>
              {a.address_2 && <div>{a.address_2}</div>}
              <div>
                {[a.city, a.province, a.postal_code].filter(Boolean).join(' ')}
              </div>
              <div>{a.country_code.toUpperCase()}</div>
            </>
          }
        />
      </DetailRows>

      {orderFee(order) !== null && (
        <DetailRows>
          <DetailRow
            label={t('playerDetail.shippingFee')}
            value={rm(order.shipping_fee ?? 0)}
          />
          {(order.insurance_fee ?? 0) > 0 && (
            <DetailRow
              label={t('playerDetail.insurance')}
              value={rm(order.insurance_fee ?? 0)}
            />
          )}
          <DetailRow
            label={t('playerDetail.paidFromBalance')}
            value={rm(orderFee(order))}
          />
        </DetailRows>
      )}

      <div className="flex flex-col gap-3 px-6 py-4">
        <Text size="small" weight="plus">
          {t('players.items')} ({order.items.length})
        </Text>
        {order.items.map((it) => (
          <CardLine
            key={it.pull_id}
            name={it.card?.name ?? t('playerDetail.unknownCard')}
            image={it.card?.slab_image || it.card?.image}
            note={it.card?.handle ?? it.pull_id}
          />
        ))}
      </div>

      {order.proof_images.length > 0 && (
        <div className="flex flex-col gap-3 px-6 py-4">
          <Text size="small" weight="plus">
            {t('playerDetail.deliveryPhotos')}
          </Text>
          <div className="flex flex-wrap gap-2">
            {order.proof_images.map((url) => (
              <a
                key={url}
                href={resolveImageUrl(url)}
                target="_blank"
                rel="noreferrer"
              >
                <img
                  src={resolveImageUrl(url)}
                  alt={t('playerDetail.deliveryPhotos')}
                  className="border-ui-border-base h-20 w-20 rounded border object-cover"
                />
              </a>
            ))}
          </div>
        </div>
      )}

      {canManage && (
        <div className="px-6 py-4">
          <Button
            size="small"
            variant="secondary"
            onClick={() => navigate(`/deliveries?q=${order.id}`)}
          >
            {t('playerDetail.manageOrder')}
          </Button>
        </div>
      )}
    </DetailDrawer>
  );
};

// Shipping half of the Orders tab: this player's delivery orders, read-only.
// Managing/bulk-editing a shipment stays on the All Orders page — this is the
// player's record of what was sent, not a second place to change it.
const ShippingOrders = ({ customerId }: { customerId: string }) => {
  const { t } = useTranslation();
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<AdminDeliveryOrder | null>(null);
  const { data, isError } = useDeliveryOrders(
    undefined,
    page,
    undefined,
    customerId,
  );
  if (isError) return <TableState isError />;
  if (!data) {
    return (
      <div className="border-t px-6 py-6">
        <LoadingSkeleton />
      </div>
    );
  }
  const orders = data.orders;
  if (orders.length === 0) {
    return <TableState empty={t('players.ordersEmpty')} />;
  }

  return (
    <>
      <div
        className="overflow-x-auto border-t"
        tabIndex={0}
        role="region"
        aria-label="Shipping orders table"
      >
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t('players.order')}</Table.HeaderCell>
              <Table.HeaderCell>{t('players.date')}</Table.HeaderCell>
              <Table.HeaderCell>{t('players.items')}</Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                {t('playerDetail.fee')}
              </Table.HeaderCell>
              <Table.HeaderCell>{t('players.status')}</Table.HeaderCell>
              <Table.HeaderCell>
                {t('playerDetail.trackingNumber')}
              </Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {orders.map((o) => (
              <Table.Row key={o.id} {...openableRow(() => setOpen(o))}>
                <Table.Cell className="font-mono text-xs">
                  #{o.id.slice(-6)}
                </Table.Cell>
                <Table.Cell className="whitespace-nowrap">
                  <When iso={o.created_at} />
                </Table.Cell>
                {/* First card + a "+N more" tail; the panel lists them all. */}
                <Table.Cell>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="max-w-[18rem] truncate">
                      {o.items[0]?.card?.name ?? o.items[0]?.pull_id ?? '—'}
                    </span>
                    {o.items.length > 1 && (
                      <span className="text-ui-fg-subtle whitespace-nowrap text-xs">
                        +{o.items.length - 1} more
                      </span>
                    )}
                  </span>
                </Table.Cell>
                <Table.Cell className="text-ui-fg-subtle whitespace-nowrap text-right tabular-nums">
                  {rm(orderFee(o))}
                </Table.Cell>
                <Table.Cell>
                  <StatusBadge color={DELIVERY_TONE[o.status] ?? 'grey'}>
                    {deliveryStatusLabel(o.status)}
                  </StatusBadge>
                  <TrackingLine order={o} />
                </Table.Cell>
                <Table.Cell className="text-ui-fg-subtle font-mono text-xs">
                  {o.tracking_number ?? '—'}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>
      <Pager
        page={page}
        onPage={setPage}
        pageSize={data.limit}
        count={orders.length}
        total={data.total}
      />
      {open && <OrderDrawer order={open} onClose={() => setOpen(null)} />}
    </>
  );
};

export const OrdersTab = ({ customerId }: { customerId: string }) => {
  const { t } = useTranslation();
  // Same two-value toggle as the All Orders page. Each half owns its own page
  // offset, so flipping kinds doesn't carry an offset into the other table.
  const [kind, setKind] = useState<'shipping' | 'purchases'>('shipping');

  return (
    <Container className="p-0">
      <div className="px-6 py-4">
        <Tabs
          value={kind}
          onValueChange={(v) => setKind(v as 'shipping' | 'purchases')}
        >
          <Tabs.List aria-label="Order kind">
            <Tabs.Trigger value="shipping">
              {t('players.ordersShipping')}
            </Tabs.Trigger>
            <Tabs.Trigger value="purchases">
              {t('players.ordersPurchases')}
            </Tabs.Trigger>
          </Tabs.List>
        </Tabs>
      </div>
      {kind === 'shipping' ? (
        <ShippingOrders customerId={customerId} />
      ) : (
        <PullsList customerId={customerId} source="pack" />
      )}
    </Container>
  );
};
