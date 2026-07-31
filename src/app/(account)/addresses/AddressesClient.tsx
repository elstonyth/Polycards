'use client';

import { useRef, useState } from 'react';
import { MapPin, Plus } from 'lucide-react';
import {
  addAddress,
  deleteAddress,
  updateAddress,
  type AddressView,
  type AddAddressInput,
} from '@/lib/actions/delivery';
import { addressViewFromInput } from '@/lib/address-view';
import { openAuth } from '@/components/AuthButton';
import { INPUT_CLASS } from '@/components/account/ui';
import { Pill, pillVariants } from '@/components/ui/pill';
import { cn } from '@/lib/utils';
import { useModalA11y } from '@/lib/use-modal-a11y';

const EMPTY_FORM: AddAddressInput = {
  firstName: '',
  lastName: '',
  address1: '',
  city: '',
  postalCode: '',
  countryCode: '',
};

// Seed the edit form from a saved address. firstName/lastName come off the view
// SPLIT (see AddressView) rather than from re-splitting the joined `name`, which
// would move the second word of a two-word given name into the surname.
const formOf = (a: AddressView): AddAddressInput => ({
  firstName: a.firstName,
  lastName: a.lastName,
  address1: a.line1,
  address2: a.line2 ?? undefined,
  city: a.city,
  province: a.province ?? undefined,
  postalCode: a.postalCode,
  countryCode: a.countryCode,
  phone: a.phone ?? undefined,
});

// Deleting an address is destructive and irreversible from here, so it takes a
// confirm — same shell + a11y contract as the vault's CancelOrderModal. The
// copy states the one thing a customer would worry about: orders already on
// their way carry their own snapshot of the address and are unaffected.
function RemoveAddressModal({
  address,
  onClose,
  onRemoved,
}: {
  address: AddressView;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, true, onClose);

  async function confirm() {
    setBusy(true);
    setError(null);
    const res = await deleteAddress(address.id);
    setBusy(false);
    if (!res.ok) {
      // Expired session: reopen the login modal rather than stranding the
      // customer on "Please log in first." inside a dialog with no way there.
      if (res.needsAuth) openAuth('login');
      else setError(res.error);
      return;
    }
    onRemoved();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Remove address"
        tabIndex={-1}
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-neutral-900 p-5 outline-none"
      >
        <h2 className="font-heading text-lg font-bold text-white">
          Remove this address?
        </h2>
        <p className="mt-1 text-[13px] text-white/55">
          It won&rsquo;t be offered next time you request a delivery. Orders
          already placed keep the address they were sent with.
        </p>

        <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-[13px] text-white/80">
          <p className="font-semibold text-white">{address.name || '—'}</p>
          <p className="mt-0.5">{address.line1}</p>
          <p>
            {address.city} {address.postalCode}{' '}
            {address.countryCode.toUpperCase()}
          </p>
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
            Keep it
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
            {busy ? 'Removing…' : 'Remove address'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Shipping-address book (the "Address" quick-access tile on /me): list, add,
 * edit, and remove. One form serves add and edit — `editingId` is the only
 * difference, and it picks which action the submit runs.
 */
export function AddressesClient({
  initialAddresses,
}: {
  initialAddresses: AddressView[];
}) {
  const [addresses, setAddresses] = useState(initialAddresses);
  const [adding, setAdding] = useState(initialAddresses.length === 0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AddressView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<AddAddressInput>(EMPTY_FORM);

  // Open for a NEW address, or for an existing one. Only one form is ever
  // mounted, so opening either closes the other by construction.
  const startAdd = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setError(null);
    setAdding(true);
  };
  const startEdit = (a: AddressView) => {
    setForm(formOf(a));
    setEditingId(a.id);
    setError(null);
    setAdding(false);
  };
  const closeForm = () => {
    setAdding(false);
    setEditingId(null);
    setError(null);
  };

  // A session that expired mid-edit comes back `needsAuth`. Showing "Please log
  // in first." in the form's error slot is a dead end — the header's Login modal
  // is the only way back, and nothing on this page points at it. Reopen it
  // instead, matching the pattern the spin screen already uses. Returns true
  // when it handled the failure, so callers can fall through to setError.
  const handled = (res: { error: string; needsAuth?: boolean }) => {
    if (res.needsAuth) {
      openAuth('login');
      return true;
    }
    return false;
  };

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (editingId) {
        const res = await updateAddress(editingId, form);
        if (!res.ok) {
          if (!handled(res)) setError(res.error);
          return;
        }
        // Optimistic in-place patch: `form` IS what was persisted.
        setAddresses((p) =>
          p.map((a) =>
            a.id === editingId ? addressViewFromInput(editingId, form) : a,
          ),
        );
      } else {
        const res = await addAddress(form);
        if (!res.ok) {
          if (!handled(res)) setError(res.error);
          return;
        }
        setAddresses((p) => [...p, addressViewFromInput(res.addressId, form)]);
      }
      setForm(EMPTY_FORM);
      closeForm();
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

  const formOpen = adding || editingId !== null;

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
              <div className="min-w-0 flex-1 text-[13px] text-neutral-300">
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
                {/* Row actions rather than a kebab menu: two actions, and a
                    44px tap target each beats a menu on a phone. */}
                <div className="mt-2 flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => startEdit(a)}
                    aria-label={`Edit address for ${a.name || a.line1}`}
                    className="-ml-2 rounded-lg px-2 py-1.5 text-[12px] font-semibold text-white/70 transition-colors hover:text-white"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => setRemoving(a)}
                    aria-label={`Remove address for ${a.name || a.line1}`}
                    className="rounded-lg px-2 py-1.5 text-[12px] font-semibold text-red-300/80 transition-colors hover:text-red-300"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* No empty state: `adding` starts true whenever the list is empty, so
          the new-address form IS the empty state. */}
      {formOpen ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="rounded-2xl border border-white/10 bg-neutral-900 p-5"
        >
          <p className="text-[12px] font-semibold uppercase tracking-wide text-neutral-400">
            {editingId ? 'Edit address' : 'New address'}
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
              {busy ? 'Saving…' : editingId ? 'Save changes' : 'Save address'}
            </Pill>
            {/* Cancel is only an exit when there IS something to go back to —
                on an empty book the form is the whole page. */}
            {(editingId || addresses.length > 0) && (
              <button
                type="button"
                onClick={closeForm}
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
          onClick={startAdd}
          className="self-start px-5"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add a new address
        </Pill>
      )}

      {removing && (
        <RemoveAddressModal
          address={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setAddresses((p) => {
              const next = p.filter((a) => a.id !== removing.id);
              // Removing the LAST one has to reopen the form: `adding` only
              // starts true at mount, so without this the empty book renders as
              // a bare "Add a new address" pill instead of the form-as-empty-
              // state the comment below promises.
              if (next.length === 0) setAdding(true);
              return next;
            });
            // A removed row must not leave the edit form open on a ghost id.
            if (editingId === removing.id) closeForm();
            setRemoving(null);
          }}
        />
      )}
    </div>
  );
}
