import type { Metadata } from 'next';
import { AccountHeader, DemoNote } from '@/components/account/ui';
import { MOCK_USERS } from '@/lib/mock/users';

export const metadata: Metadata = { title: 'Messages | Pokenic' };

const PREVIEWS = [
  'gg on that pull!',
  'Is the listing still available?',
  'Trade offer sent your way',
  'Thanks for the fast shipping',
  'Let me know if you want to sell',
  'Appreciate the deal 🙌',
];

export default function MessagesPage() {
  return (
    <>
      <AccountHeader
        title="Messages"
        sub="Conversations with other collectors."
      />
      <ul className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
        {MOCK_USERS.slice(0, 7).map((u, i) => (
          <li
            key={u.username}
            className="flex items-center gap-3 border-b border-white/5 px-4 py-3 last:border-0 hover:bg-white/[0.02]"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={u.pfp}
              alt=""
              className="h-10 w-10 shrink-0 rounded-full object-cover"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-white">
                {u.username}
              </p>
              <p className="truncate text-[13px] text-white/50">
                {PREVIEWS[i % PREVIEWS.length]}
              </p>
            </div>
            <span className="shrink-0 text-[11px] text-white/35">
              {(i + 1) * 2}h
            </span>
            {i < 2 && (
              <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
            )}
          </li>
        ))}
      </ul>
      <DemoNote />
    </>
  );
}
