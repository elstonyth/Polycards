'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import {
  ChevronRight,
  Layers,
  ShieldCheck,
  RectangleVertical,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { pillVariants } from '@/components/ui/pill';
import Reveal from '@/components/Reveal';
import QtyStepper from '@/components/QtyStepper';
import FreePackBadge from '@/components/FreePackBadge';
import {
  inGuaranteedGroup,
  packHref,
  type Pack,
  type PackCategory,
} from '@/lib/packs-data';

// Pack catalog comes from the backend via getPackCategories() (server page);
// types + presentational category meta live in @/lib/packs-data.

// ---------------------------------------------------------------------------
// Pack card (DESKTOP) — art, name, price, quantity stepper, Open. Boosted
// tiers show their buyback percentage (90% / 92%); out-of-stock tiers render
// greyed + "Sold out". Open links to the pack's detail page (the free demo
// spin there needs no login — only a real open/claim is auth-gated).
// ---------------------------------------------------------------------------

function PackCard({ pack, icon }: { pack: Pack; icon: string }) {
  const [qty, setQty] = useState(1);
  const oos = pack.inStock === false;
  const buyback = pack.buybackPercent ?? 90;
  return (
    <div
      className={cn(
        'group relative flex h-full flex-col rounded-2xl border border-white/10 bg-white/5 p-3 shadow-[0_4px_20px_rgba(0,0,0,0.25)] transition-colors duration-300',
        oos ? 'opacity-60' : 'hover:border-white/20',
      )}
    >
      {/* Status badge (top-left): buyback boost on boosted tiers, else OOS chip */}
      {oos ? (
        <span className="absolute left-3 top-3 z-[2] rounded-md bg-neutral-700/90 px-1.5 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wide text-white/80 shadow-sm sm:text-[10px]">
          Out of Stock
        </span>
      ) : (
        pack.boost && (
          <span className="absolute left-3 top-3 z-[2] rounded-md bg-buyback px-1.5 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wide text-white shadow-sm sm:text-[10px]">
            +{buyback}% Buyback Boost
          </span>
        )
      )}

      {/* Category badge (top-right) — real per-category icon from the live site */}
      <Image
        src={icon}
        alt=""
        aria-hidden="true"
        width={24}
        height={24}
        className="absolute right-3 top-3 z-[2] h-6 w-6 object-contain opacity-80"
      />

      {/* Pack image — the tall vertical pack art dominates the card, matching the
          live /claw's tall, narrow cards (art is natively ~0.57 aspect). */}
      <div className="flex items-center justify-center pb-2 pt-3">
        <Image
          src={pack.image}
          alt={pack.name}
          width={205}
          height={360}
          // Operator-entered pack art can be on any host — bypass the optimizer
          // allowlist (matches the detail hero), else the thumbnail 400s.
          unoptimized
          className={cn(
            // hover zoom measured on live /claw: art scales to 1.092 over 0.7s on
            // Tailwind's default curve (0.4,0,0.2,1) — live has no lift/translate
            'h-52 w-auto object-contain drop-shadow-[0_12px_28px_rgba(0,0,0,0.5)] transition-transform duration-700 sm:h-60',
            oos ? 'grayscale' : 'group-hover:scale-[1.092]',
          )}
        />
      </div>

      {/* Name + price. Stacked, not a justify-between row: at card width a
          13px "Platinum Pack" plus "RM 2,500" doesn't fit one line, and the
          row truncated the pack's own name ("Platinum Pa…") on a 1440 screen
          with room to spare. The name gets the full column; price sits under
          it in the ledger voice. */}
      <div className="mb-3 min-w-0">
        <p className="truncate text-[13px] font-semibold text-white sm:text-sm">
          {pack.name}
        </p>
        <p className="font-heading mt-0.5 whitespace-nowrap text-[15px] tabular-nums text-white sm:text-base">
          {pack.price}
        </p>
      </div>

      {oos ? (
        <span className="mt-auto flex h-9 w-full items-center justify-center rounded-xl bg-white/10 text-[13px] font-semibold text-white/60">
          Sold out
        </span>
      ) : (
        <>
          {/* Quantity stepper — − 1 + MAX. The reel opens 1–3 per spin. */}
          <QtyStepper qty={qty} onChange={setQty} max={3} className="mb-2" />
          {/* Open → the pack's detail page. The free demo spin there is open
              to everyone; only a real open/claim is auth-gated. */}
          <Link
            href={packHref(pack.id, qty)}
            className={cn(
              pillVariants({ variant: 'primary', size: 'sm' }),
              'mt-auto w-full',
            )}
          >
            Open
          </Link>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pack row (MOBILE) — horizontal list row matching live /claw mobile:
// thumb | name + buyback badge | price pill (the whole row is the tap target).
// Out-of-stock rows render greyed + non-interactive with a "Sold out" pill.
// ---------------------------------------------------------------------------

function PackRow({
  pack,
  icon,
  categoryName,
}: {
  pack: Pack;
  icon: string;
  categoryName: string;
}) {
  const oos = pack.inStock === false;
  const buyback = pack.buybackPercent ?? 90;

  const inner = (
    <>
      {/* Thumbnail + category chip */}
      <div className="relative flex h-16 w-14 shrink-0 items-center justify-center">
        <Image
          src={pack.image}
          alt={pack.name}
          width={205}
          height={360}
          unoptimized
          className={cn(
            'h-16 w-auto object-contain drop-shadow-[0_6px_14px_rgba(0,0,0,0.5)]',
            oos && 'grayscale',
          )}
        />
        <Image
          src={icon}
          alt=""
          aria-hidden="true"
          width={16}
          height={16}
          className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full object-contain"
        />
      </div>

      {/* Name + buyback line */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-0.5 text-sm font-semibold text-white">
          <span className="truncate">{pack.name}</span>
          {!oos && (
            <ChevronRight
              className="h-3.5 w-3.5 shrink-0 text-white/60"
              aria-hidden
            />
          )}
        </div>
        {oos ? (
          <span className="mt-1 block text-[11px] text-white/60">
            Out of stock
          </span>
        ) : pack.boost ? (
          <span className="mt-1 inline-block rounded bg-buyback px-1.5 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wide text-white">
            +{buyback}% Buyback Boost
          </span>
        ) : (
          <span className="mt-1 block text-[11px] text-white/60">
            {categoryName} · {buyback}% buyback
          </span>
        )}
      </div>

      {/* Price pill (tap target) / sold-out */}
      {oos ? (
        <span className="flex shrink-0 items-center rounded-full bg-white/10 px-4 py-2 text-[13px] font-semibold text-white/60">
          Sold out
        </span>
      ) : (
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-white px-4 py-2 text-[13px] font-semibold text-neutral-950">
          {pack.price}
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </span>
      )}
    </>
  );

  if (oos) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-2.5 opacity-60">
        {inner}
      </div>
    );
  }

  return (
    <Link
      href={packHref(pack.id, 1)}
      className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-2.5 transition-colors hover:border-white/20 hover:bg-white/[0.07]"
    >
      {inner}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Client — two composition sections, auto-detected from the backend's §2.4.8
// `group` + strict `psa10` gate (see inGuaranteedGroup): "Graded (Guaranteed
// PSA 10)" lists ONLY pools where every card is a PSA 10; everything else
// (RAW, MIX, empty/unknown, graded-but-not-all-PSA-10) lists under "Raw Cards
// (Ungraded)" so the guarantee heading can never overclaim.
// The category chip rail still filters which packs feed the two sections.
// Desktop renders a horizontally-scrolling card row per section; mobile
// renders list rows. `initialCategory` lets a deep link (/slots?category=<key>)
// preselect a tab.
// ---------------------------------------------------------------------------

const GROUPS = [
  {
    id: 'graded',
    heading: 'Graded',
    note: 'Guaranteed PSA 10',
    Icon: ShieldCheck,
  },
  {
    id: 'raw',
    heading: 'Raw Cards',
    note: 'Ungraded',
    Icon: RectangleVertical,
  },
] as const;

export default function CatalogClient({
  categories,
  initialCategory,
  freePackSlug = null,
}: {
  categories: PackCategory[];
  initialCategory: string;
  /** Non-null only while this customer's one-time welcome claim is unspent —
   *  the badge is the free pack's only entry point (it is not in `categories`). */
  freePackSlug?: string | null;
}) {
  const [active, setActive] = useState<string>(initialCategory);

  const tabs = [
    { id: 'all', tab: 'All Packs', icon: '' },
    ...categories.map((c) => ({ id: c.id, tab: c.tab, icon: c.icon })),
  ];
  // The chip filter narrows the pack set; the sections below regroup it by
  // composition, so category icons/names travel with each pack entry.
  const filtered =
    active === 'all' ? categories : categories.filter((c) => c.id === active);
  const entries = filtered.flatMap((cat) =>
    cat.packs.map((pack) => ({
      pack,
      icon: cat.icon,
      categoryName: cat.tab,
    })),
  );
  const byGroup = {
    graded: entries.filter((e) => inGuaranteedGroup(e.pack)),
    raw: entries.filter((e) => !inGuaranteedGroup(e.pack)),
  } as const;

  return (
    <div
      className={cn(
        'mx-auto w-full px-fluid py-4',
        // The badge is `fixed` on the bottom-right rail, floating OVER the
        // catalog — at the end of the scroll it lands on the last row and
        // covers the right-most tile's MAX/Open controls. Reserve its rail as
        // bottom padding (only while the badge actually renders) so the
        // catalog can always be scrolled clear of it. Badge box: 146px tall
        // (112px art at 393x512) over a 4.5rem dock offset = 218px, dropping
        // to 24px + 146px = 170px once the tab bar is gone at lg.
        freePackSlug && 'pb-56 lg:pb-44',
      )}
    >
      {freePackSlug && <FreePackBadge slug={freePackSlug} />}

      {/* Sticky filter bar — category chip rail */}
      <div className="glass-chrome sticky top-2 z-20 mb-6 rounded-2xl border border-white/10 p-2">
        {/* Category chip rail (icons + label) */}
        <div className="flex items-center gap-1.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActive(t.id)}
              aria-pressed={active === t.id}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-2 text-[12px] font-medium transition-colors sm:text-[13px]',
                active === t.id
                  ? 'bg-white text-neutral-950'
                  : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white',
              )}
            >
              {t.icon ? (
                <Image
                  src={t.icon}
                  alt=""
                  aria-hidden="true"
                  width={16}
                  height={16}
                  className="h-4 w-4 shrink-0 rounded-full object-cover"
                />
              ) : (
                <Layers className="h-3.5 w-3.5 shrink-0" aria-hidden />
              )}
              {t.tab}
            </button>
          ))}
        </div>
      </div>

      {/* Empty state — zero packs behind the active filter (the backend is
          the source of truth), whether that's "All" on an empty catalog or a
          directly-selected empty category. */}
      {entries.length === 0 && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-10 text-center text-[13px] text-white/60">
          No packs available right now — check back soon.
        </div>
      )}

      {/* Composition sections — only the non-empty ones render. */}
      {GROUPS.filter((g) => byGroup[g.id].length > 0).map((g) => (
        <section key={g.id} className="mb-8">
          {/* Section header */}
          <div className="mb-4 flex items-center gap-2.5">
            <g.Icon className="h-6 w-6 shrink-0 text-white/80" aria-hidden />
            <h2 className="font-heading text-lg font-bold tracking-tight text-white sm:text-xl">
              {g.heading}{' '}
              {/* The parenthetical is body voice, not Nekst display */}
              <span className="font-sans text-sm font-medium text-white/60 sm:text-base">
                ({g.note})
              </span>
            </h2>
            <span className="ml-auto text-[13px] text-white/60">
              {byGroup[g.id].length}{' '}
              {byGroup[g.id].length === 1 ? 'pack' : 'packs'}
            </span>
          </div>

          {/* Desktop: horizontally-scrolling card row (matches live) */}
          <div className="hidden gap-4 overflow-x-auto pb-2 sm:flex [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {byGroup[g.id].map((e, i) => (
              <Reveal
                key={e.pack.id}
                delay={Math.min(i, 6) * 50}
                className="h-full w-44 shrink-0 lg:w-48"
              >
                <PackCard pack={e.pack} icon={e.icon} />
              </Reveal>
            ))}
          </div>

          {/* Mobile: list rows */}
          <div className="flex flex-col gap-2 sm:hidden">
            {byGroup[g.id].map((e) => (
              <PackRow
                key={e.pack.id}
                pack={e.pack}
                icon={e.icon}
                categoryName={e.categoryName}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
