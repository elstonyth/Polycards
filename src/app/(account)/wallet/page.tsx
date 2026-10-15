import type { Metadata } from 'next';
import Link from 'next/link';
import { unstable_rethrow } from 'next/navigation';
import { Lock } from 'lucide-react';
import { AccountHeader, Panel } from '@/components/account/ui';
import { TopUpButton } from '@/components/account/TopUpButton';
import { getWallet } from '@/lib/actions/wallet';
import { getPaymentLimits } from '@/lib/actions/vault';
import { DEFAULT_PAYMENT_LIMITS } from '@/lib/payment-limits';
import { pillVariants } from '@/components/ui/pill';
import { walletSplit } from '@/lib/wallet-split';
import { rm, rm0 } from '@/lib/format';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Wallet' };

// The rules as the owner set them (spec 2026-10-15, revised: bonus credit and
// the welcome pack go through packs twice; gift packs, task and challenge
// rewards sell back withdrawable) — one bold lead each.
const RULES = [
  {
    lead: 'Top-ups are for opening packs.',
    body: 'A top-up can’t be withdrawn as it is. Topping up never lowers what you can already withdraw.',
  },
  {
    lead: 'Cards you pull are yours.',
    body: 'Ship them, or sell them back for withdrawable money. That includes packs you pay for, gift packs from us, and everything you win in tasks and the weekly challenge.',
  },
  {
    lead: 'Bonus credit and the welcome pack are for packs.',
    body: 'Bonus credit comes from check-ins, tasks, challenges, VIP vouchers and promotions. Every pack uses it first. Selling a card pulled with bonus credit or from the welcome pack gives you money for packs. If bonus credit paid only part of the pack, only that part is for packs. Spend that money on a pack, and cards from that pack sell back as withdrawable money, except any part paid with bonus credit.',
  },
];

// An RM figure never breaks across lines ("RM" / "30.00").
const Rm = ({ n }: { n: number }) => (
  <span className="whitespace-nowrap">{rm(n)}</span>
);

