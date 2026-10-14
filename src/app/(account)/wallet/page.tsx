import type { Metadata } from 'next';
import { unstable_rethrow } from 'next/navigation';
import { Check, Lock } from 'lucide-react';
import { AccountHeader, Panel, StatCards } from '@/components/account/ui';
import { PlaythroughProgress } from '@/components/account/PlaythroughProgress';
import { TopUpButton } from '@/components/account/TopUpButton';
import { getWallet } from '@/lib/actions/wallet';
import { getPaymentLimits } from '@/lib/actions/vault';
import { DEFAULT_PAYMENT_LIMITS } from '@/lib/payment-limits';
import { rm, rm0 } from '@/lib/format';

export const metadata: Metadata = { title: 'Wallet' };

export default async function WalletPage() {
  // The payout floor belongs to the active gateway — the same read the
  // withdraw form makes; any failure keeps the defaults.
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

  // Playthrough gate progress. deposited === 0 (no post-1b deposits) means the
  // gate is open with nothing to show — render the unlocked state, not a 0/0
  // bar.
  const { deposited, remaining } = w.playthrough;
  // No top-up ever keeps the gate shut whatever the playthrough says.
  const gateOpen = remaining <= 0 && w.hasTopup;
  // Bonus credit is inside the balance but spend only. The Normal line is the
  // part that can ever be withdrawn — computed in sen so float noise never
  // prints. Hidden while there is no bonus: a zero row would only confuse.
  const hasBonus = Math.round(w.bonus * 100) > 0;
  const normal =
    (Math.round(w.balance * 100) - Math.round(w.bonus * 100)) / 100;
  // The payout floor under Withdrawable. "You need X more" unless a freeze
  // holds the balance — what is still to play is already out of withdrawable
  // (partial unlock, 2026-10-14), so the shortfall is real. In sen, like
  // Normal above.
  const minRm = limits.withdrawal.minRm;
  const shortSen = Math.round(minRm * 100) - Math.round(w.withdrawable * 100);
  const minLine = !w.hasTopup
    ? 'Top up at least once to unlock withdrawals'
    : !w.isFrozen && shortSen > 0
      ? `Minimum withdrawal ${rm0(minRm)} — you need ${rm(shortSen / 100)} more`
      : `Minimum withdrawal ${rm0(minRm)}`;

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
      {!w.isFrozen && !w.hasTopup && normal > 0 && (
        <div
          role="status"
          className="mb-4 rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-3.5"
        >
          <p className="flex items-center gap-2 text-sm font-semibold text-white">
            <Lock className="h-4 w-4 shrink-0 text-sky-400" aria-hidden />
            Top up once to unlock withdrawals
          </p>
          <p className="mt-1.5 text-sm text-white/70">
            Your {rm(normal)} can&rsquo;t be withdrawn or used for card
            deliveries until your first top-up (from {rm0(limits.deposit.minRm)}
            ). After that, play your deposits through on packs and it unlocks,
            winnings included.
          </p>
          <TopUpButton size="sm" className="mt-3" />
        </div>
      )}

      <Panel className="mb-4">
        <p className="text-[11px] uppercase tracking-wide text-white/40">
          Available
        </p>
        <p className="mt-1 font-heading text-4xl font-bold text-white">
          {rm(w.available)}
        </p>
      </Panel>

      {/* ---- Withdrawal gate ------------------------------------------------ */}
      <Panel className="mb-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-heading text-lg font-bold text-white">
              Withdrawal gate
            </h2>
            <p className="mt-1 text-sm text-white/55">
              Money you still need to play stays locked. The rest isn&rsquo;t.
            </p>
          </div>
          <span
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
              gateOpen
                ? 'bg-buyback/15 text-buyback-fg'
                : 'bg-sky-500/15 text-sky-400'
            }`}
          >
            {gateOpen ? (
              <Check className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Lock className="h-3.5 w-3.5" aria-hidden />
            )}
            {gateOpen
              ? 'Unlocked'
              : w.hasTopup
                ? `${rm(remaining)} to play`
                : 'Locked'}
          </span>
        </div>

        {deposited > 0 ? (
          <PlaythroughProgress {...w.playthrough} />
        ) : (
          <p className="mt-4 text-sm text-white/70">
            {!w.hasTopup &&
              'Top up at least once to unlock withdrawals and card deliveries. '}
            No deposits to play through. Withdrawals require a saved bank
            account and must fit your withdrawable balance and the limits on the
            withdrawal page.
          </p>
        )}
      </Panel>

      <div className="mb-4">
        {/* No "Locked" tile — held credit is explained in the banner above
            instead of shown as a bare number with no reason attached. */}
        <StatCards
          items={[
            { label: 'Total balance', value: rm(w.balance) },
            ...(hasBonus
              ? [
                  { label: 'Normal', value: rm(normal) },
                  {
                    label: 'Bonus',
                    value: rm(w.bonus),
                    sub: 'spend only · can’t withdraw',
                  },
                ]
              : []),
            {
              label: 'Withdrawable',
              value: rm(w.withdrawable),
              sub: minLine,
            },
          ]}
        />
      </div>

      {/* ---- How it works (explainer sits last — numbers first) ------------- */}
      <Panel>
        <h2 className="font-heading text-lg font-bold text-white">
          How withdrawals work
        </h2>

        <ol className="mt-4 space-y-4">
          {[
            {
              title: 'Play what you top up',
              body: 'Money you top up must be spent on packs once before you can withdraw it. So must the bonus part of cards you sell.',
            },
            {
              title: 'Packs use it up first',
              body: 'Each pack you open uses this money first, right after bonus credit. Topping up never locks money you could already withdraw.',
            },
            {
              title: 'The rest is yours',
              body: 'Everything else, winnings included, can be withdrawn once it reaches the minimum. Bonus credit is for packs only and is used first. Task, check-in and challenge rewards are bonus credit. Bonus play does not count toward VIP or the leaderboard, and mostly-bonus packs do not count toward tasks. Nothing expires.',
            },
          ].map((s, i) => (
            <li key={s.title} className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-[12px] font-bold text-white">
                {i + 1}
              </span>
              <div>
                <p className="text-sm font-semibold text-white">{s.title}</p>
                <p className="mt-0.5 text-sm text-white/60">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>

        {/* Worked example — the sell-back case is the one customers get wrong:
            selling back plays nothing, but only the unplayed part is held. */}
        <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-[11px] uppercase tracking-wide text-white/40">
            Example
          </p>
          <ul className="mt-2 space-y-1.5 text-sm text-white/70">
            <li>You top up RM100 — RM100 to play.</li>
            <li>You open RM50 of packs — RM50 left to play.</li>
            <li>
              You sell cards for RM100 — balance RM150.{' '}
              <span className="font-semibold text-white">
                RM50 stays locked
              </span>
              ; RM100 can be withdrawn.
            </li>
            <li>You open RM50 more — all RM100 can be withdrawn.</li>
          </ul>
        </div>

        <p className="mt-4 text-[13px] text-white/50">
          Frozen accounts are held until review. Top-ups are credited after the
          payment provider confirms payment. Bank withdrawals require a
          withdrawable balance and a saved bank account; processing status
          appears on the withdrawal page. Buyback credit is available
          immediately.
        </p>
      </Panel>
    </>
  );
}
