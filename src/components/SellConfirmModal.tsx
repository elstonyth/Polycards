'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { SlabImage } from '@/components/SlabImage';
import { rm } from '@/lib/format';
import { useLiquidGlass, GLASS_SUBTLE } from '@/lib/use-liquid-glass';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Confirm-before-sell dialog, shared by the pack reveal and the vault grid.
// `rateType` switches the copy between the on-reveal instant offer (with a live
// countdown) and the flat vault rate. Accessibility mirrors AuthModal: focus
// moves into the panel, Tab is trapped, Escape + backdrop close, focus restores.
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
  const triggerRef = useRef<HTMLElement | null>(null);

  // Liquid-glass rim on the panel (frosted fallback on Safari/Firefox).
  useLiquidGlass(panelRef, open, GLASS_SUBTLE);

  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!busy) onCancel();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;
      const f = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (f.length === 0) return;
      // f.length === 0 is checked above; both indices are in bounds
      const first = f[0]!;
      const last = f[f.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      triggerRef.current?.focus();
    };
  }, [open, busy, onCancel]);

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
        tabIndex={-1}
        className="glass-panel relative z-10 max-h-[85vh] w-full overflow-y-auto rounded-t-3xl border-t p-6 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] outline-none sm:inset-x-auto sm:bottom-auto sm:max-w-sm sm:rounded-2xl sm:border sm:pb-6"
      >
        <button
          type="button"
          onClick={() => !busy && onCancel()}
          aria-label="Close"
          className="absolute right-2.5 top-2.5 flex h-11 w-11 items-center justify-center rounded-lg text-white/50 transition-colors hover:bg-white/5 hover:text-white"
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
            className="inline-flex h-11 flex-1 items-center justify-center rounded-xl bg-buyback text-sm font-bold text-white transition-colors hover:bg-buyback/90 disabled:opacity-60"
          >
            {busy ? 'Selling…' : `Sell for ${rm(netCredit)}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
