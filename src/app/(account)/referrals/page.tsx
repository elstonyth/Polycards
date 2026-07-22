import type { Metadata } from 'next';
import Link from 'next/link';
import { Crown, UserPlus, Users } from 'lucide-react';
import { getReferralSummary } from '@/lib/actions/referral';
import { getOwnProfileHandle } from '@/lib/data/profiles';
import { rm } from '@/lib/format';
import { SITE_URL } from '@/lib/site';
import { AccountHeader } from '@/components/account/ui';
import ReferralsClient, { ShareInviteButton } from './ReferralsClient';

export const metadata: Metadata = { title: 'Invite Friends' };

export default async function ReferralsPage() {
  const [res, handle] = await Promise.all([
    getReferralSummary(),
    getOwnProfileHandle().catch(() => null),
  ]);

  if (!res.ok) {
    return (
      <>
        <AccountHeader title="Invite friends" />
        <p className="rounded-xl border border-white/10 bg-neutral-900 p-4 text-sm text-neutral-400">
          {res.error}
        </p>
      </>
    );
  }

  // Canonical origin (NEXT_PUBLIC_SITE_URL) — already absolute, no dead
  // `polycards.com` fallback. See src/lib/site.ts.
  const inviteUrl = handle ? `${SITE_URL}/invite/${handle}` : null;

  return (
    <>
      <AccountHeader
        title="Invite friends"
        sub={
          <>
            Earn credit on every pack your recruits rip.{' '}
            <span className="text-chase font-semibold">
              Your rate grows with your VIP level
            </span>
            .
          </>
        }
      />

      {/* Invite link + share (showgo's invite screen, dark skin) */}
      {inviteUrl ? (
        <ReferralsClient inviteUrl={inviteUrl} />
      ) : (
        // Handles are assigned by the backend on the first
        // GET /store/profiles/me, never by the customer: getOwnProfileHandle
        // returns null only when that call fails (fetchProfileHandle swallows
        // the error), and the (account) layout has already bounced anyone who
        // is signed out. So this is a transient backend fault, NOT a missing
        // setting. There is no handle field in Settings and there should not
        // be one; if this state ever turns out to be persistent for a
        // customer, the fix belongs in the backend's lazy-assign path.
        <p className="rounded-xl border border-white/10 bg-neutral-900 p-4 text-sm text-neutral-400">
          We couldn&rsquo;t load your invite link just now. Refresh the page to
          try again, or{' '}
          <Link href="/contact" className="font-semibold text-white underline">
            contact support
          </Link>{' '}
          if it keeps happening.
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
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-white/10 bg-neutral-900 px-6 py-10 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/5">
            <UserPlus className="h-6 w-6 text-white/50" aria-hidden />
          </span>
          <h3 className="font-heading text-lg font-bold text-white">
            No recruits yet
          </h3>
          <p className="max-w-sm text-sm text-neutral-400">
            Share your invite link and you earn on their very first rip.
          </p>
          {inviteUrl && <ShareInviteButton inviteUrl={inviteUrl} />}
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
