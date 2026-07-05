'use client';

import { useState } from 'react';
import { openAuth } from '@/components/AuthButton';
import { withdrawPrize } from '@/lib/actions/daily';
import type { WithdrawAddressInput } from '@/lib/data/schemas';

// ---- input style shared with the address form ------------------------------
const INPUT_CLASS =
  'h-11 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 text-sm text-white placeholder:text-white/40 focus:border-white/25 focus:outline-none';

/** Simple inline address form for prize withdrawal. */
export function WithdrawForm({
  pullId,
  onDone,
  onCancel,
}: {
  pullId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<WithdrawAddressInput>({
    firstName: '',
    lastName: '',
    address1: '',
    city: '',
    postalCode: '',
    countryCode: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [done, setDone] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    setNeedsAuth(false);
    const res = await withdrawPrize(pullId, form);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      setNeedsAuth(res.needsAuth === true);
      return;
    }
    if (res.status === 'requested') {
      setDone(true);
      setTimeout(onDone, 1500);
    } else if (res.status === 'capped') {
      setError("You've hit today's withdrawal limit. Try again tomorrow.");
    } else {
      setError(
        "This prize can't be shipped (it may have already been requested).",
      );
    }
  }

  if (done) {
    return (
      <p className="rounded-xl border border-buyback/30 bg-buyback/10 px-4 py-3 text-sm font-semibold text-buyback-fg">
        Shipping requested! Check your Orders for status.
      </p>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="mt-4 space-y-3"
    >
      <p className="text-[13px] text-white/60">Enter your shipping address:</p>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-white/55">
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
          <span className="mb-1 block text-[12px] font-medium text-white/55">
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
          <span className="mb-1 block text-[12px] font-medium text-white/55">
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
          <span className="mb-1 block text-[12px] font-medium text-white/55">
            City
          </span>
          <input
            aria-label="City"
            autoComplete="address-level2"
            value={form.city}
            onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
            className={INPUT_CLASS}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-white/55">
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
          <span className="mb-1 block text-[12px] font-medium text-white/55">
            Country code (2 letters)
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
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300"
        >
          {error}
          {needsAuth && (
            <>
              {' '}
              <button
                type="button"
                onClick={() => openAuth('login')}
                className="font-semibold underline underline-offset-2"
              >
                Log in
              </button>
            </>
          )}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-buyback px-4 py-2 text-[13px] font-bold text-white disabled:opacity-50"
        >
          {busy ? 'Requesting…' : 'Request shipping'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-4 py-2 text-[13px] text-white/60 hover:text-white"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
