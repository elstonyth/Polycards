'use client';

import { useMemo, useState } from 'react';
import Image from 'next/image';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rm0 } from '@/lib/format';
import { isOptimizableImage } from '@/lib/optimizable-image';
import { IntentLink } from '@/components/IntentLink';
import PackCategoryTabs from '@/components/PackCategoryTabs';
import { chipVariants } from '@/components/ui/chip';
import {
  CATALOG_GROUP_HEADING,
  PACK_LANGUAGE_LABEL,
  PACK_TYPE_LABEL,
  groupPacks,
  isTicketPack,
  shelfPacks,
  shelvePacks,
  type Pack,
  type PackLanguage,
  type PackTab,
  type PackType,
  type ResolvedPack,
} from '@/lib/packs-data';

/** DESIGN.md Label: Geist 600, 12px. Uppercase is for these small field names. */
export const FIELD_LABEL =
  'text-xs font-semibold uppercase tracking-[0.02em] text-neutral-400';

/**
 * The pack page's "which pack" zone: franchise, then pack type, then language,
 * then the packs themselves, cheapest first.
 *
 * It answers three things the old rails could not: what KIND of pack each one
 * is (the admin's Classic / Original / Special tag and an original pack's
 * language, shelved by `shelvePacks`), where the one you want sits (one shelf on
 * screen at a time, every tile fully visible, no sideways swipe), and how they
 * compare (price order). Graded / Raw Cards stay as each shelf's own headings:
 * those are the backend-derived composition claims (`groupPacks`), unchanged.
 *
 * A backend that sends no tags yields one untagged shelf, so the type chips
 * disappear and this is the composition groups alone.
 *
 * Mount it with `key={pack.id}`: the open shelf and language start from the
 * pack on the page, and a new pack must restart them.
 */
