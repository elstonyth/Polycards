import Image from 'next/image';
import Link from 'next/link';
import {
  ArrowRight,
  ArrowUpRight,
  Layers2,
  PackageOpen,
  Truck,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { pillVariants } from '@/components/ui/pill';
import { SlabImage } from '@/components/SlabImage';
import { type Pack, type PackCard } from '@/lib/packs-data';
import { BUYBACK_RATE_LABEL } from '@/lib/buyback-copy';
import { rm } from '@/lib/format';

/** Brand artwork stays visible even when the live catalog is unavailable. */
export default function HeroBoard({
  hits,
}: {
  hits: { card: PackCard; pack: Pack }[];
}) {
  const lead = hits[0];
  return (
    <section
      aria-labelledby="hero-heading"
      className="px-fluid relative grid w-full gap-x-8 pt-6 pb-6 lg:min-h-[680px] lg:grid-cols-[1fr_1.05fr] lg:content-center lg:pt-14 lg:pb-10 xl:gap-x-16"
    >
      <div className="relative z-10 text-center lg:col-start-1 lg:row-start-1 lg:self-end lg:pl-[3vw] lg:text-left">
        <p className="rise-in mb-4 flex items-center justify-center gap-2 text-[11px] font-semibold tracking-[0.18em] text-neutral-400 uppercase lg:justify-start">
          <Layers2 className="h-4 w-4" aria-hidden />
          The collector’s next great find
        </p>
        <h1
          id="hero-heading"
          className="rise-in font-heading text-[clamp(2.75rem,6.1vw,6.5rem)] leading-[0.98] tracking-[-0.04em] text-white [--i:1]"
        >
          Open packs.
          <br />
          Pull real cards.
        </h1>
        <p className="rise-in mx-auto mt-5 max-w-md text-sm leading-relaxed text-neutral-400 [--i:2] lg:mx-0 lg:text-base">
          Open online. Reveal a real collectible. Keep it, sell it back, or ship
          it home.
        </p>
      </div>

      <figure className="relative row-start-3 mx-auto mt-7 aspect-[1.15] w-full max-w-[600px] lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:my-0 lg:aspect-[1.05]">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full bg-radial from-white/[0.05] via-transparent to-transparent"
        />
        {[
          'top-[5%] left-[30%] z-10 w-[41%] -rotate-[3deg]',
          'top-[15%] left-[3%] w-[36%] -rotate-[14deg]',
          'top-[15%] right-[3%] w-[36%] rotate-[14deg]',
        ].map((position, index) => {
          const hit = hits[index];
          return (
            <div
              key={index}
              className={cn('absolute', position)}
              data-hero-hit={hit ? index + 1 : undefined}
            >
              <div
                className={
                  index === 0
                    ? 'motion-safe:animate-[slabFloat_6s_ease-in-out_infinite]'
                    : undefined
                }
              >
                {hit ? (
                  <SlabImage
                    card={hit.card}
                    sizes="(min-width: 1024px) 246px, 40vw"
                    priority={index === 0}
                    glowScale={0.4}
                  />
                ) : (
                  <Image
                    src="/images/app/polycards-slab-back.webp"
                    alt={
                      index === 0
                        ? 'Polycards collectible card in a protective slab'
                        : ''
                    }
                    width={900}
                    height={1519}
                    sizes="(min-width: 1024px) 246px, 40vw"
                    className="h-auto w-full"
                    preload={index === 0}
                  />
                )}
              </div>
            </div>
          );
        })}
        <figcaption className="absolute inset-x-[8%] bottom-0 z-20 rounded-xl border border-white/10 bg-neutral-900 px-4 py-3 lg:inset-x-[12%] lg:px-5 lg:py-4">
          {lead ? (
            <>
              <div className="flex flex-col items-start justify-between gap-1 sm:flex-row sm:items-center sm:gap-3">
                <span className="text-[10px] font-semibold tracking-[0.14em] text-neutral-400 uppercase">
                  Top {hits.length} chase {hits.length === 1 ? 'card' : 'cards'}
                </span>
                <span className="font-heading text-chase text-lg lg:text-2xl">
                  {lead.card.priceMyr != null ? rm(lead.card.priceMyr) : '—'}
                </span>
              </div>
              <p className="mt-1 text-sm font-semibold text-white">
                {lead.card.name}
              </p>
              <p className="mt-1 text-xs text-neutral-400">
                Discover it in {lead.pack.name} · Pulls vary
              </p>
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

      <div className="rise-in relative z-10 row-start-2 mt-5 flex flex-col items-center [--i:3] lg:col-start-1 lg:row-start-2 lg:mt-7 lg:items-start lg:self-start lg:pl-[3vw]">
        <div className="flex w-full flex-wrap items-center justify-center gap-2 lg:justify-start lg:gap-5">
          <Link
            href="/slots"
            className={cn(
              pillVariants({ variant: 'primary', size: 'lg' }),
              'group min-w-36 px-5 sm:min-w-44 sm:px-6',
            )}
          >
            Open a pack
            <ArrowRight
              className="h-4 w-4 transition-transform group-hover:translate-x-1 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
              aria-hidden
            />
          </Link>
          <Link
            href="/how-it-works"
            className={cn(
              pillVariants({ variant: 'secondary', size: 'lg' }),
              'bg-transparent px-2 text-neutral-300 hover:bg-white/5 sm:px-4',
            )}
          >
            How it works <ArrowUpRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
        <p className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[11px] text-neutral-400 lg:justify-start lg:text-xs">
          <span className="flex items-center gap-1.5">
            <Truck className="h-3.5 w-3.5" aria-hidden />
            Physical delivery
          </span>
          <span className="h-3 border-l border-white/15" aria-hidden />
          <span>{BUYBACK_RATE_LABEL} vault buyback</span>
        </p>
      </div>

      <ol
        aria-label="How pack opening works"
        className="mt-9 grid grid-cols-3 gap-3 border-t border-white/10 pt-5 lg:col-span-2 lg:mt-10 lg:gap-8 lg:pt-6"
      >
        {[
          ['01', 'Choose your pack', 'Explore the cards and odds.'],
          ['02', 'Make the reveal', 'Discover your real collectible.'],
          ['03', 'Make it yours', 'Keep, sell back, or ship it.'],
        ].map(([number, title, description]) => (
          <li
            key={number}
            className="flex flex-col gap-1.5 lg:flex-row lg:items-center lg:gap-4"
          >
            <span className="font-heading text-xs text-neutral-400 lg:text-xl">
              {number}
            </span>
            <div>
              <p className="text-xs font-semibold text-white lg:text-sm">
                {title}
              </p>
              <p className="mt-1 hidden text-xs text-neutral-400 sm:block">
                {description}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
