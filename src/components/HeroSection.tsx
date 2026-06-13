'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { HERO_ROTATE_MS, HERO_SLIDE } from '@/lib/motion';

type Theme = {
  name: string;
  slab: string;
  pack: string;
};

const THEMES: Theme[] = [
  {
    name: 'pokemon',
    slab: '/home/hero/slabs/pokemon1.webp',
    pack: '/home/hero/ripped-packs/pokemon.webp',
  },
  {
    name: 'onepiece',
    slab: '/home/hero/slabs/onepiece2.webp',
    pack: '/home/hero/ripped-packs/onepiece.webp',
  },
  {
    name: 'basketball',
    slab: '/home/hero/slabs/basketball3.webp',
    pack: '/home/hero/ripped-packs/basketball.webp',
  },
  {
    name: 'football',
    slab: '/home/hero/slabs/football4.webp',
    pack: '/home/hero/ripped-packs/football.webp',
  },
  {
    name: 'baseball',
    slab: '/home/hero/slabs/baseball1.webp',
    pack: '/home/hero/ripped-packs/baseball.webp',
  },
  {
    name: 'yugioh',
    slab: '/home/hero/slabs/yugioh2.webp',
    pack: '/home/hero/ripped-packs/yugioh.webp',
  },
];

const N = THEMES.length;

type SlotKey = '-1' | '0' | '1';

type SlotConfig = {
  x: string;
  scale: number;
  opacity: number;
  z: number;
  rotate: number;
};

// Slot geometry + timing measured off the live carousel at rAF resolution
// (docs/research/motion-live/hero-curve2.json): center = scale 1 / 0° / opacity 1,
// sides = scale 0.822 / ±8° / opacity 0.6, back card = scale 0.7 / opacity 0;
// slides run ~650ms ease-OUT and the theme swaps every ≈4.5s (HERO_* in lib/motion).
const SLOTS: Record<SlotKey, SlotConfig> = {
  '-1': { x: '-10%', scale: 0.822, opacity: 0.6, z: 20, rotate: -8 },
  '0': { x: '0%', scale: 1, opacity: 1, z: 30, rotate: 0 },
  '1': { x: '10%', scale: 0.822, opacity: 0.6, z: 20, rotate: 8 },
};

export default function HeroSection() {
  const reduced = usePrefersReducedMotion();
  const [center, setCenter] = useState(0);

  useEffect(() => {
    if (reduced) return;
    const id = setInterval(() => {
      setCenter((c) => (c + 1) % N);
    }, HERO_ROTATE_MS);
    return () => clearInterval(id);
  }, [reduced]);

  const slotFor = (i: number): SlotKey | null => {
    const d = (i - center + N) % N;
    return d === 0 ? '0' : d === 1 ? '1' : d === N - 1 ? '-1' : null;
  };

  return (
    <section className="mb-8">
      <Link
        href="/claw"
        className={cn(
          'group/hero relative flex overflow-hidden rounded-2xl bg-neutral-950',
          'h-[420px] sm:h-[450px] lg:h-[480px]',
          'shadow-[0_4px_20px_rgba(0,0,0,0.15)]',
        )}
      >
        {/* Color glow = a blurred, over-saturated copy of the active pack image
            filling the whole hero (matches the live site — not a flat gradient). */}
        {THEMES.map((t, i) => (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            key={`glow-${t.name}`}
            src={t.pack}
            aria-hidden
            alt=""
            className={cn(
              'pointer-events-none absolute inset-0 h-full w-full scale-125 object-cover blur-[20px] saturate-[2]',
              // glow crossfade runs in the same ~650ms ease-out window as the cards
              !reduced && 'transition-opacity duration-[650ms] ease-out',
              i === center ? 'opacity-100' : 'opacity-0',
            )}
          />
        ))}

        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-r from-neutral-950 via-neutral-950/80 to-transparent"
        />

        <div className="relative z-10 flex h-full w-full flex-col-reverse md:flex-row">
          <div className="flex flex-[1.05] flex-col justify-end p-6 sm:p-8 md:justify-center md:p-10">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-widest text-white/25 lg:mb-2 lg:text-[13px]">
              Packs available now
            </p>
            <h2 className="font-heading text-2xl font-bold tracking-tight text-white md:text-3xl lg:max-w-[39rem] lg:text-5xl lg:leading-[1.1]">
              Rip packs.{' '}
              <span className="text-white/40">Pull graded cards.</span>
            </h2>
            <p className="mt-3 max-w-xs text-[13px] leading-relaxed text-white/70 sm:text-sm lg:mt-4 lg:max-w-md lg:text-base">
              Choose to hold, trade, redeem, or sell it back to us at up to{' '}
              <span className="rounded-md bg-white/15 px-2 py-0.5 font-heading text-white">
                90% value.
              </span>
            </p>
            <div className="mt-5 flex items-center gap-2.5 lg:mt-7">
              <span
                className={cn(
                  'inline-flex items-center rounded-full border border-white/15',
                  'bg-white/90 px-6 py-2.5 text-sm font-semibold text-neutral-950 shadow-lg',
                  'transition-colors duration-300 group-hover/hero:bg-white',
                  'lg:px-8 lg:py-3 lg:text-base',
                )}
              >
                Open Packs
              </span>
            </div>
          </div>

          <div className="relative flex-1">
            <div className="absolute inset-0">
              {THEMES.map((t, i) => {
                const slot = slotFor(i);
                const cfg = slot ? SLOTS[slot] : null;
                const isCenter = slot === '0';
                return (
                  <motion.div
                    key={t.name}
                    className="absolute inset-0 flex items-end justify-center p-4 pb-0 lg:p-6 lg:pb-0"
                    initial={false}
                    animate={{
                      x: cfg ? cfg.x : '0%',
                      scale: cfg ? cfg.scale : 0.7,
                      rotate: cfg ? cfg.rotate : 0,
                      opacity: cfg ? cfg.opacity : 0,
                    }}
                    transition={reduced ? { duration: 0 } : HERO_SLIDE}
                    style={{ zIndex: cfg ? cfg.z : 0 }}
                  >
                    <div
                      className={cn(
                        'relative h-full w-full max-w-[300px]',
                        isCenter
                          ? 'pointer-events-auto'
                          : 'pointer-events-none',
                        isCenter &&
                          !reduced &&
                          'transition-transform duration-200 ease-out hover:-translate-y-2 hover:scale-[1.03]',
                      )}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={t.slab}
                        className="absolute bottom-[-11%] left-1/2 z-0 h-[83%] w-auto -translate-x-1/2 object-contain drop-shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
                        alt={isCenter ? `${t.name} graded card` : ''}
                        aria-hidden={!isCenter}
                      />
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={t.pack}
                        className="absolute bottom-[-48%] left-1/2 z-10 h-[88%] w-auto -translate-x-1/2 object-contain drop-shadow-[0_-4px_20px_rgba(0,0,0,0.25)]"
                        alt=""
                        aria-hidden
                      />
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </div>
      </Link>
    </section>
  );
}
