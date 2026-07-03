import type { Metadata } from 'next';
import Link from 'next/link';
import { AccountHeader, Panel, StatCards } from '@/components/account/ui';
import { getVip } from '@/lib/actions/vip';
import { rm } from '@/lib/format';

export const metadata: Metadata = { title: 'VIP' };

function rewardLabel(r: {
  voucherAmount: number;
  boxTier: string;
  frameUnlock: boolean;
}): string {
  const parts: string[] = [];
  if (r.voucherAmount > 0) parts.push(`${rm(r.voucherAmount)} voucher`);
  if (r.boxTier) parts.push(`Tier ${r.boxTier.toUpperCase()} box`);
  if (r.frameUnlock) parts.push('a new frame');
  return parts.join(' + ') || 'rewards';
}

export default async function VipPage() {
  const res = await getVip();
  if (!res.ok) {
    return (
      <>
        <AccountHeader title="VIP" sub="Your level and progress." />
        <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-white/60">
          {res.error}
        </p>
      </>
    );
  }
  const v = res.vip;
  const pct =
    v.next && v.next.threshold > 0
      ? Math.min(100, Math.round((v.spend / v.next.threshold) * 100))
      : 100;
  return (
    <>
      <AccountHeader title="VIP" sub="Your level and progress." />
      <StatCards
        items={[
          { label: 'Level', value: `${v.level}` },
          { label: 'Highest ever', value: `${v.highestLevelEver}` },
          { label: 'Lifetime spend', value: rm(v.spend) },
        ]}
      />
      {v.next ? (
        <Panel className="mt-5">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-white/70">
              Level {v.level} → {v.next.level}
            </span>
            <span className="text-white/50">{rm(v.next.remaining)} to go</span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-emerald-400"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-3 text-[13px] text-white/60">
            Level {v.next.level} unlocks {rewardLabel(v.next.reward)}.
          </p>
        </Panel>
      ) : (
        <Panel className="mt-5">
          <p className="text-sm text-white/60">
            You&apos;ve reached the top VIP level. 🏆
          </p>
        </Panel>
      )}
      <p className="mt-4 text-[13px] text-white/40">
        View your daily box and reward grants on the{' '}
        <Link
          href="/rewards"
          className="text-emerald-400 underline-offset-2 hover:underline"
        >
          My Rewards
        </Link>{' '}
        page.
      </p>
    </>
  );
}
