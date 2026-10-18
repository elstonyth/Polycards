import type { Metadata } from 'next';
import Link from 'next/link';
import { unstable_rethrow } from 'next/navigation';
import { AccountHeader, Panel } from '@/components/account/ui';
import { WithdrawLink } from '@/components/account/WithdrawLink';
import {
  MoneyRows,
  WithdrawRules,
  WithdrawSteps,
} from '@/components/account/WithdrawSteps';
import { getWallet } from '@/lib/actions/wallet';
import { getPaymentLimits } from '@/lib/actions/vault';
import { DEFAULT_PAYMENT_LIMITS } from '@/lib/payment-limits';
import { pillVariants } from '@/components/ui/pill';
import { isWithdrawLocked, sen, walletSplit } from '@/lib/wallet-split';
import { rm } from '@/lib/format';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Wallet' };

// An RM figure never breaks across lines ("RM" / "30.00").
const Rm = ({ n }: { n: number }) => (
  <span className="whitespace-nowrap">{rm(n)}</span>
);

const QUIET_LINK =
  'inline-flex min-h-11 items-center text-[13px] font-semibold text-white/70 underline-offset-2 hover:text-white hover:underline';

export default async function WalletPage() {
  // The deposit floor belongs to the active gateway — the same read the
  // top-up sheet makes; any failure keeps the defaults.
  const [res, limits] = await Promise.all([
    getWallet(),
    getPaymentLimits().catch((err: unknown) => {
      // Let Next's own render signals (dynamic usage, redirects) through.
      unstable_rethrow(err);
      return DEFAULT_PAYMENT_LIMITS;
    }),
  ]);

  if (!res.ok) {
    return (
      <>
        <AccountHeader
          title="Wallet"
          sub="Your balance and withdrawal status."
        />
        <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-white/60">
          {res.error}
        </p>
      </>
    );
  }

  const w = res.wallet;
  const gate = { ...w, remaining: w.playthrough.remaining };
  const split = walletSplit(gate);
  // Can't withdraw yet: never topped up, or money still to use on packs
  // (the backend shuts the whole gate until it is used).
  const cantYet = !w.isFrozen && (!w.hasTopup || isWithdrawLocked(gate));
  const canWithdraw = !w.isFrozen && sen(w.withdrawable) > 0;

  return (
    <>
      <AccountHeader title="Wallet" sub="Your balance and withdrawal status." />

      {w.isFrozen && (
        <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
          An admin has frozen this account — your balance is held until review.
          Contact support if you think this is a mistake.
        </div>
      )}

      {/* 424 never-topped-up accounts held RM 22.4k on 2026-10-14 and found
          out only on the withdraw page. Say it here, before they try. */}
      {cantYet && (
        <Panel className="mb-4">
          <h2 className="font-heading text-lg font-bold text-white">
            Unlock withdrawals
          </h2>
          <WithdrawSteps
            className="mt-4"
            hasTopup={w.hasTopup}
            depositMinRm={limits.deposit.minRm}
            available={w.available}
            bonus={w.bonus}
            remaining={w.playthrough.remaining}
          />
        </Panel>
      )}

      {/* ---- Money: Balance = Withdrawable + later + For packs ------------- */}
      <Panel className="mb-4">
        <h2 className="sr-only">Your money</h2>
        <p className="text-sm text-neutral-400">Balance</p>
        <p className="mt-1 font-heading text-3xl font-bold tabular-nums whitespace-nowrap text-white sm:text-4xl">
          {rm(w.balance)}
        </p>
        {/* Frozen reads available 0: a split of nothing under the real
            balance would only confuse; the line below says why. */}
        {!w.isFrozen && (
          <div className="mt-5 border-t border-white/10 pt-4">
            <MoneyRows withdrawable={w.withdrawable} split={split} />
          </div>
        )}
        {w.isFrozen && (
          <p className="mt-3 text-[13px] text-neutral-400">
            Held while your account is under review.
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-x-5">
          {canWithdraw ? (
            <WithdrawLink
              className={cn(pillVariants({ variant: 'secondary', size: 'sm' }))}
            >
              Withdraw
            </WithdrawLink>
          ) : (
            // Payout status lives on the withdraw page, locked or not.
            w.hasTopup &&
            !w.isFrozen && (
              <Link href="/bank-withdrawal" className={QUIET_LINK}>
                Withdrawals &amp; payout status&nbsp;<span aria-hidden>→</span>
              </Link>
            )
          )}
          {!w.isFrozen && split.forPacks > 0 && (
            <Link href="/transactions" className={QUIET_LINK}>
              See where your for-packs money came from&nbsp;
              <span aria-hidden>→</span>
            </Link>
          )}
        </div>
      </Panel>

      {/* ---- How it works (explainer sits last — numbers first) ------------- */}
      <Panel>
        <h2 className="font-heading text-lg font-bold text-white">
          How withdrawals work
        </h2>
        <div className="mt-4">
          <WithdrawRules />
        </div>

        <p className="mt-4 text-sm font-semibold text-white">
          You need one top-up before you can ship cards. To withdraw, you also
          need to use all your money for packs.
        </p>

        <div className="mt-5 border-t border-white/10 pt-4">
          <p className="text-sm font-semibold text-white">Example</p>
          <ul className="mt-2 space-y-1.5 text-sm text-neutral-300">
            <li>
              Sell a prize slab for <Rm n={300} />, then top up <Rm n={50} /> →{' '}
              <Rm n={50} /> still to use on packs, withdrawals locked.
            </li>
            <li>
              Open packs with that <Rm n={50} /> →{' '}
              <span className="font-semibold text-white">
                withdrawals unlock
              </span>
              : <Rm n={300} /> plus whatever you sell back can go to your bank.
            </li>
          </ul>
        </div>

        <p className="mt-4 text-[13px] text-neutral-400">
          VIP and the leaderboard count the part of each pack you paid yourself.
          Packs paid half or more with bonus credit don&rsquo;t count toward
          tasks.
        </p>

        <p className="mt-3 text-[13px] text-neutral-400">
          Frozen accounts are held until review. Top-ups are credited after the
          payment provider confirms payment. Bank withdrawals require a
          withdrawable balance and a saved bank account; processing status
          appears on the withdrawal page.
        </p>
      </Panel>
    </>
  );
}