export function PackPicker({
  pack,
  siblings,
  categoryTabs,
  qty,
  onCategory,
}: {
  pack: ResolvedPack;
  siblings: Pack[];
  /** Under two, the category is a plain label: nothing to switch to. */
  categoryTabs: PackTab[];
  qty: number;
  onCategory: (id: string) => void;
}) {
  const ticketPack = isTicketPack(pack);
  const noun = ticketPack ? 'capsule' : 'pack';
  const shelves = useMemo(() => shelvePacks(siblings), [siblings]);
  // The shelf the page's own pack sits on opens first.
  const home =
    shelves.find((s) => s.packs.some((p) => p.id === pack.id)) ?? shelves[0];
  const [type, setType] = useState<PackType | null | undefined>(home?.type);
  const [language, setLanguage] = useState<PackLanguage | null>(
    pack.language ?? null,
  );
  const shelf = shelves.find((s) => s.type === type) ?? home;
  // A language switch only where the shelf holds two; it always has a pick.
  const shownLanguage =
    shelf && shelf.languages.length > 1
      ? language && shelf.languages.includes(language)
        ? language
        : (shelf.languages[0] ?? null)
      : null;
  const groups = shelf ? groupPacks(shelfPacks(shelf, shownLanguage)) : [];

  return (
    <div className="flex flex-col gap-3.5 px-4 pb-3 pt-4 sm:px-5">
      {/* Category */}
      <div>
        <p className={cn(FIELD_LABEL, 'mb-2')}>Category</p>
        {categoryTabs.length > 1 ? (
          // The franchise switch the home shelf and /slots already use, so the
          // other franchises are on screen instead of inside a dropdown.
          <PackCategoryTabs
            categories={categoryTabs}
            active={pack.categoryId}
            onChange={onCategory}
            compact
          />
        ) : (
          <div className="flex h-11 items-center gap-2 rounded-full bg-white/[0.06] px-4 text-sm font-semibold text-white ring-1 ring-white/10">
            <Image
              src={pack.icon}
              alt=""
              aria-hidden
              width={20}
              height={20}
              className="h-5 w-5 object-contain"
            />
            {pack.categoryName}
          </div>
        )}
      </div>

      {/* Packs — an uncataloged pack (the free welcome pack) has no siblings,
          and an empty selector reads as a broken section rather than a choice. */}
      {shelf && (
        <div
          data-testid="pack-selector"
          // A container: the tiles go three across once the panel has the room.
          className="@container flex flex-col gap-3"
        >
          <div className="flex items-baseline justify-between gap-2">
            <p className={FIELD_LABEL}>{ticketPack ? 'Capsule' : 'Pack'}</p>
            <span className="text-xs text-neutral-400">
              <span className="tabular-nums">{siblings.length}</span>{' '}
              {siblings.length === 1 ? noun : `${noun}s`}
            </span>
          </div>

          {(shelves.length > 1 || shownLanguage) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {shelves.length > 1 && (
                <div
                  role="group"
                  aria-label="Pack type"
                  className="flex flex-wrap gap-2"
                >
                  {shelves.map((s) => {
                    const on = s === shelf;
                    return (
                      <button
                        key={s.type ?? 'other'}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setType(s.type)}
                        className={cn(chipVariants(on), 'px-3.5')}
                      >
                        {s.type ? PACK_TYPE_LABEL[s.type] : 'Other'}
                        <span
                          className={cn(
                            'font-normal tabular-nums',
                            on ? 'text-neutral-600' : 'text-neutral-400',
                          )}
                        >
                          {s.packs.length}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {shownLanguage && (
                <div
                  role="group"
                  aria-label="Language"
                  className="flex flex-wrap gap-2"
                >
                  {shelf.languages.map((l) => (
                    <button
                      key={l}
                      type="button"
                      aria-pressed={l === shownLanguage}
                      onClick={() => setLanguage(l)}
                      className={cn(
                        chipVariants(l === shownLanguage),
                        'px-3.5',
                      )}
                    >
                      {PACK_LANGUAGE_LABEL[l]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {groups.map((g) => (
            <div key={g.id} data-testid="pack-selector-group">
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <p className="text-[13px] font-semibold text-white">
                  {ticketPack && g.id === 'more'
                    ? 'More Capsules'
                    : CATALOG_GROUP_HEADING[g.id]}
                </p>
                <span className="text-xs text-neutral-400">
                  <span className="tabular-nums">{g.packs.length}</span>{' '}
                  {g.packs.length === 1 ? noun : `${noun}s`}
                </span>
              </div>
              {/* `pack-rail` is the id the QA scripts know this list by; it has
                  been a wrapping grid, not a rail, since 2026-11-18. */}
              <div
                data-testid="pack-rail"
                // Two across, three once the panel is wide enough to hold a
                // full name beside the art. In two columns an odd pack out
                // takes the whole last row instead of leaving half of it empty.
                className="grid grid-cols-2 gap-2 @[26rem]:grid-cols-3 [&>*:last-child:nth-child(odd)]:col-span-2 @[26rem]:[&>*:last-child:nth-child(odd)]:col-span-1"
              >
                {g.packs.map((p) => (
                  <PackTile
                    key={p.id}
                    pack={p}
                    selected={p.id === pack.id}
                    qty={qty}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PackTile({
  pack: p,
  selected,
  qty,
}: {
  pack: Pack;
  selected: boolean;
  qty: number;
}) {
  const soldOut = p.inStock === false;
  return (
    <IntentLink
      href={`/slots/${p.id}?count=${qty}`}
      scroll={false}
      aria-current={selected ? 'page' : undefined}
      className={cn(
        'group relative flex min-h-14 items-center gap-2.5 rounded-[1.25rem] border px-2.5 py-1.5 text-left outline-none',
        'transition-[background-color,border-color,transform] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-white/40',
        'motion-reduce:transition-[background-color,border-color] motion-reduce:active:scale-100',
        selected
          ? 'border-neutral-50 bg-neutral-800'
          : 'border-white/10 bg-neutral-900 hover:border-white/25 hover:bg-neutral-800',
      )}
    >
      {/* Drawn ~23x40 CSS px. A local /public image goes through the optimizer
          at that size: the raw 925x1666 art decoded to ~6 MB each on phones
          (iOS tab memory, 2026-10-25). Art on a host outside remotePatterns
          stays unoptimized. */}
      <Image
        src={p.image}
        alt=""
        aria-hidden
        width={41}
        height={72}
        unoptimized={!isOptimizableImage(p.image)}
        className={cn(
          'h-10 w-6 shrink-0 object-contain transition-transform duration-200 group-hover:scale-[1.06] motion-reduce:transition-none motion-reduce:group-hover:scale-100',
          // Sold out dims the art, never the words.
          soldOut && 'opacity-50 grayscale',
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            'line-clamp-2 text-[13px] font-semibold leading-tight text-white',
            // Room for the tick in the corner.
            selected && 'pr-4',
          )}
        >
          {p.name.replace(' Pack', '')}
        </span>
        <span
          className={cn(
            'font-heading text-[13px] leading-none tabular-nums',
            selected ? 'text-white' : 'text-neutral-400',
          )}
        >
          {rm0(p.priceMyr)}
          {soldOut && (
            <span className="mt-1 block font-sans text-xs font-medium text-neutral-400">
              Sold out
            </span>
          )}
        </span>
      </span>
      {selected && (
        <span
          aria-hidden
          className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-neutral-50 text-neutral-950"
        >
          <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
        </span>
      )}
    </IntentLink>
  );
}
