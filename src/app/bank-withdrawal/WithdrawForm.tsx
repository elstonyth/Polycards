'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { rm, rm0 } from '@/lib/format';
import {
  addSavedBankAccount,
  fetchSavedBankAccounts,
  fetchWithdrawBanks,
  startWithdrawal,
  type SavedBankAccount,
  type WithdrawBank,
} from '@/lib/actions/vault';
import { Pill } from '@/components/ui/pill';

// The real payout band (mirrors the backend's GLOBEPAY_WD_MIN/MAX): RM 50 –
// RM 50,000, confirmed by the provider 2026-07-29. NOT the same band as
// deposits — the payout floor is higher. The gateway's own rejection names no
// numbers, so the form does.
const WD_MIN_RM = 50;
const WD_MAX_RM = 50000;

/**
 * Bank-withdrawal form. The balance is debited the moment the request is
 * accepted — the success state says "on its way", never "paid", because the
 * bank transfer completes asynchronously and a failed payout refunds the
 * debit automatically.
 */
export default function WithdrawForm({
  withdrawable,
}: {
  /** The server's freeze/locked/playthrough-gated figure — NOT raw balance. */
  withdrawable: number | null;
}) {
  const [banks, setBanks] = useState<WithdrawBank[] | null>(null);
  const [saved, setSaved] = useState<SavedBankAccount[]>([]);
  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [holderName, setHolderName] = useState('');
  const [amountText, setAmountText] = useState('');
  const [saveAccount, setSaveAccount] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{
    amount: number;
    balance: number;
    reference: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Saved accounts load alongside the bank list; a failed saved-accounts
    // read degrades to the plain form (it's a prefill, never a gate).
    Promise.all([fetchWithdrawBanks(), fetchSavedBankAccounts()]).then(
      ([banksRes, savedRes]) => {
        if (cancelled) return;
        if (banksRes.ok) setBanks(banksRes.banks);
        else setError(banksRes.error);
        if (savedRes.ok) {
          setSaved(savedRes.accounts);
          // One saved account and an empty form: prefill it outright — the
          // common case is withdrawing to the same account every time.
          const only =
            savedRes.accounts.length === 1 ? savedRes.accounts[0] : undefined;
          if (only) {
            setBankCode(only.bankCode);
            setAccountNumber(only.accountNumber);
            setHolderName(only.accountHolderName);
          }
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Does the typed-in account already exist in the saved list? Drives both
  // the picker highlight and whether "save for next time" is offered.
  const matchesSaved = saved.some(
    (a) => a.bankCode === bankCode && a.accountNumber === accountNumber,
  );

  const amount = Number.parseFloat(amountText);
  const amountValid =
    Number.isFinite(amount) &&
    amount > 0 &&
    Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6;
  const formValid =
    amountValid &&
    bankCode !== '' &&
    /^[0-9]{6,34}$/.test(accountNumber) &&
    holderName.trim().length >= 2;

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
      const res = await startWithdrawal({
        amount,
        bankCode,
        accountNumber,
        accountHolderName: holderName.trim(),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // The withdrawal is already accepted — saving the account is a
      // convenience side effect and must never surface as a payout error.
      // Fire-and-forget. The action catches its own failures, but the ACTION
      // CALL itself (a network round-trip) can still reject — swallow that
      // too, or a flaky connection turns a successful payout into an
      // unhandled-rejection overlay.
      if (saveAccount && !matchesSaved) {
        const bankName =
          (banks ?? []).find((b) => b.bankCode === bankCode)?.bankName ?? '';
        void addSavedBankAccount({
          bankCode,
          bankName,
          accountNumber,
          accountHolderName: holderName.trim(),
        }).catch(() => undefined);
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

      {saved.length > 0 && (
        <label className="mt-4 block text-[13px] font-semibold text-neutral-300">
          Saved accounts
          <select
            // Reflects the current fields when they match a saved account, so
            // switching between saved accounts and hand-editing stay in sync.
            value={
              saved.find(
                (a) =>
                  a.bankCode === bankCode && a.accountNumber === accountNumber,
              )?.id ?? ''
            }
            onChange={(e) => {
              const account = saved.find((a) => a.id === e.target.value);
              if (!account) return;
              setBankCode(account.bankCode);
              setAccountNumber(account.accountNumber);
              setHolderName(account.accountHolderName);
            }}
            aria-label="Saved bank accounts"
            className="mt-1.5 h-11 w-full rounded-xl border border-white/10 bg-neutral-900 px-3 text-sm text-white outline-none focus:border-white/25"
          >
            <option value="" disabled>
              Choose a saved account
            </option>
            {saved.map((account) => (
              <option key={account.id} value={account.id}>
                {account.bankName} ···· {account.accountNumber.slice(-4)} —{' '}
                {account.accountHolderName}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="mt-4 block text-[13px] font-semibold text-neutral-300">
        Bank
        <select
          value={bankCode}
          onChange={(e) => setBankCode(e.target.value)}
          aria-label="Destination bank"
          className="mt-1.5 h-11 w-full rounded-xl border border-white/10 bg-neutral-900 px-3 text-sm text-white outline-none focus:border-white/25"
        >
          <option value="" disabled>
            {banks == null ? 'Loading banks…' : 'Choose your bank'}
          </option>
          {(banks ?? []).map((bank) => (
            <option key={bank.bankCode} value={bank.bankCode}>
              {bank.bankName}
            </option>
          ))}
        </select>
      </label>

      <label className="mt-3 block text-[13px] font-semibold text-neutral-300">
        Account number
        <input
          type="text"
          inputMode="numeric"
          value={accountNumber}
          onChange={(e) =>
            setAccountNumber(e.target.value.replace(/[^0-9]/g, ''))
          }
          aria-label="Account number"
          placeholder="Digits only"
          className="mt-1.5 h-11 w-full rounded-xl border border-white/10 bg-neutral-900 px-3 text-sm text-white outline-none placeholder:text-neutral-600 focus:border-white/25"
        />
      </label>

      <label className="mt-3 block text-[13px] font-semibold text-neutral-300">
        Account holder name
        <input
          type="text"
          value={holderName}
          onChange={(e) => setHolderName(e.target.value)}
          aria-label="Account holder name"
          placeholder="Exactly as the bank has it"
          className="mt-1.5 h-11 w-full rounded-xl border border-white/10 bg-neutral-900 px-3 text-sm text-white outline-none placeholder:text-neutral-600 focus:border-white/25"
        />
      </label>

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

      {!matchesSaved && (
        <label className="mt-3 flex items-center gap-2 text-[13px] text-neutral-300">
          <input
            type="checkbox"
            checked={saveAccount}
            onChange={(e) => setSaveAccount(e.target.checked)}
            className="h-4 w-4 rounded border-white/20 bg-neutral-900 accent-white"
          />
          Save this account for future withdrawals
        </label>
      )}

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
