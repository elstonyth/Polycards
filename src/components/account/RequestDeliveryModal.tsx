'use client';

import { useRef, useState } from 'react';
import { SlabImage } from '@/components/SlabImage';
import {
  requestDelivery,
  addAddress,
  type AddressView,
  type AddAddressInput,
} from '@/lib/actions/delivery';
import type { VaultItem } from '@/lib/actions/vault';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { Pill } from '@/components/ui/pill';
import { useLiquidGlass, GLASS_SUBTLE } from '@/lib/use-liquid-glass';

type Props = {
  open: boolean;
  items: VaultItem[]; // the selected cards
  addresses: AddressView[];
  onClose: () => void;
  onSubmitted: (pullIds: string[]) => void; // parent removes them from the vault
};

// Reuses the input styling from SettingsForm.tsx for visual consistency.
const INPUT_CLASS =
  'h-11 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 text-sm text-white placeholder:text-white/40 focus:border-white/25 focus:outline-none';

export default function RequestDeliveryModal({
  open,
  items,
  addresses,
  onClose,
  onSubmitted,
}: Props) {
  const [addrList, setAddrList] = useState<AddressView[]>(addresses);
  const [selectedAddr, setSelectedAddr] = useState<string>(
    addresses[0]?.id ?? '',
  );
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
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, open, onClose);

  // Liquid-glass rim on the panel (frosted fallback on Safari/Firefox).
  useLiquidGlass(panelRef, open, GLASS_SUBTLE);

  if (!open) return null;

  async function saveAddress() {
    setBusy(true);
    setError(null);
    const res = await addAddress(form);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    // Optimistic: append + select. (A full refresh would re-fetch getAddresses.)
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
    setAddrList((p) => [...p, view]);
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
    const pullIds = items.map((i) => i.pullId);
    const res = await requestDelivery(pullIds, selectedAddr);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onSubmitted(pullIds);
  }

  return (
    <div className="glass-stage fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Request delivery"
        tabIndex={-1}
        className="glass-panel max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border p-5 outline-none"
      >
        <h2 className="font-heading text-lg font-bold text-white">
          Request delivery
        </h2>
        <p className="mt-1 text-[13px] text-white/55">
          Ship {items.length} card{items.length === 1 ? '' : 's'} to your
          address. No charge in this beta.
        </p>

        {/* Selected cards */}
        <div className="mt-3 flex gap-2 overflow-x-auto">
          {items.map((i) => (
            <SlabImage
              key={i.pullId}
              src={i.card.image}
              slabSrc={i.card.slabImage}
              alt={i.card.name}
              sizes="60px"
              className="w-15 shrink-0"
            />
          ))}
        </div>

        {/* Address picker / add form */}
        {!adding ? (
          <div className="mt-4 space-y-2">
            {addrList.map((a) => (
              <label
                key={a.id}
                className="flex items-start gap-2 rounded-xl border border-white/10 p-3 text-[13px] text-white/80"
              >
                <input
                  type="radio"
                  name="addr"
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
            {/* Minimal required-field form; each input binds to `form`. Input
                classes mirror SettingsForm.tsx for visual consistency. */}
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
              {addrList.length > 0 && (
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
            {busy ? 'Requesting…' : 'Request delivery'}
          </Pill>
        </div>
      </div>
    </div>
  );
}
