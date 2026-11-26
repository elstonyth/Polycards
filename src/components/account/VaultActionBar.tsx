'use client';

import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rm } from '@/lib/format';
import { useCountedValue } from '@/lib/use-counted-value';
import { Pill } from '@/components/ui/pill';

// Persistent vault action bar (boss doc / Show Go layout): "Select All" +
// live counter on top; FMV on its own line ABOVE "Sell for" and visually
// smaller; Deliver/Sell pills bottom-right with Sell rightmost. Rendered
// whenever the vault has cards — 0 selected just disables the actions.
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
  const withCount = (label: string) =>
    none ? label : `${label} ${selectedCount}`;
  // Sell carries its OWN count: a selection of three cards where one is a
  // reward reads "Deliver 3 · Sell 2", which is exactly what will happen.
  const noneSellable = sellableCount === 0;
  // The payout counts up as cards are picked instead of snapping — this is the
  // number the customer is deciding on, and watching it move is the feedback
  // that the tap registered. Snaps under reduced motion.
  const { value: countedSellTotal } = useCountedValue(sellTotal);
  return (
    // Floats above the phone tab bar: its 56px pill + max(safe area, 8px)
    // below it, and the centre Home button rising 10px over the pill, plus a
    // 12px gap = 78px over the inset.
    <div
      // globals.css: a focused card scrolls clear of this bar.
      data-vault-bar
      className="fixed inset-x-3 bottom-[calc(max(env(safe-area-inset-bottom),0.5rem)+4.875rem)] z-40 mx-auto max-w-md rounded-3xl border border-white/10 bg-neutral-900 p-3 shadow-[0_12px_32px_-12px_rgb(0_0_0/0.9)] sm:p-4 lg:bottom-8"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-semibold text-white">
          {selectedCount} selected
        </p>
        <button
          type="button"
          onClick={onToggleSelectAll}
          disabled={visibleCount === 0}
          aria-pressed={allVisibleSelected}
          className="-my-2 flex min-h-11 items-center gap-2 rounded-full px-1 text-[12px] font-semibold text-neutral-400 outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50"
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
      <div className="mt-2 flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-400">
            {/* Idle (0 selected) shows real zeroes like the Show Go reference;
                the dash is reserved for a selection whose MYR price is unknown. */}
            FMV {none ? rm(0) : fmv > 0 ? rm(fmv) : '—'}
          </p>
          <p className="font-heading whitespace-nowrap text-lg leading-tight tabular-nums text-neutral-50">
            {/* Always the counted figure. An earlier version rendered a hard 0
                while nothing was selected, which desynced the hook: the count
                kept running toward zero behind a static 0, so picking a card
                mid-animation jumped the display to whatever intermediate the
                hook had reached. Deselecting now counts down to RM 0.00 in the
                same beat the Sell pill greys out. */}
            <span className="text-[12px] font-semibold text-neutral-400">
              Sell for{' '}
            </span>
            {rm(countedSellTotal ?? sellTotal)}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 gap-2">
          <Pill
            variant="secondary"
            size="sm"
            onClick={onDeliver}
            disabled={none || busy}
          >
            {withCount('Ship')}
          </Pill>
          <Pill
            variant="glacier"
            size="sm"
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
      </div>
      {onCoinFlip && (
        <Pill
          variant="secondary"
          className="mt-3 w-full"
          disabled={none || selectedCount > 20 || busy}
          onClick={onCoinFlip}
        >
          {selectedCount > 20
            ? 'Select up to 20 cards to coin flip'
            : 'Coin flip'}
        </Pill>
      )}
    </div>
  );
}
