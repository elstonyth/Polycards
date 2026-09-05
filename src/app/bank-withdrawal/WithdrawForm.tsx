'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Clock, Landmark } from 'lucide-react';
import { rm, rm0, timeUntil } from '@/lib/format';
import {
  fetchSavedBankAccounts,
  getPaymentLimits,
  startWithdrawal,
  type SavedBankAccount,
} from '@/lib/actions/vault';
import { DEFAULT_PAYMENT_LIMITS } from '@/lib/payment-limits';
import { useTopUp } from '@/components/app-shell/TopUpProvider';
import { Pill, pillVariants } from '@/components/ui/pill';
import { PhoneGateAction } from '@/components/account/PhoneGateAction';
import { cn } from '@/lib/utils';

// The payout band belongs to whichever gateway the admin has active (TGPay
// caps at RM 30,000, GlobePay at RM 50,000), so it is read from the backend
// when the form mounts; these are only the until-it-answers defaults. NOT the
// same band as deposits — the payout floor is higher. The gateway's own
// rejection names no numbers, so the form does.
const WD_MIN_RM = DEFAULT_PAYMENT_LIMITS.withdrawal.minRm;
const WD_MAX_RM = DEFAULT_PAYMENT_LIMITS.withdrawal.maxRm;

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
    return 'not available with the current payout provider';
  }
  if (typeof account.usableFrom !== 'string') {
    return 'save it again to use it';
  }
  const wait = timeUntil(account.usableFrom, now);
  return wait ? `available ${wait}` : null;
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
}: {
  /** The server's freeze/locked/playthrough-gated figure — NOT raw balance. */
  withdrawable: number | null;
}) {
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
  } | null>(null);
  // One idempotency key per withdrawal ATTEMPT: minted lazily on submit,
  // REUSED on error retries (so a debited-but-response-lost attempt replays
  // instead of double-debiting AND double-transferring — see the doc comment
  // on startWithdrawal), and rotated only after a confirmed success so the
  // next withdrawal starts a fresh attempt. Mirrors TopUpSheet's attemptKey.
  const attemptKey = useRef<string | null>(null);

  const [band, setBand] = useState({ min: WD_MIN_RM, max: WD_MAX_RM });
  useEffect(() => {
    let cancelled = false;
    getPaymentLimits()
      .then((l) => {
        if (!cancelled)
          setBand({ min: l.withdrawal.minRm, max: l.withdrawal.maxRm });
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

  const amount = Number.parseFloat(amountText);
  const amountValid =
    Number.isFinite(amount) &&
    amount > 0 &&
    Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6;
  const selected = usableAccounts.find((a) => a.id === accountId);
  const formValid = amountValid && selected !== undefined;

  async function submit() {
    if (submitting || !formValid) return;
    setError(null);
    if (amount < band.min || amount > band.max) {
      setError(
        `Withdrawals must be between ${rm0(band.min)} and ${rm0(band.max)}.`,
      );
      return;
    }
    if (withdrawable != null && amount > withdrawable) {
      setError('That is more than you can withdraw right now.');
      return;
    }
    setSubmitting(true);
    try {
      attemptKey.current ??= crypto.randomUUID();
      const res = await startWithdrawal({
        amount,
        accountId,
        idempotencyKey: attemptKey.current,
      });
      if (!res.ok) {
        // Key stays armed on purpose — a retry of THIS attempt must replay,
        // not double-debit and double-transfer.
        setError(res.error);
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
      });
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    // 'held' means the amount above already left the balance but was parked
    // for a human to approve instead of being sent to the gateway — it must
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
          {rm(done.amount)} {held ? 'UNDER REVIEW' : 'ON ITS WAY'}
        </p>
        <p className="mt-2 max-w-sm text-sm text-neutral-400">
          {held
            ? "Withdrawals this size go through a manual review before they're sent to your bank — the amount has already left your balance, and returns automatically if the withdrawal isn't approved. Either way, we'll let you know."
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

  return (
    <div className="mt-6 max-w-md">
      <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm">
        <div className="flex items-center justify-between text-neutral-400">
          <span>Available to withdraw</span>
          <span className="font-semibold text-neutral-200">
            {withdrawable == null ? '—' : rm(withdrawable)}
          </span>
        </div>
      </div>

      {saved !== null && accounts.length === 0 && (
        <div className="mt-4 rounded-2xl border border-white/10 bg-neutral-900 px-5 py-6 text-center">
          <Landmark className="mx-auto h-8 w-8 text-neutral-500" aria-hidden />
          <p className="mt-2 text-sm text-neutral-300">
            No saved bank accounts yet.
          </p>
          <p className="mt-1 text-[13px] text-neutral-500">
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
        <label className="mt-4 block text-[13px] font-semibold text-neutral-300">
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
                  {account.bankName} ···· {account.accountNumber.slice(-4)} —{' '}
                  {account.accountHolderName}
                  {reason ? ` (${reason})` : ''}
                </option>
              );
            })}
          </select>
        </label>
      )}

      {accounts.length > 0 && usableAccounts.length === 0 && (
        <p className="mt-2 text-[13px] text-neutral-400">
          A newly saved bank account waits before it can receive withdrawals —
          the picker says how long. This protects your balance if someone else
          ever gets into your account.
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
            onChange={(e) => setAmountText(e.target.value)}
            aria-label="Withdrawal amount in RM"
            placeholder="0.00"
            className="h-11 w-full bg-transparent text-sm text-white outline-none placeholder:text-neutral-600"
          />
        </span>
      </label>

      {/* The remedy sits INSIDE role="alert" so problem and way out are one
          announcement. No onNavigate here — this is a page, not a modal. */}
      {error && (
        <div
          role="alert"
          className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2"
        >
          <p className="text-[13px] font-medium text-red-300">{error}</p>
          <PhoneGateAction error={error} />
        </div>
      )}

      <Pill
        onClick={submit}
        disabled={submitting || !formValid}
        size="lg"
        className="mt-4 w-full"
      >
        {submitting
          ? 'Sending…'
          : amountValid
            ? `Withdraw ${rm(amount)}`
            : 'Withdraw'}
      </Pill>

      <p className="mt-3 text-[12px] leading-relaxed text-neutral-400">
        The amount leaves your balance as soon as you confirm. Transfers are
        usually done in minutes; if the bank rejects it, the money returns to
        your balance automatically.
      </p>
    </div>
  );
}
