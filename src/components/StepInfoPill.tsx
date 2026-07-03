'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createPortal } from 'react-dom';
import { ArrowRight, HelpCircle, Globe, DollarSign, X } from 'lucide-react';
import { cn } from '@/lib/utils';

type Variant = 'packs' | 'buyback' | 'ships';

/**
 * The footer "info pill" on each How It Works step card. Matches the live site:
 *  - packs:   small pack icon (left) + label + arrow (right), links to /claw
 *  - buyback: label + a "?" button (right) that opens the Instant Buyback modal
 *  - ships:   globe icon (left) + label
 */
export default function StepInfoPill({
  variant,
  title,
  sub,
}: {
  variant: Variant;
  title: string;
  sub: string;
}) {
  const [open, setOpen] = useState(false);

  // lock scroll + close on Escape while the modal is open
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  const Label = (
    <div className="min-w-0 flex-1">
      <div className="truncate text-[13px] font-semibold text-white">
        {title}
      </div>
      <div className="truncate text-[11px] text-white/50">{sub}</div>
    </div>
  );

  const base =
    'mt-auto flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 transition-colors duration-300';

  if (variant === 'packs') {
    return (
      <Link
        href="/slots"
        className={cn(
          base,
          'group/pill hover:border-white/20 hover:bg-white/[0.07]',
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/claw/rookie-pack-icon.webp"
          alt=""
          aria-hidden
          className="h-7 w-7 shrink-0 object-contain"
        />
        {Label}
        <ArrowRight
          className="h-4 w-4 shrink-0 text-white/50 transition-transform duration-300 group-hover/pill:translate-x-0.5 group-hover/pill:text-white"
          aria-hidden
        />
      </Link>
    );
  }

  if (variant === 'ships') {
    return (
      <div className={base}>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/10">
          <Globe className="h-4 w-4 text-white/70" aria-hidden />
        </span>
        {Label}
      </div>
    );
  }

  // buyback
  return (
    <>
      <div className={base}>
        {Label}
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="How instant buyback works"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/70 transition-colors duration-200 hover:bg-white/20 hover:text-white"
        >
          <HelpCircle className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="buyback-title"
          >
            {/* overlay — matches original: 80% black, no blur (the page clearly darkens) */}
            <div
              className="absolute inset-0 bg-black/80 motion-safe:animate-[fadeIn_0.2s_ease-out]"
              onClick={() => setOpen(false)}
            />
            {/* dialog — original panel is 480px wide, radius 16px */}
            <div className="relative z-10 w-full max-w-[480px] rounded-2xl border border-white/10 bg-neutral-900 p-6 shadow-2xl motion-safe:animate-[modalIn_0.25s_ease-out] sm:p-7">
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-white/50 transition-colors hover:bg-white/10 hover:text-white"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>

              <h3
                id="buyback-title"
                className="font-heading text-xl font-bold text-white sm:text-2xl"
              >
                85-90% Instant Buyback
              </h3>
              <p className="mt-3 text-[13px] leading-relaxed text-white/60 sm:text-sm">
                Every card you pull has a guaranteed buyback price set at 85-90%
                of its Alt Fair Market Value. Pull a card you don&apos;t want?
                Sell it back instantly with one tap.
              </p>

              {/* three mini steps */}
              <div className="mt-6 grid grid-cols-3 gap-3">
                <MiniStep label="Open a pack">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/images/claw/platinum-pack-icon.webp"
                    alt=""
                    className="h-12 w-auto object-contain"
                  />
                </MiniStep>
                <MiniStep label="Pull a card">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/home/hero/slabs/pokemon1.webp"
                    alt=""
                    className="h-12 w-auto object-contain"
                  />
                </MiniStep>
                <MiniStep label="Sell instantly">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/15">
                    <DollarSign
                      className="h-6 w-6 text-emerald-400"
                      aria-hidden
                    />
                  </span>
                </MiniStep>
              </div>

              {/* FMV box */}
              <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-white/60">Card FMV</span>
                  <span className="font-semibold text-white">RM 100.00</span>
                </div>
                <div className="mt-2 flex items-center justify-between text-sm">
                  <span className="text-white/60">Instant buyback</span>
                  <span className="font-semibold text-emerald-400">
                    RM 85.00 - RM 90.00
                  </span>
                </div>
              </div>

              <p className="mt-4 text-[12px] leading-relaxed text-white/50">
                Prices are based on Alt Fair Market Value and updated in real
                time. Keep your grails, sell the rest.
              </p>

              <button
                type="button"
                onClick={() => setOpen(false)}
                className="mt-6 w-full rounded-xl bg-white px-6 py-3.5 text-sm font-semibold text-neutral-950 transition-opacity duration-200 hover:opacity-90"
              >
                Got it
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function MiniStep({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div className="flex h-14 items-center justify-center">{children}</div>
      <span className="text-center text-[11px] text-white/60">{label}</span>
    </div>
  );
}
