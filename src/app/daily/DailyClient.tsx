'use client';

import { useState } from 'react';
import { Check, Gift, PauseCircle } from 'lucide-react';
import { rm } from '@/lib/format';
import { cn } from '@/lib/utils';
import { claimDailyReward, type DailyStatus } from '@/lib/actions/daily';
import { useTopUp } from '@/components/app-shell/TopUpProvider';

/**
 * The 7-day check-in calendar (luka.game's daily-login pattern). Days before
 * the current streak position are collected; today claims; the rest preview.
 */
export default function DailyClient({ initial }: { initial: DailyStatus }) {
  const [claimedToday, setClaimedToday] = useState(initial.claimedToday);
  const [streakDay, setStreakDay] = useState(initial.streakDay);
  const [justClaimed, setJustClaimed] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { applyBalance } = useTopUp();

  const enabled = initial.enabled;
  const todayAmount = initial.amounts[streakDay - 1] ?? 0;

  async function claim() {
    if (busy || claimedToday || !enabled) return;
    setBusy(true);
    setError(null);
    try {
      const res = await claimDailyReward();
      if (!res.ok) {
        if (res.code === 'already_claimed') setClaimedToday(true);
        setError(res.error);
        return;
      }
      setStreakDay(res.streakDay);
      setClaimedToday(true);
      setJustClaimed(res.amount);
      applyBalance(res.balance);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <div className="text-center">
        <h1 className="font-heading text-3xl text-white">DAILY REWARDS</h1>
        <p className="mt-1 text-[13px] text-neutral-400">
          Check in every day — miss a day and the streak starts over.
        </p>
      </div>

      {!enabled && (
        <div className="mt-6 flex items-center gap-3 rounded-2xl border border-white/10 bg-neutral-900 p-4">
          <PauseCircle
            className="h-5 w-5 shrink-0 text-neutral-400"
            aria-hidden
          />
          <p className="text-sm text-neutral-300">
            Daily rewards are paused right now. Check back soon.
          </p>
        </div>
      )}

      {/* Streak strip */}
      <p className="mt-6 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
        {claimedToday
          ? `Day ${streakDay} collected — back tomorrow for day ${(streakDay % 7) + 1}`
          : `You're on day ${streakDay} of 7`}
      </p>

      {/* 7-day calendar */}
      <div className="mt-3 grid grid-cols-3 gap-2">
        {initial.amounts.map((amount, i) => {
          const day = i + 1;
          const collected =
            day < streakDay || (day === streakDay && claimedToday);
          const isToday = day === streakDay && !claimedToday;
          return (
            <div
              key={day}
              className={cn(
                'rounded-2xl border p-3 text-center transition-colors',
                day === 7 ? 'col-span-3' : '',
                collected
                  ? 'border-green-400/30 bg-green-400/5'
                  : isToday
                    ? 'border-white bg-neutral-900'
                    : 'border-white/10 bg-neutral-900',
              )}
              aria-label={`Day ${day}: ${rm(amount)}${
                collected ? ', collected' : isToday ? ', claim today' : ''
              }`}
            >
              <p
                className={cn(
                  'text-[11px] font-semibold uppercase tracking-wide',
                  isToday ? 'text-white' : 'text-neutral-500',
                )}
              >
                {isToday ? 'Today' : `Day ${day}`}
              </p>
              {collected ? (
                <Check
                  className="mx-auto mt-2 h-5 w-5 text-green-400"
                  aria-hidden
                />
              ) : (
                <Gift
                  className={cn(
                    'mx-auto mt-2 h-5 w-5',
                    isToday ? 'text-chase' : 'text-neutral-600',
                  )}
                  aria-hidden
                />
              )}
              <p
                className={cn(
                  'font-heading mt-1.5 text-sm',
                  collected
                    ? 'text-green-400/70'
                    : isToday
                      ? 'text-chase'
                      : 'text-neutral-400',
                )}
              >
                {rm(amount)}
              </p>
            </div>
          );
        })}
      </div>

      {justClaimed != null && (
        <p
          role="status"
          className="mt-4 rounded-xl border border-green-400/30 bg-green-400/10 px-4 py-3 text-center text-sm font-semibold text-green-400"
        >
          {rm(justClaimed)} added to your balance
        </p>
      )}
      {error && (
        <p className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-[13px] font-medium text-red-300">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={claim}
        disabled={busy || claimedToday || !enabled}
        className="mt-5 inline-flex h-12 w-full items-center justify-center rounded-full bg-neutral-50 text-sm font-semibold text-neutral-950 transition-transform active:scale-[0.98] disabled:opacity-40"
      >
        {busy
          ? 'Claiming…'
          : claimedToday
            ? 'Claimed — back tomorrow'
            : enabled
              ? `Claim ${rm(todayAmount)}`
              : 'Paused'}
      </button>
    </div>
  );
}
