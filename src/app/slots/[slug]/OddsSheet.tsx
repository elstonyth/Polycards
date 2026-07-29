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
  rounded = 'xl',
}: {
  /** Published rows (rarest-first). */
  odds: { rarity: Rarity; chance: string }[];
  /** Pack card-value range (display prices, markup included); null hides the row. */
  range: PoolValueRange | null;
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
              Card value range
            </span>
            <span className="text-[13px] font-semibold tabular-nums text-white">
              {range.min} – {range.max}
            </span>
          </li>
        )}
        {odds.map((o) => (
          <li
            key={o.rarity}
            className="flex items-center justify-between border-b border-white/5 px-4 py-3 last:border-b-0"
          >
            <span className="flex items-center gap-2.5 text-[13px] font-medium text-white">
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ background: `rgb(${rarityRgb(o.rarity)})` }}
              />
              {o.rarity}
            </span>
            <span className="text-[13px] tabular-nums text-white/60">
              {o.chance}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 px-1 text-[11px] text-white/60">
        Published rates for this pack.
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
}: {
  open: boolean;
  onClose: () => void;
  /** Published rows (rarest-first); null = this pack has no published odds. */
  odds: { rarity: Rarity; chance: string }[] | null;
  range: PoolValueRange | null;
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
        aria-label="Published pull odds by rarity"
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
          <PublishedOddsList odds={odds} range={range} />
        ) : (
          <p className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-6 text-center text-[13px] text-white/60">
            Odds for this pack haven&apos;t been published yet.
          </p>
        )}
      </div>
    </div>
  );
}
