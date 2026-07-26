import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useHref } from 'react-router-dom';
import {
  Checkbox,
  Container,
  Heading,
  Text,
  Table,
  Tabs,
  Button,
  Select,
  Input,
  Label,
  FocusModal,
  StatusBadge,
  toast,
} from '@medusajs/ui';
import { TruckFast, XMark } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import {
  useBulkUpdateDeliveryOrders,
  useDeliveryOrders,
  usePulls,
  useUpdateDeliveryOrder,
  useUploadImage,
} from '../../lib/queries';
import type {
  AdminDeliveryItem,
  AdminDeliveryOrder,
  DeliveryStatus,
} from '../../lib/admin-rest';
import {
  DELIVERY_STATUS_LABEL,
  deliveryStatusLabel,
  orderDateTime,
} from '../../lib/format';
import { resolveImageUrl } from '../../lib/image-url';
import { Pager } from '../../components/Pager';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

export const config: RouteConfig = {
  label: 'All Orders',
  icon: TruckFast,
  nested: '/orders',
  rank: 2,
};

const STATUSES: DeliveryStatus[] = [
  'requested',
  'processed',
  'ready_to_ship',
  'shipped',
  'completed',
  'canceled',
];
const TONE: Record<DeliveryStatus, 'orange' | 'blue' | 'green' | 'grey'> = {
  requested: 'orange',
  processed: 'orange',
  ready_to_ship: 'orange',
  shipped: 'blue',
  completed: 'green',
  canceled: 'grey',
};

// First item's thumbnail + name/handle with a "+N more" tail — the operator
// scans for "which card", the full manifest lives in the Manage modal.
const ItemCell = ({ items }: { items: AdminDeliveryItem[] }) => {
  const first = items[0];
  if (!first) {
    return <span className="text-ui-fg-subtle">—</span>;
  }
  return (
    <div className="flex items-center gap-2">
      {first.card && (
        <img
          src={resolveImageUrl(first.card.slab_image || first.card.image)}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-8 w-6 shrink-0 rounded object-contain"
        />
      )}
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm">
          {first.card?.name ?? 'Unknown card'}
        </span>
        <span className="text-ui-fg-subtle truncate text-xs">
          {first.card?.handle ?? first.pull_id}
        </span>
      </div>
      {items.length > 1 && (
        <span className="text-ui-fg-subtle whitespace-nowrap text-xs">
          +{items.length - 1} more
        </span>
      )}
    </div>
  );
};

