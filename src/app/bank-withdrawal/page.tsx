import type { Metadata } from 'next';
import { AlertCircle, Landmark } from 'lucide-react';
import AuthButton from '@/components/AuthButton';
import { getCustomer } from '@/lib/data/customer';
import { getWallet } from '@/lib/actions/wallet';
import WithdrawForm from './WithdrawForm';

export const metadata: Metadata = {
  title: 'Bank Withdrawal',
  description: 'Complete your withdrawal with a direct bank transfer.',
};

// Three honest states: signed-out visitors get the auth wall; signed-in
// customers get the real payout form once withdrawals are switched on
// (NEXT_PUBLIC_WITHDRAWALS_ENABLED, mirrored by the backend's own fail-closed
// GLOBEPAY_WITHDRAWALS_ENABLED), and the "not open yet" notice until then.
export const dynamic = 'force-dynamic';

const WITHDRAWALS_OPEN = process.env.NEXT_PUBLIC_WITHDRAWALS_ENABLED === 'true';

export default async function BankWithdrawalPage() {
  const customer = await getCustomer();
  // withdrawable, not raw balance: the freeze/locked-commission/playthrough
  // gate lives server-side, and the form must not promise money the server
  // will refuse.
  const walletResult = customer ? await getWallet() : null;
  const withdrawable =
    walletResult && walletResult.ok ? walletResult.wallet.withdrawable : null;

  return (
    <div className="w-full px-fluid py-10">
      <h1 className="font-heading text-2xl font-bold tracking-tight text-white sm:text-3xl">
        Bank Withdrawal
      </h1>
      <p className="mt-2 text-sm text-white/55">
        Complete your withdrawal with a direct bank transfer.
      </p>

      {customer ? (
        WITHDRAWALS_OPEN ? (
          <WithdrawForm withdrawable={withdrawable} />
        ) : (
          <>
            <div className="mt-6 flex items-start gap-2.5 rounded-xl border border-white/10 bg-neutral-900 px-4 py-3.5 text-sm text-white/80">
              <Landmark
                className="mt-0.5 h-4 w-4 shrink-0 text-white/60"
                aria-hidden
              />
              <span>
                Bank withdrawals aren&apos;t open yet — payouts go live with the
                payment gateway. Your credit balance is safe and stays spendable
                on packs in the meantime.
              </span>
            </div>
            <p className="mt-4 text-[13px] text-white/60">
              Want value out today? Sell-back credits from your vault apply
              instantly to your balance.
            </p>
          </>
        )
      ) : (
        <>
          <div className="mt-6 flex items-center gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3.5 text-sm font-medium text-amber-300">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
            Sign in to withdraw to your bank.
          </div>

          <AuthButton
            mode="login"
            className="mt-4 inline-flex h-11 items-center justify-center rounded-xl bg-white/10 px-4 text-sm font-semibold text-white transition-colors hover:bg-white/15"
          >
            Log in to continue
          </AuthButton>
        </>
      )}
    </div>
  );
}
