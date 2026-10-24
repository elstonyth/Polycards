'use client';

import { useRef } from 'react';
import { X } from 'lucide-react';
import { Pill } from '@/components/ui/pill';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import type { LuckyDrawResultDetail } from '@/lib/data/schemas';
import { SpinWheel } from './SpinWheel';

/** The spin as a full-screen moment. Several prizes can draw in the same
 *  minute (by default they all draw at the event's end), so results queue
 *  here and play one at a time. */
export function SpinOverlay({
  detail,
  queued,
  onNext,
  onClose,
}: {
  detail: LuckyDrawResultDetail;
  /** How many more draws wait behind this one. */
  queued: number;
  onNext: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, true, onClose);
  const reduced = usePrefersReducedMotion();
  return (
    <div className="glass-scrim fixed inset-0 z-[60] overflow-y-auto">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="spin-title"
        tabIndex={-1}
        className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-4 py-8 outline-none"
      >
        <div className="mb-6 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-[0.14em] text-neutral-400 uppercase">
              Lucky Draw
            </p>
            <h2
              id="spin-title"
              className="font-heading mt-1 text-2xl leading-tight text-white"
            >
              {detail.result.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the draw"
            className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <SpinWheel
          key={detail.result.prize_id}
          detail={detail}
          reduced={reduced}
        />
        <div className="mt-4 flex justify-center">
          {queued > 0 ? (
            <Pill size="lg" onClick={onNext}>
              Next draw ({queued})
            </Pill>
          ) : (
            <Pill size="lg" variant="secondary" onClick={onClose}>
              Done
            </Pill>
          )}
        </div>
      </div>
    </div>
  );
}
