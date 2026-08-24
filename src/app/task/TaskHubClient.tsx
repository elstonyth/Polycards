'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check, Copy, Crown, ListChecks, Users } from 'lucide-react';
import { Pill, pillVariants } from '@/components/ui/pill';
import { cn } from '@/lib/utils';
import { rm } from '@/lib/format';
import type { ReferralSummary, VipRebate } from '@/lib/data/schemas';

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

function ReferralTab({ data }: { data: ReferralSummary | null }) {
  const [copied, setCopied] = useState(false);
  if (!data) return <SignInPrompt what="your referral link and earnings" />;

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
    <div className="space-y-4">
      <Panel>
        <p className="text-[11px] tracking-wide text-white/40 uppercase">
          Your invite link
        </p>
        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-neutral-900 px-3 py-2 text-xs text-neutral-300">
            {invitePath}
          </code>
          <Pill size="sm" variant="secondary" onClick={copy} aria-live="polite">
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
  );
}

function VipTab({ data }: { data: VipRebate | null }) {
  if (!data) return <SignInPrompt what="your VIP rebate" />;
  return (
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
        回水 — every week, your VIP level pays back a slice of everything you
        ripped, as credit, every Wednesday.{' '}
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
  );
}

function TasksTab() {
  return (
    <Panel className="py-10 text-center">
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-neutral-900">
        <ListChecks className="text-chase h-6 w-6" aria-hidden />
      </span>
      <p className="font-heading mt-3 text-xl text-white">WEEKLY TASKS</p>
      <p className="mx-auto mt-1 max-w-[36ch] text-sm leading-relaxed text-neutral-400">
        Check-ins, rip challenges and achievements are coming soon — with
        credit, pack and card rewards.
      </p>
    </Panel>
  );
}

export function TaskHubClient({
  referral,
  vipRebate,
}: {
  referral: ReferralSummary | null;
  vipRebate: VipRebate | null;
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
        {tab === 'tasks' && <TasksTab />}
        {tab === 'referral' && <ReferralTab data={referral} />}
        {tab === 'vip' && <VipTab data={vipRebate} />}
      </div>
    </div>
  );
}
