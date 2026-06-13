import type { Metadata } from 'next';
import { AlertCircle } from 'lucide-react';
import AuthButton from '@/components/AuthButton';

export const metadata: Metadata = {
  title: 'Bank Withdrawal — Phygitals',
  description: 'Complete your withdrawal with a direct bank transfer.',
};

// Standalone full-width route matching the live anonymous /bank-withdrawal: heading +
// an auth wall ("Sign in to withdraw…") with a "Log in to continue" button that opens
// the global auth modal. Withdrawals are account-gated; no fabricated balance/history.
// Moved out of the (account) shell (live has no sidebar here).

export default function BankWithdrawalPage() {
  return (
    <div className="w-full px-fluid py-10">
      <h1 className="font-heading text-2xl font-bold tracking-tight text-white sm:text-3xl">
        Bank Withdrawal
      </h1>
      <p className="mt-2 text-sm text-white/55">
        Complete your withdrawal with a direct bank transfer.
      </p>

      <div className="mt-6 flex items-center gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3.5 text-sm font-medium text-amber-300">
        <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
        Sign in to withdraw to your bank.
      </div>

      <AuthButton
        mode="login"
        className="mt-4 inline-flex h-10 items-center justify-center rounded-xl bg-white/10 px-4 text-sm font-semibold text-white transition-colors hover:bg-white/15"
      >
        Log in to continue
      </AuthButton>
    </div>
  );
}
