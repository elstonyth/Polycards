'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rm, rm0 } from '@/lib/format';
import {
  getDepositMethods,
  startDeposit,
  topUpCredits,
} from '@/lib/actions/vault';
import { leaveFor } from '@/lib/navigation';
import { Pill } from '@/components/ui/pill';
import { PhoneGateAction } from '@/components/account/PhoneGateAction';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { useLiquidGlass, GLASS_SUBTLE } from '@/lib/use-liquid-glass';
import {
  DEPOSIT_METHODS,
  DEFAULT_DEPOSIT_METHOD,
  type DepositMethod,
  type DepositMethodCode,
} from '@/lib/deposit-methods';

// Which gateway backs the sheet. 'globepay' sends the customer to the
// provider's cashier page and credits nothing here — the balance updates later,
// when their signed callback settles the deposit. Anything else keeps the mock
// gateway, which credits synchronously and stays the local/dev path.
const USE_GATEWAY = process.env.NEXT_PUBLIC_PAYMENTS_PROVIDER === 'globepay';

// The gateway's band is narrower than the mock's on both ends, and it rejects
// anything outside it with a generic "Invalid Transaction Amount" that names no
// numbers. Catch it in the sheet so the customer gets a message they can act on.
// Production band, confirmed by the provider 2026-07-29: RM 30 – RM 10,000 for
// both Online Banking and QR (docs/payments/globepay365-setup.md). Mirrors the
// backend's GLOBEPAY_MIN_RM/GLOBEPAY_MAX_RM.
const GATEWAY_MIN_RM = 30;
const GATEWAY_MAX_RM = 10000;

