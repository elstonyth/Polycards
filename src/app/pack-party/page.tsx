'use client';

// NOTE: This page has client interactivity (Active / Completed tab state),
// so the page component itself is a client component. Client components cannot
// `export const metadata`, so we intentionally skip metadata here (acceptable
// per the build spec, matching /claw and /leaderboard) — the global
// <SiteHeader/>/<SiteFooter/> from layout.tsx still wrap this page body.

import { useState } from 'react';
import {
  Users,
  Clock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  List,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { rm0 } from '@/lib/format';
import Reveal from '@/components/Reveal';

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

type Party = {
  id: string;
  /** Chase card art — verified to exist under public/home/hero/slabs/. */
  image: string;
  /** Display name of the chase card / set. */
  title: string;
  /** Entry price to join (USD). */
  entry: number;
  /** Top "chase" card value (USD) — the headline pull. */
  chase: number;
  /** Average expected value per player (USD). */
  avg: number;
  /** Players already joined. */
  filled: number;
  /** Total seats in the party. */
  seats: number;
  /** Human time remaining, e.g. "4d". Completed parties use "Ended". */
  time: string;
};

// Active parties — the live, joinable ones.
// `entry < avg` flags the green "Great Deal!" badge + highlights the Entry value.
const ACTIVE_PARTIES: Party[] = [
  {
    id: 'a1',
    image: '/home/hero/slabs/pokemon1.webp',
    title: 'Pokemon Chase',
    entry: 54,
    chase: 103,
    avg: 56,
    filled: 1,
    seats: 2,
    time: '4d',
  },
  {
    id: 'a2',
    image: '/home/hero/slabs/pokemon3.webp',
    title: 'Pokemon Vintage',
    entry: 38,
    chase: 38,
    avg: 34,
    filled: 1,
    seats: 2,
    time: '2d',
  },
  {
    id: 'a3',
    image: '/home/hero/slabs/onepiece2.webp',
    title: 'One Piece OP-05',
    entry: 41,
    chase: 50,
    avg: 40,
    filled: 1,
    seats: 2,
    time: '4d',
  },
  {
    id: 'a4',
    image: '/home/hero/slabs/basketball2.webp',
    title: 'Prizm Basketball',
    entry: 39,
    chase: 52,
    avg: 39,
    filled: 1,
    seats: 2,
    time: '3d',
  },
  {
    id: 'a5',
    image: '/home/hero/slabs/onepiece4.webp',
    title: 'One Piece Romance Dawn',
    entry: 47,
    chase: 88,
    avg: 49,
    filled: 1,
    seats: 2,
    time: '5d',
  },
  {
    id: 'a6',
    image: '/home/hero/slabs/football1.webp',
    title: 'Select Football',
    entry: 33,
    chase: 41,
    avg: 33,
    filled: 2,
    seats: 4,
    time: '6d',
  },
  {
    id: 'a7',
    image: '/home/hero/slabs/yugioh1.webp',
    title: 'Yu-Gi-Oh! 25th',
    entry: 29,
    chase: 44,
    avg: 30,
    filled: 1,
    seats: 2,
    time: '2d',
  },
  {
    id: 'a8',
    image: '/home/hero/slabs/baseball1.webp',
    title: 'Topps Chrome Baseball',
    entry: 45,
    chase: 72,
    avg: 46,
    filled: 2,
    seats: 4,
    time: '4d',
  },
];

// Completed parties — already drawn. Buttons disabled, badge muted "Ended".
const COMPLETED_PARTIES: Party[] = [
  {
    id: 'c1',
    image: '/home/hero/slabs/basketball1.webp',
    title: 'Prizm Basketball',
    entry: 62,
    chase: 140,
    avg: 64,
    filled: 2,
    seats: 2,
    time: 'Ended',
  },
  {
    id: 'c2',
    image: '/home/hero/slabs/football3.webp',
    title: 'Mosaic Football',
    entry: 35,
    chase: 48,
    avg: 36,
    filled: 2,
    seats: 2,
    time: 'Ended',
  },
  {
    id: 'c3',
    image: '/home/hero/slabs/yugioh2.webp',
    title: 'Yu-Gi-Oh! Legend',
    entry: 28,
    chase: 39,
    avg: 29,
    filled: 2,
    seats: 2,
    time: 'Ended',
  },
  {
    id: 'c4',
    image: '/home/hero/slabs/football4.webp',
    title: 'Donruss Football',
    entry: 31,
    chase: 55,
    avg: 33,
    filled: 4,
    seats: 4,
    time: 'Ended',
  },
  {
    id: 'c5',
    image: '/home/hero/slabs/basketball3.webp',
    title: 'Select Basketball',
    entry: 49,
    chase: 96,
    avg: 50,
    filled: 2,
    seats: 2,
    time: 'Ended',
  },
  {
    id: 'c6',
    image: '/home/hero/slabs/onepiece2.webp',
    title: 'One Piece OP-04',
    entry: 42,
    chase: 61,
    avg: 43,
    filled: 2,
    seats: 2,
    time: 'Ended',
  },
];

const TABS = ['Active', 'Completed'] as const;
type Tab = (typeof TABS)[number];

// Blurred decorative slabs behind the header banner (verified to exist).
const HEADER_SLABS = [
  '/home/hero/slabs/pokemon1.webp',
  '/home/hero/slabs/onepiece4.webp',
  '/home/hero/slabs/basketball1.webp',
  '/home/hero/slabs/football1.webp',
  '/home/hero/slabs/yugioh1.webp',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fmt = (n: number) => rm0(n);

// Rarity ring colors extracted from the live pack-party cards — Tailwind *-500.
// Each card gets a gradient ring border (purple cards also glow), cycled by index
// so the grid reads as varied/colorful like the original.
const RARITY_RINGS = [
  '168, 85, 247', // purple
  '59, 130, 246', // blue
  '34, 197, 94', // green
  '6, 182, 212', // cyan
  '249, 115, 22', // orange
  '236, 72, 153', // pink
  '234, 179, 8', // yellow
] as const;

// ---------------------------------------------------------------------------
// Party card
// ---------------------------------------------------------------------------

function PartyCard({
  party,
  ended,
  ring,
}: {
  party: Party;
  ended: boolean;
  ring: string;
}) {
  const greatDeal = !ended && party.entry < party.avg;
  const pct = Math.min(100, Math.round((party.filled / party.seats) * 100));

  return (
    <div
      className={cn(
        'group rounded-2xl p-px transition-all duration-300 hover:-translate-y-1',
        // Live parties get a slowly-drifting gradient ring (matches the live site's
        // animated gradient-xy borders); ended cards stay static.
        !ended &&
          '[background-size:180%_180%] motion-safe:animate-[gradientShift_7s_ease-in-out_infinite]',
      )}
      style={{
        background: ended
          ? 'rgba(255,255,255,0.10)'
          : `linear-gradient(160deg, rgb(${ring}), rgba(${ring},0.25) 48%, rgba(255,255,255,0.06))`,
        boxShadow: ended ? undefined : `0 0 22px -8px rgba(${ring},0.55)`,
      }}
    >
      <div className="flex h-full flex-col overflow-hidden rounded-[15px] bg-neutral-900">
        {/* Chase card image */}
        <div className="relative aspect-[3/4] overflow-hidden bg-neutral-950">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={party.image}
            alt={party.title}
            className={cn(
              'h-full w-full object-contain p-3 transition-transform duration-500 group-hover:scale-[1.04]',
              ended && 'opacity-60 saturate-[0.7]',
            )}
          />
          {/* "Live" pulse on joinable parties (matches the live site's pinging dots) */}
          {!ended && (
            <span
              className="absolute right-2 top-2 z-10 flex h-2.5 w-2.5"
              aria-hidden
            >
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75 motion-reduce:animate-none" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
            </span>
          )}
          {/* Status badge over the image */}
          <div className="absolute left-2 top-2">
            {ended ? (
              <span className="inline-flex items-center rounded-full bg-black/60 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-white/60 ring-1 ring-white/10 backdrop-blur-sm">
                Ended
              </span>
            ) : greatDeal ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-emerald-500 to-green-500 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white shadow-sm">
                <Sparkles className="h-3 w-3" aria-hidden />
                Great Deal!
              </span>
            ) : null}
          </div>
        </div>

        {/* Body */}
        <div className="flex flex-1 flex-col gap-3 p-3">
          {/* Three-value row */}
          <div className="grid grid-cols-3 gap-1 text-center">
            <div>
              <div
                className={cn(
                  'text-sm font-bold',
                  greatDeal ? 'text-emerald-400' : 'text-white',
                )}
              >
                {fmt(party.entry)}
              </div>
              <div className="text-[10px] uppercase tracking-wide text-white/40">
                Entry
              </div>
            </div>
            <div className="border-x border-white/10">
              <div className="text-sm font-bold text-white">
                {fmt(party.chase)}
              </div>
              <div className="text-[10px] uppercase tracking-wide text-white/40">
                Chase
              </div>
            </div>
            <div>
              <div className="text-sm font-bold text-white/80">
                {fmt(party.avg)}
              </div>
              <div className="text-[10px] uppercase tracking-wide text-white/40">
                Avg
              </div>
            </div>
          </div>

          {/* Progress + count + time */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-[11px] text-white/55">
              <span className="inline-flex items-center gap-1">
                <Users className="h-3 w-3" aria-hidden />
                {party.filled}/{party.seats}
              </span>
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5',
                  ended ? 'text-white/35' : 'bg-white/10 text-white/70',
                )}
              >
                <Clock className="h-3 w-3" aria-hidden />
                {party.time}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className={cn(
                  'h-full rounded-full',
                  ended
                    ? 'bg-white/25'
                    : 'bg-gradient-to-r from-emerald-500 to-green-500',
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>

          {/* Action button */}
          {ended ? (
            <button
              type="button"
              disabled
              className="mt-auto w-full cursor-not-allowed rounded-xl border border-white/10 bg-white/5 py-2 text-xs font-semibold text-white/40"
            >
              Ended
            </button>
          ) : (
            <button
              type="button"
              className="mt-auto w-full rounded-xl bg-neutral-200 py-2 text-xs font-semibold text-neutral-950 transition-colors duration-200 hover:bg-white"
            >
              Join Party
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PackPartyPage() {
  const [tab, setTab] = useState<Tab>('Active');
  const ended = tab === 'Completed';
  const parties = ended ? COMPLETED_PARTIES : ACTIVE_PARTIES;

  return (
    <div className="mx-auto w-full px-fluid py-4">
      {/* 1. HEADER BLOCK */}
      <section className="relative mb-6 overflow-hidden rounded-2xl border border-white/10 bg-neutral-950">
        {/* Blurred, saturated slab banner */}
        <div className="pointer-events-none absolute inset-0 flex">
          {HEADER_SLABS.map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={src}
              alt=""
              aria-hidden="true"
              className="h-full flex-1 object-cover opacity-40 blur-2xl saturate-[1.8]"
            />
          ))}
        </div>
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-neutral-950 via-neutral-950/80 to-neutral-950/40" />

        <div className="relative flex flex-col gap-6 px-6 py-8 sm:px-10 sm:py-10 md:flex-row md:items-start md:justify-between">
          <div className="max-w-2xl">
            <Reveal
              as="h1"
              className="flex items-center gap-3 font-heading text-3xl font-bold tracking-tight text-white sm:text-4xl lg:text-5xl"
            >
              Pack Party
              <span className="inline-flex items-center rounded-full bg-gradient-to-r from-emerald-500 to-green-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shadow-sm">
                Beta
              </span>
            </Reveal>
            <Reveal
              as="p"
              delay={90}
              className="mt-3 max-w-xl text-sm leading-relaxed text-white/65 sm:text-base"
            >
              Rip packs with friends! Multiple players enter, one pack is
              opened, and cards are allocated to every player at random.
            </Reveal>
            <Reveal
              as="p"
              delay={160}
              className="mt-3 inline-flex items-center gap-2 text-xs text-white/50"
            >
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-gradient-to-r from-emerald-500 to-green-500" />
              = Entry &lt; Avg (great deal!)
            </Reveal>
          </div>

          <Reveal delay={120} className="shrink-0">
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-2xl bg-gradient-to-r from-emerald-500 to-green-500 px-6 py-3 text-sm font-semibold text-white shadow-lg transition-opacity duration-300 hover:opacity-90"
            >
              Create Party
            </button>
          </Reveal>
        </div>
      </section>

      {/* 2. CONTROL ROW */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Tabs */}
        <div className="inline-flex rounded-xl border border-white/10 bg-white/5 p-1">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                'rounded-lg px-4 py-1.5 text-sm font-medium transition-colors duration-200',
                tab === t
                  ? 'bg-white/10 text-white'
                  : 'text-white/50 hover:text-white/80',
              )}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Sort + view toggle (presentational) */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/70 transition-colors duration-200 hover:border-white/20 hover:text-white"
          >
            Players Needed (Low to High)
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          </button>
          <div className="inline-flex rounded-xl border border-white/10 bg-white/5 p-1">
            <button
              type="button"
              aria-label="Grid view"
              className="rounded-lg bg-white/10 p-1.5 text-white"
            >
              <LayoutGrid className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="List view"
              className="rounded-lg p-1.5 text-white/50 transition-colors duration-200 hover:text-white/80"
            >
              <List className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
      </div>

      {/* 3. PARTY GRID */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {parties.map((p, i) => (
          <Reveal key={p.id} delay={Math.min(i, 6) * 60} className="h-full">
            <PartyCard
              party={p}
              ended={ended}
              ring={RARITY_RINGS[i % RARITY_RINGS.length]!}
            />
          </Reveal>
        ))}
      </div>

      {/* 3b. PAGINATION — matches the live "Previous · Page 1 of N · Next" bar */}
      <div className="mt-8 flex items-center justify-center gap-3">
        <button
          type="button"
          aria-label="Previous page"
          disabled
          className="flex h-9 items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] px-3 text-[13px] font-medium text-white/40 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Previous
        </button>
        <span className="text-[13px] text-white/55">
          Page <span className="font-medium text-white">1</span> of{' '}
          {ended ? 2 : 4}
        </span>
        <button
          type="button"
          aria-label="Next page"
          className="flex h-9 items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] px-3 text-[13px] font-medium text-white/80 transition-colors hover:border-white/20 hover:bg-white/[0.06] hover:text-white"
        >
          Next
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {/* 4. BOTTOM CTA */}
      <Reveal
        as="section"
        className="mb-8 mt-16 overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent px-6 py-14 text-center sm:py-16"
      >
        <h2 className="font-heading text-2xl font-bold tracking-tight text-white sm:text-3xl lg:text-4xl">
          Have cards to share?
        </h2>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-white/60">
          Host your own Pack Party, set the entry, and rip a pack live with
          friends and fellow collectors. Everyone walks away with real cards.
        </p>
        <button
          type="button"
          className="mt-6 inline-flex items-center justify-center rounded-2xl bg-gradient-to-r from-emerald-500 to-green-500 px-8 py-3 text-sm font-semibold text-white shadow-lg transition-opacity duration-300 hover:opacity-90"
        >
          Create Your Own Party
        </button>
      </Reveal>
    </div>
  );
}
