'use client';

import { useRef, useState } from 'react';
import { SlabImage } from '@/components/SlabImage';
import {
  shipVaultCards,
  addAddress,
  type AddressView,
  type AddAddressInput,
} from '@/lib/actions/delivery';
import type { VaultItem } from '@/lib/actions/vault';
import { addressViewFromInput } from '@/lib/address-view';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { Pill } from '@/components/ui/pill';
import { INPUT_CLASS } from '@/components/account/ui';
import {
  computeDeliveryFee,
  deliveryZone,
  isShippablePostcode,
  PROTECTION_INCLUDED_MYR,
} from '@/lib/delivery-fee';
import { rm } from '@/lib/format';
import { PhoneGateAction } from '@/components/account/PhoneGateAction';
import { useLiquidGlass, GLASS_SUBTLE } from '@/lib/use-liquid-glass';

type Props = {
  open: boolean;
  items: VaultItem[]; // the selected cards
  addresses: AddressView[];
  onClose: () => void;
  /** Parent removes exactly these from the vault — the ones that actually
   *  shipped, which is not always the whole selection (see `skipped`). */
  onSubmitted: (
    pullIds: string[],
    skipped: { pullId: string; reason: string }[],
  ) => void;
};

// ponytail: was a fourth hand-copy of this string, and the only one left
// without the focus-visible ring (a bare focus:border-white/25 is a 1px
// 25%-alpha edge, under WCAG 2.4.11's 3:1). Canonical copy lives in ui.tsx.

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

  // Fee preview — mirrors the backend's authoritative charge (delivery-fee.ts).
  // Recomputed per render from the selected address; cheap (two lookups).
  const selectedAddress = addrList.find((a) => a.id === selectedAddr);
  // Rounded to cents like the backend's vaultValueForPulls sum, so a float
  // artifact can't show an insurance line at exactly RM200 that the
  // authoritative charge never applies.
  const orderValue =
    Math.round(items.reduce((s, i) => s + i.card.marketPriceMyr, 0) * 100) /
    100;
  const fee = selectedAddress
    ? computeDeliveryFee(
        selectedAddress.postalCode,
        orderValue,
        selectedAddress.province,
        selectedAddress.city,
      )
    : null;
  const nonMalaysian =
    !!selectedAddress &&
    selectedAddress.countryCode.trim().toUpperCase() !== 'MY';
  // The backend refuses a postcode it can't zone, so say so here rather than
  // previewing a West rate the request would reject.
  const badPostcode =
    !!selectedAddress &&
    !nonMalaysian &&
    !isShippablePostcode(selectedAddress.postalCode);

  // Liquid-glass rim on the panel (frosted fallback on Safari/Firefox).
  useLiquidGlass(panelRef, open, GLASS_SUBTLE);

  if (!open) return null;

  async function saveAddress() {
    setBusy(true);
    setError(null);
    try {
      const res = await addAddress(form);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Optimistic: append + select. (A full refresh would re-fetch getAddresses.)
      setAddrList((p) => [...p, addressViewFromInput(res.addressId, form)]);
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
      // Reward cards take a different backend — POST /store/rewards/withdraw,
      // which stamps is_reward and enforces a per-day cap — so the selection
      // is split here rather than sent to a route that would refuse half of it.
      const normalIds = items
        .filter((i) => i.source !== 'reward')
        .map((i) => i.pullId);
      const rewardIds = items
        .filter((i) => i.source === 'reward')
        .map((i) => i.pullId);
      const addr = addrList.find((a) => a.id === selectedAddr);
      if (!addr) {
        setError('Choose a shipping address.');
        return;
      }
      const res = await shipVaultCards(normalIds, rewardIds, selectedAddr, {
        firstName: addr.firstName,
        lastName: addr.lastName,
        address1: addr.line1,
        city: addr.city,
        postalCode: addr.postalCode,
        countryCode: addr.countryCode,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // A partial result is normal: the reward cap can bite mid-selection
      // after the ordinary cards have already shipped. Report it rather than
      // pretending the whole selection went.
      if (res.shippedIds.length === 0 && res.skipped.length > 0) {
        setError(
          res.skipped[0]?.reason ??
            'Those cards could not be shipped right now.',
        );
        return;
      }
      onSubmitted(res.shippedIds, res.skipped);
    } catch {
      setError('Couldn’t request delivery. Please try again.');
    } finally {
      setBusy(false);
    }
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
          address. The shipping fee is deducted from your credit balance.
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

        {/* Fee preview — the backend recomputes and charges authoritatively;
            this mirrors it so the RM total is never a surprise. Hidden while
            the add-address form is open (no priced address selected yet). */}
        {!adding && fee && !nonMalaysian && !badPostcode && (
          <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-3 text-[13px]">
            <div className="flex justify-between text-white/70">
              <span>
                Shipping (
                {deliveryZone(
                  selectedAddress?.postalCode ?? '',
                  selectedAddress?.province,
                  selectedAddress?.city,
                ) === 'east'
                  ? 'East'
                  : 'West'}{' '}
                Malaysia)
              </span>
              <span>{rm(fee.shipping)}</span>
            </div>
            {fee.insurance > 0 ? (
              <div className="mt-1 flex justify-between text-white/70">
                <span>Insurance (5% of card value)</span>
                <span>{rm(fee.insurance)}</span>
              </div>
            ) : (
              <p className="mt-1 text-[12px] text-white/45">
                Shipment protection up to {rm(PROTECTION_INCLUDED_MYR)}{' '}
                included.
              </p>
            )}
            <div className="mt-2 flex justify-between border-t border-white/10 pt-2 font-semibold text-white">
              <span>Total — deducted from balance</span>
              <span>{rm(fee.total)}</span>
            </div>
          </div>
        )}
        {!adding && nonMalaysian && (
          <p className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-[12px] text-amber-200">
            We currently ship within Malaysia only — choose a Malaysian address.
          </p>
        )}
        {!adding && badPostcode && (
          <p className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-[12px] text-amber-200">
            That address needs a valid 5-digit Malaysian postcode before it can
            be shipped.
          </p>
        )}

        {/* The remedy sits INSIDE role="alert" so problem and way out are one
            announcement. PhoneGateAction dismisses the modal on the way out —
            a bare link would leave it overlaying /settings. */}
        {error && (
          <div
            role="alert"
            className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2"
          >
            <p className="text-[12px] text-red-300">{error}</p>
            <PhoneGateAction error={error} onNavigate={onClose} />
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-[13px] text-white/60"
          >
            Cancel
          </button>
          <Pill
            disabled={
              busy || adding || !selectedAddr || nonMalaysian || badPostcode
            }
            onClick={submit}
          >
            {busy ? 'Requesting…' : 'Request delivery'}
          </Pill>
        </div>
      </div>
    </div>
  );
}
