'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/account/ui';
import { SlabImage } from '@/components/SlabImage';
import { Pill, pillVariants } from '@/components/ui/pill';
import {
  addAddress,
  cancelDeliveryOrder,
  editDeliveryAddress,
  type DeliveryOrderView,
  type AddressView,
  type AddAddressInput,
} from '@/lib/actions/delivery';
import { cn } from '@/lib/utils';
import { useModalA11y } from '@/lib/use-modal-a11y';

type Tone = 'green' | 'sky' | 'amber' | 'neutral';

// Map delivery-order status → badge tone.
const STATUS_TONE: Record<DeliveryOrderView['status'], Tone> = {
  requested: 'amber',
  packing: 'amber',
  shipped: 'sky',
  delivered: 'green',
  canceled: 'neutral',
};

// Pre-ship statuses: the address is editable and the order is cancelable only
// before it ships (mirrors the backend's transition guards).
const PRE_SHIP: ReadonlySet<DeliveryOrderView['status']> = new Set([
  'requested',
  'packing',
]);

const humanize = (s: string) =>
  s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

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

// Reuses the input styling from RequestDeliveryModal / SettingsForm.
const INPUT_CLASS =
  'h-11 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 text-sm text-white placeholder:text-white/40 focus:border-white/25 focus:outline-none';

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
    postalCode: '',
    countryCode: '',
  });
  // Only mounted while open, so `open` is always true here.
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, true, onClose);

  async function saveAddress() {
    setBusy(true);
    setError(null);
    const res = await addAddress(form);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const view: AddressView = {
      id: res.addressId,
      name: `${form.firstName} ${form.lastName}`.trim(),
      line1: form.address1,
      line2: form.address2 ?? null,
      city: form.city,
      province: form.province ?? null,
      postalCode: form.postalCode,
      countryCode: form.countryCode,
      phone: form.phone ?? null,
    };
    onAddAddress(view);
    setSelectedAddr(res.addressId);
    setAdding(false);
  }

  async function submit() {
    if (!selectedAddr) {
      setError('Choose a shipping address.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await editDeliveryAddress(order.id, selectedAddr);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    // Reflect the new destination in the row from the selected address book entry.
    const chosen = addresses.find((a) => a.id === selectedAddr);
    onSaved({
      name: chosen?.name ?? order.address.name,
      city: chosen?.city ?? order.address.city,
      countryCode: chosen?.countryCode ?? order.address.countryCode,
    });
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
    const res = await cancelDeliveryOrder(order.id);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onCanceled(res.status);
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
  // Orders canceled this session — their rows show a "back in your vault" note.
  const [canceledIds, setCanceledIds] = useState<ReadonlySet<string>>(
    new Set(),
  );

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
                  <DeliveryItems items={o.items} />
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
                  <Badge tone={STATUS_TONE[o.status] ?? 'neutral'}>
                    {humanize(o.status)}
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
                  {PRE_SHIP.has(o.status) && (
                    <span className="inline-flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setEditing(o)}
                        className="rounded-lg border border-white/15 px-3 py-1.5 text-[12px] font-semibold text-white/70 transition-colors hover:text-white"
                      >
                        Edit address
                      </button>
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
