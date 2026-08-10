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
 * raw card art stays an unframed image — it has the wrong aspect for the band.
 *
 * GEOMETRY: pass a HEIGHT only. SlabImage holds its aspect ratio by leaving the
 * other dimension auto, so pinning both (a stray `w-full` here) makes the ratio
 * inert and stretches the prism band into a landscape smear around a
 * correctly-proportioned card photo. The Link is `w-fit` for the same reason —
 * it hugs the art instead of handing it a definite width, which also keeps the
 * hover/click target on the card rather than the dead space beside it.
 *
 * The whole thumbnail is the link. How the affordance reads scales with the
 * art: the pack-tile pill (components/cards/CardTile) is sized for a ~200px
 * grid tile and overflows every prize thumbnail here — the widest is 76px — so
 * the pill is set in the smaller label size, and the 40-56px sheet and
 * standings thumbs, narrower than the words themselves, get a ring instead.
 * Both fade in on hover AND keyboard focus, and the link's aria-label carries
 * the semantics either way.
 *
 * Pack tiles open an overlay because they already hold a priced seed; a prize
 * thumbnail carries no price or rarity, so it navigates to /card/<handle> and
 * lets that page do the fetching.
 *
 * `handle` is null on an older backend that doesn't send it — the thumbnail
 * then renders exactly as before, unlinked, instead of pointing at a 404.
 */
export function PrizeCard({
  card,
  className,
  sizes,
  glowScale,
  affordance = 'pill',
}: {
  card: ChallengeCard;
  /** HEIGHT + position classes for the art (h-32, mx-auto mt-2 h-20, …). Never
   *  a width — see the GEOMETRY note above. A drop-shadow passed here overrides
   *  the default via tailwind-merge, which is how each site keeps a shadow
   *  scaled to its own size. */
  className?: string;
  sizes?: string;
  glowScale?: number;
  /** How the "view details" hint reads at this size. */
  affordance?: 'pill' | 'ring';
}) {
  // Unlinked (no handle) the image is the only thing announcing this prize, so
  // it needs its name; linked, the anchor's aria-label already carries it and a
  // named image would just repeat it to a screen reader.
  const alt = card.handle ? '' : card.name;
  const art = card.slabImage ? (
    <SlabImage
      src={card.image}
      slabSrc={card.slabImage}
      alt={alt}
      frameVariant="prism"
      glowScale={glowScale}
      sizes={sizes}
      className={className}
    />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={card.image}
      alt={alt}
      loading="lazy"
      decoding="async"
      className={cn(
        'object-contain drop-shadow-[0_10px_20px_rgba(0,0,0,0.6)]',
        className,
      )}
    />
  );

  if (!card.handle) return art;

  const ring = affordance === 'ring';

  return (
    <Link
      // `prize=weekly` tells the card page this arrival came from the
      // challenge, so the slab keeps the prism frame it wears here instead of
      // switching to the card's pack tier.
      href={`/card/${encodeURIComponent(card.handle)}?prize=weekly`}
      aria-label={`View details for ${card.name}`}
      className={cn(
        'group relative mx-auto block w-fit',
        ring &&
          'rounded-md ring-white/70 transition-shadow hover:ring-2 focus-visible:ring-2',
      )}
    >
      <span
        className={cn(
          'block transition duration-200',
          ring
            ? 'group-hover:brightness-125 group-focus-visible:brightness-125'
            : 'group-hover:opacity-60 group-focus-visible:opacity-60',
        )}
      >
        {art}
      </span>
      {!ring && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold whitespace-nowrap text-neutral-950 shadow-lg">
            View Details
          </span>
        </span>
      )}
    </Link>
  );
}
