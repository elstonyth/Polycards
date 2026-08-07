import type { CSSProperties } from 'react';
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
 *
 * Load choreography (globals.css "Shared first-paint entrance"): kicker → the
 * shop window lighting up → the chase value landing with its one-shot gold
 * bloom → subline → CTA, every step ending together just under a second. It is
 * pure CSS so this stays a server component and so nothing depends on an
 * observer firing above the fold; --i is the 70ms stagger step.
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
        className="rise-in text-[11px] font-semibold uppercase tracking-[0.3em] text-neutral-400 lg:col-start-1 lg:row-start-1 lg:self-end"
      >
        The shop is open
      </p>

      {/* The glowing shop at night — an ambient looping scene (customers walk
          in, the cashier serves) framed in a grounded panel: the clip carries
          its own dark background, so a rounded bordered box reads as an intended
          window into the shop rather than a floating cutout. */}
      <div className="w-full max-w-[min(92vw,30rem)] lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:w-full lg:max-w-none">
        <div
          style={{ '--i': 1 } as CSSProperties}
          className="window-in relative aspect-video overflow-hidden rounded-2xl border border-white/10 bg-neutral-950 shadow-[0_24px_80px_-24px_rgba(0,0,0,0.85)]"
        >
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
            {/* The bloom rides the value only when there IS a chase — the
                fallback headline is copy, not a prize, so it gets the plain
                rise (Chase Gold is reserved for prize moments). */}
            <p
              style={{ '--i': 3 } as CSSProperties}
              className="chase-land font-heading text-chase text-5xl leading-none lg:mt-3 lg:text-7xl"
            >
              {chase.value}
            </p>
            {/* No truncate: at 15px this line clipped inside max-w-xs on a
                phone, and it wraps to two readable lines instead. */}
            <p
              style={{ '--i': 4 } as CSSProperties}
              className="rise-in mt-3 max-w-xs text-[15px] text-neutral-300 lg:mt-4 lg:max-w-md lg:text-base"
            >
              Top chase: {chase.name} · {pack.name}
            </p>
          </>
        ) : (
          <>
            <p
              style={{ '--i': 3 } as CSSProperties}
              className="rise-in font-heading text-5xl leading-none text-white lg:mt-3 lg:text-7xl"
            >
              Rip real graded cards
            </p>
            {/* text-sm/neutral-400 under a 72px headline was a hierarchy cliff,
                and neutral-400 sits exactly ON the DESIGN.md contrast floor. */}
            <p
              style={{ '--i': 4 } as CSSProperties}
              className="rise-in mt-3 max-w-xs text-[15px] text-neutral-300 lg:mt-4 lg:max-w-md lg:text-base"
            >
              Every pack holds a real, professionally graded slab.
            </p>
          </>
        )}
        {/* The entrance sits directly on the pill. Tailwind 4 compiles
            `active:scale-[0.98]` to the independent `scale` property, not to
            `transform`, so the two compose and the press state survives the
            entrance untouched. */}
        <Link
          href="/slots"
          style={{ '--i': 5 } as CSSProperties}
          className={cn(
            pillVariants({ variant: 'primary', size: 'lg' }),
            'rise-in group mt-6',
          )}
        >
          RIP A PACK
          {/* The arrow leans toward the destination on hover — the one hover
              affordance on this fold. motion-reduce keeps it still. */}
          <ArrowRight
            className="h-4 w-4 transition-transform duration-200 ease-out group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
            aria-hidden
          />
        </Link>
      </div>
    </section>
  );
}
