import type { Metadata } from 'next';
import Link from 'next/link';
import { Crown, UserPlus, Users } from 'lucide-react';
import { getReferralSummary } from '@/lib/actions/referral';
import { getOwnProfileHandle } from '@/lib/data/profiles';
import { rm } from '@/lib/format';
import { SITE_URL } from '@/lib/site';
import ReferralsClient from './ReferralsClient';

export const metadata: Metadata = { title: 'Invite Friends' };

export default async function ReferralsPage() {
  const [res, handle] = await Promise.all([
    getReferralSummary(),
    getOwnProfileHandle().catch(() => null),
  ]);

  if (!res.ok) {
    return (
      <>
        <h1 className="font-heading text-3xl text-white">INVITE FRIENDS</h1>
        <p className="mt-4 rounded-xl border border-white/10 bg-neutral-900 p-4 text-sm text-neutral-400">
          {res.error}
        </p>
      </>
    );
  }

  // Canonical origin (NEXT_PUBLIC_SITE_URL) — already absolute, no dead
  // `pokenic.com` fallback. See src/lib/site.ts.
  const inviteUrl = handle ? `${SITE_URL}/invite/${handle}` : null;

  return (
    <>
      <h1 className="font-heading text-3xl text-white">INVITE FRIENDS</h1>
      <p className="mt-1 text-[13px] text-neutral-400">
        Earn credit on every pack your recruits rip —{' '}
        <span className="text-chase font-semibold">
          your rate grows with your VIP level
        </span>
        .
      </p>

      {/* Invite link + share (showgo's invite screen, dark skin) */}
      {inviteUrl ? (
        <ReferralsClient inviteUrl={inviteUrl} />
      ) : (
        <p className="mt-4 rounded-xl border border-white/10 bg-neutral-900 p-4 text-sm text-neutral-400">
          Set a profile handle in{' '}
          <Link href="/settings" className="font-semibold text-white underline">
            Settings
          </Link>{' '}
          to get your invite link.
        </p>
      )}

      {/* Stats strip */}
      <div className="mt-4 grid grid-cols-3 divide-x divide-white/10 rounded-2xl border border-white/10 bg-neutral-900 py-4">
        {[
          {
            icon: UserPlus,
            label: 'Invited',
            value: String(res.directRecruits.length),
          },
          { icon: Users, label: 'Team', value: String(res.downstreamCount) },
          {
            icon: Crown,
            label: 'Total earned',
            value: rm(res.totalEarned),
            money: true,
          },
        ].map(({ icon: Icon, label, value, money }) => (
          <div key={label} className="px-3 text-center">
            <Icon className="mx-auto h-4 w-4 text-neutral-500" aria-hidden />
            <p
              className={`font-heading mt-1 truncate text-lg ${
                money ? 'text-buyback-fg' : 'text-white'
              }`}
            >
              {value}
            </p>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
              {label}
            </p>
          </div>
        ))}
      </div>

      {/* Direct recruits */}
      <h2 className="font-heading mb-3 mt-6 text-xl text-white">
        YOUR RECRUITS
      </h2>
      {res.directRecruits.length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-neutral-900 px-6 py-10 text-center">
          <p className="text-sm text-neutral-400">
            No recruits yet — share your invite link above and earn on their
            very first rip.
          </p>
        </div>
      ) : (
        <ul className="overflow-hidden rounded-2xl border border-white/10 bg-neutral-900">
          {res.directRecruits.map((r, i) => (
            <li
              key={r.handle ?? `recruit-${i}`}
              className={`flex items-center justify-between gap-3 px-4 py-3 ${
                i > 0 ? 'border-t border-white/5' : ''
              }`}
            >
              <span className="truncate text-sm font-semibold text-white">
                {r.handle ? `@${r.handle}` : 'Collector'}
              </span>
              <span className="shrink-0 text-[13px] font-semibold text-buyback-fg">
                {rm(r.contribution)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-5 text-[12px] leading-relaxed text-neutral-400">
        Two tiers: you earn a percentage of every direct recruit&rsquo;s spend
        (rate set by your{' '}
        <Link href="/vip" className="text-neutral-300 underline">
          VIP level
        </Link>
        ), plus a flat override on your wider team&rsquo;s spend.
      </p>
    </>
  );
}
