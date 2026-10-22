'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, ChevronRight, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rm, rm0 } from '@/lib/format';
import {
  getDepositMethods,
  getPaymentLimits,
  getRegionalPayer,
  startDeposit,
  topUpCredits,
} from '@/lib/actions/vault';
import {
  DEFAULT_PAYMENT_LIMITS,
  regionalCredit,
  type PaymentLimits,
} from '@/lib/payment-limits';
import { openRails, regionalRailUi } from '@/lib/regional-rails';
import { leaveFor } from '@/lib/navigation';
import { markDepositInFlight } from '@/lib/deposit-return';
import { trackPixel } from '@/lib/pixel';
import { CountryFlag, type FlagCountry } from '@/components/ui/country-flag';
import { Pill } from '@/components/ui/pill';
import { PhoneGateAction } from '@/components/account/PhoneGateAction';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { useLiquidGlass, GLASS_SUBTLE } from '@/lib/use-liquid-glass';
import {
  DEPOSIT_METHODS,
  DEFAULT_DEPOSIT_METHOD,
  type DepositMethod,
} from '@/lib/deposit-methods';

// Does a real gateway back the sheet? Any value except 'mock' (or unset)
// sends the customer to the provider's checkout page and credits nothing here
// — the balance updates later, when the gateway's callback settles the
// deposit. WHICH gateway is the backend's decision (admin switch, plan 130):
// the storefront never needs to know, since every real gateway is a redirect.
// 'mock' / unset keeps the mock gateway, which credits synchronously and stays
// the local/dev path. Any other value ('tgpay') means the real gateway.
// An EMPTY value counts as unset (a blank build arg must not send customers
// to a gateway the deploy never chose).
const PROVIDER = process.env.NEXT_PUBLIC_PAYMENTS_PROVIDER || 'mock';
const USE_GATEWAY = PROVIDER !== 'mock';

// The gateway's band is narrower than the mock's on both ends, and it rejects
// anything outside it with a generic "Invalid Transaction Amount" that names no
// numbers. Catch it in the sheet so the customer gets a message they can act on.
// The band (and whether deposits are even open) belongs to whichever gateway
// the admin has active, so it is fetched per open (getPaymentLimits);
// DEFAULT_PAYMENT_LIMITS is only the until-it-answers value, which sits
// inside every gateway's band and never closes a channel.

// The mock's 10/25 rungs are below the gateway's floor, so offering them would
// guarantee a rejection on the real path. The gateway rungs span the production
// band rather than hugging its floor — 5,000 is a real ticket
// size now that the ceiling is 10,000, and it was impossible under the test
// account's RM 1,000 cap.
const PRESETS = USE_GATEWAY ? [300, 600, 1200, 5000] : [10, 25, 50, 100];
const DEFAULT_AMOUNT = USE_GATEWAY ? '300' : '25';

// A regional rail (Singapore via A3Pay): the customer pays in that currency
// and is credited RM at the rate the backend quotes (market rate minus our
// markup). Its rungs, channels and labels live in lib/regional-rails.ts.
/** 'MYR', or a regional rail's currency code. */
type Currency = string;

/**
 * One row of the "Choose a currency" step. The list is built from what the
 * backend reports open (getPaymentLimits) and what lib/regional-rails.ts
 * knows how to present, so a new rail (USDT next) needs no change here.
 */
