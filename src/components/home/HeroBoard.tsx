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
    <section
      aria-labelledby="hero-heading"
      className="px-fluid flex min-h-[calc(100svh-64px)] w-full flex-col items-center justify-center gap-6 py-10 text-center lg:flex-row-reverse lg:justify-between lg:gap-12 lg:py-16 lg:text-left"
    >
      {/* The slab (or pack art fallback) on its spotlight */}
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
              className="w-[min(60vw,15rem)] lg:w-[26rem]"
            />
          ) : (
            <Image
              src={pack.image}
              alt={pack.name}
              width={420}
              height={420}
              unoptimized
              className="h-auto w-[min(60vw,15rem)] object-contain lg:w-[26rem]"
            />
          )}
        </div>
      </HeroSlab>

      {/* Type block */}
      <div className="flex flex-col items-center lg:items-start">
        <p
          id="hero-heading"
          className="text-[11px] font-semibold uppercase tracking-[0.3em] text-neutral-400"
        >
          Top chase in the building
        </p>
        {chase ? (
          <>
            <p className="font-heading text-chase mt-3 text-5xl leading-none lg:text-7xl">
              {chase.value}
            </p>
            <p className="mt-2 max-w-xs truncate text-sm text-neutral-400 lg:max-w-md">
              {chase.name} · {pack.name}
            </p>
          </>
        ) : (
          <p className="font-heading mt-3 text-5xl leading-none text-white lg:text-7xl">
            {pack.name}
          </p>
        )}
        <Link
          href="/slots"
          className={cn(
            pillVariants({ variant: 'primary', size: 'lg' }),
            'mt-7',
          )}
        >
          RIP A PACK
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </section>
  );
}
