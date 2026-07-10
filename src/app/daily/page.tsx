import type { Metadata } from 'next';
import { AlertCircle, Gift } from 'lucide-react';
import { getDaily } from '@/lib/actions/daily';
import DailyClient from './DailyClient';
import JoinPrompt from './JoinPrompt';

export const metadata: Metadata = {
  title: 'Daily Rewards',
  description: 'Open your daily box and claim vouchers on PixelSlot.',
};

// Draw/claim state is per-customer and per-day — always fresh.
export const dynamic = 'force-dynamic';

export default async function DailyPage() {
  const result = await getDaily();

  if (result.ok) {
    return (
      <div className="px-fluid pt-6">
        <DailyClient initial={result.state} />
      </div>
    );
  }

  // Logged out: dormant box teaser + join prompt.
  if (result.needsAuth) {
    return (
      <div className="px-fluid mx-auto w-full max-w-md py-10 text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-neutral-900">
          <Gift className="h-7 w-7 text-neutral-400" aria-hidden />
        </span>
        <h1 className="font-heading mt-4 text-3xl text-white">DAILY REWARDS</h1>
        <p className="mx-auto mt-2 max-w-[36ch] text-sm leading-relaxed text-neutral-400">
          Open a free box every day and claim vouchers as you level up.
        </p>

        <JoinPrompt needsAuth error={result.error} />
      </div>
    );
  }

  // Backend error (not an auth issue): red error panel, matching DailyClient.
  return (
    <div className="px-fluid mx-auto w-full max-w-md py-10 text-center">
      <h1 className="font-heading text-3xl text-white">DAILY REWARDS</h1>
      <div className="mt-6 flex items-center gap-2.5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3.5 text-left text-sm font-medium text-red-300">
        <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
        {result.error}
      </div>
    </div>
  );
}
