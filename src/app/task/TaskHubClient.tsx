'use client';

import { useMemo, useState, useTransition } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  CalendarCheck,
  ChevronsUp,
  Crown,
  Flag,
  Layers,
  ListChecks,
  Lock,
  PackageOpen,
  Sun,
  Target,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { checkInToday } from '@/lib/actions/tasks';
import { Pill, pillVariants } from '@/components/ui/pill';
import { HelpTip } from '@/components/ui/help-tip';
import { TicketArt } from '@/components/TicketArt';
import {
  Panel,
  SignInPrompt,
  Stat,
  TabBanner,
  UnavailablePanel,
} from '@/components/task-ui';
import { cn } from '@/lib/utils';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import type { TaskEntry, TaskHub } from '@/lib/data/schemas';
import { CheckInTrack } from './CheckInTrack';
import { RewardArt } from './reward-art';
import {
  challengeOf,
  challengeStatus,
  checkinCount,
  claimableCounts,
  isClaimable,
  progressOf,
  splitHub,
  stubName,
  type Challenge,
  type ChallengeKind,
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

const CHALLENGE_ICON: Record<ChallengeKind, LucideIcon> = {
  rip: PackageOpen,
  pull: Target,
  vault: Layers,
  level: ChevronsUp,
  checkin: CalendarCheck,
  topup: Wallet,
  other: Flag,
};

/** The middle of the goal's sum: the pack to rip or the Pokémon to pull,
 *  else the goal's icon — also when the picture fails to load, and for a
 *  Pokémon under reduced motion (its sprite is an animated GIF that CSS
 *  cannot pause). Named for screen readers either way: the admin's title
 *  need not say which pack or Pokémon. */
function GoalArt({ goal }: { goal: Challenge }) {
  const reduced = usePrefersReducedMotion();
  const [broken, setBroken] = useState(false);
  const Icon = CHALLENGE_ICON[goal.kind];
  const pull = goal.kind === 'pull';
  const src = goal.art && !broken && !(pull && reduced) ? goal.art : null;
  return (
    <span className="relative flex h-14 w-11 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04]">
      {src ? (
        <Image
          src={src}
          alt={goal.subject ?? ''}
          fill
          sizes="44px"
          // Pixel sprites stay crisp (and animated) unscaled by the optimizer.
          unoptimized={pull}
          onError={() => setBroken(true)}
          className={cn(
            'object-contain',
            pull ? 'p-1.5 [image-rendering:pixelated]' : 'p-1',
          )}
        />
      ) : (
        <>
          <Icon className="h-5 w-5 text-neutral-300" aria-hidden />
          {goal.subject && <span className="sr-only">{goal.subject}</span>}
        </>
      )}
    </span>
  );
}

/**
 * One task as a ticket (2026-10-19, "left is the challenge, right is the
 * reward"). The body reads the goal as a sum the player gets at a glance —
 * "RIP [Bronze Pack] ×10" — then the task's own words and how far along it
 * is, a pip per step when the goal is a small count. The prize sits on a
 * perforated tear-off stub: a Claim pill once it can be claimed, a Locked
 * chip until then. A claimable ticket goes gold (the prize sparkles, a light
 * sweeps its Claim); a claimed one is stamped and steps back.
 */
function TaskRow({ task, onClaim, claimingId }: { task: TaskEntry } & Claim) {
  const claimable = isClaimable(task);
  const { claimed } = task;
  const goal = challengeOf(task);
  const progress = progressOf(task);
  const { target } = task.progress;
  const fill = claimed ? 'bg-neutral-600' : 'bg-chase';
  return (
    <li className="relative isolate flex [--stub:7rem] sm:[--stub:8.5rem]">
      <span
        aria-hidden
        className={cn(
          'ticket-cut absolute inset-0 -z-10 rounded-xl border',
          claimable
            ? 'border-chase/45 [--ticket-body:rgb(255_176_32/0.04)] [--ticket-stub:rgb(255_176_32/0.11)]'
            : claimed
              ? 'border-white/[0.06] [--ticket-body:transparent] [--ticket-stub:rgb(255_255_255/0.02)]'
              : 'border-white/10 [--ticket-body:rgb(255_255_255/0.025)] [--ticket-stub:rgb(255_255_255/0.055)]',
        )}
      />

      <div className="flex min-w-0 flex-1 flex-col justify-center py-3.5 pr-3 pl-3.5">
        {/* What to do, as a sum: verb · what · how many. */}
        <div
          className={cn(
            'flex flex-wrap items-center gap-x-2 gap-y-1',
            claimed && 'opacity-50',
          )}
        >
          <span className="font-heading text-lg leading-none text-white">
            {goal.verb}
          </span>
          <GoalArt key={goal.art ?? goal.kind} goal={goal} />
          <span className="font-heading text-2xl leading-none whitespace-nowrap text-white tabular-nums">
            {goal.amount}
          </span>
        </div>
        <p
          className={cn(
            'mt-2.5 text-xs leading-snug',
            claimed ? 'text-neutral-400' : 'text-neutral-300',
          )}
        >
          {task.title}
        </p>
        <div className="mt-2.5 flex items-center gap-2.5">
          <div
            className={cn(
              'flex h-2 flex-1',
              progress.pips
                ? 'gap-[3px]'
                : 'overflow-hidden rounded-full bg-white/10',
            )}
            role="progressbar"
            aria-valuenow={progress.done}
            aria-valuemin={0}
            aria-valuemax={target}
            aria-valuetext={progress.label}
            aria-label={`${task.title} progress`}
          >
            {progress.pips ? (
              // One pip per step, lighting up in turn: 3/10 reads as three
              // things done, not as a 30% sliver.
              Array.from({ length: target }, (_, i) => (
                <span
                  key={i}
                  className={cn(
                    'flex-1 rounded-full',
                    i < progress.done ? cn(fill, 'bar-grow') : 'bg-white/10',
                  )}
                  style={{ '--i': i } as React.CSSProperties}
                />
              ))
            ) : (
              <span
                className={cn('bar-grow rounded-full', fill)}
                style={{ width: `${progress.pct}%` }}
              />
            )}
          </div>
          <span className="font-heading shrink-0 text-sm leading-none whitespace-nowrap text-white tabular-nums">
            {progress.count.done}
            {progress.count.of && (
              <span className="text-[11px] text-neutral-400">
                /{progress.count.of}
              </span>
            )}
          </span>
        </div>
        <p
          className={cn(
            'mt-1.5 text-[11px] leading-snug',
            claimable ? 'text-chase font-semibold' : 'text-neutral-400',
          )}
        >
          {challengeStatus(task)}
        </p>
      </div>

      {/* The perforation the stub tears off along. */}
      <span
        aria-hidden
        className="my-3 border-l border-dashed border-white/15"
      />

      <div className="flex w-[var(--stub)] shrink-0 flex-col items-center px-2 pt-3.5 pb-3">
        <span className="relative">
          <RewardArt
            reward={task.reward}
            claimable={claimable}
            claimed={claimed}
            className="h-[72px] w-[60px]"
          />
          {claimed && (
            <span className="font-heading absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 -rotate-[14deg] rounded-md border-2 border-neutral-300/80 bg-neutral-950/70 px-1.5 py-0.5 text-[11px] leading-none whitespace-nowrap text-neutral-200">
              CLAIMED
            </span>
          )}
        </span>
        {/* The name WRAPS rather than truncates: a card name clipped to
            "Poncho-Weari…" on a phone is exactly the "what do I get?"
            complaint this page exists to answer. */}
        <p
          className={cn(
            'mt-3.5 text-center text-[11px] leading-tight text-balance',
            claimed ? 'text-neutral-400' : 'text-neutral-200',
          )}
        >
          {stubName(task.reward)}
        </p>
        {/* The Lucky Draw tickets this task also pays; taps through to the
            draw so the player sees where they go. */}
        {task.tickets > 0 && (
          <Link
            href="/lucky-draw"
            className={cn(
              // Tighter on a phone: "+999 tickets" must fit the 7rem stub.
              'mt-2 inline-flex items-center gap-0.5 rounded-full border px-1.5 py-1 text-[11px] font-semibold whitespace-nowrap sm:gap-1 sm:px-2.5',
              claimed
                ? 'border-white/10 text-neutral-400'
                : 'border-chase/40 text-chase',
            )}
          >
            <TicketArt width={16} className="shrink-0" />+{task.tickets}{' '}
            {task.tickets === 1 ? 'ticket' : 'tickets'}
          </Link>
        )}
        {/* Only a prize that can be claimed gets a button; one still being
            worked for says so instead of showing a dead Claim. */}
        {claimable ? (
          <Pill
            disabled={claimingId === task.id}
            onClick={() => onClaim(task)}
            aria-label={`Claim ${task.title}`}
            className="claim-sweep mt-2.5 w-full px-0"
          >
            Claim
          </Pill>
        ) : (
          !claimed && (
            <span className="mt-2 inline-flex items-center gap-1 rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-semibold text-neutral-400">
              <Lock className="h-3 w-3" aria-hidden /> Locked
            </span>
          )
        )}
      </div>
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
  // No panel around the tickets: each is its own surface, and a box around
  // boxes is a nested card.
  return (
    <section>
      <div className="flex items-center justify-between gap-2 px-1">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-white">
          <Icon className="h-4 w-4 text-neutral-400" aria-hidden /> {heading}
        </p>
        {resets && <p className="text-[11px] text-neutral-400">{resets}</p>}
      </div>
      {tasks.length === 0 ? (
        <Panel className="mt-2.5 py-5 text-center text-sm text-neutral-400">
          {empty}
        </Panel>
      ) : (
        <ul className="mt-2.5 space-y-2.5">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} {...claim} />
          ))}
        </ul>
      )}
    </section>
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
                Your VIP level rises with the part of each pack you pay yourself
                &mdash; bonus credit, gift packs, the welcome pack and task
                reward packs don&rsquo;t count. Achievements below that say
                &ldquo;reach level N&rdquo; are measured against this number,
                and each one pays out once.
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

      {taskHub && (
        <div className="mt-6 space-y-1 text-xs leading-relaxed text-neutral-400">
          <p>
            Task rewards (cards, slabs, and cards from reward packs) sell back
            as cash you can withdraw once you’ve topped up and used your money
            for packs. Cards from daily tasks work like the welcome pack: pay
            for one pack yourself to unlock selling &amp; delivery. Credit
            rewards are bonus credit for packs.{' '}
            <Link
              href="/wallet"
              className="font-semibold text-neutral-300 underline-offset-2 hover:text-white hover:underline"
            >
              How it works <span aria-hidden="true">&rarr;</span>
            </Link>
          </p>
          <p>
            Daily and weekly tasks count packs you pay for. Packs paid half or
            more with bonus credit, gift packs, the welcome pack and task reward
            packs don&rsquo;t count.
          </p>
        </div>
      )}
    </div>
  );
}
