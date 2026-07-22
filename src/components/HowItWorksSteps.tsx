'use client';

import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  useInView,
  usePrefersReducedMotion,
  staggerDelay,
} from '@/lib/use-reveal';
import StepInfoPill from '@/components/StepInfoPill';
import { BUYBACK_RATE_LABEL } from '@/lib/buyback-copy';

/**
 * The 3 "How It Works" step cards. SHARED by the homepage section and the
 * /how-it-works page so they stay pixel-identical (single source of truth).
 * Each card: number badge + title, body copy, layered illustration, and a
 * StepInfoPill footer (icon / arrow / "?"-modal per variant). Cards fade-up +
 * stagger on scroll into view (reduced-motion shows them instantly).
 */
type Step = {
  num: string;
  title: string;
  body: string;
  pill: string;
  pillSub: string;
  pillVariant: 'packs' | 'buyback' | 'ships';
  media: ReactNode;
};

const STEPS: Step[] = [
  {
    num: '1',
    title: 'Open a pack',
    body: 'Choose from a range of Pokémon packs. Every pack contains a random graded card, with live odds and commit-reveal pulls: the server commits to a hashed seed before you spin.',
    pill: 'View all packs',
    pillSub: 'Browse every category and rip',
    pillVariant: 'packs',
    media: (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/polycards/platinum-pack.webp"
          alt=""
          aria-hidden
          className="absolute z-[1] h-[62%] w-auto object-contain opacity-40 drop-shadow-[0_12px_32px_rgba(0,0,0,0.5)] transition-transform duration-500 ease-out group-hover:-translate-x-[8%]"
          style={{ transform: 'translateX(-52%) rotate(-7deg)' }}
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/polycards/bronze-pack.webp"
          alt="Trading card pack"
          className="relative z-[3] h-[78%] w-auto object-contain drop-shadow-[0_20px_60px_rgba(0,0,0,0.4)] transition-transform duration-500 ease-out group-hover:scale-[1.04]"
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/polycards/bronze-pack.webp"
          alt=""
          aria-hidden
          className="absolute z-[1] h-[62%] w-auto object-contain opacity-40 drop-shadow-[0_12px_32px_rgba(0,0,0,0.5)] transition-transform duration-500 ease-out group-hover:translate-x-[8%]"
          style={{ transform: 'translateX(52%) rotate(7deg)' }}
        />
      </>
    ),
  },
  {
    num: '2',
    title: 'Reveal your card',
    body: 'Tap to reveal what you pulled. Every card is real, vaulted by PSA, Fanatics, and Alt, and fully insured from the moment you own it.',
    pill: `${BUYBACK_RATE_LABEL} instant cash back`,
    pillSub: "Don't like your pull? Sell it back instantly",
    pillVariant: 'buyback',
    media: (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src="/home/hero/ripped-slab.webp"
        alt="Graded card revealed from a ripped pack"
        className="relative h-[88%] w-auto object-contain drop-shadow-[0_16px_40px_rgba(0,0,0,0.45)] transition-transform duration-500 ease-out group-hover:scale-[1.04]"
      />
    ),
  },
  {
    num: '3',
    title: `Keep, ship, or sell back for ${BUYBACK_RATE_LABEL}`,
    body: `Hold your card in the vault, sell it back instantly for ${BUYBACK_RATE_LABEL} of market value, or redeem and we'll ship the physical slab to your door.`,
    pill: 'Ships worldwide',
    pillSub: 'Fully tracked and insured to your door',
    pillVariant: 'ships',
    media: (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src="/home/hero/trade-sell-ship.webp"
        alt="Sell back or ship your cards worldwide"
        className="relative h-[88%] w-auto object-contain drop-shadow-[0_16px_40px_rgba(0,0,0,0.3)] transition-transform duration-500 ease-out group-hover:scale-[1.04]"
      />
    ),
  },
];

export default function HowItWorksSteps() {
  const [ref, shown] = useInView<HTMLDivElement>();
  const reduced = usePrefersReducedMotion();

  return (
    <div ref={ref} className="grid grid-cols-1 gap-4 sm:grid-cols-3 sm:gap-5">
      {STEPS.map((step, i) => (
        <div
          key={step.num}
          style={staggerDelay(shown, reduced, i, 120)}
          className={cn(
            'group relative flex h-full flex-col overflow-hidden rounded-2xl p-6 sm:p-7',
            'border border-white/10 bg-gradient-to-br from-white/[0.07] to-white/[0.02]',
            'shadow-[0_4px_20px_rgba(0,0,0,0.25)] hover:border-white/20',
            !reduced &&
              'transition-[opacity,transform,border-color] duration-700 ease-out',
            shown || reduced
              ? 'opacity-100 translate-y-0'
              : 'opacity-0 translate-y-6',
          )}
        >
          <div className="mb-4 flex items-center gap-3">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-bold text-white">
              {step.num}
            </span>
            <h3 className="font-heading text-xl font-bold text-white">
              {step.title}
            </h3>
          </div>
          <p className="mb-5 text-[13px] leading-relaxed text-white/60">
            {step.body}
          </p>
          <div className="relative flex h-44 items-center justify-center">
            {step.media}
          </div>
          <StepInfoPill
            variant={step.pillVariant}
            title={step.pill}
            sub={step.pillSub}
          />
        </div>
      ))}
    </div>
  );
}