// Pack-open history. Read-only by design: a pull is an immutable audit row —
// nothing to ship, cancel, or bulk-edit — so no checkboxes and no Actions column.
// Its own component so `usePulls` (which also computes server-side rollups) only
// fires while this tab is mounted, and so the Shipping tab's
// filter/search/page/selection state survives untouched in the parent.
// Returns a Fragment, not a wrapper: Container's `divide-y` only draws between
// its DIRECT children, so the table block and the Pager need to stay top-level.
const PackPurchases = () => {
  const [page, setPage] = useState(0);
  const { data, isError } = usePulls(page);
  const pulls = data?.pulls ?? null;

  return (
    <>
      {isError ? (
        <div className="px-6 py-8">
          <Text className="text-ui-fg-subtle">
            Failed to load pack purchases.
          </Text>
        </div>
      ) : pulls === null ? (
        <div className="px-6 py-8">
          <LoadingSkeleton />
        </div>
      ) : pulls.length === 0 ? (
        <div className="px-6 py-8">
          <Text className="text-ui-fg-subtle">No pack purchases yet.</Text>
        </div>
      ) : (
        <div
          className="overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label="Pack purchases table"
        >
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Order</Table.HeaderCell>
                <Table.HeaderCell>Date</Table.HeaderCell>
                <Table.HeaderCell>Item</Table.HeaderCell>
                <Table.HeaderCell>Qty</Table.HeaderCell>
                <Table.HeaderCell>Player</Table.HeaderCell>
                <Table.HeaderCell>Status</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {pulls.map((p) => (
                <Table.Row key={p.id}>
                  <Table.Cell className="font-mono text-xs">
                    #{p.id.slice(-6)}
                  </Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle whitespace-nowrap text-xs">
                    {orderDateTime(p.rolled_at)}
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex items-center gap-2">
                      {/* `?.image` and not just `p.card`: a card row with an
                          empty image would render <img src=""> — which the
                          browser resolves to the page URL and refetches. */}
                      {p.card?.image && (
                        <img
                          src={resolveImageUrl(p.card.image)}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="h-8 w-6 shrink-0 rounded object-contain"
                        />
                      )}
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm">
                          {p.card?.name ?? 'Unknown card'}
                        </span>
                        <span className="text-ui-fg-subtle truncate text-xs">
                          {p.pack_title ?? p.pack_id}
                        </span>
                      </div>
                    </div>
                  </Table.Cell>
                  {/* One pack open yields one card. */}
                  <Table.Cell className="tabular-nums">1</Table.Cell>
                  <Table.Cell className="text-ui-fg-subtle">
                    {p.customer_email ??
                      p.customer_id?.slice(0, 8) ??
                      'Anonymous'}
                  </Table.Cell>
                  {/* Constant: the purchase itself always completed at roll
                      time. What happened to the card afterwards (vaulted vs
                      bought back) is the Pull Ledger's story, not this table's. */}
                  <Table.Cell>
                    <StatusBadge color="green">Completed</StatusBadge>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}

      {data && (
        <Pager
          page={page}
          onPage={setPage}
          pageSize={data.limit}
          count={data.pulls.length}
          total={data.total}
        />
      )}
    </>
  );
};

const DeliveriesPage = () => {
  // Which kind of record the page is showing. 'shipping' is everything the page
  // did before: status tabs, id search, bulk tool, Manage modal.
  const [kind, setKind] = useState<'shipping' | 'purchases'>('shipping');
  const [filter, setFilter] = useState<DeliveryStatus | undefined>(undefined);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<DeliveryStatus>('processed');
  const { data, isError } = useDeliveryOrders(filter, page, q || undefined);
  const orders = data?.orders ?? null;
  const update = useUpdateDeliveryOrder();
  const bulk = useBulkUpdateDeliveryOrders();
  const uploadImg = useUploadImage();
  const [detail, setDetail] = useState<AdminDeliveryOrder | null>(null);
  const [nextStatus, setNextStatus] = useState<DeliveryStatus>('processed');
  const [tracking, setTracking] = useState('');
  const [proofImages, setProofImages] = useState<string[]>([]);
  const proofRef = useRef<HTMLInputElement>(null);
  const uploading = uploadImg.isPending;

  // The packing slips live at the sibling /deliveries/print route. useHref
  // prefixes the dashboard basename (/dashboard), which a hand-built href would
  // miss — the SPA renders its own 404 for an unprefixed path.
  const printHref = useHref(`/deliveries/print?ids=${[...selected].join(',')}`);

  // 300 ms debounce — the list refetches on the settled value, not per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Anything that changes WHICH rows are on screen drops the selection: Apply
  // must never send ids the operator can no longer see.
  const clearSelection = () => setSelected(new Set());

  const pageIds = orders?.map((o) => o.id) ?? [];
  const allOnPage =
    pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someOnPage = pageIds.some((id) => selected.has(id));

  // Decide add-vs-remove from `prev` inside the updater, not from the rendered
  // `allOnPage`: with keepPreviousData a refetch can swap `orders` between the
  // click and the update, and a stale flag turns "select all" into a no-op.
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      const everyOnPage =
        pageIds.length > 0 && pageIds.every((id) => prev.has(id));
      for (const id of pageIds) {
        if (everyOnPage) next.delete(id);
        else next.add(id);
      }
      return next;
    });

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // Partial success is the endpoint's contract. Two classes of skip:
  // `already <status>` is benign (the backend refuses to audit a no-op) and
  // belongs in the summary line; everything else is a real refusal — a missing
  // order or an illegal transition — and gets a red toast, capped at 5 so a
  // 100-id mistake doesn't bury the screen.
  const applyBulk = async () => {
    // Clearing the selection on every view change isn't enough on its own:
    // `keepPreviousData` keeps the OLD rows rendered and checkable for the whole
    // refetch window, so a row ticked mid-flight survives into the new page's
    // selection. Intersecting with what is on screen RIGHT NOW is what actually
    // makes "Apply only touches visible rows" hold, race or no race.
    const ids = [...selected].filter((id) => pageIds.includes(id));
    if (ids.length === 0) {
      clearSelection();
      return;
    }
    try {
      const { updated, skipped } = await bulk.mutateAsync({
        ids,
        status: bulkStatus,
      });
      const benign = `already ${bulkStatus}`;
      const refused = skipped.filter((s) => s.reason !== benign);
      const noop = skipped.length - refused.length;
      const tail = [
        noop > 0 ? `${noop} already ${DELIVERY_STATUS_LABEL[bulkStatus]}` : null,
        refused.length > 0 ? `${refused.length} skipped` : null,
      ]
        .filter(Boolean)
        .join(', ');
      if (updated.length > 0) {
        toast.success(
          [`${updated.length} updated`, tail].filter(Boolean).join(', '),
        );
      } else if (refused.length > 0) {
        // Nothing moved AND something was genuinely refused — worth a warning.
        toast.warning(['0 updated', tail].filter(Boolean).join(', '));
      } else {
        // Every id was already at the target status. Benign: neutral, and no
        // "0 updated" head to make a harmless no-op look like a failure.
        toast.info(tail);
      }
      for (const s of refused.slice(0, 5)) {
        toast.error(`#${s.id.slice(-6)}: ${s.reason}`);
      }
      clearSelection();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const openDetail = (o: AdminDeliveryOrder) => {
    setDetail(o);
    setNextStatus(o.status);
    setTracking(o.tracking_number ?? '');
    setProofImages(o.proof_images ?? []);
  };

  // Upload each picked file to /admin/media (kind 'delivery'; server validates)
  // and append the returned URLs. One failure doesn't drop the others.
  const handleProofFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (proofRef.current) proofRef.current.value = '';
    if (files.length === 0) return;
    for (const file of files) {
      try {
        const url = await uploadImg.mutateAsync({ file, kind: 'delivery' });
        setProofImages((prev) => [...prev, url]);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const removeProof = (url: string) =>
    setProofImages((prev) => prev.filter((u) => u !== url));

  const save = async () => {
    if (!detail) return;
    try {
      await update.mutateAsync({
        id: detail.id,
        status: nextStatus !== detail.status ? nextStatus : undefined,
        tracking_number: tracking.trim() || null,
        proof_images: proofImages,
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
      <div className="flex flex-col gap-4 px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <Heading level="h2">All Orders</Heading>
            <Text className="text-ui-fg-subtle mt-1" size="small">
              Orders and physical shipment requests.
            </Text>
          </div>
          {kind === 'shipping' && (
            <Input
              type="search"
              className="w-64"
              placeholder="Search order id"
              aria-label="Search orders by id"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
                clearSelection();
              }}
            />
          )}
        </div>
        {/* Two tablists now, so each needs its own name to tell them apart.
            Switching kind deliberately leaves the shipping state (filter,
            search, page, selection) alone — toggling back restores the view. */}
        <Tabs
          value={kind}
          onValueChange={(v) => setKind(v as 'shipping' | 'purchases')}
        >
          <Tabs.List aria-label="Record kind">
            <Tabs.Trigger value="shipping">Shipping</Tabs.Trigger>
            <Tabs.Trigger value="purchases">Pack purchases</Tabs.Trigger>
          </Tabs.List>
        </Tabs>
        {kind === 'shipping' && (
          <Tabs
            value={filter ?? 'all'}
            onValueChange={(v) => {
              setPage(0);
              clearSelection();
              setFilter(v === 'all' ? undefined : (v as DeliveryStatus));
            }}
          >
            <Tabs.List aria-label="Order status">
              <Tabs.Trigger value="all">All</Tabs.Trigger>
              {STATUSES.map((s) => (
                <Tabs.Trigger key={s} value={s}>
                  {DELIVERY_STATUS_LABEL[s]}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
          </Tabs>
        )}
      </div>

      {kind === 'purchases' && <PackPurchases />}

      {kind === 'shipping' && selected.size > 0 && (
        <div
          className="bg-ui-bg-subtle flex flex-wrap items-center gap-3 px-6 py-3"
          role="region"
          aria-label="Bulk actions"
        >
          <Text size="small" weight="plus">
            {selected.size} selected
          </Text>
          <Select
            value={bulkStatus}
            onValueChange={(v) => setBulkStatus(v as DeliveryStatus)}
          >
            <Select.Trigger className="w-44" aria-label="Mark selected as">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {STATUSES.map((s) => (
                <Select.Item key={s} value={s}>
                  {DELIVERY_STATUS_LABEL[s]}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
          <Button size="small" onClick={applyBulk} isLoading={bulk.isPending}>
            Apply
          </Button>
          {/* A real link, not a window.open() button: middle/ctrl-click, "open
              in new window" and screen-reader link semantics all come free. */}
          <Button size="small" variant="secondary" asChild>
            <a href={printHref} target="_blank" rel="noreferrer">
              Print
            </a>
          </Button>
        </div>
      )}

      {kind === 'shipping' &&
        (isError ? (
          <div className="px-6 py-8">
            <Text className="text-ui-fg-subtle">Failed to load orders.</Text>
          </div>
        ) : orders === null ? (
          <div className="px-6 py-8">
            <LoadingSkeleton />
          </div>
        ) : orders.length === 0 ? (
          <div className="px-6 py-8">
            <Text className="text-ui-fg-subtle">
              {filter || q ? 'No orders match this filter.' : 'No orders yet.'}
            </Text>
          </div>
        ) : (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Orders table"
          >
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell className="w-10">
                    <Checkbox
                      aria-label="Select all orders on this page"
                      checked={
                        allOnPage ? true : someOnPage ? 'indeterminate' : false
                      }
                      onCheckedChange={toggleAll}
                    />
                  </Table.HeaderCell>
                  <Table.HeaderCell>Order</Table.HeaderCell>
                  <Table.HeaderCell>Date</Table.HeaderCell>
                  <Table.HeaderCell>Item</Table.HeaderCell>
                  <Table.HeaderCell>Qty</Table.HeaderCell>
                  <Table.HeaderCell>Player</Table.HeaderCell>
                  <Table.HeaderCell>Status</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">
                    Actions
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {orders.map((o) => (
                  <Table.Row key={o.id}>
                    <Table.Cell>
                      <Checkbox
                        aria-label={`Select order #${o.id.slice(-6)}`}
                        checked={selected.has(o.id)}
                        onCheckedChange={() => toggleOne(o.id)}
                      />
                    </Table.Cell>
                    <Table.Cell className="font-mono text-xs">
                      #{o.id.slice(-6)}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle whitespace-nowrap text-xs">
                      {orderDateTime(o.created_at)}
                    </Table.Cell>
                    <Table.Cell>
                      <ItemCell items={o.items} />
                    </Table.Cell>
                    <Table.Cell className="tabular-nums">
                      {o.items.length}
                    </Table.Cell>
                    <Table.Cell className="text-ui-fg-subtle">
                      {o.customer_email ?? o.customer_id}
                    </Table.Cell>
                    <Table.Cell>
                      <StatusBadge color={TONE[o.status]}>
                        {deliveryStatusLabel(o.status)}
                      </StatusBadge>
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
          </div>
        ))}

      {kind === 'shipping' && data && (
        <Pager
          page={page}
          onPage={(p) => {
            setPage(p);
            clearSelection();
          }}
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
                disabled={trackingRequired || uploading}
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
                {/* Who to chase when a shipment goes wrong. `Customer`, not
                    `Email`: the value falls back to the customer id, which
                    would read as bad data under an email label (same wording
                    as the packing slip). */}
                <Heading level="h3">Player</Heading>
                {/* break-words (inherited by every dd) so an unbreakable value
                    — a long email, or the cus_… id fallback — wraps instead of
                    widening the 1fr track past the modal's max-width. */}
                <dl className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-1 break-words text-sm">
                  <dt className="text-ui-fg-subtle">Name</dt>
                  <dd>{detail.address.name}</dd>
                  <dt className="text-ui-fg-subtle">Customer</dt>
                  <dd>{detail.customer_email ?? detail.customer_id}</dd>
                  <dt className="text-ui-fg-subtle">Phone</dt>
                  <dd>{detail.address.phone ?? '—'}</dd>
                </dl>

                {/* Headings, not <section>s: an h3 opens an implicit section, so
                    screen-reader heading navigation already separates the two
                    blocks. border-t is what makes them read as two on screen. */}
                <Heading
                  level="h3"
                  className="border-ui-border-base border-t pt-5"
                >
                  Order details
                </Heading>
                <div className="flex flex-col gap-y-2">
                  <Text size="small" weight="plus">
                    Shipping address
                  </Text>
                  {/* filter(Boolean) so a null province doesn't leave a double
                      space, and address_2 only prints when there is one. */}
                  <div className="text-ui-fg-subtle text-sm">
                    <div>{detail.address.address_1}</div>
                    {detail.address.address_2 && (
                      <div>{detail.address.address_2}</div>
                    )}
                    <div>
                      {[
                        detail.address.city,
                        detail.address.province,
                        detail.address.postal_code,
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    </div>
                    <div>{detail.address.country_code.toUpperCase()}</div>
                  </div>
                </div>
                <div className="flex flex-col gap-y-2">
                  <Text size="small" weight="plus" id="delivery-status-label">
                    Status
                  </Text>
                  <Select
                    value={nextStatus}
                    onValueChange={(v) => setNextStatus(v as DeliveryStatus)}
                  >
                    <Select.Trigger aria-labelledby="delivery-status-label">
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Content>
                      {STATUSES.map((s) => (
                        <Select.Item key={s} value={s}>
                          {DELIVERY_STATUS_LABEL[s]}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select>
                </div>
                <div className="flex flex-col gap-y-2">
                  <Text size="small" weight="plus" id="delivery-tracking-label">
                    Tracking number
                  </Text>
                  <Input
                    aria-labelledby="delivery-tracking-label"
                    value={tracking}
                    onChange={(e) => setTracking(e.target.value)}
                    placeholder="Required to mark shipped"
                    aria-invalid={trackingRequired || undefined}
                    aria-describedby={
                      trackingRequired ? 'tracking-error' : undefined
                    }
                  />
                  {trackingRequired && (
                    <Text
                      id="tracking-error"
                      size="small"
                      className="text-ui-fg-error"
                    >
                      Tracking number required to mark shipped.
                    </Text>
                  )}
                </div>

                {/* Proof-of-delivery photos — operator uploads, customer sees. */}
                <div className="flex flex-col gap-y-2">
                  <Label size="small" weight="plus" htmlFor="delivery-proof">
                    Delivery photos
                  </Label>
                  <input
                    ref={proofRef}
                    id="delivery-proof"
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={handleProofFiles}
                  />
                  <div>
                    <Button
                      size="small"
                      variant="secondary"
                      type="button"
                      onClick={() => proofRef.current?.click()}
                      isLoading={uploading}
                    >
                      Upload photos
                    </Button>
                  </div>
                  {proofImages.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {proofImages.map((url) => (
                        <div key={url} className="relative">
                          <img
                            src={resolveImageUrl(url)}
                            alt="Delivery proof"
                            className="border-ui-border-base h-20 w-20 rounded border object-cover"
                          />
                          <button
                            type="button"
                            aria-label="Remove photo"
                            onClick={() => removeProof(url)}
                            className="bg-ui-bg-base border-ui-border-base text-ui-fg-subtle hover:text-ui-fg-base absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full border shadow"
                          >
                            <XMark className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* The full manifest — the table only shows the first card.
                    Every item gets a row now, card or not: an item whose card
                    row is missing used to render as nothing at all, so the
                    modal silently disagreed with the table's Qty. Fallbacks
                    match ItemCell and the packing slip. */}
                <div className="flex flex-col gap-y-2">
                  <Text size="small" weight="plus">
                    Items ({detail.items.length})
                  </Text>
                  <ul className="flex flex-col gap-3">
                    {detail.items.map((it) => (
                      <li key={it.pull_id} className="flex items-center gap-3">
                        {it.card && (
                          // alt="" — the name is right beside it as text, so a
                          // description here would just be read out twice.
                          <img
                            src={resolveImageUrl(
                              it.card.slab_image || it.card.image,
                            )}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            className="h-24 w-16 shrink-0 rounded object-contain"
                          />
                        )}
                        {/* Plain spans, same as ItemCell: `Text size` emits the
                            preset's txt-* composite, which fights a text-xs
                            utility for the handle. No truncate either — the
                            modal is where the operator reads a handle in full,
                            so it wraps instead. */}
                        <div className="flex min-w-0 flex-col">
                          <span className="text-sm">
                            {it.card?.name ?? 'Unknown card'}
                          </span>
                          <span className="text-ui-fg-subtle break-words font-mono text-xs">
                            {it.card?.handle ?? it.pull_id}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
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
