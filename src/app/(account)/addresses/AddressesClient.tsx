'use client';

import { useState } from 'react';
import { MapPin, Plus } from 'lucide-react';
import {
  addAddress,
  type AddressView,
  type AddAddressInput,
} from '@/lib/actions/delivery';
import { INPUT_CLASS } from '@/components/account/ui';
import { Pill } from '@/components/ui/pill';

const EMPTY_FORM: AddAddressInput = {
  firstName: '',
  lastName: '',
  address1: '',
  city: '',
  postalCode: '',
  countryCode: '',
};

/**
 * Shipping-address book (the "Address" quick-access tile on /me). The data
 * layer only supports list + add today — editing happens per delivery order
 * in the vault flow, so there is no edit/delete here yet.
 */
export function AddressesClient({
  initialAddresses,
}: {
  initialAddresses: AddressView[];
}) {
  const [addresses, setAddresses] = useState(initialAddresses);
  const [adding, setAdding] = useState(initialAddresses.length === 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<AddAddressInput>(EMPTY_FORM);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await addAddress(form);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Optimistic append (same pattern as RequestDeliveryModal).
      setAddresses((p) => [
        ...p,
        {
          id: res.addressId,
          name: `${form.firstName} ${form.lastName}`.trim(),
          line1: form.address1,
          line2: form.address2 ?? null,
          city: form.city,
          province: form.province ?? null,
          postalCode: form.postalCode,
          countryCode: form.countryCode,
          phone: form.phone ?? null,
        },
      ]);
      setForm(EMPTY_FORM);
      setAdding(false);
    } catch {
      setError('Couldn’t save the address. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function field(
    label: string,
    key: keyof AddAddressInput,
    props: React.InputHTMLAttributes<HTMLInputElement> = {},
  ) {
    return (
      <label className="block">
        <span className="mb-1.5 block text-[12px] font-medium text-white/55">
          {label}
        </span>
        <input
          aria-label={label}
          value={form[key] ?? ''}
          onChange={(e) =>
            setForm((f) => ({
              ...f,
              [key]:
                key === 'countryCode'
                  ? e.target.value.toUpperCase()
                  : e.target.value,
            }))
          }
          className={INPUT_CLASS}
          {...props}
        />
      </label>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {addresses.length > 0 && (
        <ul className="flex flex-col gap-2">
          {addresses.map((a) => (
            <li
              key={a.id}
              className="flex items-start gap-3 rounded-2xl border border-white/10 bg-neutral-900 p-4"
            >
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-800">
                <MapPin className="h-4 w-4 text-neutral-300" aria-hidden />
              </span>
              <div className="min-w-0 text-[13px] text-neutral-300">
                <p className="font-semibold text-white">{a.name || '—'}</p>
                <p className="mt-0.5">
                  {a.line1}
                  {a.line2 ? `, ${a.line2}` : ''}
                </p>
                <p>
                  {a.city}
                  {a.province ? `, ${a.province}` : ''} {a.postalCode}{' '}
                  {a.countryCode.toUpperCase()}
                </p>
                {a.phone && <p className="text-neutral-500">{a.phone}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* No empty state: `adding` starts true whenever the list is empty, so
          the new-address form IS the empty state. */}
      {adding ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="rounded-2xl border border-white/10 bg-neutral-900 p-5"
        >
          <p className="text-[12px] font-semibold uppercase tracking-wide text-neutral-400">
            New address
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {field('First name', 'firstName', {
              autoComplete: 'given-name',
              required: true,
            })}
            {field('Last name', 'lastName', {
              autoComplete: 'family-name',
              required: true,
            })}
            <div className="col-span-2">
              {field('Address', 'address1', {
                autoComplete: 'address-line1',
                required: true,
              })}
            </div>
            {field('City', 'city', {
              autoComplete: 'address-level2',
              required: true,
            })}
            {field('Postal code', 'postalCode', {
              autoComplete: 'postal-code',
              required: true,
            })}
            {field('Country code', 'countryCode', {
              autoComplete: 'country',
              placeholder: 'e.g. MY',
              maxLength: 2,
              required: true,
              pattern: '[A-Za-z]{2}',
              title: 'Two-letter country code, for example MY',
            })}
            {field('Phone (optional)', 'phone', { autoComplete: 'tel' })}
          </div>
          {error && (
            <p
              role="alert"
              className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300"
            >
              {error}
            </p>
          )}
          <div className="mt-4 flex items-center gap-3">
            <Pill type="submit" disabled={busy} className="px-5">
              {busy ? 'Saving…' : 'Save address'}
            </Pill>
            {addresses.length > 0 && (
              <button
                type="button"
                onClick={() => setAdding(false)}
                className="text-[13px] text-white/60 hover:text-white"
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      ) : (
        <Pill
          variant="secondary"
          onClick={() => setAdding(true)}
          className="self-start px-5"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add a new address
        </Pill>
      )}
    </div>
  );
}
