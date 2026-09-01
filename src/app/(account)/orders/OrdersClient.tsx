'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Badge, INPUT_CLASS } from '@/components/account/ui';
import { SlabImage } from '@/components/SlabImage';
import { Pill, pillVariants } from '@/components/ui/pill';
import {
  addAddress,
  cancelDeliveryOrder,
  editDeliveryAddress,
  getDeliveryOrders,
  type DeliveryOrderView,
  type AddressView,
  type AddAddressInput,
} from '@/lib/actions/delivery';
import { addressViewFromInput } from '@/lib/address-view';
import { MY_STATES } from '@/lib/my-states';
import { rm } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useModalA11y } from '@/lib/use-modal-a11y';

type Tone = 'green' | 'sky' | 'amber' | 'neutral';

// Map delivery-order status → badge tone. `packing`/`delivered` are the OLD
// names an old backend can still emit during a deploy (see DeliveryOrderSchema)
// — they render as their new equivalents rather than falling to neutral.
const STATUS_TONE: Record<DeliveryOrderView['status'], Tone> = {
  requested: 'amber',
  packing: 'amber',
  processed: 'amber',
  ready_to_ship: 'amber',
  shipped: 'sky',
  delivered: 'green',
  completed: 'green',
  canceled: 'neutral',
};

// Customer-facing label per status. Exhaustive Record over the (transitional)
// status union, so a new status is a type error here instead of a raw snake_case
// token leaking into the UI. `completed` is operator vocabulary — a customer is
// told "Delivered"; the legacy `packing`/`delivered` map onto the same words as
// the new names they were renamed to, so a skewed row reads identically.
const STATUS_LABEL: Record<DeliveryOrderView['status'], string> = {
  requested: 'Requested',
  packing: 'Processed',
  processed: 'Processed',
  ready_to_ship: 'Ready to ship',
  shipped: 'Shipped',
  delivered: 'Delivered',
  completed: 'Delivered',
  canceled: 'Canceled',
};

// Both pre-ship windows close at `processed`: from `ready_to_ship` on the
// parcel is picked and its label printed, so neither the address nor the order
// itself is the customer's to change any more — cancelling then is a support
// (or operator) action. `packing` is the legacy expand-window token
// (~`processed`): the backend's own EDITABLE and CANCELABLE lists accept it, so
// offering the affordance here is a call it honors, not one it refuses. These
// sets must keep agreeing with those two backend lists — both drop `packing` in
// the same release as the CONTRACT migration named in Migration20260727000000.
const ADDRESS_EDITABLE: ReadonlySet<DeliveryOrderView['status']> = new Set([
  'requested',
  'packing',
  'processed',
]);
// Same members as ADDRESS_EDITABLE today, spelled out rather than aliased: they
// are two independent backend lists that happen to agree, and aliasing would
// make a future change to one silently move the other.
const CANCELABLE: ReadonlySet<DeliveryOrderView['status']> = new Set([
  'requested',
  'packing',
  'processed',
]);

