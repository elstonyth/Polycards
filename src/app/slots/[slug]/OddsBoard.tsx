'use client';

import type { ReactNode } from 'react';
import { ticketCount, type Rarity } from '@/lib/packs-data';
import type { PoolValueRange } from '@/lib/packs-format';
import { rarityRgb } from '@/lib/rarity';
import { rm } from '@/lib/format';
import { Bezel } from '@/components/ui/soft';
import { hasPublishedOddsContent, rangeLabel } from './OddsSheet';

/**
 * The pack page's Pull Odds, as a board (DESIGN.md, Soft pack page): the
 * headline figure in its own plate beside one cell per tier. It states exactly
 * what `PublishedOddsList` states (the reel's odds sheet still uses that list):
 * the top figure, then every published tier with its chance and value range.
 *
 * The two bars are pictures of numbers printed beside them, so both are
 * `aria-hidden`: the split bar shows the tiers' shares of one pull, a cell's
 * bar its tier's chance out of 100. The split bar sits with the "Rates for
 * this pack" line, outside the expected-value plate: inside it, it read as a
 * breakdown of that RM figure. Tier hue only (Signal Rule).
 *
 * Exactly one `<ul>`: tests/e2e/odds-reflection.spec.ts reads the panel as
 * the section's single list.
 */
export function OddsBoard({
  heading,
  odds,
  range,
  expectedValue,
  tierRanges,
  tickets = false,
  tierCounts,
}: {
  /** The section's heading, set at the top of the board's first column. */
  heading: ReactNode;
  /** Published rows (rarest-first). */
  odds: { rarity: Rarity; chance: string }[];
  /** Pack value range; null hides the headline figure. Still the content gate. */
  range: PoolValueRange | null;
  /** Expected value of one pull; replaces the range as the headline figure. */
  expectedValue?: number | null;
  tierRanges?: Partial<Record<Rarity, PoolValueRange>>;
  /** A ticket pack: the same rows in ticket amounts, not money. */
  tickets?: boolean;
  /** Cards (prizes on a capsule) per tier, printed beside the tier's name.
   *  Opt-in: the homepage flow's summary rows; the pack page passes none. */
  tierCounts?: Partial<Record<Rarity, number>>;
}) {
  if (!hasPublishedOddsContent(odds, range)) return null;
  const noun = tickets ? 'prize' : 'card';

  // "0.2%" → 0.2, for the bars only. A chance that isn't a number draws no bar.
  const shares = odds.map((o) => {
    const n = Number.parseFloat(o.chance);
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  const anyShare = shares.some((n) => n > 0);

  return (
    <div className="@container">
      <div className="grid grid-cols-1 gap-5 @[56rem]:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] @[56rem]:gap-10">
        <div className="flex flex-col gap-5">
          {heading}
          {range !== null && (
            <Bezel core="p-5">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.02em] text-neutral-400">
                  {expectedValue != null
                    ? tickets
                      ? 'Average per pull'
                      : 'Expected value'
                    : tickets
                      ? 'Tickets per pull'
                      : 'Card value range'}
                </p>
                <p
                  className={
                    expectedValue != null
                      ? 'mt-2 font-heading text-[clamp(2rem,9cqi,2.5rem)] font-bold leading-none tracking-[-0.02em] tabular-nums text-white'
                      : // A range is two figures: smaller, and free to wrap.
                        'mt-2 font-heading text-2xl font-bold leading-tight tracking-tight tabular-nums text-white'
                  }
                >
                  {expectedValue == null
                    ? rangeLabel(range, tickets)
                    : tickets
                      ? ticketCount(Math.round(expectedValue * 10) / 10)
                      : rm(expectedValue)}
                </p>
              </div>
            </Bezel>
          )}
          <div className="flex flex-col gap-2.5 px-1">
            {anyShare && (
              <div
                aria-hidden
                className="flex h-2.5 gap-0.5 overflow-hidden rounded-full"
              >
                {odds.map((o, i) => (
                  <span
                    key={o.rarity}
                    className="min-w-1 rounded-[2px]"
                    style={{
                      flexGrow: shares[i],
                      flexBasis: 0,
                      background: `rgb(${rarityRgb(o.rarity)})`,
                    }}
                  />
                ))}
              </div>
            )}
            {/* Customer-facing copy never says "published": it implies a
                second, unpublished set of odds. These are "the rates for this
                pack". */}
            <p className="text-xs text-neutral-400">
              Rates for this {tickets ? 'capsule' : 'pack'}.
            </p>
          </div>
        </div>

        {odds.length > 0 && (
          <div className="@container">
            <ul className="grid grid-cols-1 gap-3 @[28rem]:grid-cols-2 @[44rem]:grid-cols-3">
              {odds.map((o, i) => {
                const tr = tierRanges?.[o.rarity];
                const rgb = rarityRgb(o.rarity);
                const label = tr ? rangeLabel(tr, tickets) : null;
                return (
                  <li
                    key={o.rarity}
                    // One column: name and range left, the chance right. From
                    // two columns up the cell stacks name, chance, range.
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 rounded-[1.25rem] bg-white/[0.04] p-4 ring-1 ring-white/10 @[28rem]:grid-cols-1 @[28rem]:gap-y-2 @[28rem]:p-5"
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold text-white">
                      <span
                        aria-hidden
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: `rgb(${rgb})` }}
                      />
                      {o.rarity}
                      {typeof tierCounts?.[o.rarity] === 'number' && (
                        <span className="text-xs font-normal tabular-nums text-neutral-400">
                          {tierCounts[o.rarity]}{' '}
                          {tierCounts[o.rarity] === 1 ? noun : `${noun}s`}
                        </span>
                      )}
                    </span>
                    <span className="col-start-2 row-span-2 row-start-1 font-heading text-[1.75rem] font-bold leading-none tracking-[-0.02em] tabular-nums text-white @[28rem]:col-start-1 @[28rem]:row-span-1 @[28rem]:row-start-2 @[28rem]:text-[2rem]">
                      {o.chance}
                    </span>
                    {label ? (
                      // The en-dash reads as nothing to a screen reader, so
                      // without a label the range runs into the percentage.
                      <span
                        className="text-xs leading-snug tabular-nums text-neutral-400 @[28rem]:row-start-3"
                        aria-label={`${tickets ? 'Pays' : 'Card value'} ${label.replace(' – ', ' to ')}`}
                      >
                        {label}
                      </span>
                    ) : (
                      // Keeps the chance centred in a one-column row.
                      <span aria-hidden className="@[28rem]:hidden" />
                    )}
                    <span
                      aria-hidden
                      className="col-span-full mt-1 h-1 overflow-hidden rounded-full bg-white/10"
                    >
                      <span
                        className="block h-full min-w-1 rounded-full"
                        style={{
                          // Out of 100, so a bar's length is its chance.
                          width: `${Math.min(100, shares[i] ?? 0)}%`,
                          background: `rgb(${rgb})`,
                        }}
                      />
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
