'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rm, rm0 } from '@/lib/format';
import { topUpCredits } from '@/lib/actions/vault';

const PRESETS = [10, 25, 50, 100];

/**
 * Global top-up bottom sheet (90scard's profile top-up flow, dark skin).
 * Mobile: slides up from the bottom edge; sm+: centered dialog. The mock
 * gateway contract is unchanged from AddCreditsPanel: amount-only payload,
 * ≤ RM 10,000, whole cents, amounts ending in .13 are the demo decline path.
 */
export default function TopUpSheet({
  open,
  balance,
  onClose,
  onToppedUp,
}: {
  open: boolean;
  balance: number | null;
  onClose: () => void;
  onToppedUp: (balance: number, amount: number) => void;
}) {
  const [amountText, setAmountText] = useState('25');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ amount: number; balance: number } | null>(
    null,
  );
  const panelRef = useRef<HTMLDivElement>(null);

  const amount = Number.parseFloat(amountText);
  const amountValid =
    Number.isFinite(amount) &&
    amount > 0 &&
    amount <= 10_000 &&
    Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6;

  // Escape closes; body scroll locks while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  // Reset transient state each time the sheet opens.
  useEffect(() => {
    if (open) {
      setError(null);
      setDone(null);
      setSubmitting(false);
    }
  }, [open]);

  async function submit() {
    if (submitting || !amountValid) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await topUpCredits(amount);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDone({ amount: res.amount, balance: res.balance });
      onToppedUp(res.balance, res.amount);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70]" role="presentation">
      {/* Scrim */}
      <button
        type="button"
        aria-label="Close top up"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/60"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Top up credits"
        tabIndex={-1}
        className={cn(
          'absolute inset-x-0 bottom-0 mx-auto w-full max-w-md rounded-t-2xl border-t border-white/10 bg-neutral-900 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] outline-none',
          'sm:inset-x-0 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2 sm:rounded-2xl sm:border',
          'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-safe:duration-200',
        )}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-heading text-xl text-white">TOP UP</h2>
          <div className="flex items-center gap-2">
            <span className="rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-amber-300">
              Demo
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-neutral-800 text-neutral-300 transition-colors hover:text-white"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>

        {done ? (
          <div className="mt-6 flex flex-col items-center text-center">
            <CheckCircle2 className="h-12 w-12 text-green-400" aria-hidden />
            <p className="mt-3 font-heading text-2xl text-white">
              {rm(done.amount)} ADDED
            </p>
            <p className="mt-1 text-sm text-neutral-400">
              New balance{' '}
              <span className="font-semibold text-white">
                {rm(done.balance)}
              </span>
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-6 inline-flex h-12 w-full items-center justify-center rounded-full bg-neutral-50 text-sm font-semibold text-neutral-950 transition-transform active:scale-[0.98]"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap gap-2">
              {PRESETS.map((preset) => {
                const selected = amountText === String(preset);
                return (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setAmountText(String(preset))}
                    className={cn(
                      'inline-flex h-10 items-center justify-center rounded-full px-4 text-[13px] font-semibold transition-colors',
                      selected
                        ? 'bg-neutral-50 text-neutral-950'
                        : 'bg-neutral-800 text-neutral-400 hover:text-white',
                    )}
                  >
                    {rm0(preset)}
                  </button>
                );
              })}
            </div>

            <label className="mt-3 flex items-center gap-2 rounded-xl bg-neutral-800 px-4 py-3">
              <span className="text-sm font-semibold text-neutral-400">RM</span>
              <input
                type="text"
                inputMode="decimal"
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
                aria-label="Top-up amount in RM"
                className="font-heading w-full bg-transparent text-2xl text-white outline-none placeholder:text-neutral-600"
                placeholder="0.00"
              />
            </label>

            <div className="mt-4 rounded-xl border border-white/10 bg-neutral-950/60 p-4 text-sm">
              <div className="flex items-center justify-between text-neutral-400">
                <span>Current balance</span>
                <span className="font-semibold text-neutral-200">
                  {balance == null ? '—' : rm(balance)}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between text-neutral-400">
                <span>You top up</span>
                <span className="font-semibold text-green-400">
                  {amountValid ? `+ ${rm(amount)}` : '—'}
                </span>
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-white/10 pt-3">
                <span className="text-neutral-300">New balance</span>
                <span className="font-heading text-lg text-white">
                  {balance != null && amountValid ? rm(balance + amount) : '—'}
                </span>
              </div>
            </div>

            {error && (
              <p className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] font-medium text-red-300">
                {error}
              </p>
            )}

            <button
              type="button"
              onClick={submit}
              disabled={submitting || !amountValid}
              className="mt-4 inline-flex h-12 w-full items-center justify-center rounded-full bg-neutral-50 text-sm font-semibold text-neutral-950 transition-transform active:scale-[0.98] disabled:opacity-40"
            >
              {submitting
                ? 'Processing…'
                : amountValid
                  ? `Proceed — add ${rm(amount)}`
                  : 'Enter an amount'}
            </button>

            <p className="mt-3 text-[12px] leading-relaxed text-neutral-500">
              Demo checkout: only the amount leaves your browser. Amounts ending
              in .13 are declined on purpose so you can see the error path.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