// Only render http(s) or same-origin root-relative proof URLs — never a
// `javascript:`/`data:` scheme. Defense-in-depth: the admin API already rejects
// unsafe proof-image schemes; this also guards any legacy/edge-case data.
const isSafeMediaUrl = (u: string) => {
  if (u.startsWith('/') && !u.startsWith('//')) return true;
  try {
    const { protocol } = new URL(u);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

const orderDate = (value: string | Date) =>
  new Date(value).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

function DeliveryItems({ items }: { items: DeliveryOrderView['items'] }) {
  const first = items[0];
  const extra = items.length - 1;
  return (
    <span className="flex items-center gap-2">
      {first?.card?.image && (
        <SlabImage
          src={first.card.image}
          slabSrc={first.card.slabImage}
          alt=""
          sizes="24px"
          className="w-6 shrink-0"
        />
      )}
      <span className="max-w-[220px] truncate">{first?.card?.name ?? '—'}</span>
      {extra > 0 && <span className="text-white/50">+{extra} more</span>}
    </span>
  );
}

// Self-contained address picker (pick existing or add a new one) for editing a
// pre-ship order's destination. Mirrors RequestDeliveryModal's picker, but
// confirms via editDeliveryAddress instead of requestDelivery.
function EditAddressModal({
  order,
  addresses,
  onAddAddress,
  onClose,
  onSaved,
}: {
  order: DeliveryOrderView;
  addresses: AddressView[];
  onAddAddress: (address: AddressView) => void;
  onClose: () => void;
  onSaved: (address: DeliveryOrderView['address']) => void;
}) {
  // No default selection in edit mode — changing an order's destination must be
  // an explicit choice (avoids silently re-shipping to addresses[0] on save).
  const [selectedAddr, setSelectedAddr] = useState<string>('');
  const [adding, setAdding] = useState(addresses.length === 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<AddAddressInput>({
    firstName: '',
    lastName: '',
    address1: '',
    city: '',
    province: '',
    postalCode: '',
    countryCode: '',
  });
  // Only mounted while open, so `open` is always true here.
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, true, onClose);

  async function saveAddress() {
    setBusy(true);
    setError(null);
    try {
      const res = await addAddress(form);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onAddAddress(addressViewFromInput(res.addressId, form));
      setSelectedAddr(res.addressId);
      setAdding(false);
    } catch {
      setError('Couldn’t save the address. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!selectedAddr) {
      setError('Choose a shipping address.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await editDeliveryAddress(order.id, selectedAddr);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Reflect the new destination in the row from the selected address book
      // entry. The book entry and the order's snapshot carry the same fields, so
      // this is a straight swap — falling back to the old snapshot only if the
      // list somehow no longer holds the id the backend just accepted.
      const chosen = addresses.find((a) => a.id === selectedAddr);
      onSaved(
        chosen
          ? {
              name: chosen.name,
              line1: chosen.line1,
              line2: chosen.line2,
              city: chosen.city,
              province: chosen.province,
              postalCode: chosen.postalCode,
              countryCode: chosen.countryCode,
              phone: chosen.phone,
            }
          : order.address,
      );
    } catch {
      setError('Couldn’t save the address. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Edit shipping address"
        tabIndex={-1}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-white/10 bg-neutral-900 p-5 outline-none"
      >
        <h2 className="font-heading text-lg font-bold text-white">
          Edit shipping address
        </h2>
        <p className="mt-1 text-[13px] text-white/55">
          Update where order #{order.id.slice(-6)} ships. You can change this
          until it leaves the vault.
        </p>

        {/* Address picker / add form */}
        {!adding ? (
          <div className="mt-4 space-y-2">
            {addresses.map((a) => (
              <label
                key={a.id}
                className="flex items-start gap-2 rounded-xl border border-white/10 p-3 text-[13px] text-white/80"
              >
                <input
                  type="radio"
                  name="edit-addr"
                  checked={selectedAddr === a.id}
                  onChange={() => setSelectedAddr(a.id)}
                />
                <span>
                  {a.name} — {a.line1}, {a.city} {a.postalCode}{' '}
                  {a.countryCode.toUpperCase()}
                </span>
              </label>
            ))}
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="text-[12px] font-semibold text-white/80 hover:text-white"
            >
              + Add a new address
            </button>
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-white/55">
                First name
              </span>
              <input
                aria-label="First name"
                autoComplete="given-name"
                value={form.firstName}
                onChange={(e) =>
                  setForm((f) => ({ ...f, firstName: e.target.value }))
                }
                className={INPUT_CLASS}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-white/55">
                Last name
              </span>
              <input
                aria-label="Last name"
                autoComplete="family-name"
                value={form.lastName}
                onChange={(e) =>
                  setForm((f) => ({ ...f, lastName: e.target.value }))
                }
                className={INPUT_CLASS}
              />
            </label>
            <label className="col-span-2 block">
              <span className="mb-1.5 block text-[12px] font-medium text-white/55">
                Address
              </span>
              <input
                aria-label="Address"
                autoComplete="address-line1"
                value={form.address1}
                onChange={(e) =>
                  setForm((f) => ({ ...f, address1: e.target.value }))
                }
                className={INPUT_CLASS}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-white/55">
                City
              </span>
              <input
                aria-label="City"
                autoComplete="address-level2"
                value={form.city}
                onChange={(e) =>
                  setForm((f) => ({ ...f, city: e.target.value }))
                }
                className={INPUT_CLASS}
              />
            </label>
            {/* Re-pointing an existing order is where a wrong zone costs the
                most: the backend re-derives the composite zone on an address
                edit and refuses a zone change (store/delivery-orders/[id]/
                address/route.ts). A fixed list, not free text, so a typed
                "Sabah, Malaysia" still bills East. */}
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-white/55">
                State
              </span>
              <select
                aria-label="State"
                autoComplete="address-level1"
                required
                value={form.province ?? ''}
                onChange={(e) =>
                  setForm((f) => ({ ...f, province: e.target.value }))
                }
                className={INPUT_CLASS}
              >
                <option value="" disabled>
                  Select a state
                </option>
                {MY_STATES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-white/55">
                Postal code
              </span>
              <input
                aria-label="Postal code"
                autoComplete="postal-code"
                value={form.postalCode}
                onChange={(e) =>
                  setForm((f) => ({ ...f, postalCode: e.target.value }))
                }
                className={INPUT_CLASS}
              />
            </label>
            <label className="col-span-2 block">
              <span className="mb-1.5 block text-[12px] font-medium text-white/55">
                Country code
              </span>
              <input
                aria-label="Country code"
                autoComplete="country"
                placeholder="e.g. MY"
                maxLength={2}
                value={form.countryCode}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    countryCode: e.target.value.toUpperCase(),
                  }))
                }
                className={INPUT_CLASS}
              />
            </label>
            <div className="col-span-2 flex gap-2">
              {/* Neutral-light primary (Pill): saving an address isn't money-in,
                  so no buyback green. */}
              <Pill disabled={busy} onClick={saveAddress} className="px-4">
                Save address
              </Pill>
              {addresses.length > 0 && (
                <button
                  type="button"
                  onClick={() => setAdding(false)}
                  className="text-[13px] text-white/60"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300"
          >
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-[13px] text-white/60"
          >
            Cancel
          </button>
          <Pill disabled={busy || adding || !selectedAddr} onClick={submit}>
            {busy ? 'Saving…' : 'Save address'}
          </Pill>
        </div>
      </div>
    </div>
  );
}

// Confirm-before-cancel dialog for a pre-ship order. Honest copy: the cards
// return to the vault, and delivery is free so there is nothing to refund.
// Mirrors EditAddressModal's shell + useModalA11y contract.
function CancelOrderModal({
  order,
  onClose,
  onCanceled,
}: {
  order: DeliveryOrderView;
  onClose: () => void;
  onCanceled: (status: DeliveryOrderView['status']) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only mounted while open, so `open` is always true here.
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, true, onClose);

  const count = order.items.length;

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await cancelDeliveryOrder(order.id);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onCanceled(res.status);
    } catch {
      setError('Couldn’t cancel the order. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Cancel delivery"
        tabIndex={-1}
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-neutral-900 p-5 outline-none"
      >
        <h2 className="font-heading text-lg font-bold text-white">
          Cancel this delivery?
        </h2>
        <p className="mt-1 text-[13px] text-white/55">
          Order #{order.id.slice(-6)} won&rsquo;t ship.{' '}
          {count === 1 ? 'The card goes' : `All ${count} cards go`} back to your
          vault, where you can keep, sell, or re-request{' '}
          {count === 1 ? 'it' : 'them'} anytime. Delivery is free, so
          there&rsquo;s nothing to refund.
        </p>

        <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-[13px] text-white/80">
          <DeliveryItems items={order.items} />
        </div>

        {error && (
          <p
            role="alert"
            className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300"
          >
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-[13px] text-white/60 transition-colors hover:text-white disabled:opacity-50"
          >
            Keep delivery
          </button>
          {/* Destructive confirm: Pill DNA (focus ring, press, disabled) with
              the red state color instead of a new button vocabulary. */}
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className={cn(
              pillVariants({ variant: 'ghost' }),
              'border-red-500/40 bg-red-500/10 px-5 text-red-300 hover:bg-red-500/20',
            )}
          >
            {busy ? 'Canceling…' : 'Cancel delivery'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Full contents of one order. The table row can only ever show the first card
// and a "+N more" — an 81-card delivery is unreadable there — so tapping the
// cards cell opens this: every card, and the shipping snapshot the parcel is
// actually going out with (NOT a live read of the address book, which is why
// editing that book entry later doesn't change what this shows).
function OrderDetailModal({
  order,
  onClose,
}: {
  order: DeliveryOrderView;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, true, onClose);
  const shortId = order.id.slice(-6);
  const photos = order.proofImages.filter(isSafeMediaUrl);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Order #${shortId} details`}
        tabIndex={-1}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-white/10 bg-neutral-900 p-5 outline-none"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-heading text-lg font-bold text-white">
              Order #{shortId}
            </h2>
            <p className="mt-1 text-[13px] text-white/55">
              Requested {orderDate(order.createdAt)}
            </p>
          </div>
          <Badge tone={STATUS_TONE[order.status] ?? 'neutral'}>
            {STATUS_LABEL[order.status] ?? order.status}
          </Badge>
        </div>

        <p className="mt-5 text-[11px] uppercase tracking-wide text-white/40">
          {order.items.length === 1 ? '1 card' : `${order.items.length} cards`}
        </p>
        <ul className="mt-2 flex flex-col gap-1.5">
          {order.items.map((it) => (
            <li
              key={it.pullId}
              className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-white/80"
            >
              {it.card?.image && (
                <SlabImage
                  src={it.card.image}
                  slabSrc={it.card.slabImage}
                  alt=""
                  sizes="32px"
                  className="w-8 shrink-0"
                />
              )}
              {/* Deep-link to the card page when the card still resolves; a
                  null card (deleted from the catalog) still lists its row so
                  the count on screen matches the count being shipped. */}
              {it.card ? (
                <Link
                  href={`/card/${it.card.handle}`}
                  className="min-w-0 flex-1 truncate hover:text-white"
                >
                  {it.card.name}
                </Link>
              ) : (
                <span className="min-w-0 flex-1 truncate text-white/50">
                  Card unavailable
                </span>
              )}
            </li>
          ))}
        </ul>

        <p className="mt-5 text-[11px] uppercase tracking-wide text-white/40">
          Shipping to
        </p>
        <div className="mt-2 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-[13px] text-white/80">
          <p className="font-semibold text-white">
            {order.address.name || '—'}
          </p>
          {order.address.line1 && (
            <p className="mt-0.5">
              {order.address.line1}
              {order.address.line2 ? `, ${order.address.line2}` : ''}
            </p>
          )}
          <p>
            {order.address.city}
            {order.address.province ? `, ${order.address.province}` : ''}{' '}
            {order.address.postalCode} {order.address.countryCode.toUpperCase()}
          </p>
          {order.address.phone && (
            <p className="text-white/50">{order.address.phone}</p>
          )}
        </div>

        {/* Fee lines only when a fee was charged — pre-fee orders and reward
            shipments carry null and must not render as RM 0. */}
        {order.shippingFee != null && (
          <>
            <p className="mt-5 text-[11px] uppercase tracking-wide text-white/40">
              Shipping fee
            </p>
            <div className="mt-2 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-[13px] text-white/80">
              <div className="flex justify-between">
                <span>Shipping</span>
                <span>{rm(order.shippingFee)}</span>
              </div>
              {(order.insuranceFee ?? 0) > 0 && (
                <div className="mt-0.5 flex justify-between">
                  <span>Insurance (5% of card value)</span>
                  <span>{rm(order.insuranceFee ?? 0)}</span>
                </div>
              )}
              <div className="mt-1.5 flex justify-between border-t border-white/10 pt-1.5 font-semibold text-white">
                <span>Total</span>
                <span>{rm(order.shippingFee + (order.insuranceFee ?? 0))}</span>
              </div>
            </div>
          </>
        )}

        <p className="mt-5 text-[11px] uppercase tracking-wide text-white/40">
          Tracking
        </p>
        <p className="mt-2 text-[13px] text-white/80">
          {order.trackingNumber ? (
            <span className="font-mono">{order.trackingNumber}</span>
          ) : (
            <span className="text-white/55">
              Not shipped yet — a tracking number appears here once it leaves
              the vault.
            </span>
          )}
        </p>

        {photos.length > 0 && (
          <>
            <p className="mt-5 text-[11px] uppercase tracking-wide text-white/40">
              Delivery photos
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {photos.map((url) => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary operator-uploaded proof URL (backend static / CDN), not an allowlisted next/image domain */}
                  <img
                    src={url}
                    alt="Delivery proof"
                    className="h-16 w-16 rounded-lg border border-white/10 object-cover transition-opacity hover:opacity-80"
                  />
                </a>
              ))}
            </div>
          </>
        )}

        <div className="mt-6 flex justify-end">
          <Pill variant="secondary" onClick={onClose} className="px-5">
            Close
          </Pill>
        </div>
      </div>
    </div>
  );
}

export default function OrdersClient({
  orders: initialOrders,
  addresses,
}: {
  orders: DeliveryOrderView[];
  addresses: AddressView[];
}) {
  const [orders, setOrders] = useState<DeliveryOrderView[]>(initialOrders);
  // Address book lifted to the parent so a newly added address persists across
  // modal open/close (instead of vanishing with the modal's local state).
  const [addrList, setAddrList] = useState<AddressView[]>(addresses);
  const [editing, setEditing] = useState<DeliveryOrderView | null>(null);
  const [canceling, setCanceling] = useState<DeliveryOrderView | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  // Resolve by id, not by holding the object: an address edit or a cancel
  // replaces the row in `orders`, and a held snapshot would keep showing the
  // pre-edit destination behind the modal that just changed it.
  const viewing = orders.find((o) => o.id === viewingId) ?? null;
  const setViewing = (o: DeliveryOrderView) => setViewingId(o.id);
  // Orders canceled this session — their rows show a "back in your vault" note.
  const [canceledIds, setCanceledIds] = useState<ReadonlySet<string>>(
    new Set(),
  );

  // Browser Back can restore the RSC payload rendered BEFORE a cancel, so
  // `orders` re-seeds a canceled row as "Requested" with a live Cancel button.
  // Re-sync on mount, as NotificationsClient does — never revalidatePath()
  // from the action. A transport failure or !ok keeps the server seed.
  useEffect(() => {
    let live = true;
    void getDeliveryOrders()
      .then((r) => {
        if (live && r.ok) setOrders(r.orders);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  return (
    <>
      <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.03]">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-[12px] uppercase tracking-wide text-white/40">
              {['Order', 'Cards', 'Requested', 'Tracking', 'Status', ''].map(
                (h, i) => (
                  <th key={h || `c${i}`} className="px-4 py-3 font-medium">
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr
                key={o.id}
                className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]"
              >
                <td className="whitespace-nowrap px-4 py-3 text-white/80">
                  <span className="font-mono text-[12px] text-white/60">
                    #{o.id.slice(-6)}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-white/80">
                  {/* The cards cell IS the affordance — it already shows the
                      first card and "+N more", so tapping it to see the rest is
                      what a customer reaches for. A real <button> so it's
                      keyboard-reachable, not a click handler on the <td>. */}
                  <button
                    type="button"
                    onClick={() => setViewing(o)}
                    aria-label={`View order #${o.id.slice(-6)} details`}
                    className="-mx-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-white/[0.04] hover:text-white"
                  >
                    <DeliveryItems items={o.items} />
                  </button>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-white/80">
                  {orderDate(o.createdAt)}
                </td>
                <td className="px-4 py-3 text-white/80">
                  {o.trackingNumber ? (
                    <span className="font-mono text-[12px] text-white/70">
                      {o.trackingNumber}
                    </span>
                  ) : (
                    <span className="text-white/55">—</span>
                  )}
                  {o.proofImages.filter(isSafeMediaUrl).length > 0 && (
                    <div className="mt-2">
                      <span className="block text-[11px] uppercase tracking-wide text-white/40">
                        Delivery photos
                      </span>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {o.proofImages.filter(isSafeMediaUrl).map((url) => (
                          <a
                            key={url}
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary operator-uploaded proof URL (backend static / CDN), not an allowlisted next/image domain */}
                            <img
                              src={url}
                              alt="Delivery proof"
                              className="h-12 w-12 rounded-lg border border-white/10 object-cover transition-opacity hover:opacity-80"
                            />
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-white/80">
                  {/* `?? o.status` alongside the exhaustive map: a status the
                      schema starts allowing before this map learns it shows the
                      raw token, never an empty badge. */}
                  <Badge tone={STATUS_TONE[o.status] ?? 'neutral'}>
                    {STATUS_LABEL[o.status] ?? o.status}
                  </Badge>
                  {canceledIds.has(o.id) && (
                    <p className="mt-1.5 text-[11px] text-white/50">
                      {o.items.length === 1 ? 'Card is' : 'Cards are'} back in{' '}
                      <Link
                        href="/vault"
                        className="font-semibold text-white/70 underline underline-offset-2 hover:text-white"
                      >
                        your vault
                      </Link>
                      .
                    </p>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right text-white/80">
                  {CANCELABLE.has(o.status) && (
                    <span className="inline-flex items-center gap-2">
                      {ADDRESS_EDITABLE.has(o.status) && (
                        <button
                          type="button"
                          onClick={() => setEditing(o)}
                          className="rounded-lg border border-white/15 px-3 py-1.5 text-[12px] font-semibold text-white/70 transition-colors hover:text-white"
                        >
                          Edit address
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setCanceling(o)}
                        aria-label={`Cancel order #${o.id.slice(-6)}`}
                        className="rounded-lg border border-red-500/20 px-3 py-1.5 text-[12px] font-semibold text-red-300/80 transition-colors hover:border-red-500/40 hover:text-red-300"
                      >
                        Cancel order
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <EditAddressModal
          order={editing}
          addresses={addrList}
          onAddAddress={(a) => setAddrList((p) => [...p, a])}
          onClose={() => setEditing(null)}
          onSaved={(address) => {
            setOrders((prev) =>
              prev.map((o) => (o.id === editing.id ? { ...o, address } : o)),
            );
            setEditing(null);
          }}
        />
      )}

      {viewing && (
        <OrderDetailModal order={viewing} onClose={() => setViewingId(null)} />
      )}

      {canceling && (
        <CancelOrderModal
          order={canceling}
          onClose={() => setCanceling(null)}
          onCanceled={(status) => {
            setOrders((prev) =>
              prev.map((o) => (o.id === canceling.id ? { ...o, status } : o)),
            );
            setCanceledIds((prev) => new Set(prev).add(canceling.id));
            setCanceling(null);
          }}
        />
      )}
    </>
  );
}
