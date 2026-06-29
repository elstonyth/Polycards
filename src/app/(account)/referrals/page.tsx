import type { Metadata } from 'next';
import { AccountHeader, StatCards } from '@/components/account/ui';
import { getReferralSummary } from '@/lib/actions/referral';
import { getOwnProfileHandle } from '@/lib/data/profiles';
import { rm } from '@/lib/format';
import ReferralsClient from './ReferralsClient';

export const metadata: Metadata = { title: 'Referrals' };

export default async function ReferralsPage() {
  const [res, handle] = await Promise.all([
    getReferralSummary(),
    getOwnProfileHandle().catch(() => null),
  ]);

  if (!res.ok) {
    return (
      <>
        <AccountHeader
          title="Referrals"
          sub="Invite friends and earn on every pack they rip."
        />
        <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-white/60">
          {res.error}
        </p>
      </>
    );
  }

  const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN ?? 'pokenic.com';
  const inviteUrl = handle ? `${appDomain}/invite/${handle}` : null;

  return (
    <>
      <AccountHeader
        title="Referrals"
        sub="Invite friends and earn on every pack they rip."
      />
      <StatCards
        items={[
          { label: 'Direct recruits', value: `${res.directRecruits.length}` },
          { label: 'Network size', value: `${res.downstreamCount}` },
          { label: 'Total earned', value: rm(res.totalEarned) },
        ]}
      />
      {inviteUrl && <ReferralsClient inviteUrl={inviteUrl} />}
      <h2 className="mb-3 mt-6 font-heading text-lg font-bold text-white">
        Your direct recruits
      </h2>
      {res.directRecruits.length === 0 ? (
        <p className="text-sm text-white/50">
          No recruits yet — share your invite link above.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {res.directRecruits.map((r, i) => (
            <li
              key={r.handle ?? `recruit-${i}`}
              className="flex items-center justify-between gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] p-3"
            >
              <span className="truncate text-[13px] text-white/80">
                {r.handle ?? 'Collector'}
              </span>
              <span className="shrink-0 text-[12px] text-emerald-300">
                {rm(r.contribution)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
