'use client';

import { useMemo, useState, useTransition } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, Crown, ListChecks, Sun } from 'lucide-react';
import { checkInToday } from '@/lib/actions/tasks';
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
import { CheckInTrack } from './CheckInTrack';
import { RewardArt } from './reward-art';
import {
  checkinCount,
  claimableCounts,
  isClaimable,
  rewardLabel,
  splitHub,
  type HubTabs,
} from './task-hub';
import { useClaimTask } from './use-claim-task';

// Three tabs since 2026-10-06 (daily cadence). Daily opens first: the check-in
// track is the one thing worth doing every visit. Referral lives on its own
// /referral page; VIP survives inside Achievements as the ladder the "Reach
// level N" achievements are measured against.
type TabKey = 'daily' | 'weekly' | 'achievements';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'achievements', label: 'Achievements' },
];

type Claim = {
  onClaim: (t: TaskEntry) => void;
  claimingId: string | null;
};

/**
 * One task: the prize's own art on the left (so the player SEES what they are
 * working towards, not just reads it), the goal and its progress, the claim
 * on the right. A claimable row lifts onto a gold hairline with the prize
 * sparkling and a light sweeping its Claim pill; a claimed one steps back.
 */
function TaskRow({ task, onClaim, claimingId }: { task: TaskEntry } & Claim) {
  const claimable = isClaimable(task);
  const { name, value } = rewardLabel(task.reward);
  const pct =
    task.progress.target > 0
      ? Math.round((task.progress.current / task.progress.target) * 100)
      : 0;
  return (
    <li
      className={cn(
        'flex items-center gap-3 rounded-xl px-2.5 py-3',
        claimable && 'bg-chase/[0.06] ring-chase/40 ring-1',
      )}
    >
      <RewardArt
        reward={task.reward}
        claimable={claimable}
        claimed={task.claimed}
        className="h-[76px] w-16"
      />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'text-sm leading-snug font-semibold',
            task.claimed ? 'text-neutral-400' : 'text-white',
          )}
        >
          {task.title}
        </p>
        {/* The name WRAPS rather than truncates: a card name clipped to
            "Poncho-Weari…" on a phone is exactly the "what do I get?"
            complaint this page exists to answer. */}
        <p className="mt-0.5 text-xs leading-snug text-neutral-300">
          {name}
          {task.reward.type !== 'credit' && value != null && value > 0 && (
            <span className="text-chase font-semibold whitespace-nowrap tabular-nums">
              {' '}
              · worth {rm(value)}
            </span>
          )}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <div
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-800"
            role="progressbar"
            aria-valuenow={task.progress.current}
            aria-valuemin={0}
            aria-valuemax={task.progress.target}
            aria-label={`${task.title} progress`}
          >
            <div
              className={cn(
                'h-full rounded-full',
                task.claimed ? 'bg-neutral-600' : 'bg-chase',
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-[11px] text-neutral-400 tabular-nums">
            {task.progress.current}/{task.progress.target}
          </span>
        </div>
      </div>
      {task.claimed ? (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white/[0.06] px-2.5 py-1 text-[11px] font-semibold text-neutral-400">
          <Check className="h-3 w-3" aria-hidden /> Claimed
        </span>
      ) : (
        <Pill
          size="sm"
          variant={claimable ? 'primary' : 'ghost'}
          disabled={!claimable || claimingId === task.id}
          onClick={() => onClaim(task)}
          aria-label={`Claim ${task.title}`}
          className={cn('shrink-0', claimable && 'claim-sweep')}
        >
          Claim
        </Pill>
      )}
    </li>
  );
}

