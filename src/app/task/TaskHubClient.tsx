'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CalendarCheck, Check, Crown, Gift, ListChecks } from 'lucide-react';
import { checkInToday, claimTaskReward } from '@/lib/actions/tasks';
import { Pill, pillVariants } from '@/components/ui/pill';
import { HelpTip } from '@/components/ui/help-tip';
import {
  Panel,
  SignInPrompt,
  Stat,
  TabBanner,
  UnavailablePanel,
} from '@/components/task-ui';
import { cn } from '@/lib/utils';
import { rm } from '@/lib/format';
import type { TaskEntry, TaskHub } from '@/lib/data/schemas';

// Two tabs since 2026-08-25: Referral moved to its own /referral page (linked
// from the Me quick-access grid), and the VIP rebate it sat beside was
// removed outright. VIP survives inside this tab as the ladder the
// "Reach level N" achievements are measured against — hence the level stat,
// even though the tab itself is just called Achievements.
type TabKey = 'weekly' | 'achievements';

const TABS: { key: TabKey; label: string; icon: typeof ListChecks }[] = [
  { key: 'weekly', label: 'Weekly Tasks', icon: ListChecks },
  { key: 'achievements', label: 'Achievements', icon: Crown },
];

const REWARD_LABEL: Record<string, string> = {
  credit: 'Credit',
  pack: 'Free rip',
  card: 'Card',
};

function rewardLabel(reward: TaskEntry['reward']): string {
  if (reward.type === 'credit' && typeof reward.amount_myr === 'number') {
    return rm(reward.amount_myr);
  }
  // A free rip names its pack — "Free rip · Bronze Pack" — so the player
  // knows what they are working towards before they claim it. The slug is
  // the fallback (a backend that predates pack_title, or a pack that has
  // since been deleted): never a bare "Free rip" again.
  if (reward.type === 'pack' && (reward.pack_title || reward.pack_id)) {
    return `Free rip · ${reward.pack_title || reward.pack_id}`;
  }
  return REWARD_LABEL[reward.type] ?? 'Reward';
}

// Deliberately NOT a link to the pack page: a draft or deleted pack 404s
// there, and an 11px inline chip cannot meet the focus-ring / 44px tap-target
// rules DESIGN.md sets for interactive elements. The name is the point.
function RewardChip({ reward }: { reward: TaskEntry['reward'] }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-neutral-300">
      <Gift className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{rewardLabel(reward)}</span>
    </span>
  );
}

// Every way a claim can decline, in the customer's words.
const CLAIM_FAILURE_COPY: Record<string, string> = {
  already_claimed: 'Already claimed.',
  not_completed: 'Not completed yet.',
  window_closed: 'This task has ended.',
  not_found: 'This task is no longer available.',
};
const CLAIM_FALLBACK = 'Could not claim this right now.';

