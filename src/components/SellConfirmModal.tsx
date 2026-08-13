'use client';

import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2 } from 'lucide-react';
import { SlabImage } from '@/components/SlabImage';
import { rm } from '@/lib/format';
import { useLiquidGlass, GLASS_SUBTLE } from '@/lib/use-liquid-glass';
import { useModalA11y } from '@/lib/use-modal-a11y';

// Confirm-before-sell dialog, shared by the pack reveal and the vault grid.
// `rateType` switches the copy between the on-reveal instant offer (with a live
// countdown) and the flat vault rate. Accessibility comes from useModalA11y:
// focus moves into the panel, Tab is trapped, Escape + backdrop close, focus
// restores.
export default function SellConfirmModal({
  open,
  cardName,
  image,
  slabImage,
  fmv,
  rateType,
  percent,
  netCredit,
  secondsLeft,
  count,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  cardName: string;
  image: string;
  slabImage?: string | null;
  fmv: number;
  rateType: 'instant' | 'flat';
  percent: number;
  netCredit: number;
  secondsLeft?: number;
  // Bulk sell-back: when set, fmv/netCredit are totals and the copy pluralizes.
  count?: number;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const bulk = typeof count === 'number';
  // A single-card selection can still open the bulk modal (count === 1), so
  // pluralize off the count rather than off `bulk`.
  const plural = count !== 1;
  const panelRef = useRef<HTMLDivElement>(null);

  // Liquid-glass rim on the panel (frosted fallback on Safari/Firefox).
  useLiquidGlass(panelRef, open, GLASS_SUBTLE);

  // Escape is busy-gated like the X and Cancel — a mid-sell dismissal would
  // leave the request in flight with nothing on screen. The hook reads this
  // through a ref refreshed every render, so it always sees the current `busy`
  // without re-running (the old hand-rolled effect listed `busy` in its deps,
  // so every flip tore down, bounced focus back to the trigger behind the
  // modal, and re-focused the panel).
  useModalA11y(panelRef, open, () => {
    if (!busy) onCancel();
  });

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-end justify-center sm:items-center sm:p-4">
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={() => !busy && onCancel()}
        className="glass-stage absolute inset-0 cursor-default bg-black/40"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Confirm sell-back"
        // The modal now stays mounted for the whole sell round-trip, so say so
        // — a screen-reader user otherwise gets silence after confirming.
        aria-busy={busy}
        tabIndex={-1}
        className="glass-panel relative z-10 max-h-[85vh] w-full overflow-y-auto rounded-t-3xl border-t p-6 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] outline-none sm:inset-x-auto sm:bottom-auto sm:max-w-sm sm:rounded-2xl sm:border sm:pb-6"
      >
        <button
          type="button"
          onClick={() => !busy && onCancel()}
          // Match Cancel/Confirm: the handler was already guarded, but leaving
          // it focusable and lit made a mid-sell click look like a dead button.
          disabled={busy}
          aria-label="Close"
          className="absolute right-2.5 top-2.5 flex h-11 w-11 items-center justify-center rounded-lg text-white/50 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-40"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>

        <div className="flex items-center gap-3">
          {!bulk && (
            <SlabImage
              src={image}
              slabSrc={slabImage}
              alt={cardName}
              sizes="48px"
              className="w-12 shrink-0"
            />
          )}
          <div className="min-w-0">
            <h2 className="font-heading text-lg font-bold text-white">
              {bulk
                ? `Sell ${count} card${plural ? 's' : ''}?`
                : 'Sell this card?'}
            </h2>
            <p className="truncate text-[13px] text-white/60">{cardName}</p>
          </div>
        </div>

        <dl className="mt-5 space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm">
          <div className="flex justify-between">
            <dt className="text-white/55">
              {bulk ? 'Total market value' : 'Market value'}
            </dt>
            {/* 0 means the MYR price is unknown (older backend) — show a dash
                rather than a fake RM 0.00 on a money confirm. */}
            <dd className="text-white/85">{fmv > 0 ? rm(fmv) : '—'}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-white/55">
              {rateType === 'instant' ? 'Instant rate' : 'Vault rate'}
            </dt>
            <dd className="text-white/85">{percent}%</dd>
          </div>
          <div className="flex justify-between border-t border-white/10 pt-2">
            <dt className="font-semibold text-white">You receive</dt>
            <dd className="font-bold text-buyback-fg">{rm(netCredit)}</dd>
          </div>
        </dl>

        <p className="mt-3 text-[12px] text-white/50">
          {rateType === 'instant' && typeof secondsLeft === 'number'
            ? `Instant offer — ${secondsLeft}s left. `
            : ''}
          Selling is permanent: the{' '}
          {bulk && plural ? 'cards leave' : 'card leaves'} your vault and the
          amount is credited to your site balance.
        </p>

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="inline-flex h-11 flex-1 items-center justify-center rounded-xl border border-white/15 bg-white/5 text-sm font-semibold text-white/80 transition-colors hover:bg-white/10 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-buyback text-sm font-bold text-white transition-colors hover:bg-buyback/90 disabled:opacity-60"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {busy ? 'Selling…' : `Sell for ${rm(netCredit)}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
