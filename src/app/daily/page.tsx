import type { Metadata } from 'next';
import { CalendarCheck, Gift } from 'lucide-react';
import { getDailyStatus } from '@/lib/actions/daily';
import DailyClient from './DailyClient';
import JoinPrompt from './JoinPrompt';

export const metadata: Metadata = {
  title: 'Daily Rewards',
  description: 'Claim a free reward every day you check in on Pokenic.',
};

// Claim state is per-customer and per-day — always fresh.
export const dynamic = 'force-dynamic';

const TEASER_DAYS = [1, 2, 3, 4, 5, 6, 7];

export default async function DailyPage() {
  const result = await getDailyStatus();

  if (result.ok) {
    return (
      <div className="px-fluid py-8">
        <DailyClient initial={result.status} />
      </div>
    );
  }

  // Logged out (or backend unavailable): dormant calendar + join prompt.
  return (
    <div className="px-fluid mx-auto w-full max-w-md py-10 text-center">
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-neutral-900">
        <CalendarCheck className="h-7 w-7 text-neutral-400" aria-hidden />
      </span>
      <h1 className="font-heading mt-4 text-3xl text-white">DAILY REWARDS</h1>
      <p className="mx-auto mt-2 max-w-[36ch] text-sm leading-relaxed text-neutral-400">
        Check in every day to build a streak and claim free credits.
      </p>

      <div className="mt-8 grid grid-cols-3 gap-2" aria-hidden>
        {TEASER_DAYS.map((day) => (
          <div
            key={day}
            className={`rounded-2xl border border-white/10 bg-neutral-900 p-4 ${
              day === 7 ? 'col-span-3' : ''
            }`}
          >
            <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
              Day {day}
            </p>
            <Gift className="mx-auto mt-2 h-6 w-6 text-neutral-700" />
          </div>
        ))}
      </div>

      <JoinPrompt needsAuth={result.needsAuth === true} error={result.error} />
    </div>
  );
}