function TaskRow({
  task,
  onDone,
}: {
  task: TaskEntry;
  onDone: (message: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const pctDone =
    task.progress.target > 0
      ? Math.round((task.progress.current / task.progress.target) * 100)
      : 0;
  const claim = () =>
    startTransition(async () => {
      const res = await claimTaskReward(task.id);
      if (res.ok && res.claimed) {
        // A pack reward is a free RIP, so the claim hands the player to the
        // slot to take it. The entitlement is already recorded server-side —
        // if they never arrive, or bail before spinning, it waits for them on
        // /task rather than evaporating.
        if (res.spin) {
          onDone('Free rip unlocked — spinning it up…');
          router.push(
            `/slots/${encodeURIComponent(res.spin.packId)}/spin?freeRip=${encodeURIComponent(res.spin.claimId)}`,
          );
          return;
        }
        onDone(
          res.rewardType === 'credit'
            ? 'Credit added to your wallet.'
            : 'Card added to your vault.',
        );
      } else if (res.ok && !res.claimed) {
        onDone(CLAIM_FAILURE_COPY[res.reason] ?? CLAIM_FALLBACK);
      } else if (!res.ok) {
        onDone(res.error);
      }
      router.refresh();
    });
  return (
    <li className="flex items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-white">{task.title}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <div
            className="h-1.5 w-28 overflow-hidden rounded-full bg-neutral-800"
            role="progressbar"
            aria-valuenow={task.progress.current}
            aria-valuemin={0}
            aria-valuemax={task.progress.target}
            aria-label={`${task.title} progress`}
          >
            <div
              className="bg-chase h-full rounded-full"
              style={{ width: `${pctDone}%` }}
            />
          </div>
          <span className="text-xs text-white/40 tabular-nums">
            {task.progress.current}/{task.progress.target}
          </span>
          <RewardChip reward={task.reward} />
        </div>
      </div>
      {task.claimed ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-300 uppercase">
          <Check className="h-3 w-3" aria-hidden /> Claimed
        </span>
      ) : (
        <Pill
          size="sm"
          variant={task.progress.completed ? 'primary' : 'ghost'}
          disabled={!task.progress.completed || pending}
          onClick={claim}
        >
          Claim
        </Pill>
      )}
    </li>
  );
}

function WeeklyTab({
  data,
  isLoggedIn,
}: {
  data: TaskHub | null;
  isLoggedIn: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const router = useRouter();
  if (!data) {
    return isLoggedIn ? (
      <UnavailablePanel />
    ) : (
      <SignInPrompt what="your weekly tasks" />
    );
  }

  const weekly = data.tasks.filter((t) => t.kind === 'weekly');
  const checkIn = () =>
    startTransition(async () => {
      const res = await checkInToday();
      setNotice(
        res.ok
          ? res.checked
            ? 'Checked in — see you tomorrow!'
            : 'Already checked in today.'
          : res.error,
      );
      router.refresh();
    });

  return (
    <div>
      <TabBanner
        src="/images/task/tasks-banner.webp"
        title="WEEKLY TASKS"
        sub="Check in, rip packs, claim the rewards — every week."
      />
      <div className="space-y-4">
        <Panel className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-neutral-900">
            <CalendarCheck className="text-chase h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1 text-sm font-semibold text-white">
              Daily check-in
              <HelpTip label="How the weekly reset works">
                Weekly tasks and their progress reset every Monday at 00:00
                (Malaysia time). Anything you have finished but not claimed by
                then is gone, so claim before the reset.
              </HelpTip>
            </p>
            <p className="text-xs text-neutral-500">
              Week of {data.week_start} — check-ins feed the weekly tasks.
            </p>
          </div>
          <Pill
            size="sm"
            variant={data.checked_in_today ? 'ghost' : 'primary'}
            disabled={data.checked_in_today || pending}
            onClick={checkIn}
          >
            {data.checked_in_today ? (
              <>
                <Check className="h-4 w-4" aria-hidden /> Done
              </>
            ) : (
              'Check in'
            )}
          </Pill>
        </Panel>

        {notice && (
          <p
            aria-live="polite"
            className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-neutral-300"
          >
            {notice}
          </p>
        )}

        {data.pending_spins.length > 0 && (
          // An entitlement outlives the task that granted it — a retired task,
          // or one whose window closed, must not take an unspent free rip with
          // it. So this is driven by the claims, not by the rows above.
          <Panel className="border-chase/40 bg-chase/[0.06]">
            <p className="text-sm font-semibold text-white">
              {data.pending_spins.length === 1
                ? 'You have a free rip waiting'
                : `You have ${data.pending_spins.length} free rips waiting`}
            </p>
            <ul className="mt-2 space-y-2">
              {data.pending_spins.map((s) => (
                <li
                  key={s.claim_id}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="min-w-0 flex-1 text-xs text-neutral-400">
                    <span className="block truncate">{s.title}</span>
                    {(s.pack_title || s.pack_id) && (
                      <span className="block truncate text-neutral-200">
                        {s.pack_title || s.pack_id}
                      </span>
                    )}
                  </span>
                  <Link
                    href={`/slots/${encodeURIComponent(s.pack_id)}/spin?freeRip=${encodeURIComponent(s.claim_id)}`}
                    className={cn(pillVariants({ size: 'sm' }))}
                  >
                    Spin it
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        <Panel>
          <p className="mb-1 flex items-center gap-1.5 text-[11px] tracking-wide text-white/40 uppercase">
            <ListChecks className="h-3.5 w-3.5" aria-hidden /> This week
          </p>
          {weekly.length === 0 ? (
            <p className="py-3 text-center text-sm text-neutral-500">
              No weekly tasks right now — check back soon.
            </p>
          ) : (
            <ul className="divide-y divide-white/5">
              {weekly.map((t) => (
                <TaskRow key={t.id} task={t} onDone={setNotice} />
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

function AchievementsTab({
  data,
  isLoggedIn,
}: {
  data: TaskHub | null;
  isLoggedIn: boolean;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  if (!data) {
    return isLoggedIn ? (
      <UnavailablePanel />
    ) : (
      <SignInPrompt what="your achievements" />
    );
  }

  const achievements = data.tasks.filter((t) => t.kind === 'achievement');
  const done = achievements.filter((t) => t.claimed).length;

  return (
    <div>
      <TabBanner
        src="/images/task/vip-banner.webp"
        title="ACHIEVEMENTS"
        sub="Climb the VIP ladder and fill the vault — one-off rewards."
      />
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <Stat
            label="VIP level"
            value={`L${data.vip_level}`}
            help={
              <HelpTip label="How VIP levels work">
                Your VIP level rises with lifetime spend. Achievements below
                that say &ldquo;reach level N&rdquo; are measured against this
                number, and each one pays out once.
              </HelpTip>
            }
          />
          <Stat label="Claimed" value={`${done}/${achievements.length}`} />
        </div>

        {notice && (
          <p
            aria-live="polite"
            className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-neutral-300"
          >
            {notice}
          </p>
        )}

        <Panel>
          <p className="mb-1 flex items-center gap-1.5 text-[11px] tracking-wide text-white/40 uppercase">
            <Crown className="h-3.5 w-3.5" aria-hidden /> Achievements
          </p>
          {achievements.length === 0 ? (
            <p className="py-3 text-center text-sm text-neutral-500">
              No achievements configured yet.
            </p>
          ) : (
            <ul className="divide-y divide-white/5">
              {achievements.map((t) => (
                <TaskRow key={t.id} task={t} onDone={setNotice} />
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

export function TaskHubClient({
  taskHub,
  isLoggedIn,
}: {
  taskHub: TaskHub | null;
  isLoggedIn: boolean;
}) {
  const [tab, setTab] = useState<TabKey>('weekly');
  return (
    <div className="px-fluid mx-auto w-full max-w-2xl py-6">
      <h1 className="font-heading text-3xl text-white">TASK</h1>
      <div
        role="tablist"
        aria-label="Task hub sections"
        className="mt-4 flex gap-2"
      >
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              pillVariants({
                variant: tab === key ? 'primary' : 'ghost',
                size: 'sm',
              }),
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
            {label}
          </button>
        ))}
      </div>
      <div className="mt-4">
        {tab === 'weekly' && (
          <WeeklyTab data={taskHub} isLoggedIn={isLoggedIn} />
        )}
        {tab === 'achievements' && (
          <AchievementsTab data={taskHub} isLoggedIn={isLoggedIn} />
        )}
      </div>
    </div>
  );
}
