'use client';

import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rm } from '@/lib/format';
import { useCountedValue } from '@/lib/use-counted-value';
import { Pill } from '@/components/ui/pill';

// The vault's action bar. With nothing selected it is a slim pill over the
// phone dock: Select All, and what a selection can do. Picking a card grows
// it: the count, FMV above "Sell for", then Coin flip, Ship and Sell back in
// one row with Sell rightmost. (Owner 2026-11-26: the always-open three-row
// bar stood too tall over the cards.) Rendered whenever the vault has cards.
// Purely presentational: selection state and money live in VaultClient.
export function VaultActionBar({
  selectedCount,
  sellableCount,
  allVisibleSelected,
  visibleCount,
  fmv,
  sellTotal,
  quotesFirm,
  busy,
  onToggleSelectAll,
  onSell,
  onDeliver,
  onCoinFlip,
}: {
  selectedCount: number;
  /** How many of the selected cards can actually be SOLD. A reward card ships
   *  but never sells, so Sell counts and prices only these. */
  sellableCount: number;
  allVisibleSelected: boolean;
  visibleCount: number;
  fmv: number;
  sellTotal: number;
  quotesFirm: boolean;
  busy: boolean;
  onToggleSelectAll: () => void;
  onSell: () => void;
  onDeliver: () => void;
  onCoinFlip?: () => void;
}) {
  const none = selectedCount === 0;
  const tooManyToFlip = selectedCount > 20;
  // Sell carries its OWN count: a selection of three cards where one is a
  // reward reads "Ship 3 · Sell back 2", which is exactly what will happen.
  const noneSellable = sellableCount === 0;
  // The payout counts up as cards are picked instead of snapping — this is the
  // number the customer is deciding on, and watching it move is the feedback
  // that the tap registered. Snaps under reduced motion.
  const { value: countedSellTotal } = useCountedValue(sellTotal);
  const action = 'px-3.5 max-[359px]:px-2.5';
  return (
    // Floats 12px above the phone dock (56px + max(safe area, 8px)).
    <div
      // globals.css: a focused card scrolls clear of this bar.
      data-vault-bar
      className="fixed inset-x-3 bottom-[calc(max(env(safe-area-inset-bottom),0.5rem)+4.25rem)] z-40 mx-auto max-w-88 rounded-3xl border border-white/10 bg-neutral-900 p-1.5 shadow-[0_12px_32px_-12px_rgb(0_0_0/0.9)] lg:bottom-8"
    >
      <div className="flex min-h-8.5 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-2">
        <div className="min-w-0">
          {!none && (
            <p className="text-[13px] leading-tight font-semibold text-white">
              {selectedCount} selected
            </p>
          )}
          <button
            type="button"
            onClick={onToggleSelectAll}
            disabled={visibleCount === 0}
            aria-pressed={allVisibleSelected}
            className="-my-3 flex min-h-11 items-center gap-2 rounded-full text-[12px] font-semibold text-neutral-400 outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50"
          >
            <span
              aria-hidden
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded-full border text-[11px] font-bold',
                allVisibleSelected
                  ? 'border-glacier bg-glacier text-glacier-ink'
                  : 'border-white/40 text-transparent',
              )}
            >
              ✓
            </span>
            Select All
          </button>
        </div>
        {none ? (
          <p className="min-w-0 truncate text-[12px] text-neutral-400">
            Select cards to ship{onCoinFlip ? ', sell or flip' : ' or sell'}
          </p>
        ) : (
          <div className="ml-auto min-w-0 text-right">
            <p className="text-[11px] leading-tight font-semibold tracking-[0.08em] text-neutral-400 uppercase">
              {/* The dash is for a selection whose MYR price is unknown. */}
              FMV {fmv > 0 ? rm(fmv) : '—'}
            </p>
            <p className="font-heading text-[clamp(0.8125rem,4.2vw,1rem)] leading-tight whitespace-nowrap text-neutral-50 tabular-nums">
              {/* Always the counted figure, never a hard number beside it:
                  the two would drift apart mid-count. */}
              <span className="text-[12px] font-semibold text-neutral-400">
                Sell for{' '}
              </span>
              {rm(countedSellTotal ?? sellTotal)}
            </p>
          </div>
        )}
      </div>
      {/* The actions fold away with nothing selected: height eases through
          the grid row, 0fr to 1fr, and the folded row takes no focus. */}
      <div
        inert={none}
        className={cn(
          'grid transition-[grid-template-rows] duration-300 ease-(--ease-out-quart) motion-reduce:transition-none',
          none ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
        )}
      >
        <div className="overflow-hidden">
          {/* Padded so the clip leaves the focus rings whole. */}
          <div className="flex gap-2 p-1.5 pt-2.5">
            {onCoinFlip && (
              <Pill
                variant="secondary"
                size="sm"
                className={action}
                disabled={none || tooManyToFlip || busy}
                onClick={onCoinFlip}
              >
                Coin flip
              </Pill>
            )}
            <Pill
              variant="secondary"
              size="sm"
              className={action}
              onClick={onDeliver}
              disabled={none || busy}
            >
              {none ? 'Ship' : `Ship ${selectedCount}`}
            </Pill>
            <Pill
              variant="glacier"
              size="sm"
              className={cn(action, 'min-w-0 flex-1')}
              onClick={onSell}
              disabled={noneSellable || busy || !quotesFirm}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {busy
                ? 'Selling…'
                : noneSellable
                  ? 'Sell back'
                  : `Sell back ${sellableCount}`}
            </Pill>
          </div>
          {onCoinFlip && tooManyToFlip && (
            <p className="px-2 pb-1.5 text-center text-[11px] text-neutral-400">
              Select up to 20 cards to coin flip
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
