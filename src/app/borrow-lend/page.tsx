'use client';

// /borrow-lend — peer lending marketplace matching live phygitals: "Borrow / Lend"
// header + "Create lend offer" CTA, two mode tiles (lend USD / borrow USDC), a
// collections + APR-sort filter row with the active-offer count, then a list of
// lend offers (thumb | card + lender + expiry | amount + APR/duration | Lend).
// Standalone full-width route (global header/footer, no account sidebar — matching
// live). Client component for mode + sort state; metadata skipped (consistent with
// /claw, /repacks, /pack-party).

import { useState } from 'react';
import { Landmark, Plus, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import Reveal from '@/components/Reveal';
import { MOCK_CARDS } from '@/lib/mock/cards';
import { MOCK_USERS } from '@/lib/mock/users';
import { usd } from '@/lib/format';

const DURATIONS = ['3d', '7d', '14d', '30d'];
const EXPIRES = [
  'expires in 1h',
  'expires in 1d',
  'expires in 2d',
  'expires in 3d',
  'expires in 5d',
];

// One lend offer per card in the mock pool (48) → "48 active offers", APR descending.
const OFFERS = MOCK_CARDS.map((c, i) => ({
  id: c.id,
  image: c.image,
  name: c.name,
  user: MOCK_USERS[i % MOCK_USERS.length].username,
  expires: EXPIRES[i % EXPIRES.length],
  amount: c.fmv,
  apr: Math.max(50, 200 - i * 3),
  duration: DURATIONS[i % DURATIONS.length],
}));

type Mode = 'lend' | 'borrow';

export default function BorrowLendPage() {
  const [mode, setMode] = useState<Mode>('lend');
  const [collection, setCollection] = useState('All collections');
  const [aprDir, setAprDir] = useState<'high' | 'low'>('high');

  const offers = [...OFFERS].sort((a, b) =>
    aprDir === 'high' ? b.apr - a.apr : a.apr - b.apr,
  );

  const selectClass =
    'appearance-none rounded-xl border border-white/10 bg-white/5 py-2 pl-3 pr-9 text-[13px] font-medium text-white/80 transition-colors hover:bg-white/10 focus:outline-none focus:ring-1 focus:ring-white/20';

  return (
    <div className="w-full px-fluid py-6">
      {/* Header */}
      <div className="mb-5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <Landmark className="h-6 w-6 text-emerald-400" aria-hidden />
          <h1 className="font-heading text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Borrow / Lend
          </h1>
        </div>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-neutral-100 px-4 py-2 text-[13px] font-semibold text-neutral-950 transition-colors hover:bg-white"
        >
          <Plus className="h-4 w-4" aria-hidden /> Create lend offer
        </button>
      </div>

      {/* Mode tiles */}
      <div className="mb-5 grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => setMode('lend')}
          aria-pressed={mode === 'lend'}
          className={cn(
            'rounded-2xl border p-4 text-left transition-colors',
            mode === 'lend'
              ? 'border-white/25 bg-white/[0.07]'
              : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04]',
          )}
        >
          <div className="text-sm font-semibold text-white">
            I want to lend USD
          </div>
          <div className="mt-1 text-xs text-white/45">
            Fund borrow offers and earn APR
          </div>
        </button>
        <button
          type="button"
          onClick={() => setMode('borrow')}
          aria-pressed={mode === 'borrow'}
          className={cn(
            'rounded-2xl border p-4 text-left transition-colors',
            mode === 'borrow'
              ? 'border-white/25 bg-white/[0.07]'
              : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04]',
          )}
        >
          <div className="text-sm font-semibold text-white">
            I want to borrow USDC
          </div>
          <div className="mt-1 text-xs text-white/45">
            Use an item as collateral
          </div>
        </button>
      </div>

      {/* Filter row */}
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <div className="relative">
          <select
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            className={selectClass}
            aria-label="Filter by collection"
          >
            <option>All collections</option>
            <option>Pokémon</option>
            <option>Basketball</option>
            <option>One Piece</option>
            <option>Baseball</option>
          </select>
          <ChevronDown
            className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/50"
            aria-hidden
          />
        </div>
        <div className="relative">
          <select
            value={aprDir}
            onChange={(e) => setAprDir(e.target.value as 'high' | 'low')}
            className={selectClass}
            aria-label="Sort by APR"
          >
            <option value="high">APR: high to low</option>
            <option value="low">APR: low to high</option>
          </select>
          <ChevronDown
            className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/50"
            aria-hidden
          />
        </div>
        <span className="ml-auto text-[13px] text-white/45">
          {OFFERS.length} active offers
        </span>
      </div>

      {/* Offers list */}
      <div className="flex flex-col">
        {offers.map((o, i) => (
          <Reveal as="div" key={o.id} delay={Math.min(i, 10) * 25}>
            <div className="flex flex-col gap-3 border-b border-white/[0.06] py-4 sm:flex-row sm:items-center sm:gap-4">
              {/* Card + lender */}
              <div className="flex min-w-0 flex-1 items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={o.image}
                  alt=""
                  className="h-14 w-11 shrink-0 rounded bg-white/5 object-contain"
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-white">
                    {o.name}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-white/45">
                    by @{o.user} · {o.expires}
                  </p>
                </div>
              </div>

              {/* Amount + APR/duration + Lend */}
              <div className="flex items-center justify-between gap-4 sm:justify-end">
                <div className="text-left sm:text-right">
                  <div className="text-sm font-semibold text-emerald-400">
                    {usd(o.amount)}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-white/70">
                      {o.apr.toFixed(2)}% APR
                    </span>
                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-white/55">
                      {o.duration}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className="shrink-0 rounded-xl bg-neutral-100 px-5 py-2 text-sm font-semibold text-neutral-950 transition-colors hover:bg-white"
                >
                  Lend
                </button>
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </div>
  );
}
