import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pillVariants } from '@/components/ui/pill';
import { AmbientVideo } from '@/components/AmbientVideo';
import { type Pack, type PackCard } from '@/lib/packs-data';

/**
 * Board 01 — THE SHOP IS OPEN. A framed, always-looping scene of the Polycards
 * shop at night (customers browsing, the cashier at the counter). Phone:
 * stacked near-full-viewport; desktop: type left, shop right. The top chase
 * still headlines the type block when the pool has one.
 * CTA → /slots (the routing rule: home never deep-links a product).
 */
export default function HeroBoard({
  pack,
  chase,
}: {
  pack: Pack;
  chase: PackCard | null;
}) {
  return (
    // Phone: kicker → slab → value/name → CTA, all inside the first viewport
    // (media height is capped so the pill stays in thumb reach). Desktop: the
    // kicker + type block form the left column, the slab the right.
    <section
      aria-labelledby="hero-heading"
      // Phone height subtracts header (64) + fixed TabBar (64) so the CTA
      // clears the bar even on short phones; desktop has no TabBar.
      // Desktop: text + shop sit as a CENTERED cluster (both columns
      // content-sized, `justify-center` soaks up wide-screen slack) so the
      // shop never drifts to the far-right edge with a dead gap in the middle
      // — the old `1fr auto` did exactly that. Columns shrink (minmax floor 0)
      // before they overflow narrower desktops.
      className="px-fluid flex min-h-[calc(100svh-128px)] w-full flex-col items-center justify-center gap-5 py-8 text-center lg:grid lg:min-h-[calc(100svh-64px)] lg:grid-cols-[minmax(0,34rem)_minmax(0,46rem)] lg:content-center lg:items-center lg:justify-center lg:gap-x-16 lg:py-16 lg:text-left"
    >
      <p
        id="hero-heading"
        className="text-[11px] font-semibold uppercase tracking-[0.3em] text-neutral-400 lg:col-start-1 lg:row-start-1 lg:self-end"
      >
        The shop is open
      </p>

      {/* The glowing shop at night — an ambient looping scene (customers walk
          in, the cashier serves) framed in a grounded panel: the clip carries
          its own dark background, so a rounded bordered box reads as an intended
          window into the shop rather than a floating cutout. */}
      <div className="w-full max-w-[min(92vw,30rem)] lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:w-full lg:max-w-none">
        <div className="relative aspect-video overflow-hidden rounded-2xl border border-white/10 bg-neutral-950 shadow-[0_24px_80px_-24px_rgba(0,0,0,0.85)]">
          <AmbientVideo
            mp4="/images/polycards/shop-night.mp4"
            webm="/images/polycards/shop-night.webm"
            poster="/images/polycards/shop-night-poster.webp"
            className="absolute inset-0 h-full w-full"
          />
        </div>
      </div>

      {/* Type block — the top chase still gets the headline when one exists. */}
      <div className="flex flex-col items-center lg:col-start-1 lg:row-start-2 lg:items-start lg:self-start">
        {chase ? (
          <>
            <p className="font-heading text-chase text-5xl leading-none lg:mt-3 lg:text-7xl">
              {chase.value}
            </p>
            <p className="mt-3 max-w-xs truncate text-[15px] text-neutral-300 lg:mt-4 lg:max-w-md lg:text-base">
              Top chase: {chase.name} · {pack.name}
            </p>
          </>
        ) : (
          <>
            <p className="font-heading text-5xl leading-none text-white lg:mt-3 lg:text-7xl">
              Rip real graded cards
            </p>
            {/* text-sm/neutral-400 under a 72px headline was a hierarchy cliff
                and sat near the DESIGN.md contrast floor. */}
            <p className="mt-3 max-w-xs text-[15px] text-neutral-300 lg:mt-4 lg:max-w-md lg:text-base">
              Every pack holds a real, professionally graded slab.
            </p>
          </>
        )}
        <Link
          href="/slots"
          className={cn(
            pillVariants({ variant: 'primary', size: 'lg' }),
            'mt-6',
          )}
        >
          RIP A PACK
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </section>
  );
}
