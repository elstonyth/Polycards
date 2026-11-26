'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
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
import { useTopUp } from '@/components/app-shell/TopUpProvider';
import { pillVariants } from '@/components/ui/pill';
import {
  PAGE_COLUMN,
  PAGE_FILL,
  PageBody,
  PageTitle,
} from '@/components/ui/page-frame';
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
  type NoticeLink,
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
    <span className="relative flex h-8 w-7 shrink-0 items-center justify-center rounded-md bg-neutral-800">
      {src ? (
        <Image
          src={src}
          alt={goal.subject ?? ''}
          fill
          sizes="28px"
          // Pixel sprites stay crisp (and animated) unscaled by the optimizer.
          unoptimized={pull}
          onError={() => setBroken(true)}
          className={cn(
            'object-contain',
            pull ? 'p-0.5 [image-rendering:pixelated]' : 'p-0.5',
          )}
        />
      ) : (
        <>
          <Icon className="h-4 w-4 text-neutral-300" aria-hidden />
          {goal.subject && <span className="sr-only">{goal.subject}</span>}
        </>
      )}
    </span>
  );
}

/**
 * One task as a panel (redesign v3, 2026-11-26): the prize's own art on the
 * left, then the goal as a sum ("RIP [Bronze Pack] ×10"), the task's words, a
 * thin progress bar with its count (a pip per step when the goal is a small
 * count), the status line and the reward as gold chips. The action sits on the
 * right: an outlined Claim once it can be claimed, a Locked chip until then.
 * A claimable prize sparkles; a claimed one is stamped and steps back.
 */
