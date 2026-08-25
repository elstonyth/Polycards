'use client';

import { useState, useTransition } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  CalendarCheck,
  Check,
  Copy,
  Crown,
  Gift,
  ListChecks,
  Trophy,
  Users,
} from 'lucide-react';
import { checkInToday, claimTaskReward } from '@/lib/actions/tasks';
import { Pill, pillVariants } from '@/components/ui/pill';
import { cn } from '@/lib/utils';
import { rm } from '@/lib/format';
import type {
  ReferralSummary,
  TaskEntry,
  TaskHub,
  VipRebate,
} from '@/lib/data/schemas';

type TabKey = 'tasks' | 'referral' | 'vip';

const TABS: { key: TabKey; label: string; icon: typeof Users }[] = [
  { key: 'tasks', label: 'Tasks', icon: ListChecks },
  { key: 'referral', label: 'Referral', icon: Users },
  { key: 'vip', label: 'VIP', icon: Crown },
];

const fromCents = (cents: number): string => rm(cents / 100);
// Same rendering as the admin console: up to 2 decimals, trailing zeros
// trimmed — 50→"0.5%", 115→"1.15%", 200→"2%" (review 2026-08-25 finding 5).
const pct = (bp: number): string =>
  `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

// The tab hero band. A 21:9 art plate with the subject on the RIGHT and dark
// negative space on the left, so the heading sits over empty black and stays
// legible without a scrim fighting the art. Decorative only — every banner is
// aria-hidden and the heading it carries is real text, never baked into the
// image.
function TabBanner({
  src,
  title,
  sub,
}: {
  src: string;
  title: string;
  sub: string;
}) {
  return (
    <div className="relative mb-4 overflow-hidden rounded-2xl border border-white/10 bg-neutral-950">
      <Image
        src={src}
        alt=""
        aria-hidden
        width={1600}
        height={686}
        priority={false}
        className="pointer-events-none h-28 w-full object-cover object-right select-none sm:h-32"
      />
      {/* Left-to-right fade: guarantees the copy's contrast even if the art
          ever changes, without dimming the subject on the right. */}
      <div className="absolute inset-0 bg-gradient-to-r from-neutral-950 via-neutral-950/80 to-transparent" />
      <div className="absolute inset-0 flex flex-col justify-center px-4">
        <p className="font-heading text-xl leading-none text-white sm:text-2xl">
          {title}
        </p>
        <p className="mt-1.5 max-w-[26ch] text-[11px] leading-snug text-neutral-400 sm:text-xs">
          {sub}
        </p>
      </div>
    </div>
  );
}

function Panel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-white/10 bg-white/[0.03] p-4',
        className,
      )}
    >
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-neutral-900 p-3">
      <p className="text-[11px] tracking-wide text-white/40 uppercase">
        {label}
      </p>
      <p className="font-heading mt-1 text-lg text-white">{value}</p>
    </div>
  );
}

// Rendered when a tab's data is null but the customer IS logged in — the
// backend hiccuped, and telling a logged-in customer to "sign in" reads as a
// lost session (review 2026-08-25 finding 7).
function UnavailablePanel() {
  return (
    <Panel className="text-center">
      <p className="text-sm leading-relaxed text-neutral-400">
        Couldn't load this right now — give it a second and refresh.
      </p>
    </Panel>
  );
}

function SignInPrompt({ what }: { what: string }) {
  return (
    <Panel className="text-center">
      <p className="text-sm leading-relaxed text-neutral-400">
        Sign in to see {what}.
      </p>
      <Link
        href="/settings"
        className={cn(pillVariants({ size: 'sm' }), 'mt-4')}
      >
        Sign in
      </Link>
    </Panel>
  );
}

function HistoryList({
  rows,
  empty,
}: {
  rows: ReferralSummary['history'];
  empty: string;
}) {
  if (rows.length === 0) {
    return <p className="py-3 text-center text-sm text-neutral-500">{empty}</p>;
  }
  return (
    <ul className="divide-y divide-white/5">
      {rows.map((row) => (
        <li
          key={`${row.week_start}-${row.status}-${row.amount_cents}`}
          className="flex items-center justify-between py-2.5 text-sm"
        >
          <div>
            <p className="text-white">{fromCents(row.amount_cents)}</p>
            <p className="text-xs text-white/40">
              Week of {row.week_start} · {pct(row.rate_bp)} of{' '}
              {fromCents(row.basis_cents)}
            </p>
          </div>
          <span
            className={cn(
              'rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase',
              row.status === 'paid' && 'bg-emerald-500/15 text-emerald-300',
              row.status === 'pending' && 'bg-amber-500/15 text-amber-300',
              row.status === 'voided' && 'bg-white/5 text-white/40',
            )}
          >
            {row.status}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ReferralTab({
  data,
  isLoggedIn,
}: {
  data: ReferralSummary | null;
  isLoggedIn: boolean;
}) {
  const [copied, setCopied] = useState(false);
  if (!data) {
    return isLoggedIn ? (
      <UnavailablePanel />
    ) : (
      <SignInPrompt what="your referral link and earnings" />
    );
  }

  // Rendered as a path (identical on server and client — no hydration skew);
  // the copy handler runs client-only, so it can prepend the real origin.
  const invitePath = `/invite/${data.handle}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}${invitePath}`,
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (permissions/http) — the URL is visible to
      // select manually, so silently doing nothing beats an error toast.
    }
  };

  return (
    <div>
      <TabBanner
        src="/images/task/referral-banner.webp"
        title="INVITE & EARN"
        sub="Every pack your friends rip pays you a weekly cut."
      />
      <div className="space-y-4">
        <Panel>
          <p className="text-[11px] tracking-wide text-white/40 uppercase">
            Your invite link
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-neutral-900 px-3 py-2 text-xs text-neutral-300">
              {invitePath}
            </code>
            <Pill
              size="sm"
              variant="secondary"
              onClick={copy}
              aria-live="polite"
            >
              {copied ? (
                <Check className="h-4 w-4" aria-hidden />
              ) : (
                <Copy className="h-4 w-4" aria-hidden />
              )}
              {copied ? 'Copied' : 'Copy'}
            </Pill>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-neutral-500">
            Friends who sign up through your link count toward your weekly
            commission — a cut of everything they rip, paid every Wednesday.
          </p>
        </Panel>

        <div className="grid grid-cols-2 gap-2">
          <Stat label="Referrals" value={String(data.downline_count)} />
          <Stat
            label="Their spend this week"
            value={fromCents(data.week.turnover_cents)}
          />
          <Stat
            label={data.week.partner ? 'Partner rate' : 'Current rate'}
            value={pct(data.week.rate_bp)}
          />
          <Stat
            label="Projected payout"
            value={fromCents(data.week.projected_cents)}
          />
        </div>

        <Panel>
          <p className="mb-1 text-[11px] tracking-wide text-white/40 uppercase">
            Past payouts
          </p>
          <HistoryList
            rows={data.history}
            empty="No payouts yet — share your link to start earning."
          />
        </Panel>
      </div>
    </div>
  );
}

function VipTab({
  data,
  isLoggedIn,
}: {
  data: VipRebate | null;
  isLoggedIn: boolean;
}) {
  if (!data) {
    return isLoggedIn ? (
      <UnavailablePanel />
    ) : (
      <SignInPrompt what="your VIP rebate" />
    );
  }
  return (
    <div>
      <TabBanner
        src="/images/task/vip-banner.webp"
        title="VIP REBATE"
        sub="Your level pays back a slice of everything you rip."
      />
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <Stat label="VIP level" value={`L${data.level}`} />
          <Stat label="Rebate rate" value={pct(data.rebate_bp)} />
          <Stat
            label="Your spend this week"
            value={fromCents(data.week.turnover_cents)}
          />
          <Stat
            label="Projected rebate"
            value={fromCents(data.week.projected_cents)}
          />
        </div>
        <p className="px-1 text-xs leading-relaxed text-neutral-500">
          Rebate — every week, your VIP level pays back a slice of everything
          you ripped, as credit, every Wednesday.{' '}
          {data.rebate_bp === 0 && 'Level up to unlock a rebate rate.'}
        </p>
        <Panel>
          <p className="mb-1 text-[11px] tracking-wide text-white/40 uppercase">
            Past rebates
          </p>
          <HistoryList
            rows={data.history}
            empty="No rebates yet — rip packs to build this week's rebate."
          />
        </Panel>
      </div>
    </div>
  );
}

const REWARD_LABEL: Record<string, string> = {
  credit: 'Credit',
  pack: 'Free rip',
  card: 'Card',
};

function rewardLabel(reward: TaskEntry['reward']): string {
  if (reward.type === 'credit' && typeof reward.amount_myr === 'number') {
    return rm(reward.amount_myr);
  }
  return REWARD_LABEL[reward.type] ?? 'Reward';
}

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
        onDone(
          res.rewardType === 'credit'
            ? 'Credit added to your wallet.'
            : res.rewardType === 'pack'
              ? 'Your free rip landed in your vault.'
              : 'Card added to your vault.',
        );
      } else if (res.ok && !res.claimed && res.reason === 'already_claimed') {
        onDone('Already claimed.');
      } else if (res.ok && !res.claimed) {
        onDone('Not completed yet.');
      } else if (!res.ok) {
        onDone(res.error);
      }
      router.refresh();
    });
  return (
    <li className="flex items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-white">{task.title}</p>
        <div className="mt-1.5 flex items-center gap-2">
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
          <span className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-neutral-300">
            <Gift className="h-3 w-3" aria-hidden />
            {rewardLabel(task.reward)}
          </span>
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

function TasksTab({
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
      <SignInPrompt what="your tasks and achievements" />
    );
  }

  const weekly = data.tasks.filter((t) => t.kind === 'weekly');
  const achievements = data.tasks.filter((t) => t.kind === 'achievement');
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
        sub="Check in, rip packs, hit milestones — claim the rewards."
      />
      <div className="space-y-4">
        <Panel className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-neutral-900">
            <CalendarCheck className="text-chase h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-white">Daily check-in</p>
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

        <Panel>
          <p className="mb-1 flex items-center gap-1.5 text-[11px] tracking-wide text-white/40 uppercase">
            <ListChecks className="h-3.5 w-3.5" aria-hidden /> Weekly tasks
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

        <Panel>
          <p className="mb-1 flex items-center gap-1.5 text-[11px] tracking-wide text-white/40 uppercase">
            <Trophy className="h-3.5 w-3.5" aria-hidden /> Achievements
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
  referral,
  vipRebate,
  taskHub,
  isLoggedIn,
}: {
  referral: ReferralSummary | null;
  vipRebate: VipRebate | null;
  taskHub: TaskHub | null;
  isLoggedIn: boolean;
}) {
  const [tab, setTab] = useState<TabKey>('tasks');
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
        {tab === 'tasks' && <TasksTab data={taskHub} isLoggedIn={isLoggedIn} />}
        {tab === 'referral' && (
          <ReferralTab data={referral} isLoggedIn={isLoggedIn} />
        )}
        {tab === 'vip' && <VipTab data={vipRebate} isLoggedIn={isLoggedIn} />}
      </div>
    </div>
  );
}
