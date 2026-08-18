// src/app/slots/[slug]/OddsSheet.tsx
'use client';

import { useRef } from 'react';
import { X } from 'lucide-react';
import type { Rarity } from '@/lib/packs-data';
import type { PoolValueRange } from '@/lib/packs-format';
import { rarityRgb } from '@/lib/rarity';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { useLiquidGlass, GLASS_SUBTLE } from '@/lib/use-liquid-glass';

/** True when there is at least one row to render — a pack can publish odds with
 *  no per-tier percentages AND have nothing priced (a backend without
 *  `marketPriceMyr` prices every card as '—', so poolValueRange returns null),
 *  which would otherwise paint an empty bordered box. Callers gate on this so
 *  they can fall back to their own "not published yet" copy. */
export const hasPublishedOddsContent = (
  odds: { rarity: Rarity; chance: string }[] | null,
  range: PoolValueRange | null,
): odds is { rarity: Rarity; chance: string }[] =>
  odds !== null && (odds.length > 0 || range !== null);

/** The published-odds list itself — value-range row + per-rarity rows + caption.
 *  Shared between this sheet and the pack page's odds panel so the two can't
 *  drift (they did during the Epic→Mythical rename). */
export function PublishedOddsList({
  odds,
  range,
  expectedValue,
  tierRanges,
  rounded = 'xl',
}: {
  /** Published rows (rarest-first). */
  odds: { rarity: Rarity; chance: string }[];
  /** Pack card-value range (display prices, markup included); null hides the row.
   *  Still the content gate (see hasPublishedOddsContent) even when the row
   *  itself renders the expected value instead. */
  range: PoolValueRange | null;
  /** Expected value of one pull over the published tiers; when present it
   *  REPLACES the range in the top row. Null (no published tier has a priced
   *  card) falls back to the range, so a pack with a priced pool but no
   *  per-tier rows still has something in that row. */
  expectedValue?: string | null;
  /** Per-tier value ranges. A tier absent here (nothing priced in that tier, or
   *  the caller did not supply them) simply renders without a range line. */
  tierRanges?: Partial<Record<Rarity, PoolValueRange>>;
  rounded?: 'xl' | '2xl';
}) {
  // Nothing to show: render nothing rather than an empty bordered <ul> + a
  // "Published rates for this pack." caption over zero rates.
  if (!hasPublishedOddsContent(odds, range)) return null;

  return (
    <>
      <ul
        className={`overflow-hidden border border-white/10 bg-white/[0.03] ${
          rounded === '2xl' ? 'rounded-2xl' : 'rounded-xl'
        }`}
      >
        {range !== null && (
          <li className="flex items-center justify-between border-b border-white/5 bg-white/[0.03] px-4 py-3">
            <span className="text-[13px] font-semibold text-white">
              {expectedValue ? 'Expected value' : 'Card value range'}
            </span>
            <span className="text-[13px] font-semibold tabular-nums text-white">
              {expectedValue ?? `${range.min} – ${range.max}`}
            </span>
          </li>
        )}
        {odds.map((o) => {
          const tr = tierRanges?.[o.rarity];
          return (
            <li
              key={o.rarity}
              className="flex items-center justify-between gap-3 border-b border-white/5 px-4 py-3 last:border-b-0"
            >
              {/* Tier name, with its own value range beneath. The range is a
                  second line rather than a third column so a long
                  "RM 1,676.90 – RM 22,377.23" never crushes the percentage on a
                  narrow phone — this panel is mobile-first. */}
              <span className="flex min-w-0 items-start gap-2.5">
                <span
                  className="mt-[5px] h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: `rgb(${rarityRgb(o.rarity)})` }}
                />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-white">
                    {o.rarity}
                  </span>
                  {tr && (
                    // The en-dash reads as nothing to a screen reader, so
                    // without a label the range runs into the percentage as
                    // one unbroken string of numbers.
                    <span
                      className="block text-[11px] tabular-nums text-white/45"
                      aria-label={
                        tr.min === tr.max
                          ? `Card value ${tr.min}`
                          : `Card value ${tr.min} to ${tr.max}`
                      }
                    >
                      {tr.min === tr.max ? tr.min : `${tr.min} – ${tr.max}`}
                    </span>
                  )}
                </span>
              </span>
              <span className="shrink-0 text-[13px] tabular-nums text-white/60">
                {o.chance}
              </span>
            </li>
          );
        })}
      </ul>
      {/* Customer-facing copy never says "published". It implies a second,
          UNPUBLISHED set of odds — which invites exactly the question we do not
          want a player asking. These are simply "the rates for this pack". */}
      <p className="mt-2 px-1 text-[11px] text-white/60">
        Rates for this pack.
      </p>
    </>
  );
}

/** Published rarity-odds list (admin-authored, from the backend). Never
 *  exposes the win-rate lock (PRD §3.7/§8). */
export function OddsSheet({
  open,
  onClose,
  odds,
  range,
  expectedValue,
  tierRanges,
}: {
  open: boolean;
  onClose: () => void;
  /** Published rows (rarest-first); null = this pack has no published odds. */
  odds: { rarity: Rarity; chance: string }[] | null;
  range: PoolValueRange | null;
  expectedValue?: string | null;
  tierRanges?: Partial<Record<Rarity, PoolValueRange>>;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, open, onClose);

  // Liquid-glass rim on the sheet panel (frosted fallback on Safari/Firefox).
  useLiquidGlass(panelRef, open, GLASS_SUBTLE);

  if (!open) return null;

  return (
    <div
      className="glass-stage fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Pull odds by rarity"
        tabIndex={-1}
        className="glass-panel max-h-[85vh] w-full overflow-y-auto rounded-t-2xl border-t p-5 pb-[env(safe-area-inset-bottom)] outline-none sm:inset-x-auto sm:bottom-auto sm:max-w-sm sm:rounded-2xl sm:border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-heading text-lg font-bold tracking-tight text-white">
            Pull odds by rarity
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close odds"
            className="flex h-11 w-11 items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        {/* Published AND non-empty ⇢ render. Odds can be published with no
            per-tier rows; if nothing in the pool is priced either, the range row
            is gone too and the list would be an empty box — so fall through to
            the not-published copy. Same gate as the pack page's odds panel. */}
        {hasPublishedOddsContent(odds, range) ? (
          <PublishedOddsList
            odds={odds}
            range={range}
            expectedValue={expectedValue}
            tierRanges={tierRanges}
          />
        ) : (
          <p className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-6 text-center text-[13px] text-white/60">
            Odds for this pack aren&apos;t available yet.
          </p>
        )}
      </div>
    </div>
  );
}