type CurrencyOption = {
  code: Currency;
  /** Shown after the name and in front of amounts. */
  symbol: string;
  /** The badge: which country's banks pay in this currency. */
  flag: FlagCountry;
  name: string;
  hint: string;
  /** Listed but not choosable (the RM gateway is paused). */
  disabled?: boolean;
};

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
  // A rail code: an RM channel, or a regional rail's own (UTRC, …).
  const [method, setMethod] = useState<string>(preferred);
  // null = the "Choose a currency" step. Gateway mode always starts there;
  // the demo (mock) path has RM only and goes straight to the form.
  const [currency, setCurrency] = useState<Currency | null>(
    USE_GATEWAY ? null : 'MYR',
  );
  // The paying account's name (A3Pay rails): what the sheet will send, the
  // lookup it was pre-filled from, and whether the customer opened it to edit.
  const [payerName, setPayerName] = useState('');
  const [payer, setPayer] = useState<{
    currency: string;
    savedName: string | null;
    realName: string | null;
  } | null>(null);
  const [editingName, setEditingName] = useState(false);
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

  // Focus-in, Tab trap, Escape, scroll lock + focus restore on close.
  useModalA11y(panelRef, open, onClose);

  // Liquid-glass rim on the sheet panel (frosted fallback on Safari/Firefox).
  useLiquidGlass(panelRef, open, GLASS_SUBTLE);

  // Reset transient state each time the sheet opens. `preferred` is deliberately
  // NOT a dependency: it changes when the channel list arrives below, and
  // re-running then would wipe a selection the customer had already made.
  useEffect(() => {
    if (open) {
      // Deposit sheet: every open starts a fresh attempt, together with the
      // idempotency-key reset just below.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- per-open reset of the deposit attempt
      setError(null);
      setDone(null);
      setSubmitting(false);
      setMethod(preferred);
      setCurrency(USE_GATEWAY ? null : 'MYR');
      setPayerName('');
      setPayer(null);
      setEditingName(false);
      attemptKey.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Ask the server which channels are on offer, per open. Gateway path only —
  // the mock has no channels — and failure keeps the compiled list, since the
  // action re-checks the code anyway and a refused channel shows its own error.
  const [limits, setLimits] = useState<PaymentLimits>(DEFAULT_PAYMENT_LIMITS);
  // The regional rails the backend has open AND priced (gateway path only),
  // and the one being paid through, if any. Undefined = paying in RM.
  const rails = USE_GATEWAY ? openRails(limits.regional, 'deposit') : [];
  const rail = rails.find((option) => option.currency === currency);
  const money = rail ? rail.ui.money : rm;
  const money0 = rail ? rail.ui.money0 : rm0;
  const minAmount = rail
    ? Math.max(0.01, rail.deposit.min ?? 0.01)
    : USE_GATEWAY
      ? Math.max(0.01, limits.deposit.minRm)
      : 0.01;
  const maxAmount = rail
    ? (rail.deposit.max ?? 10_000)
    : USE_GATEWAY
      ? limits.deposit.maxRm
      : 10_000;
  // The channel itself, not the band — the admin can close deposits outright
  // while a gateway stays configured (getPaymentLimits, plan 135).
  const depositsClosed = USE_GATEWAY && !rail && !limits.depositsEnabled;
  const amount = Number(amountText.trim());
  const amountValid =
    /^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(amountText.trim()) &&
    Number.isFinite(amount) &&
    amount >= minAmount &&
    amount <= maxAmount;
  // A valid amount into a closed channel still cannot be paid — fold the
  // channel into the same "can this actually be submitted" signal the button
  // and its label already key off, rather than adding a second disabled path.
  // What lands on the balance: the amount itself in RM, or the quoted RM
  // credit for a regional payment (floored to the cent, as the backend
  // quotes it).
  const credit =
    rail && amountValid ? regionalCredit(amount, rail.rate.deposit) : amount;
  // A rail that matches the transfer against the payer's account name
  // (A3Pay) always sends one: a saved account's holder, shown with "Change"
  // because the customer may pay from another account, or — none saved —
  // a field pre-filled with the real name. The pay button waits for the
  // lookup rather than send no name.
  const askFor = rail?.ui.needsPayerName ? rail.currency : null;
  useEffect(() => {
    if (!askFor) return;
    let live = true;
    const settle = (answer: {
      savedName: string | null;
      realName: string | null;
    }) => {
      if (!live) return;
      setPayer({ currency: askFor, ...answer });
      setPayerName(
        (typed) => typed || answer.savedName || answer.realName || '',
      );
    };
    // A failed lookup reads as nothing saved: the field shows, never a stuck
    // button.
    getRegionalPayer(askFor).then(settle, () =>
      settle({ savedName: null, realName: null }),
    );
    return () => {
      live = false;
    };
  }, [askFor]);
  const payerInfo = askFor && payer?.currency === askFor ? payer : null;
  const payerLoading = askFor !== null && payerInfo === null;
  const nameField = payerInfo !== null && (!payerInfo.savedName || editingName);
  const payerValid =
    !askFor || (payerName.trim().length >= 2 && payerName.trim().length <= 120);
  const canPay = amountValid && !depositsClosed && !payerLoading && payerValid;
  const shownMethods = rail ? rail.ui.methods : methods;
  const presets = rail ? rail.ui.presets : PRESETS;

  // Step 1's rows: RM always — marked paused, not hidden, when the admin has
  // closed RM top-ups, so the customer is told rather than left wondering —
  // then every open regional rail, then any closed one the backend still
  // reports, paused for the same reason.
  const rmPaused = USE_GATEWAY && !limits.depositsEnabled;
  const currencyOptions: CurrencyOption[] = [
    {
      code: 'MYR',
      symbol: 'RM',
      flag: 'MY',
      name: 'Malaysian Ringgit',
      hint: rmPaused
        ? 'Paused right now — your balance and cards are unaffected'
        : 'Online banking (FPX) · QR / e-wallet',
      disabled: rmPaused,
    },
    ...rails.map((option) => ({
      code: option.currency,
      symbol: option.ui.symbol,
      flag: option.ui.flag,
      name: option.ui.name,
      hint: `${option.ui.hint} · ${option.ui.unit} = RM ${option.rate.deposit.toFixed(4)}`,
    })),
    ...(USE_GATEWAY ? (limits.regional ?? []) : []).flatMap((closed) => {
      const ui = regionalRailUi(closed.currency);
      return ui && !rails.some((open) => open.currency === closed.currency)
        ? [
            {
              code: closed.currency,
              symbol: ui.symbol,
              flag: ui.flag,
              name: ui.name,
              hint: 'Paused right now — your balance and cards are unaffected',
              disabled: true,
            },
          ]
        : [];
    }),
  ];
  // The picker shows until a currency is chosen — and again if the chosen
  // rail closes while the sheet is open (its form would have nothing to pay).
  const picking = currency === null || (currency !== 'MYR' && !rail);
  const chosen = currencyOptions.find((option) => option.code === currency);

  // Choosing resets the amount to that currency's default rung — "300" means
  // something very different in RM and in S$ — and moves focus into the form,
  // so keyboard and screen-reader users are not left on a removed button.
  const amountRef = useRef<HTMLInputElement>(null);
  const chooseCurrency = (next: Currency) => {
    if (next !== currency) {
      setAmountText(regionalRailUi(next)?.defaultAmount ?? DEFAULT_AMOUNT);
    }
    setCurrency(next);
    setError(null);
    requestAnimationFrame(() => amountRef.current?.focus());
  };

  useEffect(() => {
    if (!open || !USE_GATEWAY) return;
    let cancelled = false;
    // Back to the safe defaults on every open: the admin may have switched
    // gateways since the last one, and a band (or a closed channel) the
    // previous gateway answered with must not judge this open before the
    // fresh answer lands.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- safe defaults until this open's fetch answers
    setLimits(DEFAULT_PAYMENT_LIMITS);
    getPaymentLimits()
      .then((l) => {
        if (!cancelled) setLimits(l);
      })
      .catch(() => {});
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
    if (shownMethods.some((option) => option.code === method)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- disarm a channel the server just retracted
    setMethod(shownMethods[0]?.code ?? preferred);
  }, [shownMethods, method, preferred]);

  async function submit() {
    if (submitting || !canPay) return;
    setError(null);
    setSubmitting(true);
    // Set once we hand the page to the cashier: navigation does not block,
    // so re-enabling Pay meanwhile let a second tap open a second deposit.
    let leaving = false;
    // Ads funnel (lib/pixel.ts): the customer has started a top-up. Sent
    // before the checkout call so the beacon is out before the cashier
    // redirect takes the page away.
    trackPixel('InitiateCheckout', {
      value: amount,
      currency: rail ? rail.currency : 'MYR',
    });
    try {
      if (USE_GATEWAY) {
        // The rate shown goes with the request: the backend refuses one
        // that has moved since (an admin edited the markup), rather than
        // crediting at a rate the customer never saw.
        const res = rail
          ? await startDeposit(amount, method, {
              currency: rail.currency,
              quotedRate: rail.rate.deposit,
              ...(askFor ? { payerName } : {}),
            })
          : await startDeposit(amount, method);
        if (!res.ok) {
          setError(res.error);
          // A regional refusal may be that rate change: re-read the rails so
          // the sheet shows today's rate before the customer retries.
          // An unreachable backend answers the defaults, which carry no
          // rails: keep what the sheet has rather than drop the S$ form.
          if (rail) {
            getPaymentLimits()
              .then((fresh) => {
                if (fresh.gateway !== DEFAULT_PAYMENT_LIMITS.gateway) {
                  setLimits(fresh);
                }
              })
              .catch(() => {});
          }
          return;
        }
        // Leave for the cashier page. Deliberately a full navigation, not a new
        // tab: popup blockers eat a window.open() that follows an await, and
        // the customer must land back on our return URL afterwards. Nothing was
        // credited — the balance updates when their callback settles.
        //
        // The flag is the only thing that survives the round trip: it tells the
        // return page to keep re-reading for a bit, because crediting happens on
        // the backend sweep and can land after they are already back.
        markDepositInFlight();
        leaving = true;
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
      if (!leaving) setSubmitting(false);
    }
  }

  // Back from the cashier to a page restored from the browser's cache: the
  // sheet is as it was left, Pay included, so let it be pressed again.
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) setSubmitting(false);
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

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
            <p className="mt-1 text-sm text-neutral-300">
              After a top-up, withdrawals pause until you use all your money for
              packs.
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
        ) : picking ? (
          <div className="mt-4" data-testid="topup-currency">
            <p className="text-[13px] font-semibold text-neutral-400">
              Choose a currency
            </p>
            {/* Plain buttons, not radios: choosing moves to the next step
                rather than marking a selection on this one. */}
            <ul className="mt-3 flex flex-col gap-2">
              {currencyOptions.map((option) => (
                <li key={option.code}>
                  <button
                    type="button"
                    onClick={() => chooseCurrency(option.code)}
                    disabled={option.disabled}
                    className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3.5 text-left transition-colors hover:border-white/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-white/10"
                  >
                    <CountryFlag
                      country={option.flag}
                      className="h-[27px] w-10"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-semibold text-white">
                        {option.name}{' '}
                        <span className="font-normal text-neutral-400">
                          ({option.symbol})
                        </span>
                      </span>
                      <span className="mt-0.5 block text-[12px] leading-snug text-neutral-400">
                        {option.hint}
                      </span>
                    </span>
                    <ChevronRight
                      className="h-4 w-4 shrink-0 text-neutral-500"
                      aria-hidden
                    />
                  </button>
                </li>
              ))}
            </ul>
            {/* A refusal that closed the chosen rail lands the customer back
                here; its reason must come with them. */}
            {error && (
              <p
                role="alert"
                className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] font-medium text-red-300"
              >
                {error}
              </p>
            )}
            <p className="mt-3 text-[12px] leading-relaxed text-neutral-400">
              Your balance is always kept in RM — other currencies are converted
              when you pay.
            </p>
          </div>
        ) : (
          <>
            {/* The chosen currency, and the way back to the list. Hidden in
                demo mode, which has RM only and no list to go back to. */}
            {USE_GATEWAY && chosen && (
              <div className="mt-4 flex items-center justify-between rounded-xl bg-neutral-800/60 px-3 py-2">
                <span className="flex items-center gap-1.5 text-[13px] text-neutral-400">
                  Paying in
                  <CountryFlag country={chosen.flag} className="h-3 w-[18px]" />
                  <span className="font-semibold text-white">
                    {chosen.name} ({chosen.symbol})
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setCurrency(null);
                    setError(null);
                  }}
                  className="inline-flex h-9 items-center gap-1 rounded-full px-3 text-[13px] font-semibold text-neutral-300 transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/60"
                >
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
                  Change
                </button>
              </div>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              {presets.map((preset) => {
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
                    {money0(preset)}
                  </button>
                );
              })}
            </div>

            <label className="mt-3 flex items-center gap-2 rounded-xl bg-neutral-800 px-4 py-3">
              <span className="text-sm font-semibold text-neutral-400">
                {rail ? rail.ui.symbol : 'RM'}
              </span>
              <input
                ref={amountRef}
                type="text"
                inputMode="decimal"
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
                disabled={depositsClosed}
                aria-label={`Top-up amount in ${rail ? rail.ui.symbol : 'RM'}`}
                aria-describedby="topup-amount-guidance"
                aria-invalid={amountText.trim().length > 0 && !amountValid}
                className="font-heading w-full bg-transparent text-2xl text-white outline-none placeholder:text-neutral-600 disabled:opacity-50"
                placeholder="0.00"
              />
            </label>
            <p
              id="topup-amount-guidance"
              className={cn(
                'mt-2 text-[12px] leading-relaxed',
                !depositsClosed && amountText.trim().length > 0 && !amountValid
                  ? 'text-red-300'
                  : 'text-neutral-400',
              )}
            >
              {depositsClosed
                ? 'Top-ups are paused right now. Your balance and cards are unaffected.'
                : `Enter ${money(minAmount)}–${money(maxAmount)}, with up to 2 decimal places.`}
            </p>

            {/* The name A3Pay matches against the incoming transfer: it
                must be the name on the PAYING bank account, which a nickname
                is not. A saved account's holder shows as a line with Change
                (the customer may pay from another account); with none saved,
                a field pre-filled with the real name. */}
            {payerInfo !== null && !nameField && (
              <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-neutral-800/60 px-4 py-3">
                <div className="min-w-0">
                  <span className="block text-[12px] font-semibold text-neutral-400">
                    Paying from the account of
                  </span>
                  <span className="block truncate text-[15px] text-white">
                    {payerName}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setEditingName(true)}
                  aria-label="Change the name on the paying account"
                  className="shrink-0 rounded-lg px-2 py-1 text-[13px] font-semibold text-neutral-300 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/60"
                >
                  Change
                </button>
              </div>
            )}
            {nameField && (
              <label className="mt-3 block">
                <span className="text-[12px] font-semibold text-neutral-400">
                  Name on your bank account
                </span>
                <input
                  type="text"
                  autoComplete="name"
                  value={payerName}
                  onChange={(e) => setPayerName(e.target.value)}
                  maxLength={120}
                  aria-invalid={payerName.trim().length > 0 && !payerValid}
                  className="mt-1 w-full rounded-xl bg-neutral-800 px-4 py-3 text-[15px] text-white outline-none placeholder:text-neutral-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/60"
                  placeholder="As it appears at your bank"
                />
                <span className="mt-1 block text-[11px] leading-snug text-neutral-500">
                  Exactly as your bank shows it, or the payment can&apos;t be
                  matched.
                  {payerInfo?.savedName
                    ? null
                    : ' Save your bank account under Bank accounts to skip this next time.'}
                </span>
              </label>
            )}

            {/* Channel picker. Gateway only: the mock has no channels, and
                without this the customer always landed on whichever one
                default rail (QR), with no way to pay by bank.
                Hidden at one channel — a "choice" of one is noise, and the
                single code still ships on submit.

                Native radios inside labels, not role="radio" buttons: the ARIA
                role advertises an arrow-key contract that hand-rolled buttons
                do not honour, and the input gives it for free along with
                grouped announcement from the fieldset legend. */}
            {USE_GATEWAY && shownMethods.length > 1 && (
              <fieldset className="mt-3 grid grid-cols-2 gap-2">
                <legend className="sr-only">Payment method</legend>
                {shownMethods.map((option) => {
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
                <span>Balance</span>
                <span className="font-semibold text-neutral-200">
                  {balance == null ? '—' : rm(balance)}
                </span>
              </div>
              {rail && (
                <div className="mt-2 flex items-center justify-between text-neutral-400">
                  <span>You pay</span>
                  <span className="font-semibold text-neutral-200">
                    {amountValid ? money(amount) : '—'}
                  </span>
                </div>
              )}
              <div className="mt-2 flex items-center justify-between text-neutral-400">
                <span>{rail ? 'You get' : 'You top up'}</span>
                <span
                  className="font-semibold text-buyback-fg"
                  data-testid="topup-credit"
                >
                  {amountValid ? `+ ${rm(credit)}` : '—'}
                </span>
              </div>
              {rail && (
                <p className="mt-1 text-right text-[11px] text-neutral-500">
                  {rail.ui.unit} = RM {rail.rate.deposit.toFixed(4)}
                </p>
              )}
              {/* The A3Pay platform matches a transfer ONLY by its exact
                  amount, and may ask for a few cents more than this to keep
                  it unique. */}
              {rail && (
                <p className="mt-2 text-[12px] leading-snug text-neutral-300">
                  {rail.ui.exactAmountNote}
                </p>
              )}
              <div className="mt-3 flex items-center justify-between border-t border-white/10 pt-3">
                {/* On the gateway path the credit is NOT immediate — it lands
                    when the provider confirms the payment. Calling this "New
                    balance" would promise something the button cannot deliver. */}
                <span className="text-neutral-300">
                  {USE_GATEWAY ? 'Balance once paid' : 'New balance'}
                </span>
                <span className="font-heading text-lg text-white">
                  {balance != null && amountValid ? rm(balance + credit) : '—'}
                </span>
              </div>
            </div>

            <p className="mt-3 text-[12px] leading-relaxed text-neutral-300">
              After a top-up, withdrawals pause until you use all your money for
              packs.
            </p>

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
              disabled={submitting || !canPay}
              size="lg"
              className="mt-4 w-full"
            >
              {submitting
                ? USE_GATEWAY
                  ? 'Taking you to payment…'
                  : 'Processing…'
                : canPay
                  ? USE_GATEWAY
                    ? // Nothing is added here — the button leaves the site.
                      `Pay ${money(amount)}`
                    : `Proceed — add ${rm(amount)}`
                  : amountValid && payerLoading
                    ? 'Checking…'
                    : amountValid && !payerValid
                      ? 'Enter the account name'
                      : 'Enter a valid amount'}
            </Pill>

            <p className="mt-3 text-[12px] leading-relaxed text-neutral-400">
              {USE_GATEWAY
                ? 'You’ll finish paying on our payment provider’s page, then come back here. Credits appear once your payment is confirmed — usually within a minute.'
                : 'Demo checkout: only the amount leaves your browser. Amounts ending in .13 are declined on purpose so you can see the error path.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
