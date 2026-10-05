'use client';

import { Check } from 'lucide-react';
import { Pill } from '@/components/ui/pill';
import { HelpTip } from '@/components/ui/help-tip';
import { cn } from '@/lib/utils';
import { rm } from '@/lib/format';
import type { TaskEntry } from '@/lib/data/schemas';
import { RewardArt, Sparkles } from './reward-art';
import { isClaimable, rewardLabel } from './task-hub';

const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;

const worth = (t: TaskEntry): string => {
  const { name, value } = rewardLabel(t.reward);
  return t.reward.type !== 'credit' && value != null && value > 0
    ? `${name} (${rm(value)})`
    : name;
};

/** The sentence under the track: what is ready, or what is next. */
function nextLine(
  count: number,
  milestones: Map<number, TaskEntry[]>,
): { text: string; ready: boolean } {
  const days = [...milestones.keys()].sort((a, b) => a - b);
  const ready = days.find((d) => milestones.get(d)!.some(isClaimable));
  if (ready != null)
    return {
      text: `Day ${ready} reward is ready — tap it to claim.`,
      ready: true,
    };
  for (const day of days) {
    const next =
      day > count ? milestones.get(day)?.find((t) => !t.claimed) : undefined;
    if (next) {
      const togo = day - count;
      return {
        text: `${togo} more ${togo === 1 ? 'check-in' : 'check-ins'} to day ${day}: ${worth(next)}.`,
        ready: false,
      };
    }
  }
  return days.length
    ? { text: 'Every check-in reward this week is yours.', ready: false }
    : {
        text: 'Check in each day to keep your streak this week.',
        ready: false,
      };
}

/**
 * The week's check-in track: seven card-shaped slots, Day 1…Day 7 — the COUNT
 * of check-ins this task week, which is exactly what weekly "check in on N
 * days" tasks measure (not weekdays: a player who starts on Thursday still
 * reaches Day 3). Each of those tasks sits on its slot N as the prize's own
 * art; a claimable one breathes gold and sparkles, and the slot IS the claim
 * button.
 */
export function CheckInTrack({
  count,
  checkedInToday,
  milestones,
  onCheckIn,
  checkingIn,
  onClaim,
  claimingId,
  onNotice,
}: {
  count: number;
  checkedInToday: boolean;
  milestones: Map<number, TaskEntry[]>;
  onCheckIn: () => void;
  checkingIn: boolean;
  onClaim: (t: TaskEntry) => void;
  claimingId: string | null;
  onNotice: (message: string) => void;
}) {
  const line = nextLine(count, milestones);
  return (
    <section
      aria-labelledby="checkin-heading"
      className="rounded-2xl border border-white/10 bg-neutral-900 p-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2
          id="checkin-heading"
          className="font-heading flex items-center gap-1 text-lg text-white"
        >
          CHECK-IN
          <HelpTip label="How check-in works">
            Check in once a day. Every check-in fills the next slot; the track
            and its rewards reset every Monday at 00:00 (Malaysia time), so
            claim before then.
          </HelpTip>
        </h2>
        <p className="text-xs text-neutral-400">
          <span className="font-heading text-base text-white tabular-nums">
            {count}
          </span>
          /7 this week
        </p>
      </div>

      <ol className="mt-3 grid grid-cols-7 gap-1.5 sm:gap-2">
        {DAYS.map((day) => {
          const tasks = milestones.get(day) ?? [];
          const lead =
            tasks.find(isClaimable) ??
            tasks.find((t) => !t.claimed) ??
            tasks[0];
          const done = day <= count;
          const isNext = !checkedInToday && day === count + 1;
          const claimable = Boolean(lead && isClaimable(lead));
          const claimed = Boolean(lead && tasks.every((t) => t.claimed));
          const extra = tasks.length - 1;

          const face = (
            <>
              <span
                className={cn(
                  'absolute top-1 left-1.5 text-[9px] font-semibold tabular-nums sm:text-[10px]',
                  done ? 'text-white' : 'text-neutral-500',
                )}
              >
                {day}
              </span>
              {lead ? (
                <RewardArt
                  reward={lead.reward}
                  claimed={claimed}
                  compact
                  className="h-[64%] w-[78%] rounded-md border-0 bg-transparent"
                />
              ) : done ? (
                <Check className="h-4 w-4 text-white" aria-hidden />
              ) : null}
              {done && lead && (
                <span className="absolute right-1 bottom-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-white text-neutral-950">
                  <Check className="h-2.5 w-2.5" strokeWidth={3} aria-hidden />
                </span>
              )}
              {claimable && <Sparkles />}
              {extra > 0 && (
                <span className="absolute top-1 right-1 rounded-full bg-white/15 px-1 text-[8px] leading-tight text-white">
                  +{extra}
                </span>
              )}
            </>
          );

          const tile = cn(
            'relative flex aspect-[5/7] w-full items-center justify-center rounded-lg border transition-transform',
            done
              ? 'border-white/20 bg-white/[0.09]'
              : 'border-white/10 bg-neutral-950',
            isNext && 'border-white/60',
            claimable && 'claim-ring border-transparent bg-chase/[0.08]',
          );

          return (
            <li key={day}>
              {lead ? (
                <button
                  type="button"
                  disabled={claimingId === lead.id}
                  onClick={() =>
                    claimable
                      ? onClaim(lead)
                      : onNotice(
                          claimed
                            ? `Day ${day} reward claimed: ${worth(lead)}.`
                            : `Day ${day} reward: ${worth(lead)}. Check in ${day} ${day === 1 ? 'day' : 'days'} this week to unlock it.`,
                        )
                  }
                  aria-label={`Day ${day} reward: ${worth(lead)}. ${claimable ? 'Ready — claim it.' : claimed ? 'Claimed.' : `Unlocks at ${day} check-ins.`}`}
                  className={cn(
                    tile,
                    'outline-none focus-visible:ring-2 focus-visible:ring-white/40 active:scale-[0.97] motion-reduce:active:scale-100',
                  )}
                >
                  {face}
                </button>
              ) : (
                <div
                  className={tile}
                  aria-label={`Day ${day}${done ? ', checked in' : ''}`}
                >
                  {face}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <p
        className={cn(
          'mt-3 text-xs',
          line.ready ? 'text-chase font-semibold' : 'text-neutral-400',
        )}
      >
        {line.text}
      </p>

      <Pill
        className="mt-3 w-full"
        variant={checkedInToday ? 'secondary' : 'primary'}
        disabled={checkedInToday || checkingIn || count >= 7}
        onClick={onCheckIn}
      >
        {checkedInToday ? (
          <>
            <Check className="h-4 w-4" aria-hidden /> Checked in today
          </>
        ) : (
          `Check in · Day ${Math.min(count + 1, 7)}`
        )}
      </Pill>
    </section>
  );
}
