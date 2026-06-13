import type { Metadata } from 'next';
import { Zap } from 'lucide-react';
import { AccountHeader, Badge, DemoNote } from '@/components/account/ui';
import { MOCK_CARDS } from '@/lib/mock/cards';
import { usd } from '@/lib/format';

export const metadata: Metadata = { title: 'Accelerate Claim | Pokenic' };

export default function AccelerateClaimPage() {
  const claims = MOCK_CARDS.slice(3, 8);
  return (
    <>
      <AccountHeader
        title="Accelerate Claim"
        sub="Skip the queue and get pending redemptions shipped faster."
      />
      <ul className="flex flex-col gap-3">
        {claims.map((c, i) => (
          <li
            key={c.id}
            className="flex items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={c.image}
              alt=""
              className="h-14 w-10 shrink-0 rounded object-contain"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">
                {c.name}
              </p>
              <p className="mt-0.5 flex items-center gap-2 text-[12px] text-white/45">
                <Badge tone={i === 0 ? 'amber' : 'neutral'}>
                  {i === 0 ? 'Processing' : 'Queued'}
                </Badge>
                Est. {10 - i} days
              </p>
            </div>
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3.5 py-2 text-[13px] font-semibold text-amber-300 transition-colors hover:bg-amber-400/20"
            >
              <Zap className="h-3.5 w-3.5" aria-hidden /> Accelerate ·{' '}
              {usd(9.99)}
            </button>
          </li>
        ))}
      </ul>
      <DemoNote />
    </>
  );
}
