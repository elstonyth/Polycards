'use client';

import { type CSSProperties, useRef } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { rm } from '@/lib/format';
import type { DrawPrize } from '@/lib/actions/daily';
import { useModalA11y } from '@/lib/use-modal-a11y';

/**
 * SUSPENDED 2026-07-29 — its only caller was `/daily` (DailyClient), deleted
 * with the rest of the VIP reward surfaces
 * (docs/superpowers/specs/2026-07-29-suspend-vip-referral-surfaces-design.md).
 * Kept unreferenced, not deleted, so un-suspending is a revert — same
 * treatment as the other kept orphans (daily.ts, referral.ts, voucherLabel).
 * The notification copy in lib/notifications/copy.ts still cites this
 * component as the reason `reward_won` doesn't toast; that suppression is
 * inert until the surface returns.
 *
 * A minimal reveal animation for the daily box prize (adapted from the slab aesthetic).
 */
export function PrizeReveal({
  prize,
  onClose,
}: {
  prize: DrawPrize;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus-in, Tab trap, Escape close, body scroll lock + focus restore on
  // close. Only mounted while open, so `open` is always true here.
  useModalA11y(dialogRef, true, onClose);

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
              className="object-contain drop-shadow-[0_0_40px_rgba(255,176,32,0.5)]"
            />
          </div>
        ) : (
          <div
            className="flex h-40 w-40 items-center justify-center rounded-full border border-white/10"
            style={
              {
                background:
                  prize.kind === 'credit'
                    ? // buyback-fg #2fbf6e
                      'radial-gradient(circle, rgba(47,191,110,0.25), rgba(47,191,110,0.05))'
                    : prize.kind === 'voucher'
                      ? // chase gold #ffb020
                        'radial-gradient(circle, rgba(255,176,32,0.25), rgba(255,176,32,0.05))'
                      : 'radial-gradient(circle, rgba(163,163,163,0.2), rgba(163,163,163,0.05))',
              } as CSSProperties
            }
          >
            {prize.kind === 'credit' ? (
              <span className="font-heading text-4xl font-black text-buyback-fg">
                RM
              </span>
            ) : prize.kind === 'voucher' ? (
              <span className="font-heading text-4xl font-black text-chase">
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
              <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-chase/70">
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
              <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-chase/70">
                Voucher Won
              </p>
              <p className="font-heading text-3xl font-black text-chase">
                +{rm(prize.amountMyr ?? 0)}
              </p>
              <p className="text-sm text-white/50">
                Voucher added —{' '}
                <Link
                  href="/vip"
                  className="text-white/80 underline underline-offset-2 hover:text-white"
                >
                  claim it on the VIP page
                </Link>
                .
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