function TaskList({
  heading,
  icon: Icon,
  resets,
  tasks,
  empty,
  ...claim
}: {
  heading: string;
  icon: typeof ListChecks;
  resets?: string;
  tasks: TaskEntry[];
  empty: string;
} & Claim) {
  return (
    <Panel className="px-2 pt-3 pb-1">
      <div className="flex items-center justify-between gap-2 px-2.5">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-white">
          <Icon className="h-4 w-4 text-neutral-400" aria-hidden /> {heading}
        </p>
        {resets && <p className="text-[11px] text-neutral-400">{resets}</p>}
      </div>
      {tasks.length === 0 ? (
        <p className="px-2.5 py-5 text-center text-sm text-neutral-400">
          {empty}
        </p>
      ) : (
        <ul className="mt-1 space-y-1">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} {...claim} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

// An entitlement outlives the task that granted it — a retired task, or one
// whose window closed, must not take an unspent free rip with it. So this is
// driven by the claims, not by the rows, and sits above the tabs: a free rip
// waiting is no single tab's business.
function PendingSpins({ spins }: { spins: TaskHub['pending_spins'] }) {
  if (spins.length === 0) return null;
  return (
    <Panel className="border-chase/40 bg-chase/[0.06]">
      <p className="text-sm font-semibold text-white">
        {spins.length === 1
          ? 'You have a free rip waiting'
          : `You have ${spins.length} free rips waiting`}
      </p>
      <ul className="mt-3 space-y-2">
        {spins.map((s) => (
          <li key={s.claim_id} className="flex items-center gap-3">
            <span className="relative h-12 w-10 shrink-0">
              {s.pack_image && (
                <Image
                  src={s.pack_image}
                  alt=""
                  fill
                  sizes="40px"
                  className="object-contain"
                />
              )}
            </span>
            <span className="min-w-0 flex-1 text-xs text-neutral-400">
              <span className="block truncate">{s.title}</span>
              {(s.pack_title || s.pack_id) && (
                <span className="block truncate text-sm font-semibold text-white">
                  {s.pack_title || s.pack_id}
                </span>
              )}
            </span>
            <Link
              href={`/slots/${encodeURIComponent(s.pack_id)}/spin?freeRip=${encodeURIComponent(s.claim_id)}`}
              className={cn(pillVariants({ size: 'sm' }), 'claim-sweep')}
            >
              Spin it
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function DailyTab({
  hub,
  tabs,
  onNotice,
  ...claim
}: {
  hub: TaskHub;
  tabs: HubTabs;
  onNotice: (m: string) => void;
} & Claim) {
  const [checkingIn, startTransition] = useTransition();
  const router = useRouter();
  const checkIn = () =>
    startTransition(async () => {
      const res = await checkInToday();
      onNotice(
        res.ok
          ? res.checked
            ? 'Checked in — see you tomorrow!'
            : 'Already checked in today.'
          : res.error,
      );
      router.refresh();
    });
  return (
    <div className="space-y-4">
      <CheckInTrack
        count={checkinCount(hub, tabs)}
        checkedInToday={hub.checked_in_today}
        milestones={tabs.milestones}
        onCheckIn={checkIn}
        checkingIn={checkingIn}
        onClaim={claim.onClaim}
        claimingId={claim.claimingId}
        onNotice={onNotice}
      />
      <TaskList
        heading="Today"
        icon={Sun}
        resets="Resets 00:00 MYT"
        tasks={tabs.daily}
        empty="No daily tasks right now — check back tomorrow."
        {...claim}
      />
    </div>
  );
}

function WeeklyTab({ tabs, ...claim }: { tabs: HubTabs } & Claim) {
  return (
    <div>
      <TabBanner
        src="/images/task/tasks-banner.webp"
        title="WEEKLY TASKS"
        sub="Rip packs and chase the pulls — fresh goals every Monday."
      />
      <TaskList
        heading="This week"
        icon={ListChecks}
        resets="Resets Monday 00:00 MYT"
        tasks={tabs.weekly}
        empty="No weekly tasks right now — check back soon."
        {...claim}
      />
    </div>
  );
}

function AchievementsTab({
  hub,
  tabs,
  ...claim
}: { hub: TaskHub; tabs: HubTabs } & Claim) {
  const done = tabs.achievements.filter((t) => t.claimed).length;
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
            value={`L${hub.vip_level}`}
            help={
              <HelpTip label="How VIP levels work">
                Your VIP level rises with lifetime spend. Achievements below
                that say &ldquo;reach level N&rdquo; are measured against this
                number, and each one pays out once.
              </HelpTip>
            }
          />
          <Stat label="Claimed" value={`${done}/${tabs.achievements.length}`} />
        </div>
        <TaskList
          heading="Achievements"
          icon={Crown}
          tasks={tabs.achievements}
          empty="No achievements configured yet."
          {...claim}
        />
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
  const [tab, setTab] = useState<TabKey>('daily');
  const [notice, setNotice] = useState<string | null>(null);
  const { claim, pendingId } = useClaimTask(setNotice);
  const tabs = useMemo(
    () => (taskHub ? splitHub(taskHub.tasks) : null),
    [taskHub],
  );
  const ready = tabs ? claimableCounts(tabs) : null;
  const claimProps: Claim = { onClaim: claim, claimingId: pendingId };

  return (
    <div className="px-fluid mx-auto w-full max-w-2xl py-6">
      <h1 className="font-heading text-3xl text-white">TASK</h1>

      {taskHub && (
        <div className="mt-4">
          <PendingSpins spins={taskHub.pending_spins} />
        </div>
      )}

      {/* Plain toggle buttons (aria-pressed), the leaderboard's segmented
          pill. A gold count marks every tab holding something to claim, so
          the player knows where to look without opening each one. */}
      <div
        role="group"
        aria-label="Task hub sections"
        className="mt-4 grid grid-cols-[1fr_1fr_1.45fr] gap-1 rounded-full border border-white/10 bg-neutral-900 p-1 sm:grid-cols-3"
      >
        {TABS.map(({ key, label }) => {
          const n = ready?.[key] ?? 0;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={tab === key}
              onClick={() => setTab(key)}
              aria-label={n > 0 ? `${label}, ${n} to claim` : label}
              className={cn(
                'flex min-h-11 items-center justify-center gap-1 rounded-full px-1.5 text-[13px] font-semibold transition-colors sm:gap-1.5 sm:px-2 sm:text-sm',
                'outline-none focus-visible:ring-2 focus-visible:ring-white/40',
                tab === key
                  ? 'bg-neutral-50 text-neutral-950'
                  : 'text-neutral-400 hover:text-white',
              )}
            >
              {label}
              {n > 0 && (
                <span
                  aria-hidden
                  className="bg-chase inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold text-neutral-950 tabular-nums"
                >
                  {n}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {notice && (
        <p
          aria-live="polite"
          className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-neutral-300"
        >
          {notice}
        </p>
      )}

      <div className="mt-4">
        {!taskHub || !tabs ? (
          isLoggedIn ? (
            <UnavailablePanel />
          ) : (
            <SignInPrompt
              what={
                tab === 'achievements'
                  ? 'your achievements'
                  : tab === 'weekly'
                    ? 'your weekly tasks'
                    : 'your daily check-in'
              }
            />
          )
        ) : tab === 'daily' ? (
          <DailyTab
            hub={taskHub}
            tabs={tabs}
            onNotice={setNotice}
            {...claimProps}
          />
        ) : tab === 'weekly' ? (
          <WeeklyTab tabs={tabs} {...claimProps} />
        ) : (
          <AchievementsTab hub={taskHub} tabs={tabs} {...claimProps} />
        )}
      </div>
    </div>
  );
}
