'use client';

import { useState } from 'react';
import Image from 'next/image';
import {
  requestDelivery,
  addAddress,
  type AddressView,
  type AddAddressInput,
} from '@/lib/actions/delivery';
import type { VaultItem } from '@/lib/actions/vault';

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-neutral-900 p-5">
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
            <div
              key={i.pullId}
              className="relative h-20 w-15 shrink-0 overflow-hidden rounded"
            >
              <Image
                src={i.card.image}
                alt={i.card.name}
                fill
                sizes="60px"
                className="object-contain"
              />
            </div>
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
              className="text-[12px] font-semibold text-emerald-400"
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
                placeholder="e.g. US"
                value={form.countryCode}
                onChange={(e) =>
                  setForm((f) => ({ ...f, countryCode: e.target.value }))
                }
                className={INPUT_CLASS}
              />
            </label>
            <div className="col-span-2 flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={saveAddress}
                className="rounded-lg bg-emerald-500 px-3 py-2 text-[13px] font-bold text-white disabled:opacity-50"
              >
                Save address
              </button>
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
          <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
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
          <button
            type="button"
            disabled={busy || adding || !selectedAddr}
            onClick={submit}
            className="rounded-lg bg-gradient-to-r from-emerald-500 to-green-500 px-4 py-2 text-[13px] font-bold text-white disabled:opacity-50"
          >
            {busy ? 'Requesting…' : 'Request delivery'}
          </button>
        </div>
      </div>
    </div>
  );
}
