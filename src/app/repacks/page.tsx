'use client';

// /repacks — community-created packs ("Packs created by anyone"). Single-file client
// component (needs chip-filter + per-card quantity state); metadata is intentionally
// skipped, consistent with /claw and /pack-party. The global SiteHeader/SiteFooter from
// layout.tsx still wrap this body.
//
// Layout matches the live phygitals /repacks: a hero banner over blurred pack art, a
// category chip rail + sort toolbar, then a grid of BIG pack cards each with a quantity
// stepper (− 1 + MAX) and an Open button — distinct from /claw (which has no stepper).
// Pack ART is real (reused from the /claw catalog); the names/creators are community
// flavored so the two pages don't render identically. (Layout fix, not an exact 1:1
// content match — the live 50/50 / FIRE / PIKA custom artwork is user-uploaded.)

import { useState } from 'react';
import Link from 'next/link';
import { Plus, SlidersHorizontal, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import Reveal from '@/components/Reveal';
import QtyStepper from '@/components/QtyStepper';
import { usd0 } from '@/lib/format';
import { MOCK_USERS } from '@/lib/mock/users';
import { CATEGORIES } from '../claw/packs-data';

// ---------------------------------------------------------------------------
// Data — community packs (real art, community-flavored names + creators).
// ---------------------------------------------------------------------------

const CAT_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

// Chip-rail tabs: "All Packs" + the real /claw categories (label + icon reused).
const TABS = [
  { id: 'all', tab: 'All Packs', icon: '' },
  ...CATEGORIES.map((c) => ({ id: c.id, tab: c.tab, icon: c.icon })),
];

const MAX_QTY = 10;

type CommunityPack = {
  id: string;
  name: string;
  /** Maps to a /claw category id (drives chip filtering + the card badge icon). */
  categoryId: string;
  /** Pack art under public/images/claw/ (verified to exist via the /claw catalog). */
  image: string;
  price: number;
  /** Index into MOCK_USERS for the "created by" attribution. */
  creator: number;
  /** Shows the green "+85% Buyback" badge. */
  boost?: boolean;
};

// Pokémon-only catalog — every community pack is Pokémon (real /claw Pokémon
// pack art, community-flavored names + creators).
const COMMUNITY_PACKS: CommunityPack[] = [
  {
    id: 'mini-5050',
    name: 'Mini 50/50 Pack',
    categoryId: 'pokemon',
    image: '/images/claw/rookie-pack-icon.webp',
    price: 50,
    creator: 0,
    boost: true,
  },
  {
    id: '5050',
    name: '50/50 Pack',
    categoryId: 'pokemon',
    image: '/images/claw/elite-pack-icon.webp',
    price: 100,
    creator: 5,
  },
  {
    id: 'super-mini-fire',
    name: 'Super Mini Fire Pack',
    categoryId: 'pokemon',
    image: '/images/claw/mythic-pack-icon.webp',
    price: 25,
    creator: 11,
    boost: true,
  },
  {
    id: 'phantom-pika',
    name: 'Phantom Pika Pack',
    categoryId: 'pokemon',
    image: '/images/claw/legend-pack-icon.webp',
    price: 250,
    creator: 3,
    boost: true,
  },
  {
    id: 'daily-ripper',
    name: 'Daily Ripper',
    categoryId: 'pokemon',
    image: '/images/claw/trainer-pack-icon.webp',
    price: 15,
    creator: 7,
  },
  {
    id: 'grail-hunter',
    name: 'Grail Hunter',
    categoryId: 'pokemon',
    image: '/images/claw/black-pack-icon.webp',
    price: 250,
    creator: 13,
    boost: true,
  },
  {
    id: 'quick-draw-mini',
    name: 'Quick Draw Mini',
    categoryId: 'pokemon',
    image: '/images/claw/elite-pack-icon.webp',
    price: 40,
    creator: 2,
  },
  {
    id: 'black-ice-whale',
    name: 'Black Ice Whale',
    categoryId: 'pokemon',
    image: '/images/claw/black-pack-icon.webp',
    price: 1000,
    creator: 16,
    boost: true,
  },
  {
    id: 'diamond-rookie',
    name: 'Diamond Rookie',
    categoryId: 'pokemon',
    image: '/images/claw/diamond-pack-icon.webp',
    price: 20,
    creator: 9,
  },
  {
    id: 'hidden-grail',
    name: 'Hidden Grail',
    categoryId: 'pokemon',
    image: '/images/claw/platinum-pack-icon.webp',
    price: 500,
    creator: 4,
    boost: true,
  },
  {
    id: 'pull-perfect',
    name: 'Pull Perfect',
    categoryId: 'pokemon',
    image: '/images/claw/elite-pack-icon.webp',
    price: 100,
    creator: 15,
  },
  {
    id: 'daily-pull',
    name: 'Daily Pull',
    categoryId: 'pokemon',
    image: '/images/claw/rookie-pack-icon.webp',
    price: 10,
    creator: 8,
  },
  {
    id: 'rookie-starter',
    name: 'Rookie Starter',
    categoryId: 'pokemon',
    image: '/images/claw/rookie-pack-icon.webp',
    price: 25,
    creator: 17,
  },
];

// Blurred pack-art slabs behind the hero (atmosphere — verified to exist).
const HERO_SLABS = [
  '/images/claw/legend-pack-icon.webp',
  '/images/claw/mythic-pack-icon.webp',
  '/images/claw/black-pack-icon.webp',
  '/images/claw/diamond-pack-icon.webp',
  '/images/claw/platinum-pack-icon.webp',
];

// ---------------------------------------------------------------------------
// Pack card — big art, name/price, creator, quantity stepper, Open button.
// ---------------------------------------------------------------------------

function PackCard({ pack }: { pack: CommunityPack }) {
  const [qty, setQty] = useState(1);
  const creator = MOCK_USERS[pack.creator % MOCK_USERS.length];
  const icon = CAT_BY_ID.get(pack.categoryId)?.icon;

  return (
    <div className="group relative flex h-full flex-col rounded-2xl border border-white/10 bg-white/5 p-3 shadow-[0_4px_20px_rgba(0,0,0,0.25)] transition-colors duration-300 hover:border-white/20">
      {/* Green buyback badge */}
      {pack.boost && (
        <span className="absolute left-3 top-3 z-[2] rounded-md bg-emerald-500/90 px-1.5 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wide text-white shadow-sm sm:text-[10px]">
          +85% Buyback
        </span>
      )}

      {/* Category badge (top-right) */}
      {icon && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={icon}
          alt=""
          aria-hidden="true"
          width={24}
          height={24}
          className="absolute right-3 top-3 z-[2] h-6 w-6 object-contain opacity-80"
        />
      )}

      {/* Big pack art */}
      <div className="flex items-center justify-center py-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={pack.image}
          alt={pack.name}
          width={220}
          height={290}
          loading="lazy"
          className="h-44 w-auto object-contain drop-shadow-[0_12px_28px_rgba(0,0,0,0.5)] transition-transform duration-300 ease-out group-hover:-translate-y-1 sm:h-48"
        />
      </div>

      {/* Name + price */}
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="truncate text-[13px] font-semibold text-white sm:text-sm">
          {pack.name}
        </span>
        <span className="shrink-0 text-[13px] font-semibold text-white/90 sm:text-sm">
          {usd0(pack.price)}
        </span>
      </div>

      {/* Creator attribution */}
      <Link
        href={`/profile/${creator.username}`}
        className="mb-3 flex items-center gap-1.5 text-[11px] text-white/40 transition-colors hover:text-white/70"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={creator.pfp}
          alt=""
          className="h-4 w-4 rounded-full object-cover"
        />
        <span className="truncate">by {creator.username}</span>
      </Link>

      {/* Quantity stepper — − 1 + MAX (shared with /claw via QtyStepper) */}
      <QtyStepper qty={qty} onChange={setQty} max={MAX_QTY} className="mb-2" />

      {/* Open button */}
      <Link
        href="/claw"
        className="mt-auto flex h-9 w-full items-center justify-center rounded-xl bg-neutral-200 text-[13px] font-semibold text-neutral-950 transition-colors duration-200 hover:bg-white"
      >
        Open{qty > 1 ? ` ×${qty}` : ''}
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function RepacksPage() {
  const [cat, setCat] = useState('all');
  const packs =
    cat === 'all'
      ? COMMUNITY_PACKS
      : COMMUNITY_PACKS.filter((p) => p.categoryId === cat);

  return (
    <div className="mx-auto w-full px-fluid py-4">
      {/* 1. HERO BANNER */}
      <section className="relative mb-6 overflow-hidden rounded-2xl border border-white/10 bg-neutral-950">
        {/* Blurred pack-art atmosphere */}
        <div className="pointer-events-none absolute inset-0 flex">
          {HERO_SLABS.map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={src}
              alt=""
              aria-hidden="true"
              className="h-full flex-1 object-cover opacity-30 blur-3xl saturate-150"
            />
          ))}
        </div>
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-neutral-950 via-neutral-950/85 to-neutral-950/30" />

        <div className="relative flex flex-col gap-6 px-6 py-10 sm:px-10 sm:py-12 md:flex-row md:items-center md:justify-between">
          <div className="max-w-xl">
            <Reveal
              as="h1"
              className="font-heading text-3xl font-bold tracking-tight text-white sm:text-4xl lg:text-5xl"
            >
              Packs created by anyone
            </Reveal>
            <Reveal
              as="p"
              delay={90}
              className="mt-3 max-w-md text-sm leading-relaxed text-white/65 sm:text-base"
            >
              Curated pulls with 85% guaranteed buyback. Filter and sort to find
              your next rip.
            </Reveal>
            <Reveal delay={150}>
              <Link
                href="/clawmaker"
                className="mt-6 inline-flex items-center gap-2 rounded-2xl bg-neutral-100 px-6 py-3 text-sm font-semibold text-neutral-950 shadow-lg transition-colors duration-200 hover:bg-white"
              >
                <Plus className="h-4 w-4" aria-hidden /> Create a Claw
              </Link>
            </Reveal>
          </div>

          {/* Featured pack render (desktop) */}
          <Reveal
            delay={120}
            className="pointer-events-none hidden shrink-0 md:block"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/images/claw/legend-pack-icon.webp"
              alt=""
              aria-hidden="true"
              className="h-44 w-auto rotate-3 object-contain drop-shadow-[0_20px_50px_rgba(0,0,0,0.65)] lg:h-56"
            />
          </Reveal>
        </div>
      </section>

      {/* 2. CHIP RAIL + SORT TOOLBAR */}
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setCat(t.id)}
              aria-pressed={cat === t.id}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors sm:text-[13px]',
                cat === t.id
                  ? 'bg-white text-neutral-950'
                  : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white',
              )}
            >
              {t.icon && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={t.icon}
                  alt=""
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 rounded-full object-cover"
                />
              )}
              {t.tab}
            </button>
          ))}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-white/10 sm:text-[13px]"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden /> Filters
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[12px] font-medium text-white/70 transition-colors hover:text-white sm:text-[13px]"
          >
            Last Pulled <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </div>

      {/* 3. PACK GRID */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {packs.map((p, i) => (
          <Reveal key={p.id} delay={Math.min(i, 8) * 50} className="h-full">
            <PackCard pack={p} />
          </Reveal>
        ))}
      </div>
    </div>
  );
}
