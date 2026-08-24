import type { Metadata } from 'next';
import { Check, Lock } from 'lucide-react';
import { AccountHeader, Panel, StatCards } from '@/components/account/ui';
import { getWallet } from '@/lib/actions/wallet';
import { rm } from '@/lib/format';

export const metadata: Metadata = { title: 'Wallet' };

export default async function WalletPage() {
  const res = await getWallet();

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
  // bar. used can exceed deposited once the customer keeps playing, so clamp.
  const { deposited, used, remaining } = w.playthrough;
  const gateOpen = remaining <= 0;
  const pct =
    deposited > 0 ? Math.min(100, Math.round((used / deposited) * 100)) : 100;

  return (
    <>
      <AccountHeader title="Wallet" sub="Your balance and withdrawal status." />

      {w.isFrozen && (
        <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
          An admin has frozen this account — your balance is held until review.
          Contact support if you think this is a mistake.
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
              Deposits must be played through on packs before any balance can be
              withdrawn.
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
            {gateOpen ? 'Unlocked' : 'Locked'}
          </span>
        </div>

        {deposited > 0 ? (
          <>
            <div
              className="mt-4 h-2 overflow-hidden rounded-full bg-neutral-800"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-label="Deposit playthrough progress"
            >
              <div
                className={`h-full rounded-full ${
                  gateOpen ? 'bg-buyback' : 'bg-sky-400'
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
              <span className="text-white/70">
                {rm(Math.min(used, deposited))} of {rm(deposited)} deposits
                played through
              </span>
              <span
                className={
                  gateOpen ? 'text-buyback-fg' : 'font-semibold text-white'
                }
              >
                {gateOpen ? 'Fully played through' : `${rm(remaining)} to go`}
              </span>
            </div>
          </>
        ) : (
          <p className="mt-4 text-sm text-white/70">
            No deposits to play through — your balance is withdrawable as soon
            as payouts open.
          </p>
        )}
      </Panel>

      <div className="mb-4">
        {/* No "Locked" tile — held credit is explained in the banner above
            instead of shown as a bare number with no reason attached. */}
        <StatCards
          items={[
            { label: 'Total balance', value: rm(w.balance) },
            { label: 'Withdrawable', value: rm(w.withdrawable) },
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
              title: 'Play through what you deposit',
              body: 'Every RM you top up has to be spent opening packs before it can leave your account. Deposit RM100, open RM100 of packs — gate unlocked.',
            },
            {
              title: 'Opening packs is what counts — not topping up',
              body: 'Every pack you open uses your deposit up first, so it moves the gate until your deposits are fully spent — even when you pay with sell-back credit. Topping up again does not unlock anything: it adds to what you still have to play through.',
            },
            {
              title: 'Then the whole balance unlocks',
              body: 'Once you are fully played through, your entire available balance is withdrawable — winnings included, not just your deposit back. Nothing expires and there is no waiting period.',
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
            a bigger balance does not unlock anything. */}
        <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-[11px] uppercase tracking-wide text-white/40">
            Example
          </p>
          <ul className="mt-2 space-y-1.5 text-sm text-white/70">
            <li>You deposit RM100 — RM100 to play through.</li>
            <li>You open RM50 of packs — RM50 to go.</li>
            <li>
              You sell cards back for RM100 — balance is now RM150, but selling
              back is not playthrough, so it is{' '}
              <span className="font-semibold text-white">still RM50 to go</span>
              . Withdrawable stays RM0.
            </li>
            <li>
              You open RM50 more — gate unlocked, and the full RM100 balance
              becomes withdrawable.
            </li>
          </ul>
        </div>

        <p className="mt-4 text-[13px] text-white/50">
          Frozen accounts are held until review. Bank payouts go live with the
          payment gateway — until then your balance stays spendable on packs and
          sell-back credit lands instantly.
        </p>
      </Panel>
    </>
  );
}