const FIGURE =
  'font-heading whitespace-nowrap font-bold tabular-nums text-white';

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
  const split = walletSplit({ ...w, remaining: w.playthrough.remaining });

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
      {!w.isFrozen && !w.hasTopup && (
        <div
          role="status"
          className="mb-4 rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-3.5"
        >
          <p className="flex items-center gap-2 text-sm font-semibold text-white">
            <Lock className="h-4 w-4 shrink-0 text-sky-400" aria-hidden />
            Top up once to unlock withdrawals
          </p>
          <p className="mt-1.5 text-sm text-white/70">
            {split.afterTopup > 0 ? (
              <>
                Top up once (from{' '}
                <span className="whitespace-nowrap">
                  {rm0(limits.deposit.minRm)}
                </span>
                ) and <Rm n={split.afterTopup} /> of your balance becomes
                withdrawable. Card deliveries start then too.
              </>
            ) : (
              <>
                Withdrawals and card deliveries start after your first top-up
                (from{' '}
                <span className="whitespace-nowrap">
                  {rm0(limits.deposit.minRm)}
                </span>
                ).
              </>
            )}
          </p>
          <TopUpButton size="sm" className="mt-3" />
        </div>
      )}

      {/* ---- Money: Balance = Withdrawable (+ after top-up) + For packs ---- */}
      <Panel className="mb-4">
        <h2 className="sr-only">Your money</h2>
        <p className="text-[11px] uppercase tracking-wide text-neutral-400">
          Balance
        </p>
        <p className={`mt-1 text-3xl sm:text-4xl ${FIGURE}`}>{rm(w.balance)}</p>

        <div className="mt-5 grid gap-5 border-t border-white/10 pt-5 sm:grid-cols-2">
          <div>
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-[11px] uppercase tracking-wide text-neutral-400">
                Withdrawable
              </p>
              <p className={`text-xl sm:text-2xl ${FIGURE}`}>
                {rm(w.withdrawable)}
              </p>
            </div>
            {/* Never topped up: the banner above already says when
                withdrawals start, so only the figure waiting on it. */}
            {(w.isFrozen || w.hasTopup || split.afterTopup > 0) && (
              <p className="mt-1.5 text-[13px] text-white/60">
                {w.isFrozen ? (
                  'Held while your account is under review.'
                ) : w.hasTopup ? (
                  'Can go to your bank. The withdraw page shows the minimum.'
                ) : (
                  <>
                    Withdrawable after your first top-up:{' '}
                    <Rm n={split.afterTopup} />
                  </>
                )}
              </p>
            )}
            {!w.isFrozen && w.hasTopup && (
              <Link
                href="/bank-withdrawal"
                className={cn(
                  pillVariants({ variant: 'secondary', size: 'sm' }),
                  'mt-3',
                )}
              >
                Withdraw
              </Link>
            )}
          </div>

          <div>
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-[11px] uppercase tracking-wide text-neutral-400">
                For packs
              </p>
              <p className={`text-xl sm:text-2xl ${FIGURE}`}>
                {rm(split.forPacks)}
              </p>
            </div>
            {/* Frozen reads available 0 — a split of nothing would only
                confuse; the Withdrawable line says why. */}
            {!w.isFrozen && (
              <>
                <dl className="mt-2 space-y-1 text-[13px]">
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-white/70">
                      Bonus credit{' '}
                      <span className="text-white/60">· used first</span>
                    </dt>
                    <dd className="whitespace-nowrap tabular-nums text-white">
                      {rm(split.bonus)}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-white/70">Still to use on packs</dt>
                    <dd className="whitespace-nowrap tabular-nums text-white">
                      {rm(split.stillToUse)}
                    </dd>
                  </div>
                </dl>
                <p className="mt-2 text-[13px] text-white/60">
                  Use this to open packs. It can&rsquo;t go to your bank.
                </p>
                <Link
                  href="/transactions"
                  className="inline-flex min-h-11 items-center text-[12px] font-semibold text-white/70 underline-offset-2 hover:text-white hover:underline"
                >
                  See where your for-packs money came from&nbsp;
                  <span aria-hidden>→</span>
                </Link>
              </>
            )}
          </div>
        </div>
      </Panel>

      {/* ---- How it works (explainer sits last — numbers first) ------------- */}
      <Panel>
        <h2 className="font-heading text-lg font-bold text-white">
          How withdrawals work
        </h2>

        <ol className="mt-4 space-y-4">
          {RULES.map((r, i) => (
            <li key={r.lead} className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-[12px] font-bold text-white">
                {i + 1}
              </span>
              <p className="text-sm text-white/60">
                <strong className="font-semibold text-white">{r.lead}</strong>{' '}
                {r.body}
              </p>
            </li>
          ))}
        </ol>

        <p className="mt-4 text-sm font-semibold text-white">
          You need one top-up before you can withdraw or ship cards.
        </p>

        <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-[11px] uppercase tracking-wide text-neutral-400">
            Example
          </p>
          <ul className="mt-2 space-y-1.5 text-sm text-white/70">
            <li>
              Top up <Rm n={50} /> → <Rm n={50} /> for packs.
            </li>
            <li>
              Open a <Rm n={45} /> pack → <Rm n={5} /> for packs.
            </li>
            <li>
              Sell the card back for <Rm n={30} /> →{' '}
              <span className="font-semibold text-white">
                <Rm n={30} /> withdrawable
              </span>
              .
            </li>
          </ul>
          <p className="mt-3 text-sm text-white/70">
            Another example: you have <Rm n={9} /> bonus credit. Open a{' '}
            <Rm n={45} /> pack and sell its card for <Rm n={30} /> →{' '}
            <Rm n={6} /> is for packs, <Rm n={24} /> is withdrawable.
          </p>
        </div>

        <p className="mt-4 text-[13px] text-white/60">
          VIP and the leaderboard count the part of each pack you paid yourself.
          Packs paid half or more with bonus credit don&rsquo;t count toward
          tasks.
        </p>

        <p className="mt-3 text-[13px] text-white/60">
          Frozen accounts are held until review. Top-ups are credited after the
          payment provider confirms payment. Bank withdrawals require a
          withdrawable balance and a saved bank account; processing status
          appears on the withdrawal page. Sell-back money reaches your balance
          at once. Money from the welcome pack&rsquo;s card, and the part of any
          sale paid with bonus credit, is for packs. The rest is withdrawable
          after your first top-up.
        </p>
      </Panel>
    </>
  );
}
