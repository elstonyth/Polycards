'use client';

import { Check, Lock } from 'lucide-react';
import { Pill } from '@/components/ui/pill';
import { HelpTip } from '@/components/ui/help-tip';
import { rmAuto } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { TaskEntry } from '@/lib/data/schemas';
import { RewardArt, Sparkles } from './reward-art';
import {
  dayWorth,
  isClaimable,
  isWaitingOnTopUp,
  ticketCountLabel,
  topUpAsk,
  type CheckinUnlock,
} from './task-hub';

const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** The sentence under the track: what is ready, or what is next. */
function nextLine(
  count: number,
  milestones: Map<number, TaskEntry[]>,
): { text: string; ready: boolean } {
  const days = [...milestones.keys()].sort((a, b) => a - b);
  const ready = days.find((d) => milestones.get(d)!.some(isClaimable));
  if (ready != null)
    return {
      text: `Day ${ready} reward is ready: ${dayWorth(milestones.get(ready)!)}. Tap it to claim.`,
      ready: true,
    };
  // Earned but waiting for this week's top-up: the bar under the line says
  // how much is left, so this line only names the prize that is waiting.
  const waiting = days.find((d) => milestones.get(d)!.some(isWaitingOnTopUp));
  if (waiting != null)
    return {
      text: `Day ${waiting} reward is waiting for this week's top-up: ${dayWorth(milestones.get(waiting)!)}.`,
      ready: false,
    };
  for (const day of days) {
    const tasks = milestones.get(day) ?? [];
    if (day > count && tasks.some((t) => !t.claimed)) {
      const togo = day - count;
      return {
        text: `${togo} more ${togo === 1 ? 'check-in' : 'check-ins'} to day ${day}: ${dayWorth(tasks)}.`,
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

/** Where this week's top-ups stand against the bar check-in rewards wait for
 *  (owner 2026-11-20), with the way to top up. Shown only while the bar is
 *  unmet and the track still has a prize to unlock. */
function TopUpBar({
  unlock,
  onTopUp,
}: {
  unlock: CheckinUnlock;
  onTopUp: () => void;
}) {
  const required = unlock.required_myr;
  const done = Math.max(0, Math.min(unlock.topped_up_myr, required));
  const pct = required > 0 ? Math.floor((done / required) * 100) : 0;
  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-center gap-3">
        <Lock className="h-4 w-4 shrink-0 text-neutral-400" aria-hidden />
        <p className="min-w-0 flex-1 text-xs leading-snug text-neutral-300">
          {topUpAsk(unlock)} to unlock your check-in rewards.
        </p>
        <Pill size="sm" variant="secondary" onClick={onTopUp}>
          Top up
        </Pill>
      </div>
      <div className="mt-2.5 flex items-center gap-2.5">
        <div
          className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-white/10"
          role="progressbar"
          aria-valuenow={done}
          aria-valuemin={0}
          aria-valuemax={required}
          aria-valuetext={`${rmAuto(done)} of ${rmAuto(required)}`}
          aria-label="Topped up this week"
        >
          <span
            className="bar-grow rounded-full bg-neutral-50"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="font-heading shrink-0 text-sm leading-none whitespace-nowrap text-white tabular-nums">
          {rmAuto(done)}
          <span className="text-[11px] text-neutral-400">
            /{rmAuto(required)}
          </span>
        </span>
      </div>
    </div>
  );
}

/**
 * The week's check-in track: seven card-shaped slots, Day 1…Day 7 — the COUNT
 * of check-ins this task week, which is exactly what weekly "check in on N
 * days" tasks measure (not weekdays: a player who starts on Thursday still
 * reaches Day 3). Each of those tasks sits on its slot N as the prize's own
 * art; a claimable one breathes gold and sparkles, and the slot IS the claim
 * button. An earned slot still waiting for this week's top-up wears a lock.
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
  unlock,
  onTopUp,
}: {
  count: number;
  checkedInToday: boolean;
  milestones: Map<number, TaskEntry[]>;
  onCheckIn: () => void;
  checkingIn: boolean;
  onClaim: (t: TaskEntry) => void;
  claimingId: string | null;
  onNotice: (message: string) => void;
  /** This week's top-ups against the reward bar; absent = no bar. */
  unlock?: CheckinUnlock;
  onTopUp: () => void;
}) {
  const line = nextLine(count, milestones);
  const showBar =
    unlock != null &&
    !unlock.unlocked &&
    [...milestones.values()].some((tasks) => tasks.some((t) => !t.claimed));
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
            Check in once a day. Every check-in fills the next slot.
            {unlock
              ? ` Rewards unlock once you top up ${rmAuto(unlock.required_myr)} in the same week, and then every slot you have filled can be claimed.`
              : ''}{' '}
            The track and its rewards reset every Monday at 00:00 (Malaysia
            time), so claim before then.
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
          const waiting = Boolean(lead && !claimable && isWaitingOnTopUp(lead));
          const claimed = Boolean(lead && tasks.every((t) => t.claimed));
          const extra = tasks.length - 1;
          const ticketCount = lead ? ticketCountLabel(lead.reward) : null;

          const face = (
            <>
              {(lead || done) && (
                <span
                  className={cn(
                    'absolute top-1 left-1.5 text-[9px] font-semibold tabular-nums sm:text-[10px]',
                    done ? 'text-white' : 'text-neutral-400',
                  )}
                >
                  {day}
                </span>
              )}
              {lead ? (
                <RewardArt
                  reward={lead.reward}
                  claimed={claimed}
                  compact
                  className="h-[72%] w-[88%] rounded-md border-0 bg-transparent"
                />
              ) : done ? (
                <Check className="h-4 w-4 text-white" aria-hidden />
              ) : (
                // A slot with no prize still reads as a day to fill: its
                // numeral, set large in Nekst, lit when it is the next one.
                <span
                  aria-hidden
                  className={cn(
                    'font-heading text-lg tabular-nums sm:text-3xl',
                    isNext ? 'text-white' : 'text-neutral-700',
                  )}
                >
                  {day}
                </span>
              )}
              {done && lead && (
                <span
                  className={cn(
                    'absolute right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-white text-neutral-950',
                    // Clears the ticket count, which hangs off the bottom edge.
                    ticketCount ? 'bottom-2.5' : 'bottom-1',
                  )}
                >
                  {waiting ? (
                    <Lock className="h-2 w-2" strokeWidth={3} aria-hidden />
                  ) : (
                    <Check
                      className="h-2.5 w-2.5"
                      strokeWidth={3}
                      aria-hidden
                    />
                  )}
                </span>
              )}
              {claimable && <Sparkles />}
              {ticketCount && (
                <span
                  className={cn(
                    'font-heading absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-white/10 bg-neutral-950 px-1 py-px text-[10px] leading-tight whitespace-nowrap tabular-nums sm:px-1.5 sm:text-xs',
                    claimed ? 'text-neutral-400' : 'text-chase',
                  )}
                >
                  {ticketCount}
                </span>
              )}
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
                            ? `Day ${day} reward claimed: ${dayWorth(tasks)}.`
                            : waiting
                              ? `Day ${day} reward: ${dayWorth(tasks)}. ${topUpAsk(unlock)} to claim it.`
                              : `Day ${day} reward: ${dayWorth(tasks)}. Check in ${day} ${day === 1 ? 'day' : 'days'} this week to unlock it.`,
                        )
                  }
                  aria-label={`Day ${day} reward: ${dayWorth(tasks)}. ${claimable ? 'Ready — claim it.' : claimed ? 'Claimed.' : waiting ? 'Waiting for this week\u2019s top-up.' : `Unlocks at ${day} check-ins.`}`}
                  className={cn(
                    tile,
                    // An OUTLINE focus ring: the claimable glow animates
                    // box-shadow, which would paint over a ring-* focus style.
                    'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70 active:scale-[0.97] motion-reduce:active:scale-100',
                  )}
                >
                  {face}
                </button>
              ) : (
                <div className={tile}>
                  <span className="sr-only">
                    {`Day ${day}${done ? ', checked in' : ''}`}
                  </span>
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

      {showBar && unlock && <TopUpBar unlock={unlock} onTopUp={onTopUp} />}

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
