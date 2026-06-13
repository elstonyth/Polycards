'use client';

import { useState } from 'react';
import { usd } from '@/lib/format';
import { topUpCredits } from '@/lib/actions/vault';

const PRESETS = [10, 25, 50, 100];

// "Add credits" — the demo top-up checkout. The card fields are theater (a
// clearly-marked fake form; nothing but the amount ever leaves the browser):
// the mock gateway approves everything except amounts ending in .13, which is
// the demo's decline path. The real gateway swaps in behind the same action.
export function AddCreditsPanel({
  onToppedUp,
}: {
  onToppedUp: (balance: number, amount: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [amountText, setAmountText] = useState('25');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const amount = Number.parseFloat(amountText);
  const amountValid =
    Number.isFinite(amount) &&
    amount > 0 &&
    amount <= 10_000 &&
    Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6;

  async function submit() {
    if (submitting || !amountValid) return;
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      const res = await topUpCredits(amount);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSuccess(`${usd(res.amount)} added to your balance.`);
      onToppedUp(res.balance, res.amount);
    } catch {
      // A transport-level throw must still surface feedback, not fail silently.
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex h-10 items-center justify-center rounded-xl bg-gradient-to-r from-emerald-500 to-green-500 px-5 text-sm font-bold text-white transition-opacity hover:opacity-95"
        >
          Add credits
        </button>
        {success && (
          <p className="text-[13px] font-medium text-emerald-300">{success}</p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-white">Add credits</p>
        <span className="rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-amber-300">
          Demo — no real payment
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => setAmountText(String(preset))}
            className={`inline-flex h-9 items-center justify-center rounded-lg border px-4 text-[13px] font-bold transition-colors ${
              amountText === String(preset)
                ? 'border-emerald-400/60 bg-emerald-400/10 text-emerald-300'
                : 'border-white/15 bg-white/[0.02] text-white/70 hover:bg-white/[0.06]'
            }`}
          >
            ${preset}
          </button>
        ))}
        <label className="flex items-center gap-1.5 text-[13px] text-white/70">
          <span>$</span>
          <input
            type="text"
            inputMode="decimal"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            aria-label="Top-up amount in USD"
            className="h-9 w-24 rounded-lg border border-white/15 bg-white/[0.02] px-2.5 text-[13px] font-semibold text-white outline-none focus:border-emerald-400/60"
          />
        </label>
      </div>

      {/* Fake card form — client-side only, never submitted anywhere. */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <input
          type="text"
          defaultValue="4242 4242 4242 4242"
          aria-label="Card number (demo)"
          className="col-span-2 h-9 rounded-lg border border-white/15 bg-white/[0.02] px-2.5 text-[13px] text-white/70 outline-none focus:border-white/30"
        />
        <input
          type="text"
          defaultValue="12/30"
          aria-label="Expiry (demo)"
          className="h-9 rounded-lg border border-white/15 bg-white/[0.02] px-2.5 text-[13px] text-white/70 outline-none focus:border-white/30"
        />
        <input
          type="text"
          defaultValue="123"
          aria-label="CVC (demo)"
          className="h-9 rounded-lg border border-white/15 bg-white/[0.02] px-2.5 text-[13px] text-white/70 outline-none focus:border-white/30"
        />
      </div>

      {error && (
        <p className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] font-medium text-red-300">
          {error}
        </p>
      )}
      {success && (
        <p className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[13px] font-medium text-emerald-300">
          {success}
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={submitting || !amountValid}
          className="inline-flex h-10 items-center justify-center rounded-xl bg-gradient-to-r from-emerald-500 to-green-500 px-5 text-sm font-bold text-white transition-opacity hover:opacity-95 disabled:opacity-50"
        >
          {submitting
            ? 'Processing…'
            : amountValid
              ? `Add ${usd(amount)}`
              : 'Enter an amount'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="inline-flex h-10 items-center justify-center rounded-xl border border-white/15 px-4 text-sm font-semibold text-white/70 transition-colors hover:bg-white/[0.06]"
        >
          Close
        </button>
      </div>

      <p className="mt-3 text-[12px] text-white/35">
        Demo checkout: card details stay in your browser and are never sent or
        stored. Amounts ending in .13 are declined on purpose so you can see the
        error path.
      </p>
    </div>
  );
}
