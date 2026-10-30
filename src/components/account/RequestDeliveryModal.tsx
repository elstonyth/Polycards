'use client';

import { useEffect, useRef, useState } from 'react';
import { SlabImage } from '@/components/SlabImage';
import {
  shipVaultCards,
  addAddress,
  updateAddress,
  getPrizeShippingAllowance,
  type AddressView,
  type AddAddressInput,
} from '@/lib/actions/delivery';
import { getWallet } from '@/lib/actions/wallet';
import type { VaultItem } from '@/lib/actions/vault';
import { addressViewFromInput } from '@/lib/address-view';
import { stateAfterCountryChange, statesFor } from '@/lib/my-states';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { Pill } from '@/components/ui/pill';
import { INPUT_CLASS } from '@/components/account/ui';
import { CountrySelect } from '@/components/account/CountrySelect';
import {
  computeParcelFee,
  deliveryZone,
  isShippableCountry,
  isShippablePostcode,
  postcodeHint,
  PROTECTION_INCLUDED_MYR,
  ZONE_LABEL,
} from '@/lib/delivery-fee';
import { rm } from '@/lib/format';
import { normalizePhone } from '@/lib/profile-validation';
import { PhoneGateAction } from '@/components/account/PhoneGateAction';
import { useLiquidGlass, GLASS_SUBTLE } from '@/lib/use-liquid-glass';
import { useTopUp } from '@/components/app-shell/TopUpProvider';

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

const EMPTY_FORM: AddAddressInput = {
  firstName: '',
  lastName: '',
  address1: '',
  city: '',
  province: '',
  postalCode: '',
  countryCode: 'MY',
};