function TaskRow({ task, onClaim, claimingId }: { task: TaskEntry } & Claim) {
  const claimable = isClaimable(task);
  const { claimed } = task;
  const goal = challengeOf(task);
  const progress = progressOf(task);
  const { target } = task.progress;
  const fill = claimed ? 'bg-neutral-600' : 'bg-glacier-grad';
  return (
    <li
      className={cn(
        'flex items-center gap-3 rounded-3xl border bg-neutral-900 p-3.5 sm:gap-4 sm:p-4',
        claimable ? 'border-chase/40' : 'border-white/10',
      )}
    >
      <span className="relative shrink-0">
        <RewardArt
          reward={task.reward}
          claimable={claimable}
          claimed={claimed}
          className="h-[68px] w-14 rounded-2xl bg-neutral-800"
        />
        {claimed && (
          <span className="font-heading absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 -rotate-[14deg] rounded-md border-2 border-neutral-300/80 bg-neutral-950/70 px-1 py-0.5 text-[10px] leading-none whitespace-nowrap text-neutral-200">
            CLAIMED
          </span>
        )}
      </span>

      <div className="min-w-0 flex-1">
        {/* What to do, as a sum: verb · what · how many. */}
        <div
          className={cn(
            'flex flex-wrap items-center gap-x-1.5 gap-y-1',
            claimed && 'opacity-50',
          )}
        >
          <span className="font-heading text-sm leading-none text-neutral-50">
            {goal.verb}
          </span>
          <GoalArt key={goal.art ?? goal.kind} goal={goal} />
          <span className="font-heading text-base leading-none whitespace-nowrap text-neutral-50 tabular-nums">
            {goal.amount}
          </span>
        </div>
        <p
          className={cn(
            'mt-1.5 text-sm leading-snug font-semibold',
            claimed ? 'text-neutral-400' : 'text-neutral-50',
          )}
        >
          {task.title}
        </p>
        <div className="mt-2 flex items-center gap-2.5">
          <div
            className={cn(
              'flex h-1.5 flex-1',
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
          <span className="shrink-0 text-xs leading-none whitespace-nowrap text-neutral-400 tabular-nums">
            {progress.count.done}
            {progress.count.of && <>/{progress.count.of}</>}
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
        {/* The reward as gold chips. The name WRAPS rather than truncates: a
            card name clipped to "Poncho-Weari…" on a phone is exactly the
            "what do I get?" complaint this page exists to answer. The tickets
            chip taps through to the draw so the player sees where they go. */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              'rounded-lg border px-2 py-0.5 text-[11px] leading-snug font-semibold text-balance',
              claimed
                ? 'border-white/10 text-neutral-400'
                : 'border-chase/30 bg-chase/10 text-chase',
            )}
          >
            {stubName(task.reward)}
          </span>
          {task.tickets > 0 && (
            <Link
              href="/lucky-draw"
              className={cn(
                'inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px] leading-snug font-semibold whitespace-nowrap',
                claimed
                  ? 'border-white/10 text-neutral-400'
                  : 'border-chase/30 bg-chase/10 text-chase',
              )}
            >
              <TicketArt width={14} className="shrink-0" />+{task.tickets}{' '}
              {task.tickets === 1 ? 'ticket' : 'tickets'}
            </Link>
          )}
        </div>
      </div>

      {/* Only a prize that can be claimed gets a button; one still being
          worked for says so instead of showing a dead Claim. Outlined: the
          screen's one filled glacier button is Check in. */}
      {claimable ? (
        <button
          type="button"
          disabled={claimingId === task.id}
          onClick={() => onClaim(task)}
          aria-label={`Claim ${task.title}`}
          className="border-glacier text-glacier inline-flex h-11 shrink-0 items-center justify-center rounded-full border px-4 text-sm font-semibold transition-colors outline-none select-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950 disabled:pointer-events-none disabled:opacity-40"
        >
          Claim
        </button>
      ) : (
        !claimed && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-neutral-800 px-2.5 py-1 text-[11px] font-semibold text-neutral-400">
            <Lock className="h-3 w-3" aria-hidden /> Locked
          </span>
        )
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
  // No panel around the rows: each is its own surface, and a box around
  // boxes is a nested card.
  return (
    <section>
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-base font-semibold text-neutral-50">
          <Icon className="h-4 w-4 text-neutral-400" aria-hidden /> {heading}
        </p>
        {resets && <p className="text-xs text-neutral-400">{resets}</p>}
      </div>
      {tasks.length === 0 ? (
        <Panel className="mt-3 rounded-3xl bg-neutral-900 py-5 text-center text-sm text-neutral-400">
          {empty}
        </Panel>
      ) : (
        <ul className="mt-3 space-y-2.5">
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
    <Panel className="border-chase/40 rounded-3xl bg-neutral-900">
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
  const { openTopUp } = useTopUp();
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
        unlock={hub.checkin_unlock}
        onTopUp={openTopUp}
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
  const [notice, setNoticeState] = useState<{
    text: string;
    link?: NoticeLink;
  } | null>(null);
  const setNotice = (text: string, link?: NoticeLink) =>
    setNoticeState({ text, link });
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  // A notice with a step to take sits at the top: bring it to a player who
  // tapped Claim further down the list.
  useEffect(() => {
    const el = noticeRef.current;
    if (!notice || !el) return;
    if (notice.link)
      el.scrollIntoView({
        block: 'nearest',
        behavior: reducedMotion ? 'auto' : 'smooth',
      });
    // A repeat tap sets the same text, so nothing on screen changed and players
    // read it as a dead button (support chat, 2026-11-06). Flash it on every
    // notice. The animation leaves the DOM alone, which keeps it safe under
    // Chrome page translation. Element.animate skips the globals.css
    // reduced-motion backstop, so reduced motion is checked here: the site
    // keeps still for those players, fades included.
    if (!reducedMotion)
      el.animate(
        [{ opacity: 0.35, backgroundColor: 'rgb(255 255 255 / 0.14)' }],
        { duration: 450, easing: 'ease-out' },
      );
  }, [notice, reducedMotion]);
  const { claim, pendingId } = useClaimTask(setNotice);
  const tabs = useMemo(
    () => (taskHub ? splitHub(taskHub.tasks) : null),
    [taskHub],
  );
  const ready = tabs ? claimableCounts(tabs) : null;
  const claimProps: Claim = { onClaim: claim, claimingId: pendingId };

  return (
    <div className={cn(PAGE_COLUMN, PAGE_FILL, 'pb-6 lg:pt-6')}>
      {/* Below lg the Tasks | Ranks switch above names the page. */}
      <PageTitle className="sr-only lg:not-sr-only">TASK</PageTitle>

      <PageBody>
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
          className="mt-4 grid grid-cols-[1fr_1fr_1.45fr] gap-2 sm:grid-cols-3"
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
                  'flex min-h-11 items-center justify-center gap-1 rounded-full border px-1.5 text-[13px] font-semibold transition-colors sm:gap-1.5 sm:px-2 sm:text-sm',
                  'outline-none focus-visible:ring-2 focus-visible:ring-white/40',
                  tab === key
                    ? 'border-white/30 bg-neutral-700 text-white'
                    : 'border-white/10 bg-neutral-900 text-neutral-400 hover:text-white',
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

        {/* Always mounted, so screen readers hear every notice. */}
        <p
          ref={noticeRef}
          aria-live="polite"
          className={
            notice
              ? 'mt-4 scroll-mt-20 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-neutral-300'
              : 'sr-only'
          }
        >
          {notice?.text}
          {notice?.link && (
            <>
              {' '}
              <Link
                href={notice.link.href}
                className="font-semibold whitespace-nowrap text-white underline underline-offset-2"
              >
                {notice.link.label}
              </Link>
            </>
          )}
        </p>

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
                className="font-semibold whitespace-nowrap text-glacier underline underline-offset-2 hover:text-white"
              >
                How it works <span aria-hidden="true">&rarr;</span>
              </Link>
            </p>
            <p>
              Daily and weekly tasks count packs you pay for, bonus credit
              included. Gift packs, the welcome pack and task reward packs
              don&rsquo;t count.
            </p>
          </div>
        )}
      </PageBody>
    </div>
  );
}
