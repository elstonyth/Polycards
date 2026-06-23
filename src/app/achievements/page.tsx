'use client';

// /achievements — "Achievement System" matching live phygitals: centered hero with
// trophy + stat pills (count / total XP), 5 color-coded rarity-tier cards, then a
// sortable "All Achievements" data table. Standalone full-width route (global header/
// footer only — no account sidebar, matching live). Client component for the sortable
// table; metadata is skipped (consistent with /claw, /repacks, /pack-party).
//
// All achievements render "Locked" — the live anonymous view exposes no progress.

import { useState } from 'react';
import {
  Trophy,
  Zap,
  Star,
  Medal,
  ChevronsUpDown,
  ChevronUp,
  ChevronDown,
  Package,
  Layers,
  Repeat,
  Wallet,
  Users,
  Flame,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import Reveal from '@/components/Reveal';

type Rarity = 'Common' | 'Uncommon' | 'Rare' | 'Epic' | 'Legendary';

const RARITY_ORDER: Record<Rarity, number> = {
  Common: 0,
  Uncommon: 1,
  Rare: 2,
  Epic: 3,
  Legendary: 4,
};

const RARITY_STYLE: Record<
  Rarity,
  {
    text: string;
    border: string;
    glow: string;
    chipBg: string;
    chipText: string;
  }
> = {
  Common: {
    text: 'text-white',
    border: 'border-white/15',
    glow: '',
    chipBg: 'bg-white/10',
    chipText: 'text-white/80',
  },
  Uncommon: {
    text: 'text-blue-400',
    border: 'border-blue-500/40',
    glow: 'shadow-[0_0_30px_-12px_rgba(59,130,246,0.7)]',
    chipBg: 'bg-blue-500/15',
    chipText: 'text-blue-300',
  },
  Rare: {
    text: 'text-emerald-400',
    border: 'border-emerald-500/40',
    glow: 'shadow-[0_0_30px_-12px_rgba(16,185,129,0.7)]',
    chipBg: 'bg-emerald-500/15',
    chipText: 'text-emerald-300',
  },
  Epic: {
    text: 'text-purple-400',
    border: 'border-purple-500/40',
    glow: 'shadow-[0_0_30px_-12px_rgba(168,85,247,0.7)]',
    chipBg: 'bg-purple-500/15',
    chipText: 'text-purple-300',
  },
  Legendary: {
    text: 'text-amber-400',
    border: 'border-amber-500/40',
    glow: 'shadow-[0_0_30px_-12px_rgba(245,158,11,0.7)]',
    chipBg: 'bg-amber-500/15',
    chipText: 'text-amber-300',
  },
};

const TIERS: { rarity: Rarity; range: string }[] = [
  { rarity: 'Common', range: '50-100' },
  { rarity: 'Uncommon', range: '200-500' },
  { rarity: 'Rare', range: '500-1000' },
  { rarity: 'Epic', range: '1000-2500' },
  { rarity: 'Legendary', range: '5000' },
];

const CATEGORY_ICON: Record<string, LucideIcon> = {
  'Cases Opened': Package,
  Collection: Layers,
  Trading: Repeat,
  Spending: Wallet,
  Social: Users,
  Streaks: Flame,
  Pulls: Sparkles,
};

type Achievement = {
  name: string;
  desc: string;
  category: keyof typeof CATEGORY_ICON;
  rarity: Rarity;
  xp: number;
};

// 31 achievements, grouped by category in ascending difficulty (XP sums to 42,050).
const ACHIEVEMENTS: Achievement[] = [
  {
    name: 'First Pull',
    desc: 'Open your first case',
    category: 'Cases Opened',
    rarity: 'Common',
    xp: 50,
  },
  {
    name: 'Case Opener',
    desc: 'Open 25 cases',
    category: 'Cases Opened',
    rarity: 'Common',
    xp: 100,
  },
  {
    name: 'Case Enthusiast',
    desc: 'Open 50 cases',
    category: 'Cases Opened',
    rarity: 'Uncommon',
    xp: 250,
  },
  {
    name: 'Case Master',
    desc: 'Open 250 cases',
    category: 'Cases Opened',
    rarity: 'Rare',
    xp: 500,
  },
  {
    name: 'Case Legend',
    desc: 'Open 1,000 cases',
    category: 'Cases Opened',
    rarity: 'Epic',
    xp: 1500,
  },
  {
    name: 'Case God',
    desc: 'Open 5,000 cases',
    category: 'Cases Opened',
    rarity: 'Legendary',
    xp: 5000,
  },
  {
    name: 'Getting Started',
    desc: 'Add your first card',
    category: 'Collection',
    rarity: 'Common',
    xp: 50,
  },
  {
    name: 'Collector',
    desc: 'Own 10 cards',
    category: 'Collection',
    rarity: 'Common',
    xp: 100,
  },
  {
    name: 'Curator',
    desc: 'Own 100 cards',
    category: 'Collection',
    rarity: 'Uncommon',
    xp: 250,
  },
  {
    name: 'Archivist',
    desc: 'Own 500 cards',
    category: 'Collection',
    rarity: 'Rare',
    xp: 750,
  },
  {
    name: 'Set Finisher',
    desc: 'Complete a full set',
    category: 'Collection',
    rarity: 'Rare',
    xp: 1000,
  },
  {
    name: 'Hoarder',
    desc: 'Own 1,000 cards',
    category: 'Collection',
    rarity: 'Epic',
    xp: 1500,
  },
  {
    name: 'Vault Keeper',
    desc: 'Own 5,000 cards',
    category: 'Collection',
    rarity: 'Legendary',
    xp: 5000,
  },
  {
    name: 'First Trade',
    desc: 'Complete your first trade',
    category: 'Trading',
    rarity: 'Common',
    xp: 50,
  },
  {
    name: 'Window Shopper',
    desc: 'List your first card',
    category: 'Trading',
    rarity: 'Common',
    xp: 100,
  },
  {
    name: 'Dealmaker',
    desc: 'Complete 25 trades',
    category: 'Trading',
    rarity: 'Uncommon',
    xp: 500,
  },
  {
    name: 'Market Maker',
    desc: 'Complete 100 trades',
    category: 'Trading',
    rarity: 'Rare',
    xp: 750,
  },
  {
    name: 'Trade Tycoon',
    desc: 'Complete 500 trades',
    category: 'Trading',
    rarity: 'Epic',
    xp: 2000,
  },
  {
    name: 'Big Spender',
    desc: 'Spend $1,000',
    category: 'Spending',
    rarity: 'Uncommon',
    xp: 200,
  },
  {
    name: 'Heavy Hitter',
    desc: 'Spend $5,000',
    category: 'Spending',
    rarity: 'Rare',
    xp: 1000,
  },
  {
    name: 'Whale',
    desc: 'Spend $10,000',
    category: 'Spending',
    rarity: 'Epic',
    xp: 1000,
  },
  {
    name: 'High Roller',
    desc: 'Spend $50,000',
    category: 'Spending',
    rarity: 'Legendary',
    xp: 5000,
  },
  {
    name: 'Socialite',
    desc: 'Refer your first friend',
    category: 'Social',
    rarity: 'Uncommon',
    xp: 200,
  },
  {
    name: 'Connector',
    desc: 'Refer 5 friends',
    category: 'Social',
    rarity: 'Uncommon',
    xp: 500,
  },
  {
    name: 'Community Pillar',
    desc: 'Refer 25 friends',
    category: 'Social',
    rarity: 'Epic',
    xp: 2500,
  },
  {
    name: 'Daily Devotee',
    desc: 'Log in 7 days in a row',
    category: 'Streaks',
    rarity: 'Uncommon',
    xp: 200,
  },
  {
    name: 'Streak Keeper',
    desc: 'Log in 30 days in a row',
    category: 'Streaks',
    rarity: 'Rare',
    xp: 1000,
  },
  {
    name: 'Marathoner',
    desc: 'Log in 100 days in a row',
    category: 'Streaks',
    rarity: 'Epic',
    xp: 2500,
  },
  {
    name: 'Lucky Streak',
    desc: 'Pull 3 rares in a row',
    category: 'Pulls',
    rarity: 'Rare',
    xp: 1000,
  },
  {
    name: 'Grail Hunter',
    desc: 'Pull a Legendary card',
    category: 'Pulls',
    rarity: 'Epic',
    xp: 2500,
  },
  {
    name: 'Jackpot',
    desc: 'Pull a 1/1',
    category: 'Pulls',
    rarity: 'Legendary',
    xp: 5000,
  },
];

const TOTAL_XP = ACHIEVEMENTS.reduce((sum, a) => sum + a.xp, 0);
const COUNT = ACHIEVEMENTS.length;

type SortKey = 'name' | 'category' | 'rarity' | 'xp';
type SortDir = 'asc' | 'desc';

function compare(a: Achievement, b: Achievement, key: SortKey): number {
  switch (key) {
    case 'name':
      return a.name.localeCompare(b.name);
    case 'category':
      return a.category.localeCompare(b.category);
    case 'rarity':
      return RARITY_ORDER[a.rarity] - RARITY_ORDER[b.rarity];
    case 'xp':
      return a.xp - b.xp;
  }
}

export default function AchievementsPage() {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null);

  const rows = sort
    ? [...ACHIEVEMENTS].sort((a, b) =>
        sort.dir === 'asc' ? compare(a, b, sort.key) : compare(b, a, sort.key),
      )
    : ACHIEVEMENTS;

  const toggleSort = (key: SortKey) =>
    setSort((prev) =>
      prev?.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' },
    );

  // Render helper (not a nested component) — returns the sort glyph for a column.
  // Defined as a function, not a component, so it isn't recreated each render.
  const sortIcon = (col: SortKey) => {
    if (sort?.key !== col)
      return <ChevronsUpDown className="h-3 w-3 text-white/30" aria-hidden />;
    return sort.dir === 'asc' ? (
      <ChevronUp className="h-3 w-3 text-white/70" aria-hidden />
    ) : (
      <ChevronDown className="h-3 w-3 text-white/70" aria-hidden />
    );
  };

  return (
    <div className="w-full px-fluid py-10">
      {/* Hero */}
      <div className="mx-auto max-w-2xl text-center">
        <Reveal className="mx-auto mb-4 flex h-12 w-12 items-center justify-center">
          <Trophy className="h-9 w-9 text-white" aria-hidden />
        </Reveal>
        <Reveal
          as="h1"
          delay={60}
          className="font-heading text-4xl font-bold tracking-tight text-white sm:text-5xl"
        >
          Achievement System
        </Reveal>
        <Reveal
          as="p"
          delay={120}
          className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-white/55 sm:text-base"
        >
          Level up your collecting journey through achievements. Earn XP, unlock
          perks, and showcase your dedication.
        </Reveal>
        <Reveal
          delay={180}
          className="mt-5 flex items-center justify-center gap-3"
        >
          <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-sm font-medium text-white">
            <Trophy className="h-4 w-4 text-white/70" aria-hidden /> {COUNT}{' '}
            Achievements
          </span>
          <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-sm font-medium text-white">
            <Zap className="h-4 w-4 text-amber-400" aria-hidden />{' '}
            {TOTAL_XP.toLocaleString('en-US')} Total XP
          </span>
        </Reveal>
      </div>

      {/* Rarity tier cards */}
      <div className="mx-auto mt-10 grid max-w-6xl grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {TIERS.map((t, i) => {
          const s = RARITY_STYLE[t.rarity];
          return (
            <Reveal key={t.rarity} delay={Math.min(i, 5) * 60}>
              <div
                className={cn(
                  'flex flex-col rounded-2xl border bg-white/[0.02] p-4',
                  s.border,
                  s.glow,
                )}
              >
                <div className="mb-3 flex items-center justify-between">
                  <span className={cn('text-sm font-semibold', s.text)}>
                    {t.rarity}
                  </span>
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/5">
                    <Star className={cn('h-3.5 w-3.5', s.text)} aria-hidden />
                  </span>
                </div>
                <span className={cn('font-heading text-2xl font-bold', s.text)}>
                  {t.range}
                </span>
                <span className="mt-1 text-[11px] uppercase tracking-wide text-white/40">
                  XP Reward
                </span>
              </div>
            </Reveal>
          );
        })}
      </div>

      {/* All Achievements table */}
      <section className="mx-auto mt-12 max-w-6xl">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h2 className="font-heading text-xl font-bold tracking-tight text-white sm:text-2xl">
              All Achievements
            </h2>
            <p className="mt-1 text-sm text-white/50">
              Track your progress across all achievement categories
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/5 px-3 py-1.5 text-[13px] font-medium text-white/70">
            {COUNT} Total
          </span>
        </div>

        <div className="overflow-hidden rounded-2xl border border-white/10">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-white/10 bg-white/[0.03] text-[11px] uppercase tracking-wide text-white/50">
                <th className="px-4 py-3">
                  <button
                    type="button"
                    onClick={() => toggleSort('name')}
                    className="inline-flex items-center gap-1 hover:text-white/70"
                  >
                    <Trophy className="h-3.5 w-3.5" aria-hidden /> Achievement{' '}
                    {sortIcon('name')}
                  </button>
                </th>
                <th className="px-4 py-3">
                  <button
                    type="button"
                    onClick={() => toggleSort('category')}
                    className="inline-flex items-center gap-1 hover:text-white/70"
                  >
                    Category {sortIcon('category')}
                  </button>
                </th>
                <th className="hidden px-4 py-3 md:table-cell">
                  <button
                    type="button"
                    onClick={() => toggleSort('rarity')}
                    className="inline-flex items-center gap-1 hover:text-white/70"
                  >
                    Rarity {sortIcon('rarity')}
                  </button>
                </th>
                <th className="hidden px-4 py-3 md:table-cell">
                  <button
                    type="button"
                    onClick={() => toggleSort('xp')}
                    className="inline-flex items-center gap-1 hover:text-white/70"
                  >
                    XP Reward {sortIcon('xp')}
                  </button>
                </th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const Cat = CATEGORY_ICON[a.category] ?? Sparkles;
                const rs = RARITY_STYLE[a.rarity];
                return (
                  <tr
                    key={a.name}
                    className="border-b border-white/[0.06] last:border-0 transition-colors hover:bg-white/[0.02]"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/5">
                          <Medal
                            className="h-4 w-4 text-white/50"
                            aria-hidden
                          />
                        </span>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-white">
                            {a.name}
                          </div>
                          <div className="truncate text-xs text-white/50">
                            {a.desc}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 text-sm text-white/70">
                        <Cat className="h-4 w-4 text-white/40" aria-hidden />{' '}
                        {a.category}
                      </span>
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      <span
                        className={cn(
                          'inline-block rounded px-2 py-0.5 text-[11px] font-semibold',
                          rs.chipBg,
                          rs.chipText,
                        )}
                      >
                        {a.rarity}
                      </span>
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-400">
                        <Zap className="h-3 w-3" aria-hidden /> +
                        {a.xp.toLocaleString('en-US')} XP
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 text-xs text-white/50">
                        <span
                          className="h-1.5 w-1.5 rounded-full bg-white/30"
                          aria-hidden
                        />{' '}
                        Locked
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
