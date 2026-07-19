'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Trophy, Layers, TrendingUp, CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';
import Reveal from '@/components/Reveal';
import { SlabImage } from '@/components/SlabImage';
import { FramedAvatar } from '@/components/FramedAvatar';
import { rm, num } from '@/lib/format';
import { type ProfileViewUser } from '@/lib/profile-view';

const TABS = ['Collection', 'Activity'] as const;
type Tab = (typeof TABS)[number];

export default function ProfileClient({ user }: { user: ProfileViewUser }) {
  const [tab, setTab] = useState<Tab>('Collection');
  const stats = [
    // Real profiles carry no global rank (a leaderboard concern) — render "—".
    {
      icon: Trophy,
      label: 'Rank',
      value: user.rank == null ? '—' : `#${num(user.rank)}`,
    },
    { icon: Layers, label: 'Pulls', value: num(user.pulls) },
    { icon: TrendingUp, label: 'Volume', value: rm(user.volume) },
  ];
  // Real profiles ship their pull activity; the mock pool derives a synthetic
  // feed from the collection (unchanged legacy behavior).
  const activity = useMemo(
    () =>
      user.activity ??
      user.collection.map((c, i) => ({
        verb: ['pulled', 'bought', 'listed', 'sold'][i % 4],
        card: c,
        time: `${(i + 1) * 3}h ago`,
      })),
    [user],
  );

  return (
    <div className="mx-auto w-full px-fluid py-6">
      {/* Header */}
      <Reveal
        as="header"
        className="relative mb-6 overflow-hidden rounded-2xl border border-white/10 bg-neutral-950 p-6 sm:p-8"
      >
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-white/[0.06] to-transparent" />
        <div className="relative flex flex-col items-center gap-5 sm:flex-row sm:items-end">
          <FramedAvatar
            src={user.pfp}
            initial={user.username?.[0]?.toUpperCase()}
            frameSrc={user.frame}
            animateLevel={user.frameLevel}
            alt={user.username}
            size={96}
            priority
            className="ring-4 ring-white/10"
          />
          <div className="min-w-0 flex-1 text-center sm:text-left">
            <h1 className="font-heading text-3xl font-bold tracking-tight text-white sm:text-4xl">
              {user.username}
            </h1>
            <p className="mt-1 flex items-center justify-center gap-1.5 text-[13px] text-white/50 sm:justify-start">
              <CalendarDays className="h-3.5 w-3.5" aria-hidden /> Collecting
              since {user.joined}
            </p>
          </div>
        </div>

        {/* stats */}
        <div className="relative mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stats.map((s) => {
            const Icon = s.icon;
            return (
              <div
                key={s.label}
                className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-center sm:text-left"
              >
                <div className="flex items-center justify-center gap-1.5 text-white/60 sm:justify-start">
                  <Icon className="h-3.5 w-3.5" aria-hidden />
                  <span className="text-[11px] uppercase tracking-wide">
                    {s.label}
                  </span>
                </div>
                <p className="mt-1 font-heading text-xl font-bold text-white">
                  {s.value}
                </p>
              </div>
            );
          })}
        </div>
      </Reveal>

      {/* Tabs — plain toggle buttons (aria-pressed), not ARIA tabs: no
          tabpanel/keyboard-arrow wiring exists to back the tab roles. */}
      <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl border border-white/10 bg-neutral-900 p-1 sm:inline-flex">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              'rounded-lg px-5 py-2 text-center text-sm font-medium transition-colors',
              tab === t
                ? 'bg-white/10 text-white'
                : 'text-white/50 hover:text-white/80',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Panels */}
      {tab === 'Collection' &&
        (user.collection.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] px-6 py-12 text-center">
            <p className="text-sm font-medium text-white/60">
              No cards showcased yet.
            </p>
            <p className="mt-1 text-[13px] text-white/55">
              Cards featured from the vault appear here.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {/* Key includes the index: a real profile's recent pulls can repeat
                the same card (same handle) — ids alone would collide. */}
            {user.collection.map((c, i) => (
              <Reveal
                key={`${c.id}-${i}`}
                delay={Math.min(i, 8) * 45}
                className="h-full"
              >
                <Link
                  href={`/card/${c.id}`}
                  className="group block h-full rounded-2xl border border-white/10 bg-neutral-800 transition-[transform,border-color] duration-300 hover:-translate-y-1 hover:border-white/20"
                >
                  {/* No overflow-hidden: the tier halo reaches ~44px past the
                      slab and a clipping ancestor cuts it into a hard rectangle
                      (same treatment as the vault grid). */}
                  <div className="relative w-full rounded-t-2xl bg-[radial-gradient(120%_80%_at_50%_15%,#2e2e2e_0%,#1c1c1c_55%,#141414_100%)] p-3">
                    <SlabImage
                      src={c.image}
                      slabSrc={c.slabImage}
                      rarity={c.rarity}
                      alt={c.name}
                      sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 16vw"
                      className="w-full transition-transform duration-300 group-hover:scale-[1.04]"
                    />
                  </div>
                  <div className="p-2.5">
                    <p className="truncate text-[11px] text-white/60">
                      {c.grader} {c.grade}
                    </p>
                    <p className="text-sm font-bold text-white">
                      {c.price != null ? rm(c.price) : '—'}
                    </p>
                  </div>
                </Link>
              </Reveal>
            ))}
          </div>
        ))}

      {tab === 'Activity' && (
        <ul className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
          {activity.map((a, i) => (
            <li
              key={i}
              className="flex items-center gap-3 border-b border-white/5 px-4 py-3 last:border-b-0"
            >
              <SlabImage
                src={a.card.image}
                slabSrc={a.card.slabImage}
                alt=""
                sizes="32px"
                className="w-8 shrink-0"
              />
              <p className="min-w-0 flex-1 truncate text-[13px] text-white/80">
                <span className="text-white/50">{a.verb}</span>{' '}
                <Link
                  href={`/card/${a.card.id}`}
                  className="font-medium text-white hover:underline"
                >
                  {a.card.name}
                </Link>
              </p>
              <span className="shrink-0 text-[12px] tabular-nums text-white/50">
                {a.card.price != null ? rm(a.card.price) : '—'}
              </span>
              <span className="hidden shrink-0 text-[11px] text-white/55 sm:inline">
                {a.time}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