export default function RequestDeliveryModal({
  open,
  items,
  addresses,
  onClose,
  onSubmitted,
}: Props) {
  const [addrList, setAddrList] = useState<AddressView[]>(addresses);
  // A saved address that can ship beats one that can't (old free-text
  // country rows), so a fixed customer isn't greeted by the warning again.
  const [selectedAddr, setSelectedAddr] = useState<string>(
    (addresses.find((a) => isShippableCountry(a.countryCode)) ?? addresses[0])
      ?.id ?? '',
  );
  const [adding, setAdding] = useState(addresses.length === 0);
  // The saved address the form is repairing ("Fix this address"), or null
  // when it is adding a new one.
  const [fixingId, setFixingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The charge is confirmed in a second step before anything is requested.
  const [confirming, setConfirming] = useState(false);
  const { balance, openTopUp, refreshBalance } = useTopUp();
  // Read on open: the wallet balance (the fallback while the top-up context
  // has none) and today's prize-shipping allowance. Null until (or unless)
  // each answers.
  const [wallet, setWallet] = useState<{ balance: number } | null>(null);
  const hasPrizes = items.some((i) => i.source === 'reward');
  const [prizeAllowance, setPrizeAllowance] = useState<{
    perDay: number;
    remaining: number;
  } | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getWallet()
      .then((r) => {
        if (!cancelled && r.ok) {
          setWallet({ balance: r.wallet.balance });
        }
      })
      .catch(() => {});
    if (hasPrizes) {
      getPrizeShippingAllowance()
        .then((a) => {
          if (!cancelled) setPrizeAllowance(a);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [open, hasPrizes]);
  const [form, setForm] = useState<AddAddressInput>(EMPTY_FORM);
  const panelRef = useRef<HTMLDivElement>(null);
  // The sheet stays mounted while closed, so a pending confirmation must not
  // survive a close: the next open (maybe another selection) starts over.
  const close = () => {
    setConfirming(false);
    onClose();
  };
  useModalA11y(panelRef, open, close);

  // Fee preview — mirrors the backend's authoritative charge (delivery-fee.ts).
  // Recomputed per render from the selected address; cheap (two lookups).
  const selectedAddress = addrList.find((a) => a.id === selectedAddr);
  const country = selectedAddress?.countryCode ?? '';
  // One parcel, one shipping fee (2026-10-23): the vault cards and the prize
  // cards go as ONE order, priced like the backend's computeParcelFee — the
  // zone's shipping once, plus 5% insurance above RM200 on the vault cards'
  // combined value and on each prize's own value.
  const paidItems = items.filter((i) => i.source !== 'reward');
  const selectedPrizes = items.filter((i) => i.source === 'reward');
  // Prize cards ship up to a daily limit; only those are priced and sent, and
  // the rest stay in the vault (said below). Unknown limit = all of them,
  // with the backend's cap still deciding.
  const prizeItems =
    prizeAllowance === null
      ? selectedPrizes
      : selectedPrizes.slice(0, prizeAllowance.remaining);
  const prizesHeldBack = selectedPrizes.length - prizeItems.length;
  // Rounded to cents like the backend's vaultValueForPulls sum, so a float
  // artifact can't show an insurance line at exactly RM200 that the
  // authoritative charge never applies.
  const orderValue =
    Math.round(
      paidItems.reduce((s, i) => s + (i.card.priceMyr ?? 0), 0) * 100,
    ) / 100;
  const fee =
    selectedAddress && paidItems.length + prizeItems.length > 0
      ? computeParcelFee(
          selectedAddress.postalCode,
          orderValue,
          prizeItems.map((i) => i.card.priceMyr ?? 0),
          selectedAddress.province,
          selectedAddress.city,
          country,
        )
      : null;
  const totalCharge = fee?.total ?? 0;
  const zone = selectedAddress
    ? deliveryZone(
        selectedAddress.postalCode,
        selectedAddress.province,
        selectedAddress.city,
        country,
      )
    : null;
  const unshippableCountry = !!selectedAddress && !isShippableCountry(country);
  // The backend refuses a postcode it can't zone, so say so here rather than
  // previewing a rate the request would reject.
  const badPostcode =
    !!selectedAddress &&
    !unshippableCountry &&
    !isShippablePostcode(selectedAddress.postalCode, country);
  const priceable = !!selectedAddress && !unshippableCountry && !badPostcode;
  // What actually ships now: the vault cards plus the prizes today's limit lets.
  const shipCount = paidItems.length + prizeItems.length;
  // Checked before the request (the backend's floor guard still decides):
  // a balance that cannot cover the charge is sent to top up instead. Bonus
  // credit pays fees too (ADR 0014), so the whole balance counts. The LIVE
  // balance, so a top-up made from this sheet clears the shortfall.
  const spendable = balance ?? wallet?.balance ?? null;
  const shortBy =
    priceable && spendable != null && totalCharge > spendable
      ? Math.round((totalCharge - spendable) * 100) / 100
      : 0;

  // Liquid-glass rim on the panel (frosted fallback on Safari/Firefox).
  useLiquidGlass(panelRef, open, GLASS_SUBTLE);

  if (!open) return null;

  async function saveAddress() {
    setBusy(true);
    setError(null);
    try {
      if (fixingId) {
        // Repaired in place: a second row would leave the broken one behind.
        const res = await updateAddress(fixingId, form);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setAddrList((p) =>
          p.map((a) =>
            a.id === fixingId ? addressViewFromInput(fixingId, form) : a,
          ),
        );
        setSelectedAddr(fixingId);
        setFixingId(null);
      } else {
        const res = await addAddress(form);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        // Optimistic: append + select. (A full refresh would re-fetch getAddresses.)
        setAddrList((p) => [...p, addressViewFromInput(res.addressId, form)]);
        setSelectedAddr(res.addressId);
      }
      setAdding(false);
      // A new address re-prices: confirm the new charge.
      setConfirming(false);
    } catch {
      setError('Couldn’t save the address. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  // Reopens a saved row that can't ship in the form; saveAddress then updates
  // that same row.
  function startFix(a: AddressView) {
    // A real country stays (the postcode is what's wrong); a junk one starts
    // on the select's placeholder.
    const countryCode = isShippableCountry(a.countryCode)
      ? a.countryCode.trim().toUpperCase()
      : '';
    setForm({
      firstName: a.firstName,
      lastName: a.lastName,
      address1: a.line1,
      address2: a.line2 ?? undefined,
      city: a.city,
      // An old free-text state isn't on the list: blank, so the select asks
      // rather than painting its first option.
      province: stateAfterCountryChange(countryCode, a.province),
      postalCode: a.postalCode,
      countryCode,
      // This form has no phone field, so a number updateAddress would refuse
      // is dropped rather than leaving an error the customer can't act on.
      // Blank falls back to the verified profile phone at request time
      // (request-delivery.ts).
      phone: a.phone && normalizePhone(a.phone) ? a.phone : undefined,
    });
    setError(null);
    setFixingId(a.id);
    setAdding(true);
    setConfirming(false);
  }

  async function submit() {
    if (!selectedAddr) {
      setError('Choose a shipping address.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const normalIds = paidItems.map((i) => i.pullId);
      // Only the prizes today's limit lets ship; the rest stay in the vault.
      // The backend refuses the whole parcel past the cap, so never send more.
      const rewardIds = prizeItems.map((i) => i.pullId);
      const res = await shipVaultCards(normalIds, rewardIds, selectedAddr);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // The fees left the balance server-side; repaint the header chip.
      void refreshBalance();
      onSubmitted(res.shippedIds, res.skipped);
    } catch {
      setError('Couldn’t request delivery. Please try again.');
    } finally {
      setBusy(false);
      setConfirming(false);
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
          address. The shipping fee is deducted from your balance.
        </p>

        {/* Selected cards. overflow-x-auto clips the halo on all four sides
            (same CSS coupling as the PoolByRarity rail, src/app/slots/[slug]/PoolByRarity.tsx:97-114)
            so the room has to live in this box's own padding: `px-3 py-3`
            give the ~13px a 60px slab's glowScale=0.3 halo reaches. Dropping
            the old `mt-3` and letting `py-3`'s top half stand in for it keeps
            the gap under the paragraph above unchanged (margin 0 + padding
            12 = the old margin-12 + padding-0); `-mb-3` then cancels py-3's
            bottom half so the address picker below doesn't shift down either.
            No `-mx` needed: with width:auto in normal block flow the box's
            outer edges don't move when padding changes, only its content
            area shrinks — exactly where the extra room is wanted. */}
        <div className="-mb-3 flex gap-2 overflow-x-auto px-3 py-3">
          {items.map((i) => (
            <SlabImage
              key={i.pullId}
              card={i.card}
              sizes="60px"
              className="w-15 shrink-0"
              glowScale={0.3}
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
                  onChange={() => {
                    setSelectedAddr(a.id);
                    // A new address re-prices: confirm the new charge.
                    setConfirming(false);
                  }}
                />
                <span>
                  {a.name} — {a.line1}, {a.city} {a.postalCode}{' '}
                  {a.countryCode.toUpperCase()}
                </span>
              </label>
            ))}
            <button
              type="button"
              onClick={() => {
                // Clean slate: a cancelled repair leaves the broken row in
                // `form`, and saving that here would be the duplicate the
                // repair exists to avoid.
                setForm(EMPTY_FORM);
                setFixingId(null);
                setAdding(true);
                setConfirming(false);
              }}
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
            {/* A fixed list, not free text: the state feeds the shipping zone
                (delivery-fee.ts), so a typed "Sabah, Malaysia" must still bill
                East. aria-label matches the sibling inputs — none of these
                labels are `for`-associated. */}
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
                {statesFor(form.countryCode).map((s) => (
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
                Country
              </span>
              <CountrySelect
                value={form.countryCode}
                onChange={(countryCode) =>
                  // A state from the other country's list is never valid.
                  setForm((f) => ({
                    ...f,
                    countryCode,
                    province: stateAfterCountryChange(countryCode, f.province),
                  }))
                }
              />
            </label>
            <div className="col-span-2 flex gap-2">
              {/* Neutral-light primary (Pill): saving an address isn't money-in,
                  so no buyback green. Not a real <form>, so the select's
                  `required` does nothing here. */}
              <Pill
                disabled={busy || !isShippableCountry(form.countryCode)}
                onClick={saveAddress}
                className="px-4"
              >
                Save address
              </Pill>
              {addrList.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false);
                    setFixingId(null);
                    setError(null);
                  }}
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
        {!adding && priceable && zone && shipCount > 0 && (
          <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-3 text-[13px]">
            {fee && (
              <>
                <div className="flex justify-between text-white/70">
                  <span>Shipping ({ZONE_LABEL[zone]})</span>
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
              </>
            )}
            <div className="mt-2 flex justify-between border-t border-white/10 pt-2 font-semibold text-white">
              <span>Total — deducted from balance</span>
              <span>{rm(totalCharge)}</span>
            </div>
            {balance != null && (
              <p className="mt-1 text-right text-[12px] text-white/45">
                Your balance: {rm(balance)}
              </p>
            )}
          </div>
        )}
        {/* Prize cards past today's limit stay in the vault, unpriced. */}
        {!adding && prizesHeldBack > 0 && prizeAllowance !== null && (
          <p className="mt-3 rounded-xl border border-white/15 bg-white/[0.06] p-3 text-[12px] text-white/75">
            Prize cards ship {prizeAllowance.perDay} per day. {prizesHeldBack}{' '}
            prize card{prizesHeldBack === 1 ? '' : 's'} will stay in your vault
            and can ship on another day — they are not charged now.
          </p>
        )}
        {/* Checked before anything is requested; the backend's floor guard
            is still the authority. */}
        {!adding && shortBy > 0 && (
          <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-[12px] text-amber-200">
            <p>
              Not enough balance: this delivery costs {rm(totalCharge)} and you
              have {rm(spendable ?? 0)}. Top up {rm(shortBy)} or more to ship
              it.
            </p>
            <Pill onClick={openTopUp} className="mt-2 px-4">
              Top up
            </Pill>
          </div>
        )}
        {/* Nearly every address that lands here is Malaysian, saved with "60"
            or "MALAYSIA" as its country back when that was free text, so name
            the stored value and offer the fix rather than only the rule. */}
        {!adding && unshippableCountry && selectedAddress && (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-[12px] text-amber-200">
            <p>
              {country
                ? `This address has “${country}” as its country`
                : 'This address has no country'}
              , so it can’t ship. We ship within Malaysia and Singapore only —
              fix it and pick the country from the list.
            </p>
            <Pill
              onClick={() => startFix(selectedAddress)}
              className="mt-2 px-4"
            >
              Fix this address
            </Pill>
          </div>
        )}
        {!adding && badPostcode && selectedAddress && (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-[12px] text-amber-200">
            <p>
              That address needs {postcodeHint(country)} before it can be
              shipped.
            </p>
            <Pill
              onClick={() => startFix(selectedAddress)}
              className="mt-2 px-4"
            >
              Fix this address
            </Pill>
          </div>
        )}
        {/* The charge is confirmed before anything is requested. */}
        {confirming && !adding && priceable && shortBy === 0 && (
          <p
            role="status"
            className="mt-3 rounded-xl border border-white/15 bg-white/[0.06] p-3 text-[13px] text-white"
          >
            {rm(totalCharge)} will be deducted from your balance to ship{' '}
            {shipCount} card{shipCount === 1 ? '' : 's'} to{' '}
            {ZONE_LABEL[zone ?? 'west']}. Confirm to continue.
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
            <PhoneGateAction error={error} onNavigate={close} />
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={confirming ? () => setConfirming(false) : close}
            className="rounded-lg px-4 py-2 text-[13px] text-white/60"
          >
            {confirming ? 'Back' : 'Cancel'}
          </button>
          <Pill
            disabled={
              busy ||
              adding ||
              !selectedAddr ||
              !priceable ||
              shortBy > 0 ||
              shipCount === 0
            }
            onClick={confirming ? submit : () => setConfirming(true)}
          >
            {busy
              ? 'Requesting…'
              : confirming
                ? `Confirm & pay ${rm(totalCharge)}`
                : 'Request delivery'}
          </Pill>
        </div>
      </div>
    </div>
  );
}
