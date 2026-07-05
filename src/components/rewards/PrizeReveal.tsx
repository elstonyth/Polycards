'use client';

import { type CSSProperties, useEffect, useRef } from 'react';
import Image from 'next/image';
import { rm } from '@/lib/format';
import type { DrawPrize } from '@/lib/actions/daily';

/** A minimal reveal animation for the daily box prize (adapted from the slab aesthetic). */
export function PrizeReveal({
  prize,
  onClose,
}: {
  prize: DrawPrize;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Focus the dialog on mount so keyboard/SR users land inside it, not on
    // whatever was behind it. Escape closes; Tab is trapped to the dialog's
    // own focusable elements since nothing behind it should be reachable.
    dialogRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-[80] flex flex-col items-center justify-center bg-black/95 p-6 outline-none motion-safe:animate-[fadeIn_0.3s_ease-out]"
      role="dialog"
      aria-modal="true"
      aria-label="Daily box reveal"
    >
      <div className="flex flex-col items-center gap-6 text-center">
        {/* Prize display */}
        {prize.kind === 'product' && prize.image ? (
          <div className="relative h-[280px] w-[200px]">
            <Image
              src={prize.image}
              alt={prize.title ?? 'Prize'}
              fill
              sizes="200px"
              className="object-contain drop-shadow-[0_0_40px_rgba(251,146,60,0.5)]"
            />
          </div>
        ) : (
          <div
            className="flex h-40 w-40 items-center justify-center rounded-full border border-white/10"
            style={
              {
                background:
                  prize.kind === 'credit'
                    ? 'radial-gradient(circle, rgba(52,211,153,0.25), rgba(52,211,153,0.05))'
                    : prize.kind === 'voucher'
                      ? 'radial-gradient(circle, rgba(251,191,36,0.25), rgba(251,191,36,0.05))'
                      : 'radial-gradient(circle, rgba(163,163,163,0.2), rgba(163,163,163,0.05))',
              } as CSSProperties
            }
          >
            {prize.kind === 'credit' ? (
              <span className="font-heading text-4xl font-black text-buyback-fg">
                RM
              </span>
            ) : prize.kind === 'voucher' ? (
              <span className="font-heading text-4xl font-black text-amber-400">
                RM
              </span>
            ) : (
              <span className="text-5xl">🎁</span>
            )}
          </div>
        )}

        {/* Prize text */}
        <div className="space-y-1">
          {prize.kind === 'product' && (
            <>
              <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-amber-400/70">
                Prize Won
              </p>
              <p className="font-heading text-2xl font-bold text-white">
                {prize.title ?? 'Product Prize'}
              </p>
              <p className="text-sm text-white/50">
                Added to your vault — ship it from the Prizes section below.
              </p>
            </>
          )}
          {prize.kind === 'credit' && (
            <>
              <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-buyback-fg/70">
                Credit Won
              </p>
              <p className="font-heading text-3xl font-black text-buyback-fg">
                +{rm(prize.amountMyr ?? 0)}
              </p>
              <p className="text-sm text-white/50">
                Added to your wallet balance.
              </p>
            </>
          )}
          {prize.kind === 'voucher' && (
            <>
              <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-amber-400/70">
                Voucher Won
              </p>
              <p className="font-heading text-3xl font-black text-amber-400">
                +{rm(prize.amountMyr ?? 0)}
              </p>
              <p className="text-sm text-white/50">
                Added to your claimable vouchers.
              </p>
            </>
          )}
          {prize.kind === 'nothing' && (
            <>
              <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-white/40">
                Better luck next time
              </p>
              <p className="font-heading text-2xl font-bold text-white/60">
                No prize today
              </p>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={onClose}
          className="mt-2 inline-flex h-12 w-[260px] items-center justify-center rounded-xl bg-buyback text-sm font-bold text-white shadow-lg shadow-buyback/30 transition-opacity hover:opacity-95"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
