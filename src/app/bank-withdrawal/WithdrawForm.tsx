'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, ChevronDown, Clock, Landmark, Lock } from 'lucide-react';
import { rm, rm0, timeUntil } from '@/lib/format';
import { openRails, regionalRailUi } from '@/lib/regional-rails';
import { isWithdrawLocked, walletSplit } from '@/lib/wallet-split';
import {
  MoneyRows,
  WithdrawRules,
  WithdrawSteps,
} from '@/components/account/WithdrawSteps';
import {
  fetchSavedBankAccounts,
  getPaymentLimits,
  startWithdrawal,
  type SavedBankAccount,
} from '@/lib/actions/vault';
import {
  DEFAULT_PAYMENT_LIMITS,
  regionalPayout,
  type PaymentLimits,
} from '@/lib/payment-limits';
import { useTopUp } from '@/components/app-shell/TopUpProvider';
import { Pill, pillVariants } from '@/components/ui/pill';
import { PhoneGateAction } from '@/components/account/PhoneGateAction';
import { cn } from '@/lib/utils';
import { reopenLabel } from '@/lib/reopen-time';

// The payout band (and whether withdrawals are even open) belongs to
// whichever gateway the admin has active (TGPay caps at RM 30,000; another
// gateway may differ), so it is read from the backend when the form mounts;
// DEFAULT_PAYMENT_LIMITS is only the until-it-answers value. NOT the same
// band as deposits — the payout floor is higher. The gateway's own rejection
// names no numbers, so the form does.

/** Can this destination receive money right now? The server's `usableFrom` is
 *  the only input — the cooling-off duration is never duplicated here, so
 *  retuning it on the backend moves this UI with it. Absent/null means "not
 *  without re-saving", which is also the safe reading of a backend that has not
 *  shipped the field. */
const isUsable = (account: SavedBankAccount, now: Date) =>
  account.supported !== false &&
  typeof account.usableFrom === 'string' &&
  new Date(account.usableFrom).getTime() <= now.getTime();

/** Why a destination cannot be picked yet, in the customer's terms. */
function unusableReason(account: SavedBankAccount, now: Date): string | null {
  if (account.supported === false) {
    return (
      account.unavailableReason ??
      'not available with the current payout provider'
    );
  }
  if (typeof account.usableFrom !== 'string') {
    return 'save it again to use it';
  }
  const wait = timeUntil(account.usableFrom, now);
  return wait ? `available ${wait}` : null;
}

/** Digits (commas allowed as thousands separators), at most one dot and two
 *  decimals. Anything else never reaches state — typed or pasted. */
const AMOUNT_PATTERN = /^[\d,]*(\.\d{0,2})?$/;

/** The amount field's next text, or `prev` when `next` is not an amount at
 *  all. A figure above `withdrawable` snaps down to it (floored to sen), so the
 *  field can never show more than the customer may take out. UX only: the
 *  backend's locked wallet gate is the enforcement, and a null `withdrawable`
 *  (wallet failed to load) leaves the field uncapped for it to judge. */
export function nextAmountText(
  prev: string,
  next: string,
  withdrawable: number | null,
): string {
  if (!AMOUNT_PATTERN.test(next)) return prev;
  if (withdrawable == null) return next;
  // The epsilon keeps 0.29 * 100 (28.999…) from flooring a whole sen away.
  const cap = Math.floor(Math.max(withdrawable, 0) * 100 + 1e-6) / 100;
  return Number(next.replace(/,/g, '')) > cap ? cap.toFixed(2) : next;
}

/** How much more `withdrawable` needs to reach the payout floor, in whole sen
 *  (50 − 49.71 is 0.29, not 0.2900000000000027). Never below 0. */
export function minimumGap(minRm: number, withdrawable: number): number {
  return (
    Math.max(0, Math.round(minRm * 100) - Math.round(withdrawable * 100)) / 100
  );
}

