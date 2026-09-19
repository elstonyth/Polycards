import Link from 'next/link';
import { ArrowRight, ArrowUpRight, Layers2, Truck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pillVariants } from '@/components/ui/pill';
import { HeroSlabs } from './HeroSlabs';
import { type Pack, type PackCard } from '@/lib/packs-data';
import { BUYBACK_RATE_LABEL } from '@/lib/buyback-copy';

/** Brand artwork stays visible even when the live catalog is unavailable. */
export default function HeroBoard({
  hits,
}: {
  hits: { card: PackCard; pack: Pack }[];
}) {
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

      <HeroSlabs hits={hits} />

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
