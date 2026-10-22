'use client';

import { useEffect, useState } from 'react';
import { Landmark, Trash2, Wallet } from 'lucide-react';
import {
  addSavedBankAccount,
  fetchSavedBankAccounts,
  fetchWithdrawBanks,
  removeSavedBankAccount,
  type SavedBankAccount,
  type WithdrawBank,
} from '@/lib/actions/vault';
import { Pill, pillVariants } from '@/components/ui/pill';
import { WithdrawLink } from '@/components/account/WithdrawLink';
import { BankCountryToggle } from '@/components/account/BankCountryToggle';
import { timeUntil } from '@/lib/format';
import { bankCountryGroups } from '@/lib/regional-rails';
import { cn } from '@/lib/utils';

// Saved payout accounts — list, add, remove. This list is where withdrawals
// GO: the withdraw form submits an account id and the server resolves the bank
// details from here, so this page is the only place a payout destination is
// chosen. The backend caps the list at 5 and validates with the payout-submit
// rules. Existing accounts are rechecked when listed and used.
//
// A newly added account may have to wait out a cooling-off window before it can
// receive money; the server says when via `usableFrom`. That state is rendered
// here rather than recomputed — the duration is the backend's to tune, down to
// and including zero (PAYOUT_DESTINATION_COOLDOWN_HOURS), so no copy on this
// page may name one.

/** Show only the tail on the list — enough to recognise, nothing to shoulder-surf. */
const maskAccount = (accountNumber: string) =>
  `···· ${accountNumber.slice(-4)}`;

/**
 * The account's payout status, as the customer needs to read it. Three states,
 * and none of them hides the account: a saved account missing from this list
 * would read as data loss.
 */
function payoutStatus(
  account: SavedBankAccount,
  now: Date,
): { label: string; ready: boolean } {
  if (account.supported === false) {
    // Keep invalid or unavailable destinations visible with their remedy.
    return {
      label:
        account.unavailableReason ??
        'Not available with the current payout provider',
      ready: false,
    };
  }
  if (typeof account.usableFrom !== 'string') {
    // Saved before the cooling-off rule existed: waiting will never arm it.
    return { label: 'Remove and save again to withdraw to it', ready: false };
  }
  const wait = timeUntil(account.usableFrom, now);
  return wait
    ? { label: `Available for withdrawals ${wait}`, ready: false }
    : { label: 'Ready for withdrawals', ready: true };
}

