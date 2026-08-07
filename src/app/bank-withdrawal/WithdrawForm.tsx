'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Landmark } from 'lucide-react';
import { rm, rm0, timeUntil } from '@/lib/format';
import {
  fetchSavedBankAccounts,
  startWithdrawal,
  type SavedBankAccount,
} from '@/lib/actions/vault';
import { Pill, pillVariants } from '@/components/ui/pill';
import { cn } from '@/lib/utils';

// The real payout band (mirrors the backend's GLOBEPAY_WD_MIN/MAX): RM 50 –
// RM 50,000, confirmed by the provider 2026-07-29. NOT the same band as
// deposits — the payout floor is higher. The gateway's own rejection names no
// numbers, so the form does.
const WD_MIN_RM = 50;
const WD_MAX_RM = 50000;

/** Can this destination receive money right now? The server's `usableFrom` is
 *  the only input — the cooling-off duration is never duplicated here, so
 *  retuning it on the backend moves this UI with it. Absent/null means "not
 *  without re-saving", which is also the safe reading of a backend that has not
 *  shipped the field. */
const isUsable = (account: SavedBankAccount, now: Date) =>
  typeof account.usableFrom === 'string' &&
  new Date(account.usableFrom).getTime() <= now.getTime();

/** Why a destination cannot be picked yet, in the customer's terms. */
function unusableReason(account: SavedBankAccount, now: Date): string | null {
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
  const [saved, setSaved] = useState<SavedBankAccount[] | null>(null);
  const [accountId, setAccountId] = useState('');
  const [amountText, setAmountText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{
    amount: number;
    balance: number;
    reference: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
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
    if (amount < WD_MIN_RM || amount > WD_MAX_RM) {
      setError(
        `Withdrawals must be between ${rm0(WD_MIN_RM)} and ${rm0(WD_MAX_RM)}.`,
      );
      return;
    }
    if (withdrawable != null && amount > withdrawable) {
      setError('That is more than you can withdraw right now.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await startWithdrawal({ amount, accountId });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDone({
        amount: res.amount,
        balance: res.balance,
        reference: res.reference,
      });
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="mt-6 flex max-w-md flex-col items-center rounded-2xl border border-white/10 bg-neutral-900 px-6 py-8 text-center">
        <CheckCircle2 className="h-12 w-12 text-buyback-fg" aria-hidden />
        <p className="mt-3 font-heading text-2xl text-white">
          {rm(done.amount)} ON ITS WAY
        </p>
        <p className="mt-2 max-w-sm text-sm text-neutral-400">
          Your bank transfer is processing — most arrive within minutes. If the
          bank rejects it, the full amount returns to your balance
          automatically.
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
            Withdrawals go to an account you saved earlier. Add one now — it
            becomes available for withdrawals a day later.
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
          A newly saved bank account can only receive withdrawals a day after
          you add it. This protects your balance if someone else ever gets into
          your account.
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

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] font-medium text-red-300"
        >
          {error}
        </p>
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
