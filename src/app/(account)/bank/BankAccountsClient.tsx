'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Landmark, Trash2 } from 'lucide-react';
import {
  addSavedBankAccount,
  fetchSavedBankAccounts,
  fetchWithdrawBanks,
  removeSavedBankAccount,
  type SavedBankAccount,
  type WithdrawBank,
} from '@/lib/actions/vault';
import { Pill, pillVariants } from '@/components/ui/pill';
import { cn } from '@/lib/utils';

// Saved payout accounts — list, add, remove. The withdraw form reads the same
// list to prefill; this page is where a customer manages it. The backend caps
// the list at 5 and validates with the payout-submit rules, so anything saved
// here is guaranteed submittable.

/** Show only the tail on the list — enough to recognise, nothing to shoulder-surf. */
const maskAccount = (accountNumber: string) =>
  `···· ${accountNumber.slice(-4)}`;

export function BankAccountsClient() {
  const [accounts, setAccounts] = useState<SavedBankAccount[] | null>(null);
  const [banks, setBanks] = useState<WithdrawBank[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Add-form state
  const [adding, setAdding] = useState(false);
  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [holderName, setHolderName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchSavedBankAccounts(), fetchWithdrawBanks()]).then(
      ([accountsRes, banksRes]) => {
        if (cancelled) return;
        if (accountsRes.ok) setAccounts(accountsRes.accounts);
        else setError(accountsRes.error);
        if (banksRes.ok) setBanks(banksRes.banks);
        else if (accountsRes.ok) setError(banksRes.error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const formValid =
    bankCode !== '' &&
    /^[0-9]{6,34}$/.test(accountNumber) &&
    holderName.trim().length >= 2;

  async function submitAdd() {
    if (submitting || !formValid) return;
    setError(null);
    setSubmitting(true);
    try {
      const bankName =
        (banks ?? []).find((b) => b.bankCode === bankCode)?.bankName ?? '';
      const res = await addSavedBankAccount({
        bankCode,
        bankName,
        accountNumber,
        accountHolderName: holderName.trim(),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setAccounts(res.accounts);
      setAdding(false);
      setBankCode('');
      setAccountNumber('');
      setHolderName('');
    } catch {
      // The action catches its own failures — this is for the action CALL
      // itself failing (network), which would otherwise leave silence.
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(id: string) {
    if (removingId) return;
    setError(null);
    setRemovingId(id);
    try {
      const res = await removeSavedBankAccount(id);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setAccounts(res.accounts);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="mt-4 flex max-w-md flex-col gap-3">
      {accounts === null && !error && (
        <p className="text-sm text-neutral-400">Loading your accounts…</p>
      )}

      {accounts?.length === 0 && !adding && (
        <div className="rounded-2xl border border-white/10 bg-neutral-900 px-5 py-6 text-center">
          <Landmark className="mx-auto h-8 w-8 text-neutral-500" aria-hidden />
          <p className="mt-2 text-sm text-neutral-300">
            No saved bank accounts yet.
          </p>
          <p className="mt-1 text-[13px] text-neutral-500">
            Save one and withdrawals prefill it — no retyping account numbers.
          </p>
        </div>
      )}

      {(accounts ?? []).map((account) => (
        <div
          key={account.id}
          className="flex items-center gap-3 rounded-2xl border border-white/10 bg-neutral-900 px-4 py-3"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-neutral-800">
            <Landmark className="h-5 w-5 text-neutral-300" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-white">
              {account.bankName}
            </p>
            <p className="text-[13px] text-neutral-400">
              {maskAccount(account.accountNumber)} · {account.accountHolderName}
            </p>
          </div>
          <button
            type="button"
            onClick={() => remove(account.id)}
            disabled={removingId !== null}
            aria-label={`Remove ${account.bankName} ${maskAccount(account.accountNumber)}`}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-red-300 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ))}

      {error && (
        <p
          role="alert"
          className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] font-medium text-red-300"
        >
          {error}
        </p>
      )}

      {adding ? (
        <div className="rounded-2xl border border-white/10 bg-neutral-900 p-4">
          <label className="block text-[13px] font-semibold text-neutral-300">
            Bank
            <select
              value={bankCode}
              onChange={(e) => setBankCode(e.target.value)}
              aria-label="Bank"
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

          <div className="mt-4 flex gap-2">
            <Pill
              onClick={submitAdd}
              disabled={submitting || !formValid}
              size="lg"
              className="flex-1"
            >
              {submitting ? 'Saving…' : 'Save account'}
            </Pill>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className={cn(pillVariants({ variant: 'secondary', size: 'lg' }))}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        accounts !== null && (
          <div className="flex gap-2">
            <Pill onClick={() => setAdding(true)} size="lg" className="flex-1">
              Add bank account
            </Pill>
            <Link
              href="/bank-withdrawal"
              className={cn(pillVariants({ variant: 'secondary', size: 'lg' }))}
            >
              Withdraw
            </Link>
          </div>
        )
      )}
    </div>
  );
}
