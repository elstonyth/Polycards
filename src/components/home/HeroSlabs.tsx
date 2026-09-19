'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';
import { ArrowRight, PackageOpen, Pause, Play } from 'lucide-react';
import { SlabImage } from '@/components/SlabImage';
import { pillVariants } from '@/components/ui/pill';
import type { Pack, PackCard } from '@/lib/packs-data';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { cn } from '@/lib/utils';
import { rm } from '@/lib/format';

const POSITIONS = [
  'z-10 translate-x-0 translate-y-0 -rotate-[3deg] scale-100',
  'z-0 translate-x-[70%] translate-y-[14%] rotate-[14deg] scale-[0.88]',
  'z-0 -translate-x-[70%] translate-y-[14%] -rotate-[14deg] scale-[0.88]',
] as const;

export function HeroSlabs({
  hits,
}: {
  hits: { card: PackCard; pack: Pack }[];
}) {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const reduced = usePrefersReducedMotion();
  const current = active % Math.max(hits.length, 1);
  const lead = hits[current];

  useEffect(() => {
    if (hits.length < 2 || paused || hovered || reduced) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) setActive((index) => (index + 1) % hits.length);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [hits.length, paused, hovered, reduced]);

  function select(index: number) {
    setActive(index);
    setPaused(true);
  }

  return (
    <figure
      aria-label="Top chase cards"
      aria-roledescription="carousel"
      className="relative row-start-3 mx-auto mt-7 aspect-[0.95] w-full max-w-[600px] lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:my-0 lg:aspect-[1.05]"
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full bg-radial from-white/[0.05] via-transparent to-transparent"
      />
      {[0, 1, 2].map((index) => {
        const hit = hits[index];
        const position = (index - current + 3) % 3;
        const className = cn(
          'absolute top-[5%] left-[30%] w-[41%] transition-transform duration-700 ease-[var(--ease-out-expo)] motion-reduce:transition-none',
          POSITIONS[position],
        );
        return hit ? (
          <button
            key={hit.card.handle}
            type="button"
            aria-label={`Show ${hit.card.name}`}
            aria-pressed={index === current}
            data-hero-hit={index + 1}
            data-position={position}
            className={cn(
              className,
              'cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-4 focus-visible:ring-offset-neutral-950',
            )}
            onFocus={() => setPaused(true)}
            onClick={() => select(index)}
          >
            <SlabImage
              card={hit.card}
              alt=""
              sizes="(min-width: 1024px) 246px, 41vw"
              priority={index === 0}
              glowScale={0.4}
            />
          </button>
        ) : (
          <div key={index} className={className}>
            <Image
              src="/images/app/polycards-slab-back.webp"
              alt={
                index === 0
                  ? 'Polycards collectible card in a protective slab'
                  : ''
              }
              width={900}
              height={1519}
              sizes="(min-width: 1024px) 246px, 41vw"
              className="h-auto w-full"
              preload={index === 0}
            />
          </div>
        );
      })}
      <figcaption className="absolute inset-x-[8%] bottom-0 z-20 rounded-xl border border-white/10 bg-neutral-900 px-4 py-3 lg:inset-x-[12%] lg:px-5 lg:py-4">
        {lead ? (
          <>
            <div aria-live={paused || reduced ? 'polite' : 'off'} aria-atomic>
              <div className="flex flex-col items-start justify-between gap-1 sm:flex-row sm:items-center sm:gap-3">
                <span className="text-[10px] font-semibold tracking-[0.14em] text-neutral-400 uppercase">
                  Top {hits.length} chase {hits.length === 1 ? 'card' : 'cards'}
                </span>
                <span className="font-heading text-chase text-lg lg:text-2xl">
                  {lead.card.priceMyr != null ? rm(lead.card.priceMyr) : '—'}
                </span>
              </div>
              <p
                data-hit-name
                className="mt-1 text-sm font-semibold text-white"
              >
                {lead.card.name}
              </p>
              <p className="mt-1 text-xs text-neutral-400">
                Discover it in {lead.pack.name} · Pulls vary
              </p>
            </div>
            {hits.length > 1 && (
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  className={cn(
                    pillVariants({ variant: 'ghost' }),
                    'px-3 text-xs',
                  )}
                  onFocus={() => setPaused(true)}
                  onClick={() => select((current + 1) % hits.length)}
                >
                  Next card <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={
                    paused ? 'Resume card rotation' : 'Pause card rotation'
                  }
                  className={cn(
                    pillVariants({ variant: 'ghost' }),
                    'w-11 px-0 motion-reduce:hidden',
                  )}
                  onClick={() => setPaused((value) => !value)}
                >
                  {paused ? (
                    <Play className="h-4 w-4" aria-hidden />
                  ) : (
                    <Pause className="h-4 w-4" aria-hidden />
                  )}
                </button>
                <span
                  className="ml-1 text-xs tabular-nums text-neutral-400"
                  aria-hidden
                >
                  {current + 1} / {hits.length}
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-white">
                Your next reveal starts here.
              </p>
              <p className="mt-1 text-xs text-neutral-400">
                Open online. Collect for real.
              </p>
            </div>
            <PackageOpen
              className="hidden h-6 w-6 shrink-0 text-neutral-400 sm:block"
              aria-hidden
            />
          </div>
        )}
      </figcaption>
    </figure>
  );
}
