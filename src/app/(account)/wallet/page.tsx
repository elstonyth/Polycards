import type { Metadata } from 'next';
import {
  AccountHeader,
  Panel,
  StatCards,
  Badge,
} from '@/components/account/ui';
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
          sub="Your available and locked balance."
        />
        <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-white/60">
          {res.error}
        </p>
      </>
    );
  }

  const w = res.wallet;

  return (
    <>
      <AccountHeader title="Wallet" sub="Your available and locked balance." />

      {w.isFrozen && (
        <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
          Your account is frozen — available balance is held until review.
        </div>
      )}

      <Panel className="mb-4">
        <p className="text-[11px] uppercase tracking-wide text-white/40">
          Available
        </p>
        <p className="mt-1 font-heading text-4xl font-bold text-white">
          {rm(w.available)}
        </p>
        {w.nextUnlock && (
          <p className="mt-3 text-sm text-white/60">
            <Badge tone="sky">Locked</Badge> {rm(w.nextUnlock.amount)} unlocking
            on{' '}
            {new Date(w.nextUnlock.date).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
            })}
          </p>
        )}
      </Panel>

      <StatCards
        items={[
          { label: 'Total balance', value: rm(w.balance) },
          { label: 'Available', value: rm(w.available) },
          { label: 'Locked', value: rm(w.locked) },
        ]}
      />
    </>
  );
}
