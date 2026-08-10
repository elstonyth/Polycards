import Link from 'next/link';
import { cn } from '@/lib/utils';
import { SlabImage } from '@/components/SlabImage';
import type { ChallengeCard } from '@/lib/data/challenge';

/**
 * One challenge prize thumbnail, everywhere the challenge shows one: the
 * rewards summary, the stage carousel's podium grid, the ranks 4-10 sheet and
 * the standings prize column.
 *
 * Art rule (unchanged, just centralised): a graded slab wears the prism frame,
 * raw card art stays a plain <img> — it has the wrong aspect for the band.
 *
 * The whole thumbnail is the link, with the "View Details" pill fading in on
 * hover AND keyboard focus — the same affordance as the pack pool tiles
 * (components/cards/CardTile). Pack tiles open an overlay because they already
 * hold a priced seed; a prize thumbnail carries no price or rarity, so it
 * navigates to /card/<handle> and lets that page do the fetching.
 *
 * `handle` is null on an older backend that doesn't send it — the thumbnail
 * then renders exactly as before, unlinked, instead of pointing at a 404.
 */
export function PrizeCard({
  card,
  className,
  sizes,
  glowScale,
  compact = false,
}: {
  card: ChallengeCard;
  /** Sizing/position classes for the art itself (h-32, mx-auto mt-2 h-20, …). */
  className?: string;
  sizes?: string;
  glowScale?: number;
  /** Smaller pill for the h-14/h-20 tiles, where the default overflows. */
  compact?: boolean;
}) {
  const art = card.slabImage ? (
    <SlabImage
      src={card.image}
      slabSrc={card.slabImage}
      alt=""
      frameVariant="prism"
      glowScale={glowScale}
      sizes={sizes}
      className={cn('w-full', className)}
    />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={card.image}
      alt=""
      loading="lazy"
      decoding="async"
      className={cn(
        'object-contain drop-shadow-[0_10px_20px_rgba(0,0,0,0.6)]',
        className,
      )}
    />
  );

  if (!card.handle) return art;

  return (
    <Link
      href={`/card/${card.handle}`}
      aria-label={`View details for ${card.name}`}
      className="group relative block"
    >
      <span className="block transition-opacity duration-200 group-hover:opacity-60 group-focus-visible:opacity-60">
        {art}
      </span>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        <span
          className={cn(
            'rounded-full bg-white font-bold text-neutral-950 shadow-lg',
            compact ? 'px-2 py-0.5 text-[9px]' : 'px-3.5 py-1.5 text-[12px]',
          )}
        >
          View Details
        </span>
      </span>
    </Link>
  );
}
