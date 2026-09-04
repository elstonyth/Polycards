import Image from 'next/image';
import { cn } from '@/lib/utils';

/** Highest rank with a numeral asset in public/images/ranks/. */
const GLYPH_MAX = 10;

/**
 * Rank numeral for the boards — the glowing-outline art for ranks 1–10 (chase
 * gold / silver / bronze on the podium, neutral after), falling back to the
 * plain neutral disc the boards used before for anything deeper.
 *
 * The art is keyed to transparency off its #171717 ground, so it composites
 * correctly on the own-row highlight (bg-white/[0.04]) as well as the plain
 * neutral-900 row. Every rank occupies the same 32px box — the two-digit 10 is
 * scaled to fit by width — so rows stay aligned down the board.
 */
export function RankGlyph({
  rank,
  className,
}: {
  rank: number;
  className?: string;
}) {
  if (!Number.isInteger(rank) || rank < 1 || rank > GLYPH_MAX) {
    return (
      <span
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-[13px] font-bold text-neutral-400',
          className,
        )}
        aria-label={`Rank ${rank}`}
      >
        {rank}
      </span>
    );
  }

  return (
    <Image
      src={`/images/ranks/rank-${rank}.png`}
      alt={`Rank ${rank}`}
      width={96}
      height={96}
      className={cn('h-8 w-8 shrink-0 object-contain', className)}
    />
  );
}
