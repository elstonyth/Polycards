import { useState } from 'react';
import {
  Container,
  Heading,
  Text,
  Table,
  Button,
  Select,
  Input,
  FocusModal,
  StatusBadge,
  toast,
} from '@medusajs/ui';
import { TruckFast } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import { useDeliveryOrders, useUpdateDeliveryOrder } from '../../lib/queries';
import type { AdminDeliveryOrder, DeliveryStatus } from '../../lib/admin-rest';
import { resolveImageUrl } from '../../lib/image-url';
import { Pager } from '../../components/Pager';

export const config: RouteConfig = {
  label: 'Deliveries',
  icon: TruckFast,
  nested: '/operations',
  rank: 1,
};

const STATUSES: DeliveryStatus[] = [
  'requested',
  'packing',
  'shipped',
  'delivered',
  'canceled',
];
const TONE: Record<DeliveryStatus, 'orange' | 'blue' | 'green' | 'grey'> = {
  requested: 'orange',
  packing: 'orange',
  shipped: 'blue',
  delivered: 'green',
  canceled: 'grey',
};

const DeliveriesPage = () => {
  const [filter, setFilter] = useState<DeliveryStatus | undefined>(undefined);
  const [page, setPage] = useState(0);
  const { data, isError } = useDeliveryOrders(filter, page);
  const orders = data?.orders ?? null;
  const update = useUpdateDeliveryOrder();
  const [detail, setDetail] = useState<AdminDeliveryOrder | null>(null);
  const [nextStatus, setNextStatus] = useState<DeliveryStatus>('packing');
  const [tracking, setTracking] = useState('');

  const openDetail = (o: AdminDeliveryOrder) => {
    setDetail(o);
    setNextStatus(o.status);
    setTracking(o.tracking_number ?? '');
  };

  const save = async () => {
    if (!detail) return;
    try {
      await update.mutateAsync({
        id: detail.id,
        status: nextStatus !== detail.status ? nextStatus : undefined,
        tracking_number: tracking.trim() || null,
      });
      toast.success('Delivery updated');
      setDetail(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  // Mirrors delivery.ts checkTransition: moving TO shipped requires tracking.
  const trackingRequired =
    detail !== null &&
    nextStatus === 'shipped' &&
    detail.status !== 'shipped' &&
    tracking.trim() === '';

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between gap-4 px-6 py-4">
        <div>
          <Heading level="h2">Deliveries</Heading>
          <Text className="text-ui-fg-subtle mt-1" size="small">
            Physical shipment requests for vaulted cards.
          </Text>
        </div>
        <Select
          value={filter ?? 'all'}
          onValueChange={(v) => {
            setPage(0);
            setFilter(v === 'all' ? undefined : (v as DeliveryStatus));
          }}
        >
          <Select.Trigger className="w-44">
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="all">All statuses</Select.Item>
            {STATUSES.map((s) => (
              <Select.Item key={s} value={s}>
                {s}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
      </div>

      {isError ? (
        <div className="px-6 py-8">
          <Text className="text-ui-fg-subtle">Failed to load deliveries.</Text>
        </div>
      ) : orders === null ? (
        <div className="px-6 py-8">
          <Text className="text-ui-fg-subtle">…</Text>
        </div>
      ) : orders.length === 0 ? (
        <div className="px-6 py-8">
          <Text className="text-ui-fg-subtle">No delivery orders.</Text>
        </div>
      ) : (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Order</Table.HeaderCell>
              <Table.HeaderCell>Customer</Table.HeaderCell>
              <Table.HeaderCell>Cards</Table.HeaderCell>
              <Table.HeaderCell>Status</Table.HeaderCell>
              <Table.HeaderCell className="text-right">Actions</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {orders.map((o) => (
              <Table.Row key={o.id}>
                <Table.Cell className="font-mono text-xs">
                  #{o.id.slice(-6)}
                </Table.Cell>
                <Table.Cell className="text-ui-fg-subtle">
                  {o.customer_email ?? o.customer_id}
                </Table.Cell>
                <Table.Cell>
                  <div className="flex items-center gap-1">
                    {o.items.slice(0, 4).map((it) =>
                      it.card ? (
                        <img
                          key={it.pull_id}
                          src={resolveImageUrl(it.card.image)}
                          alt=""
                          className="h-8 w-6 rounded object-contain"
                        />
                      ) : null,
                    )}
                    {o.items.length > 4 && (
                      <span className="text-ui-fg-subtle text-xs">
                        +{o.items.length - 4}
                      </span>
                    )}
                  </div>
                </Table.Cell>
                <Table.Cell>
                  <StatusBadge color={TONE[o.status]}>{o.status}</StatusBadge>
                </Table.Cell>
                <Table.Cell className="text-right">
                  <Button
                    size="small"
                    variant="secondary"
                    onClick={() => openDetail(o)}
                  >
                    Manage
                  </Button>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}

      {data && (
        <Pager
          page={page}
          onPage={setPage}
          pageSize={data.limit}
          count={data.orders.length}
          total={data.total}
        />
      )}

      <FocusModal
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      >
        <FocusModal.Content>
          <FocusModal.Header>
            <div className="flex items-center justify-end gap-x-2">
              <Button
                size="small"
                variant="secondary"
                onClick={() => setDetail(null)}
              >
                Cancel
              </Button>
              <Button
                size="small"
                onClick={save}
                isLoading={update.isPending}
                disabled={trackingRequired}
              >
                Save
              </Button>
            </div>
          </FocusModal.Header>
          <FocusModal.Body className="flex flex-col items-center overflow-auto p-10">
            {detail && (
              <div className="flex w-full max-w-[560px] flex-col gap-y-5">
                <FocusModal.Title asChild>
                  <Heading level="h2">Delivery #{detail.id.slice(-6)}</Heading>
                </FocusModal.Title>
                <Text className="text-ui-fg-subtle" size="small">
                  {detail.address.name} — {detail.address.address_1},{' '}
                  {detail.address.city} {detail.address.postal_code}{' '}
                  {detail.address.country_code.toUpperCase()}
                </Text>
                <Text className="text-ui-fg-subtle" size="small">
                  Customer: {detail.customer_email ?? detail.customer_id}
                </Text>
                <div className="flex flex-col gap-y-2">
                  <Text size="small" weight="plus">
                    Status
                  </Text>
                  <Select
                    value={nextStatus}
                    onValueChange={(v) => setNextStatus(v as DeliveryStatus)}
                  >
                    <Select.Trigger>
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Content>
                      {STATUSES.map((s) => (
                        <Select.Item key={s} value={s}>
                          {s}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select>
                </div>
                <div className="flex flex-col gap-y-2">
                  <Text size="small" weight="plus">
                    Tracking number
                  </Text>
                  <Input
                    value={tracking}
                    onChange={(e) => setTracking(e.target.value)}
                    placeholder="Required to mark shipped"
                  />
                  {trackingRequired && (
                    <Text size="small" className="text-ui-fg-error">
                      Tracking number required to mark shipped.
                    </Text>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {detail.items.map((it) =>
                    it.card ? (
                      <img
                        key={it.pull_id}
                        src={resolveImageUrl(it.card.image)}
                        alt={it.card.name}
                        className="h-24 w-16 rounded object-contain"
                      />
                    ) : null,
                  )}
                </div>
              </div>
            )}
          </FocusModal.Body>
        </FocusModal.Content>
      </FocusModal>
    </Container>
  );
};

export default DeliveriesPage;
