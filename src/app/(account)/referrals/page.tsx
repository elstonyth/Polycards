import type { Metadata } from 'next';
import {
  AccountHeader,
  StatCards,
  Panel,
  DemoNote,
} from '@/components/account/ui';
import { MOCK_USERS } from '@/lib/mock/users';
import { usd } from '@/lib/format';

export const metadata: Metadata = { title: 'Referrals | Pokenic' };

export default function ReferralsPage() {
  return (
    <>
      <AccountHeader
        title="Referrals"
        sub="Invite friends and earn on every pack they rip."
      />
      <StatCards
        items={[
          { label: 'Invited', value: '14' },
          { label: 'Active', value: '9' },
          { label: 'Earned', value: usd(642.5) },
          { label: 'Rate', value: '5%' },
        ]}
      />
      <Panel className="mt-5">
        <p className="mb-2 text-[12px] font-medium text-white/55">
          Your referral link
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            readOnly
            value="pokenic.com/invite/662b59"
            className="h-11 flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-3 text-sm text-white/80 focus:outline-none"
          />
          <button
            type="button"
            className="rounded-xl bg-neutral-200 px-5 py-2.5 text-sm font-semibold text-neutral-950 transition-colors hover:bg-white"
          >
            Copy link
          </button>
        </div>
      </Panel>
      <h2 className="mb-3 mt-6 font-heading text-lg font-bold text-white">
        Invited collectors
      </h2>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {MOCK_USERS.slice(0, 8).map((u) => (
          <li
            key={u.username}
            className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] p-3"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={u.pfp}
              alt=""
              className="h-8 w-8 shrink-0 rounded-full object-cover"
            />
            <span className="truncate text-[13px] text-white/80">
              {u.username}
            </span>
          </li>
        ))}
      </ul>
      <DemoNote />
    </>
  );
}
