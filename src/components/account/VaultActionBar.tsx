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
    <div className="fixed inset-x-4 bottom-24 z-40 mx-auto max-w-md rounded-2xl border border-white/10 bg-neutral-900 p-4 shadow-[0_8px_32px_rgba(0,0,0,0.6)] lg:bottom-8">
      <button
        type="button"
        onClick={onToggleSelectAll}
        disabled={visibleCount === 0}
        aria-pressed={allVisibleSelected}
        className="flex items-center gap-2 text-[13px] font-semibold text-white disabled:opacity-50"
      >
        <span
          aria-hidden
          className={cn(
            'flex h-5 w-5 items-center justify-center rounded-full border text-[11px] font-bold',
            allVisibleSelected
              ? 'border-white bg-neutral-50 text-neutral-950'
              : 'border-white/40 text-transparent',
          )}
        >
          ✓
        </span>
        Select All
        <span className="font-normal text-neutral-400">
          · {selectedCount} selected
        </span>
      </button>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
            {/* Idle (0 selected) shows real zeroes like the Show Go reference;
                the dash is reserved for a selection whose MYR price is unknown. */}
            FMV {none ? rm(0) : fmv > 0 ? rm(fmv) : '—'}
          </p>
          <p className="text-[15px] font-bold tabular-nums text-buyback-fg">
            {/* Always the counted figure. An earlier version rendered a hard 0
                while nothing was selected, which desynced the hook: the count
                kept running toward zero behind a static 0, so picking a card
                mid-animation jumped the display to whatever intermediate the
                hook had reached. Deselecting now counts down to RM 0.00 in the
                same beat the Sell pill greys out. */}
            Sell for {rm(countedSellTotal ?? sellTotal)}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Pill
            variant="secondary"
            size="sm"
            onClick={onDeliver}
            disabled={none || busy}
          >
            {withCount('Deliver')}
          </Pill>
          <Pill
            size="sm"
            onClick={onSell}
            disabled={noneSellable || busy || !quotesFirm}
            className="bg-buyback text-white hover:bg-buyback/90 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {busy
              ? 'Selling…'
              : noneSellable
                ? 'Sell'
                : `Sell ${sellableCount}`}
          </Pill>
        </div>
      </div>
    </div>
  );
}