// The mock's 10/25 rungs are below the gateway's floor, so offering them would
// guarantee a rejection on the real path. The gateway rungs span the production
// band (RM 30 – 10,000) rather than hugging its floor — 5,000 is a real ticket
// size now that the ceiling is 10,000, and it was impossible under the test
// account's RM 1,000 cap.
const PRESETS = USE_GATEWAY ? [50, 250, 500, 5000] : [10, 25, 50, 100];
const DEFAULT_AMOUNT = USE_GATEWAY ? '50' : '25';

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
  const [amountText, setAmountText] = useState(DEFAULT_AMOUNT);
  // Every provisioned channel until the server says otherwise. An operator can
  // retract one at runtime (DEPOSIT_METHODS_ENABLED), which is asked for when
  // the sheet opens rather than resolved in the layout — see getDepositMethods.
  const [methods, setMethods] =
    useState<readonly DepositMethod[]>(DEPOSIT_METHODS);
  // Gateway path only — the mock has no channels. QR (the backend's own
  // default) when it is on offer, so an untouched sheet behaves exactly as it
  // did before the picker; otherwise whatever is left, since preselecting a
  // retracted channel would hand the server action a code it must refuse.
  const preferred =
    methods.find((option) => option.code === DEFAULT_DEPOSIT_METHOD)?.code ??
    methods[0]?.code ??
    DEFAULT_DEPOSIT_METHOD;
  const [method, setMethod] = useState<DepositMethodCode>(preferred);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{
    amount: number;
    balance: number;
    replayed?: boolean;
  } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // One idempotency key per top-up ATTEMPT: minted lazily on submit, REUSED on
  // error retries (so a credited-but-response-lost top-up replays instead of
  // double-crediting — the backend returns the original result), and rotated
  // only after a confirmed success so "top up more" starts a fresh attempt.
  const attemptKey = useRef<string | null>(null);

  const amount = Number.parseFloat(amountText);
  const amountValid =
    Number.isFinite(amount) &&
    amount > 0 &&
    amount <= 10_000 &&
    Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6;

  // Focus-in, Tab trap, Escape, scroll lock + focus restore on close.
  useModalA11y(panelRef, open, onClose);

  // Liquid-glass rim on the sheet panel (frosted fallback on Safari/Firefox).
  useLiquidGlass(panelRef, open, GLASS_SUBTLE);

  // Reset transient state each time the sheet opens. `preferred` is deliberately
  // NOT a dependency: it changes when the channel list arrives below, and
  // re-running then would wipe a selection the customer had already made.
  useEffect(() => {
    if (open) {
      setError(null);
      setDone(null);
      setSubmitting(false);
      setMethod(preferred);
      attemptKey.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Ask the server which channels are on offer, per open. Gateway path only —
  // the mock has no channels — and failure keeps the compiled list, since the
  // action re-checks the code anyway and a refused channel shows its own error.
  useEffect(() => {
    if (!open || !USE_GATEWAY) return;
    let cancelled = false;
    getDepositMethods()
      .then((codes) => {
        if (cancelled) return;
        const offered = DEPOSIT_METHODS.filter((option) =>
          codes.includes(option.code),
        );
        if (offered.length > 0) setMethods(offered);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  // A retract that lands while the sheet is open must not leave a now-invalid
  // code armed on the Pay button.
  useEffect(() => {
    if (!methods.some((option) => option.code === method)) setMethod(preferred);
  }, [methods, method, preferred]);

  async function submit() {
    if (submitting || !amountValid) return;
    setError(null);
    setSubmitting(true);
    try {
      if (USE_GATEWAY) {
        if (amount < GATEWAY_MIN_RM || amount > GATEWAY_MAX_RM) {
          setError(
            `Top-ups must be between ${rm0(GATEWAY_MIN_RM)} and ${rm0(GATEWAY_MAX_RM)}.`,
          );
          return;
        }
        const res = await startDeposit(amount, method);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        // Leave for the cashier page. Deliberately a full navigation, not a new
        // tab: popup blockers eat a window.open() that follows an await, and
        // the customer must land back on our return URL afterwards. Nothing was
        // credited — the balance updates when their callback settles.
        leaveFor(res.url);
        return;
      }

      attemptKey.current ??= crypto.randomUUID();
      const res = await topUpCredits(amount, attemptKey.current);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      attemptKey.current = null;
      setDone({
        amount: res.amount,
        balance: res.balance,
        replayed: res.replayed,
      });
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
      {/* Scrim: mouse-only close affordance, hidden from the a11y tree and tab
          order — the X button and Esc cover AT/keyboard (matches AuthModal). */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
        className="glass-stage absolute inset-0 h-full w-full cursor-default bg-black/40"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Top up credits"
        tabIndex={-1}
        className={cn(
          'glass-panel absolute inset-x-0 bottom-0 mx-auto w-full max-w-md rounded-t-2xl border-t p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] outline-none',
          'sm:inset-x-0 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2 sm:rounded-2xl sm:border',
          'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-safe:duration-200',
        )}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-heading text-xl text-white">TOP UP</h2>
          <div className="flex items-center gap-2">
            {/* Never in gateway mode: this sheet redirects to a real cashier
                and takes real money, so a "Demo" badge would be a lie on the
                one screen where it matters most. */}
            {!USE_GATEWAY && (
              <span className="rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-amber-300">
                Demo
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-11 w-11 items-center justify-center rounded-full bg-neutral-800 text-neutral-300 transition-colors hover:text-white"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>

        {done ? (
          <div className="mt-6 flex flex-col items-center text-center">
            <CheckCircle2 className="h-12 w-12 text-buyback-fg" aria-hidden />
            <p className="mt-3 font-heading text-2xl text-white">
              {rm(done.amount)} ADDED
            </p>
            <p className="mt-1 text-sm text-neutral-400">
              New balance{' '}
              <span className="font-semibold text-white">
                {rm(done.balance)}
              </span>
            </p>
            {done.replayed && (
              <p
                role="status"
                className="mt-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[13px] font-medium text-amber-300"
              >
                This top-up was already processed — no double charge.
              </p>
            )}
            <Pill onClick={onClose} size="lg" className="mt-6 w-full">
              Done
            </Pill>
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
                      'inline-flex h-11 items-center justify-center rounded-full px-4 text-[13px] font-semibold transition-colors',
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

            {/* Channel picker. Gateway only: the mock has no channels, and
                without this the customer always landed on whichever one
                GLOBEPAY_DEPOSIT_METHOD names (QR), with no way to pay by bank.
                Hidden at one channel — a "choice" of one is noise, and the
                single code still ships on submit.

                Native radios inside labels, not role="radio" buttons: the ARIA
                role advertises an arrow-key contract that hand-rolled buttons
                do not honour, and the input gives it for free along with
                grouped announcement from the fieldset legend. */}
            {USE_GATEWAY && methods.length > 1 && (
              <fieldset className="mt-3 grid grid-cols-2 gap-2">
                <legend className="sr-only">Payment method</legend>
                {methods.map((option) => {
                  const selected = option.code === method;
                  return (
                    <label
                      key={option.code}
                      className={cn(
                        'cursor-pointer rounded-xl border px-3 py-2.5 text-left transition-colors',
                        'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-white/60',
                        // Selected inverts to the solid light fill the amount
                        // presets above already use. A brighter border alone
                        // (the first cut) was too quiet to answer "which one am
                        // I paying with" at a glance — and this is the control
                        // that decides where the customer's money goes.
                        selected
                          ? 'border-transparent bg-neutral-50'
                          : 'border-white/10 bg-white/[0.03] hover:border-white/20',
                      )}
                    >
                      <input
                        type="radio"
                        name="deposit-method"
                        value={option.code}
                        checked={selected}
                        onChange={() => setMethod(option.code)}
                        className="sr-only"
                      />
                      <span
                        className={cn(
                          'block text-[13px] font-semibold',
                          selected ? 'text-neutral-950' : 'text-neutral-300',
                        )}
                      >
                        {option.label}
                      </span>
                      <span
                        className={cn(
                          'mt-0.5 block text-[11px] leading-snug',
                          selected ? 'text-neutral-600' : 'text-neutral-500',
                        )}
                      >
                        {option.hint}
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            )}

            <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm">
              <div className="flex items-center justify-between text-neutral-400">
                <span>Current balance</span>
                <span className="font-semibold text-neutral-200">
                  {balance == null ? '—' : rm(balance)}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between text-neutral-400">
                <span>You top up</span>
                <span className="font-semibold text-buyback-fg">
                  {amountValid ? `+ ${rm(amount)}` : '—'}
                </span>
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-white/10 pt-3">
                {/* On the gateway path the credit is NOT immediate — it lands
                    when the provider confirms the payment. Calling this "New
                    balance" would promise something the button cannot deliver. */}
                <span className="text-neutral-300">
                  {USE_GATEWAY ? 'Balance once paid' : 'New balance'}
                </span>
                <span className="font-heading text-lg text-white">
                  {balance != null && amountValid ? rm(balance + amount) : '—'}
                </span>
              </div>
            </div>

            {/* The remedy sits INSIDE role="alert" so a screen reader gets the
                problem and the way out in one utterance. PhoneGateAction closes
                the sheet on the way out — it lives in a global provider and
                would otherwise stay overlaid on /settings. */}
            {error && (
              <div
                role="alert"
                className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2"
              >
                <p className="text-[13px] font-medium text-red-300">{error}</p>
                <PhoneGateAction error={error} onNavigate={onClose} />
              </div>
            )}

            <Pill
              onClick={submit}
              disabled={submitting || !amountValid}
              size="lg"
              className="mt-4 w-full"
            >
              {submitting
                ? USE_GATEWAY
                  ? 'Taking you to payment…'
                  : 'Processing…'
                : amountValid
                  ? USE_GATEWAY
                    ? // Nothing is added here — the button leaves the site.
                      `Pay ${rm(amount)}`
                    : `Proceed — add ${rm(amount)}`
                  : 'Enter an amount'}
            </Pill>

            <p className="mt-3 text-[12px] leading-relaxed text-neutral-400">
              {USE_GATEWAY
                ? 'You’ll finish paying on GlobePay365, then come back here. Credits appear once your payment is confirmed — usually within a minute.'
                : 'Demo checkout: only the amount leaves your browser. Amounts ending in .13 are declined on purpose so you can see the error path.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