/** Backend refusal → the screen that fixes it. Matches the backend's own
 *  wording, which reaches this form verbatim through lib/vault-errors.ts's
 *  withdrawal pass-through rule. Refusals that already say what to do (the
 *  cap, the daily limit, a paused channel) get no link. The phone gate has
 *  its own PhoneGateAction. */
const REMEDIES: [RegExp, string | null, string][] = [
  // First: the no-top-up refusal also talks about "money for packs", and it
  // is the top-up that fixes it. null = open the top-up sheet in place.
  [/top up at least once/i, null, 'Top up'],
  // The locked refusal (spend first, 2026-10-15): "Withdrawals unlock once
  // you've used RM X more on packs. …"
  [/withdrawals unlock once/i, '/slots', 'Open packs'],
  // shortcut: older backend texts ("… is for opening packs.", "… more on
  // packs"), kept for a storefront-first deploy; drop once both are live.
  [/is for opening packs/i, '/slots', 'Open packs'],
  [/more on packs/i, '/slots', 'Open packs'],
  [/under review/i, '/contact', 'Contact support'],
  [/add an email address/i, '/settings', 'Add an email address'],
  [
    // NOT "bank details": the paused-payouts refusal says "Your bank details
    // are fine", and linking it to /bank would contradict it.
    /bank account|account number|account holder name|choose a bank/i,
    '/bank',
    'Manage bank accounts',
  ],
];

export function withdrawRemedy(
  error: string,
): { href: string | null; label: string } | null {
  const hit = REMEDIES.find(([test]) => test.test(error));
  return hit ? { href: hit[1], label: hit[2] } : null;
}

function WithdrawRemedy({ error }: { error: string }) {
  const { openTopUp } = useTopUp();
  const remedy = withdrawRemedy(error);
  if (!remedy) return null;
  // secondary, for the reason PhoneGateAction gives: it sits right above the
  // white full-width Withdraw button.
  const className = cn(
    pillVariants({ variant: 'secondary', size: 'sm' }),
    'mt-2 w-full',
  );
  return remedy.href === null ? (
    <button type="button" onClick={openTopUp} className={className}>
      {remedy.label}
    </button>
  ) : (
    <Link href={remedy.href} className={className}>
      {remedy.label}
    </Link>
  );
}

/**
 * Bank-withdrawal form. The balance is debited the moment the request is
 * accepted — the success state says "on its way", never "paid", because the
 * bank transfer completes asynchronously and a failed payout refunds the
 * debit automatically.
 *
 * Payouts go to a SAVED account and nothing else: this form submits an account
 * id, and the server resolves the bank details from the customer's own list. A
 * newly added destination waits out a cooling-off window first, so adding one
 * lives on /bank rather than here — a form that let you type a destination and
 * pay it in the same breath is exactly what that window exists to prevent.
 * Accounts still cooling off are shown DISABLED with their timing, never
 * hidden: a saved account that vanished from the picker reads as a bug.
 */
