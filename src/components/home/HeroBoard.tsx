import Link from 'next/link';
import Image from 'next/image';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pillVariants } from '@/components/ui/pill';
import { SlabImage } from '@/components/SlabImage';
import HeroSlab from '@/components/home/HeroSlab';
import { priceNumber, type Pack, type PackCard } from '@/lib/packs-data';
import { rarityRgb } from '@/lib/rarity';
import { priceTier, TIER_COLOR } from '@/lib/price-tier';

/**
 * Board 01 — TOP CHASE IN THE BUILDING. One slab lit by its own rarity in the
 * dark room. Phone: stacked near-full-viewport; desktop: type left, slab right.
 * CTA → /slots (the routing rule: home never deep-links a product).
 */
export default function HeroBoard({
  pack,
  chase,
}: {
  pack: Pack;
  chase: PackCard | null;
}) {
  // Glow hue: the chase card's rarity; pack-art fallback uses the price tier.
  const glow = chase
    ? rarityRgb(chase.rarity)
    : TIER_COLOR[priceTier(priceNumber(pack.price))];

  return (
    // Phone: kicker → slab → value/name → CTA, all inside the first viewport
    // (media height is capped so the pill stays in thumb reach). Desktop: the
    // kicker + type block form the left column, the slab the right.
    <section
      aria-labelledby="hero-heading"
      className="px-fluid flex min-h-[calc(100svh-64px)] w-full flex-col items-center justify-center gap-5 py-8 text-center lg:grid lg:grid-cols-[1fr_auto] lg:content-center lg:items-center lg:gap-x-12 lg:py-16 lg:text-left"
    >
      <p
        id="hero-heading"
        className="text-[11px] font-semibold uppercase tracking-[0.3em] text-neutral-400 lg:col-start-1 lg:row-start-1 lg:self-end"
      >
        Top chase in the building
      </p>

      {/* The slab (or pack art fallback) on its spotlight */}
      <div className="lg:col-start-2 lg:row-span-2 lg:row-start-1">
        <HeroSlab>
          <div
            className="rounded-xl"
            style={{ boxShadow: `0 0 80px 8px rgba(${glow}, 0.35)` }}
          >
            {chase ? (
              <SlabImage
                src={chase.image}
                slabSrc={chase.slabImage}
                alt={chase.name}
                sizes="(min-width: 1024px) 420px, 60vw"
                className="max-h-[42svh] w-auto max-w-[min(60vw,15rem)] lg:max-h-[60svh] lg:max-w-[26rem]"
              />
            ) : (
              <Image
                src={pack.image}
                alt={pack.name}
                width={420}
                height={420}
                unoptimized
                className="h-auto max-h-[42svh] w-auto max-w-[min(60vw,15rem)] object-contain lg:max-h-[60svh] lg:max-w-[26rem]"
              />
            )}
          </div>
        </HeroSlab>
      </div>

      {/* Type block */}
      <div className="flex flex-col items-center lg:col-start-1 lg:row-start-2 lg:items-start lg:self-start">
        {chase ? (
          <>
            <p className="font-heading text-chase text-5xl leading-none lg:mt-3 lg:text-7xl">
              {chase.value}
            </p>
            <p className="mt-2 max-w-xs truncate text-sm text-neutral-400 lg:max-w-md">
              {chase.name} · {pack.name}
            </p>
          </>
        ) : (
          <p className="font-heading text-5xl leading-none text-white lg:mt-3 lg:text-7xl">
            {pack.name}
          </p>
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
