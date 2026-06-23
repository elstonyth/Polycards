'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import Image from 'next/image';
import { X } from 'lucide-react';
import { usd } from '@/lib/format';

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
  fmv,
  rateType,
  percent,
  netCredit,
  secondsLeft,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  cardName: string;
  image: string;
  fmv: number;
  rateType: 'instant' | 'flat';
  percent: number;
  netCredit: number;
  secondsLeft?: number;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

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
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={() => !busy && onCancel()}
        className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Confirm sell-back"
        tabIndex={-1}
        className="relative z-10 w-full max-w-sm rounded-2xl border border-white/10 bg-neutral-950 p-6 shadow-2xl shadow-black/60 outline-none"
      >
        <button
          type="button"
          onClick={() => !busy && onCancel()}
          aria-label="Close"
          className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-lg text-white/50 transition-colors hover:bg-white/5 hover:text-white"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>

        <div className="flex items-center gap-3">
          <Image
            src={image}
            alt={cardName}
            width={56}
            height={78}
            className="h-[78px] w-auto rounded-md object-contain"
          />
          <div className="min-w-0">
            <h2 className="font-heading text-lg font-bold text-white">
              Sell this card?
            </h2>
            <p className="truncate text-[13px] text-white/60">{cardName}</p>
          </div>
        </div>

        <dl className="mt-5 space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm">
          <div className="flex justify-between">
            <dt className="text-white/55">Market value</dt>
            <dd className="text-white/85">{usd(fmv)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-white/55">
              {rateType === 'instant' ? 'Instant rate' : 'Vault rate'}
            </dt>
            <dd className="text-white/85">{percent}%</dd>
          </div>
          <div className="flex justify-between border-t border-white/10 pt-2">
            <dt className="font-semibold text-white">You receive</dt>
            <dd className="font-bold text-emerald-300">{usd(netCredit)}</dd>
          </div>
        </dl>

        <p className="mt-3 text-[12px] text-white/50">
          {rateType === 'instant' && typeof secondsLeft === 'number'
            ? `Instant offer — ${secondsLeft}s left. `
            : ''}
          Selling is permanent: the card leaves your vault and the amount is
          credited to your site balance.
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
            className="inline-flex h-11 flex-1 items-center justify-center rounded-xl bg-amber-400 text-sm font-bold text-neutral-950 transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {busy ? 'Selling…' : `Sell for ${usd(netCredit)}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