export default function WithdrawForm({
  withdrawable,
  available = null,
  frozen = false,
  noTopup = false,
  bonus = 0,
  remaining = 0,
}: {
  /** The server's freeze/locked/playthrough-gated figure — NOT raw balance. */
  withdrawable: number | null;
  /** The wallet's `available` (0 while frozen). What of it is not
   *  withdrawable is the "For packs" part, named so the gap is no mystery. */
  available?: number | null;
  /** The account is frozen for review — outranks every other hold. */
  frozen?: boolean;
  /** The account has never topped up, so nothing may leave (2026-10-11). */
  noTopup?: boolean;
  /** Spend-only bonus credit inside the balance, already left out of
   *  `withdrawable` — the first line of the For-packs part. */
  bonus?: number;
  /** playthrough.remaining — what is still to use on packs. While any is
   *  left, the backend shuts the whole gate (spend first, 2026-10-15). */
  remaining?: number;
}) {
  const needsTopup = !frozen && noTopup;
  // The wallet page's split, so both pages agree.
  const split =
    !frozen && withdrawable != null && available != null
      ? walletSplit({ available, withdrawable, bonus, remaining })
      : null;
  // Topped up, but money is still to use on packs: nothing may leave yet.
  const locked =
    withdrawable != null &&
    isWithdrawLocked({
      hasTopup: !noTopup,
      isFrozen: frozen,
      remaining,
      withdrawable,
    });
  // Can't withdraw yet: the steps replace the form.
  const cantYet = needsTopup || locked;
  // Any hold means no amount can pass the server's gate, so the form says
  // why up front and does not invite an attempt that is certain to fail.
  const onHold = frozen || needsTopup || locked;
  // The payout debits the balance server-side; repaint it here so the header
  // chip is not stale. (This used to light the Me-tab money dot too — that dot
  // was suspended 2026-08-11; see components/account/credit-dot.tsx.)
  const { applyBalance } = useTopUp();
  const [saved, setSaved] = useState<SavedBankAccount[] | null>(null);
  const [accountId, setAccountId] = useState('');
  const [amountText, setAmountText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{
    amount: number;
    balance: number;
    reference: string;
    status: 'pending' | 'held';
    payout?: { currency: string; amount: number };
  } | null>(null);
  // One idempotency key per withdrawal ATTEMPT: minted lazily on submit,
  // REUSED on error retries (so a debited-but-response-lost attempt replays
  // instead of double-debiting AND double-transferring — see the doc comment
  // on startWithdrawal), and rotated only after a confirmed success so the
  // next withdrawal starts a fresh attempt. Mirrors TopUpSheet's attemptKey.
  const attemptKey = useRef<string | null>(null);

  const [limits, setLimits] = useState<PaymentLimits>(DEFAULT_PAYMENT_LIMITS);
  // Regional payout rails (Singapore via A3Pay), open and priced. An account
  // in a regional currency is paid through its rail in that currency; every
  // other account through the active gateway in RM.
  const rails = openRails(limits.regional, 'withdrawal');
  const selectedAccount = saved?.find((a) => a.id === accountId);
  const toRegional =
    selectedAccount?.currency !== undefined &&
    selectedAccount.currency !== 'MYR';
  const rail = toRegional
    ? rails.find((option) => option.currency === selectedAccount.currency)
    : undefined;
  // The RM band THIS payout is judged by: the rail's own (its RM band
  // narrowed to what pays inside its S$ band) for a regional account, else
  // the active gateway's. At 3.2017, S$30 needs RM 96.05, not RM 50.
  const payoutBand = rail?.withdrawalRm ?? limits.withdrawal;
  // The channel itself, not the band — the admin can close withdrawals
  // outright while a gateway stays configured (getPaymentLimits, plan 135).
  // Judged against the rail that would pay the chosen account; before one is
  // chosen, open if any rail is.
  const withdrawalsClosed = toRegional
    ? !rail
    : !limits.withdrawalsEnabled &&
      (selectedAccount !== undefined || rails.length === 0);
  // A timed pause or the admin's switch / daily hours names when to come
  // back, in Malaysia time.
  const resumeAt = limits.withdrawalsPausedUntil
    ? reopenLabel(limits.withdrawalsPausedUntil)
    : null;
  // Gate open but less than the payout floor: no amount can pass the band, and
  // nextAmountText would snap every attempt down below it — say so instead.
  // The floor is the rail's (S$ rail: RM 96.05 at 3.2017), as shown on top.
  const belowMin =
    !onHold && withdrawable != null && withdrawable < payoutBand.minRm;
  const blocked = onHold || belowMin;
  const guidanceId = withdrawalsClosed
    ? 'withdraw-amount-guidance'
    : blocked
      ? 'withdraw-hold-reason'
      : undefined;
  useEffect(() => {
    let cancelled = false;
    getPaymentLimits()
      .then((l) => {
        if (!cancelled) setLimits(l);
      })
      .catch(() => {});
    fetchSavedBankAccounts().then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        // `saved` deliberately stays null. Setting it to [] would render the
        // "No saved bank accounts yet" empty state below, so a network error or
        // an expired session would tell the customer their saved accounts do
        // not exist and invite them to re-add one. The error banner is the
        // honest answer to a failed load; the empty state is reserved for a
        // list we actually read.
        setError(res.error);
        return;
      }
      setSaved(res.accounts);
      // Exactly one usable destination is the common case — preselect it.
      const usable = res.accounts.filter((a) => isUsable(a, new Date()));
      const only = usable.length === 1 ? usable[0] : undefined;
      if (only) setAccountId((cur) => cur || only.id);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Recomputed per render rather than stored: a page left open long enough for
  // an account to finish cooling off re-reads it on the next interaction.
  const now = new Date();
  const accounts = saved ?? [];
  const usableAccounts = accounts.filter((a) => isUsable(a, now));

  // nextAmountText already limited the text to digits, commas and two
  // decimals, so stripping the commas leaves a plain number (or "." -> NaN).
  const amount = Number(amountText.replace(/,/g, ''));
  const amountValid = Number.isFinite(amount) && amount > 0;
  const selected = usableAccounts.find((a) => a.id === accountId);
  const formValid = amountValid && selected !== undefined;
  // A destination can carry its own floor above the gateway's (Touch 'n Go:
  // RM 100 — smaller TNG payouts are refused by the gateway). The backend
  // enforces the same figure; this states it before the customer taps.
  const accountMin =
    selected?.minRm != null && selected.minRm > payoutBand.minRm
      ? selected.minRm
      : null;
  const minRm = accountMin ?? payoutBand.minRm;
  // What a regional bank receives for this RM amount, at today's payout rate
  // (floored to the cent, exactly as the backend quotes and locks it).
  const payoutRegional =
    rail && amountValid ? regionalPayout(amount, rail.rate.payout) : null;

  async function submit() {
    if (submitting || !formValid || withdrawalsClosed || blocked) return;
    setError(null);
    if (amount < minRm || amount > payoutBand.maxRm) {
      // A rail's floor is a converted figure (RM 96.05): show its cents.
      const floor = Number.isInteger(minRm) ? rm0(minRm) : rm(minRm);
      setError(
        accountMin === null && rail?.withdrawalRm
          ? `${rail.ui.payoutNoun} must be between ${floor} and ${rm0(payoutBand.maxRm)} today.`
          : `Withdrawals must be between ${floor} and ${rm0(payoutBand.maxRm)}${accountMin !== null ? ` for ${selected?.bankName}` : ''}.`,
      );
      return;
    }
    const band = rail?.withdrawal;
    if (
      rail &&
      payoutRegional !== null &&
      band &&
      ((band.min !== null && payoutRegional < band.min) ||
        (band.max !== null && payoutRegional > band.max))
    ) {
      setError(
        `${rail.ui.payoutNoun} must come to between ${rail.ui.money(band.min ?? 0)} and ${rail.ui.money(band.max ?? 0)} (${rm(amount)} is ${rail.ui.money(payoutRegional)}).`,
      );
      return;
    }
    if (withdrawable != null && amount > withdrawable) {
      // The backend's own cap wording (withdrawalGateError), so the figure the
      // customer may take out is named instead of a bare "too much".
      setError(`You can withdraw up to ${rm(withdrawable)} right now.`);
      return;
    }
    setSubmitting(true);
    try {
      attemptKey.current ??= crypto.randomUUID();
      const res = await startWithdrawal({
        amount,
        accountId,
        idempotencyKey: attemptKey.current,
        // The rate shown: the backend refuses one that has moved since,
        // before any debit, instead of paying out at a rate never seen.
        quotedRate: rail?.rate.payout,
      });
      if (!res.ok) {
        // Key stays armed on purpose — a retry of THIS attempt must replay,
        // not double-debit and double-transfer.
        setError(res.error);
        // A regional refusal may be that rate change: re-read the rails so
        // the estimate shows today's rate before the customer retries.
        if (rail) {
          getPaymentLimits()
            .then(setLimits)
            .catch(() => {});
        }
        return;
      }
      attemptKey.current = null;
      // The payout already debited server-side; repaint the header chip now so
      // it is not stale. Adding a destination lives on /bank since Plan 088, so
      // there is no save-the-account side effect left to fire here.
      applyBalance(res.balance);
      setDone({
        amount: res.amount,
        balance: res.balance,
        reference: res.reference,
        status: res.status,
        payout: res.payout,
      });
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    // 'held' means the amount above already left the balance but was parked
    // for staff to approve instead of being sent to the gateway. "Awaiting
    // approval", never "under review": that now means a frozen account. It must
    // never read as a completed payout, and the copy below never claims the
    // balance is still spendable (the "Balance now" line already reflects the
    // debit). No threshold figure here on purpose: naming RM 1,000 would be a
    // second source of truth for a value the backend reads from an env var.
    const held = done.status === 'held';
    return (
      <div className="mt-6 flex max-w-md flex-col items-center rounded-2xl border border-white/10 bg-neutral-900 px-6 py-8 text-center">
        {held ? (
          <Clock className="h-12 w-12 text-amber-400" aria-hidden />
        ) : (
          <CheckCircle2 className="h-12 w-12 text-buyback-fg" aria-hidden />
        )}
        <p className="mt-3 font-heading text-2xl text-white">
          {rm(done.amount)} {held ? 'AWAITING APPROVAL' : 'ON ITS WAY'}
        </p>
        {/* The balance is RM, but a Singapore bank is paid in S$: name what
            lands, as the form did before the tap. */}
        {done.payout && (
          <p className="mt-1 text-sm font-semibold text-neutral-200">
            {regionalRailUi(done.payout.currency)?.money(done.payout.amount) ??
              `${done.payout.currency} ${done.payout.amount.toFixed(2)}`}{' '}
            to your bank
          </p>
        )}
        <p className="mt-2 max-w-sm text-sm text-neutral-400">
          {held
            ? "Withdrawals this size need staff approval before they're sent to your bank — the amount has already left your balance, and returns automatically if the withdrawal isn't approved. Either way, we'll let you know."
            : 'Your bank transfer is processing — most arrive within minutes. If the bank rejects it, the full amount returns to your balance automatically.'}
        </p>
        <p className="mt-3 text-[12px] text-neutral-500">
          Reference <span className="font-mono">{done.reference}</span>
        </p>
        <p className="mt-1 text-sm text-neutral-400">
          Balance now{' '}
          <span className="font-semibold text-white">{rm(done.balance)}</span>
        </p>
      </div>
    );
  }

  // Frozen: one message, nothing else (after every hook above).
  if (frozen) {
    return (
      <div className="mt-6 max-w-md">
        <div
          id="withdraw-hold-reason"
          role="status"
          className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3.5"
        >
          <p className="flex items-center gap-2 text-sm font-semibold text-amber-300">
            <Lock className="h-4 w-4 shrink-0" aria-hidden />
            Your account is under review
          </p>
          <p className="mt-1 text-[13px] text-white/60">
            Your balance is safe. Contact support to withdraw.
          </p>
          <Link
            href="/contact"
            className={cn(pillVariants({ size: 'sm' }), 'mt-3')}
          >
            Contact support
          </Link>
        </div>
      </div>
    );
  }

  // The remedy sits INSIDE role="alert" so problem and way out are one
  // announcement. No onNavigate here — this is a page, not a modal.
  const errorAlert = error && (
    <div
      role="alert"
      className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2"
    >
      <p className="text-[13px] font-medium text-red-300">{error}</p>
      <PhoneGateAction error={error} />
      <WithdrawRemedy error={error} />
    </div>
  );

  return (
    <div className="mt-6 max-w-md">
      {cantYet ? (
        // ---- Can't withdraw yet: the two steps, nothing to fill in --------
        <section aria-label="Withdrawals">
          <p className="text-sm text-neutral-400">
            <span className="font-heading text-2xl">
              {rm(withdrawable ?? 0)}
            </span>{' '}
            withdrawable
          </p>
          <WithdrawSteps
            id="withdraw-hold-reason"
            className="mt-5"
            hasTopup={!noTopup}
            depositMinRm={limits.deposit.minRm}
            available={available ?? 0}
            bonus={bonus}
            remaining={remaining}
          />
          {/* Get the cooling-off window out of the way while packs unlock
              withdrawals — only when there is nothing to pay to yet. */}
          {saved !== null && usableAccounts.length === 0 && (
            <Link
              href="/bank"
              className="mt-2 inline-flex min-h-11 items-center text-[13px] font-semibold text-white/70 underline-offset-2 hover:text-white hover:underline"
            >
              Save your bank account now&nbsp;<span aria-hidden>→</span>
            </Link>
          )}
          {errorAlert}
        </section>
      ) : (
        <>
          {/* ---- Can withdraw: the figure, then the form ------------------ */}
          <section aria-label="Withdrawable">
            <p className="font-heading text-4xl text-white tabular-nums">
              {withdrawable == null ? '—' : rm(withdrawable)}
            </p>
            <p className="mt-1 text-sm text-neutral-300">Withdrawable</p>
            <p className="mt-0.5 text-[13px] text-neutral-400">
              Minimum withdrawal {rm(payoutBand.minRm)}
            </p>
            {belowMin && (
              <p
                id="withdraw-hold-reason"
                role="status"
                className="mt-1 text-[13px] text-neutral-300"
              >
                {`You can withdraw once your withdrawable money reaches ${rm(payoutBand.minRm)} (${rm(minimumGap(payoutBand.minRm, withdrawable ?? 0))} more).`}
              </p>
            )}
          </section>

          {saved !== null && accounts.length === 0 && (
            <div className="mt-5 rounded-2xl border border-white/10 bg-neutral-900 px-5 py-6 text-center">
              <Landmark
                className="mx-auto h-8 w-8 text-neutral-500"
                aria-hidden
              />
              <p className="mt-2 text-sm text-neutral-300">
                No saved bank accounts yet.
              </p>
              <p className="mt-1 text-[13px] text-neutral-400">
                Withdrawals go to an account you saved earlier. Add one to get
                started.
              </p>
              <Link
                href="/bank"
                className={cn(pillVariants({ size: 'lg' }), 'mt-4 w-full')}
              >
                Add a bank account
              </Link>
            </div>
          )}

          {accounts.length > 0 && (
            <label className="mt-5 block text-[13px] font-semibold text-neutral-300">
              Withdraw to
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                aria-label="Saved bank account"
                className="mt-1.5 h-11 w-full rounded-xl border border-white/10 bg-neutral-900 px-3 text-sm text-white outline-none focus:border-white/25"
              >
                <option value="" disabled>
                  {usableAccounts.length === 0
                    ? 'No account is available yet'
                    : 'Choose a saved account'}
                </option>
                {accounts.map((account) => {
                  const reason = unusableReason(account, now);
                  return (
                    <option
                      key={account.id}
                      value={account.id}
                      disabled={!isUsable(account, now)}
                    >
                      {account.bankName} ···· {account.accountNumber.slice(-4)}{' '}
                      — {account.accountHolderName}
                      {reason ? ` (${reason})` : ''}
                    </option>
                  );
                })}
              </select>
            </label>
          )}

          {accounts.length > 0 && usableAccounts.length === 0 && (
            <p className="mt-2 text-[13px] text-neutral-400">
              New bank accounts need a short wait before first use, to keep your
              money safe.{' '}
              <Link
                href="/bank"
                className="text-white/80 underline underline-offset-2 hover:text-white"
              >
                Manage bank accounts
              </Link>
            </p>
          )}

          <label className="mt-3 block text-[13px] font-semibold text-neutral-300">
            Amount
            <span className="mt-1.5 flex items-center gap-2 rounded-xl border border-white/10 bg-neutral-900 px-3">
              <span className="text-sm font-semibold text-neutral-400">RM</span>
              <input
                type="text"
                inputMode="decimal"
                value={amountText}
                onChange={(e) =>
                  setAmountText(
                    nextAmountText(amountText, e.target.value, withdrawable),
                  )
                }
                disabled={withdrawalsClosed || blocked}
                aria-label="Withdrawal amount in RM"
                aria-describedby={guidanceId}
                placeholder="0.00"
                className="h-11 w-full bg-transparent text-sm text-white outline-none placeholder:text-neutral-600 disabled:opacity-50"
              />
            </span>
          </label>
          {accountMin !== null && !withdrawalsClosed && !blocked && (
            <p className="mt-2 text-[12px] leading-relaxed text-neutral-400">
              Minimum withdrawal to {selected?.bankName} is {rm0(accountMin)}.
            </p>
          )}
          {rail && payoutRegional !== null && (
            <div
              className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm"
              data-testid="withdraw-regional-estimate"
            >
              <div className="flex items-center justify-between text-neutral-400">
                <span>Your bank receives</span>
                <span className="font-semibold text-white">
                  {rail.ui.money(payoutRegional)}
                </span>
              </div>
              <p className="mt-1 text-right text-[11px] text-neutral-400">
                {rail.ui.symbol}1 = RM {rail.rate.payout.toFixed(4)} · rate
                locked when you confirm
              </p>
            </div>
          )}
          {withdrawalsClosed && (
            <p
              id="withdraw-amount-guidance"
              className="mt-2 text-[12px] leading-relaxed text-neutral-400"
            >
              {resumeAt
                ? `Withdrawals are paused until ${resumeAt} (Malaysia time). Your balance is safe — please try again then.`
                : 'Withdrawals are paused. Your balance is safe — try again later.'}
            </p>
          )}

          {errorAlert}

          <Pill
            onClick={submit}
            disabled={submitting || !formValid || withdrawalsClosed || blocked}
            size="lg"
            className="mt-4 w-full"
          >
            {submitting
              ? 'Sending…'
              : amountValid
                ? rail && payoutRegional !== null
                  ? `Withdraw ${rm(amount)} → ${rail.ui.money(payoutRegional)}`
                  : `Withdraw ${rm(amount)}`
                : 'Withdraw'}
          </Pill>

          <p className="mt-3 text-[12px] leading-relaxed text-neutral-400">
            The amount leaves your balance as soon as you confirm. Transfers are
            usually done in minutes; if the bank rejects it, the money returns
            to your balance automatically.
          </p>
        </>
      )}

      {/* ---- Collapsed: the numbers and the rules, said once ------------- */}
      <div className="mt-8 border-t border-white/10">
        {split && withdrawable != null && (
          <details className="group border-b border-white/10">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between py-3 text-sm font-semibold text-white [&::-webkit-details-marker]:hidden">
              Your money
              <ChevronDown
                className="h-4 w-4 text-neutral-400 transition-transform group-open:rotate-180 motion-reduce:transition-none"
                aria-hidden
              />
            </summary>
            <div id="withdraw-money" className="pb-4">
              <MoneyRows
                balance={available ?? 0}
                withdrawable={withdrawable}
                split={split}
              />
            </div>
          </details>
        )}
        <details className="group border-b border-white/10">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between py-3 text-sm font-semibold text-white [&::-webkit-details-marker]:hidden">
            How withdrawals work
            <ChevronDown
              className="h-4 w-4 text-neutral-400 transition-transform group-open:rotate-180 motion-reduce:transition-none"
              aria-hidden
            />
          </summary>
          <div className="pb-4">
            <WithdrawRules />
          </div>
        </details>
      </div>
    </div>
  );
}