export function BankAccountsClient() {
  const [accounts, setAccounts] = useState<SavedBankAccount[] | null>(null);
  const [banks, setBanks] = useState<WithdrawBank[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Add-form state
  const [adding, setAdding] = useState(false);
  const [country, setCountry] = useState('');
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

  // Require the customer's choice, even when only one country is available.
  const countries = bankCountryGroups(banks ?? []);
  const shown = countries.find((group) => group.country === country);
  const selectedBank = shown?.items.find((bank) => bank.bankCode === bankCode);
  // A USDT wallet takes an address and no holder name. Its checksum is the
  // server's to judge (it says what is wrong); here only the shape.
  const wallet = selectedBank?.wallet;
  // The USDT group lists networks, not banks: word the form for a wallet
  // as soon as it is picked, before a network is.
  const walletGroup = shown?.items.some((bank) => bank.wallet) ?? false;
  const offersWallets = countries.some((group) =>
    group.items.some((bank) => bank.wallet),
  );
  const lengths = selectedBank?.accountLengths;
  const accountNumberValid =
    (wallet ? accountNumber !== '' : /^[0-9]{5,34}$/.test(accountNumber)) &&
    (!lengths || lengths.includes(accountNumber.length)) &&
    (!selectedBank?.accountPattern ||
      new RegExp(selectedBank.accountPattern).test(accountNumber));
  const numberHint =
    selectedBank?.accountHint ??
    (walletGroup
      ? 'Choose the network your wallet uses first.'
      : lengths && lengths.length <= 2
        ? `${selectedBank.bankName} account numbers are ${lengths.join(' or ')} digits. Check your bank country and account number.`
        : 'Check your bank country and use the account number shown in your banking app, not a card number.');
  const numberInvalid =
    selectedBank !== undefined && accountNumber !== '' && !accountNumberValid;

  const formValid =
    selectedBank !== undefined &&
    accountNumberValid &&
    (wallet !== undefined ||
      (holderName.trim().length >= 2 && holderName.trim().length <= 120));

  async function submitAdd() {
    if (submitting || !formValid) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await addSavedBankAccount({
        bankCode,
        bankName: selectedBank.bankName,
        accountNumber,
        accountHolderName: wallet ? '' : holderName.trim(),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setAccounts(res.accounts);
      setAdding(false);
      setCountry('');
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
            Withdrawals go to an account saved here. Add one to get started.
          </p>
        </div>
      )}

      {(accounts ?? []).map((account) => {
        const status = payoutStatus(account, new Date());
        return (
          <div
            key={account.id}
            className="flex items-center gap-3 rounded-2xl border border-white/10 bg-neutral-900 px-4 py-3"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-neutral-800">
              {account.wallet ? (
                <Wallet className="h-5 w-5 text-neutral-300" aria-hidden />
              ) : (
                <Landmark className="h-5 w-5 text-neutral-300" aria-hidden />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-white">
                {account.bankName}
              </p>
              <p className="text-[13px] text-neutral-400">
                {maskAccount(account.accountNumber)}
                {/* A wallet has no holder (its network name is stored). */}
                {!account.wallet && ` · ${account.accountHolderName}`}
              </p>
              <p
                className={cn(
                  'mt-0.5 text-[12px]',
                  status.ready ? 'text-neutral-500' : 'text-amber-300/80',
                )}
              >
                {status.label}
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
        );
      })}

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
          <BankCountryToggle
            groups={countries}
            value={shown?.country ?? ''}
            onChange={(next) => {
              setCountry(next);
              setBankCode('');
              setAccountNumber('');
              setError(null);
            }}
            className="mb-3"
            label={offersWallets ? 'Bank country or wallet' : undefined}
          />
          <label className="block text-[13px] font-semibold text-neutral-300">
            {walletGroup ? 'Network' : 'Bank'}
            <select
              value={bankCode}
              onChange={(e) => {
                setBankCode(e.target.value);
                // Digits for a bank, an address for a wallet: never carry one
                // over as the other.
                setAccountNumber('');
                setError(null);
              }}
              disabled={!shown}
              aria-label={walletGroup ? 'Network' : 'Bank'}
              className="mt-1.5 h-11 w-full rounded-xl border border-white/10 bg-neutral-900 px-3 text-sm text-white outline-none focus:border-white/25"
            >
              <option value="" disabled>
                {banks == null
                  ? 'Loading banks…'
                  : !shown
                    ? 'Choose bank country first'
                    : walletGroup
                      ? 'Choose a network'
                      : 'Choose your bank'}
              </option>
              {(shown?.items ?? []).map((bank) => (
                <option key={bank.bankCode} value={bank.bankCode}>
                  {bank.bankName}
                </option>
              ))}
            </select>
          </label>

          {walletGroup ? (
            <>
              <label className="mt-3 block text-[13px] font-semibold text-neutral-300">
                Wallet address
                <input
                  type="text"
                  disabled={!wallet}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={accountNumber}
                  onChange={(e) =>
                    setAccountNumber(e.target.value.replace(/\s/g, ''))
                  }
                  aria-label="Wallet address"
                  aria-invalid={numberInvalid}
                  aria-describedby={
                    selectedBank
                      ? 'bank-account-number-hint wallet-address-warning'
                      : 'bank-account-number-hint'
                  }
                  placeholder={
                    wallet === 'tron'
                      ? 'Starts with T'
                      : wallet === 'evm'
                        ? 'Starts with 0x'
                        : 'Paste your wallet address'
                  }
                  className="mt-1.5 h-11 w-full rounded-xl border border-white/10 bg-neutral-900 px-3 font-mono text-[13px] text-white outline-none placeholder:font-sans placeholder:text-neutral-600 focus:border-white/25"
                />
              </label>
              <p
                id="bank-account-number-hint"
                aria-live="polite"
                className={cn(
                  'mt-1.5 text-[13px]',
                  numberInvalid ? 'text-red-300' : 'text-neutral-400',
                )}
              >
                {numberHint}
              </p>
              {selectedBank && (
                <p
                  id="wallet-address-warning"
                  className="mt-2 text-[12px] leading-snug text-amber-300/80"
                >
                  Paste the address from your wallet&apos;s receive screen for{' '}
                  {selectedBank.bankName}. USDT sent to a wrong address or
                  network can&apos;t be recovered.
                </p>
              )}
            </>
          ) : (
            <>
              <label className="mt-3 block text-[13px] font-semibold text-neutral-300">
                Account number
                <input
                  type="text"
                  inputMode="numeric"
                  disabled={!selectedBank}
                  value={accountNumber}
                  onChange={(e) =>
                    setAccountNumber(e.target.value.replace(/[^0-9]/g, ''))
                  }
                  aria-label="Account number"
                  aria-invalid={numberInvalid}
                  aria-describedby="bank-account-number-hint"
                  placeholder="Digits only"
                  className="mt-1.5 h-11 w-full rounded-xl border border-white/10 bg-neutral-900 px-3 text-sm text-white outline-none placeholder:text-neutral-600 focus:border-white/25"
                />
              </label>
              <p
                id="bank-account-number-hint"
                aria-live="polite"
                className={cn(
                  'mt-1.5 text-[13px]',
                  numberInvalid ? 'text-red-300' : 'text-neutral-400',
                )}
              >
                {numberHint}
              </p>

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
            </>
          )}

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
            <WithdrawLink
              className={cn(pillVariants({ variant: 'secondary', size: 'lg' }))}
            >
              Withdraw
            </WithdrawLink>
          </div>
        )
      )}
    </div>
  );
}
