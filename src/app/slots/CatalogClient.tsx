'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import Image from 'next/image';
import {
  ChevronRight,
  Layers,
  ShieldCheck,
  RectangleVertical,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { rm0 } from '@/lib/format';
import { BUYBACK_RATE_LABEL } from '@/lib/buyback-copy';
import { pillVariants } from '@/components/ui/pill';
import Reveal from '@/components/Reveal';
import QtyStepper from '@/components/QtyStepper';
import FreePackBadge from '@/components/FreePackBadge';
import PackCategoryTabs from '@/components/PackCategoryTabs';
import {
  catalogGroupOf,
  packHref,
  packTabs,
  pickCategory,
  CATALOG_GROUP_HEADING,
  CATALOG_GROUP_ORDER,
  isTicketPack,
  type CatalogGroup,
  type Pack,
  type PackCategory,
} from '@/lib/packs-data';
import type { FreePackState } from '@/lib/data/free-pack';

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
            {buyback}% Instant Buyback
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
          {rm0(pack.priceMyr)}
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
            {buyback}% Instant Buyback
          </span>
        ) : (
          <span className="mt-1 block text-[11px] text-white/60">
            {isTicketPack(pack)
              ? categoryName
              : `${categoryName} · ${buyback}% instant buyback`}
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
          {rm0(pack.priceMyr)}
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
// Client — three composition sections, auto-detected from the backend's
// §2.4.8 `group` + strict `psa10` gate (see catalogGroupOf in packs-data.ts):
// "Graded (Guaranteed PSA 10)" lists ONLY pools where every card is a PSA 10;
// "Raw Cards (Ungraded)" lists ONLY backend-derived all-raw pools; everything
// uncertain (MIX, graded-but-not-all-PSA-10, null/older-backend) lists under
// the claim-free "More Packs" so neither heading can ever overclaim.
// The franchise switch picks which category's packs feed the sections.
// Desktop renders a horizontally-scrolling card row per section; mobile
// renders list rows. `initialCategory` lets a deep link (/slots?category=<key>)
// preselect a tab.
// ---------------------------------------------------------------------------

// Headings + order come from packs-data (shared with the pack detail page's
// sibling selector); only the icon and the qualifying note are this page's.
const GROUP_CHROME: Record<
  CatalogGroup,
  { note?: string; Icon: typeof ShieldCheck }
> = {
  graded: { note: 'Guaranteed PSA 10', Icon: ShieldCheck },
  raw: { note: 'Ungraded', Icon: RectangleVertical },
  // Claim-free by design — see catalogGroupOf's doc comment. No `note`:
  // an empty/omitted note is the only wording that's honest for every
  // member (MIX, non-PSA-10 graded, AND unknown/null composition alike).
  more: { Icon: Layers },
};

export default function CatalogClient({
  categories,
  freePack = null,
}: {
  /** Every franchise, empty ones included (they show as "Coming soon"). */
  categories: PackCategory[];
  /** Visible badge state, or null. `claim` only while this customer's one-time
   *  welcome claim is unspent; `signup` for logged-out visitors while an
   *  active free pack exists. The badge is the free pack's only entry point
   *  (it is not in `categories`). */
  freePack?: Exclude<FreePackState, { mode: 'hidden' }> | null;
}) {
  // The URL is the only state: Back to a cached /slots, a shared link and a
  // refresh that drops a franchise all read the same ?category=.
  const active =
    pickCategory(categories, useSearchParams().get('category') ?? undefined) ??
    '';
  const tabs = packTabs(categories);
  const pick = (id: string) => {
    // Next syncs useSearchParams with replaceState; other params survive.
    const params = new URLSearchParams(window.location.search);
    params.set('category', id);
    window.history.replaceState(null, '', `?${params}`);
  };

  // One franchise at a time; the sections below regroup it by composition,
  // so category icons/names travel with each pack entry.
  const entries = categories
    .filter((c) => c.id === active)
    .flatMap((cat) =>
      cat.packs.map((pack) => ({
        pack,
        icon: cat.icon,
        categoryName: cat.tab,
      })),
    );
  const byGroup = {
    graded: entries.filter((e) => catalogGroupOf(e.pack) === 'graded'),
    raw: entries.filter((e) => catalogGroupOf(e.pack) === 'raw'),
    more: entries.filter((e) => catalogGroupOf(e.pack) === 'more'),
  } as const;

  return (
    <div
      data-testid="catalog-root"
      className={cn(
        'mx-auto w-full px-fluid py-4',
        // The badge is `fixed` on the bottom-right rail, floating OVER the
        // catalog — at the end of the scroll it lands on the last row and
        // covers the right-most tile's MAX/Open controls. Reserve its rail as
        // bottom padding (only while the badge actually renders) so the
        // catalog can always be scrolled clear of it. Badge box: 146px tall
        // (112px art at 393x512) over a 4.5rem dock offset = 218px, dropping
        // to 24px + 146px = 170px once the tab bar is gone at lg.
        freePack && 'pb-56 lg:pb-44',
      )}
    >
      {freePack && <FreePackBadge state={freePack} />}

      {!entries.every((e) => isTicketPack(e.pack)) && (
        <p className="mb-4 text-[12px] leading-relaxed text-neutral-400">
          Instant buyback rates apply during the reveal countdown. Leaving the
          reveal or letting its timer expire changes buyback to{' '}
          {BUYBACK_RATE_LABEL} of card value in your vault.
        </p>
      )}

      {/* Franchise switch — only once there are two to pick from. Not sticky:
          the app header is sticky itself and would cover it. */}
      {tabs.length > 1 && (
        <div className="mb-6">
          <PackCategoryTabs categories={tabs} active={active} onChange={pick} />
        </div>
      )}

      {/* Empty state — zero packs in the catalog (the backend is the source
          of truth). */}
      {entries.length === 0 && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-10 text-center text-[13px] text-white/60">
          No packs available right now — check back soon.
        </div>
      )}

      {/* Composition sections — only the non-empty ones render. */}
      {CATALOG_GROUP_ORDER.filter((id) => byGroup[id].length > 0).map((id) => {
        const g = GROUP_CHROME[id];
        return (
          <section key={id} className="mb-8">
            {/* Section header */}
            <div className="mb-4 flex items-center gap-2.5">
              <g.Icon className="h-6 w-6 shrink-0 text-white/80" aria-hidden />
              <h2 className="font-heading text-lg font-bold tracking-tight text-white sm:text-xl">
                {CATALOG_GROUP_HEADING[id]}
                {/* The parenthetical is body voice, not Nekst display. Skipped
                  entirely (not rendered empty) when a section has no note
                  that's honest for every pack in it — see GROUP_CHROME above. */}
                {g.note && (
                  <>
                    {' '}
                    <span className="font-sans text-sm font-medium text-white/60 sm:text-base">
                      ({g.note})
                    </span>
                  </>
                )}
              </h2>
              <span className="ml-auto text-[13px] text-white/60">
                {byGroup[id].length}{' '}
                {byGroup[id].length === 1 ? 'pack' : 'packs'}
              </span>
            </div>

            {/* Desktop: horizontally-scrolling card row (matches live) */}
            <div className="hidden gap-4 overflow-x-auto pb-2 sm:flex [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {byGroup[id].map((e, i) => (
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
              {byGroup[id].map((e) => (
                <PackRow
                  key={e.pack.id}
                  pack={e.pack}
                  icon={e.icon}
                  categoryName={e.categoryName}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
