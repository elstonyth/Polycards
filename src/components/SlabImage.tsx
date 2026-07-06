'use client';

import Image from 'next/image';
import { cn } from '@/lib/utils';

/**
 * Aspect ratio of the baked slab composite (= the frame asset it's baked
 * from — scripts/process-slab-frame.mjs prints it). Real PSA cases ≈ 0.62.
 */
export const SLAB_ASPECT = 1462 / 2446;

/** Bare trading-card stock (63×88mm ≈ 5:7) — the raw-card fallback. */
const CARD_ASPECT_RAW = 5 / 7;

/**
 * One card image. Graded cards pass `slabSrc` — the backend-baked
 * frame+photo composite — rendered as a single <Image>. Raw cards (and
 * graded cards whose bake failed) render the bare photo, letterboxed inside
 * the SAME SLAB_ASPECT box so mixed grids stay row-uniform and call sites
 * never branch on aspect. The corner rounding matches what the old runtime
 * clip applied (4.8% / 3.4%).
 */
export function SlabImage({
  src,
  slabSrc,
  alt,
  sizes,
  className,
  priority = false,
}: {
  src: string;
  slabSrc?: string | null;
  alt: string;
  sizes?: string;
  className?: string;
  priority?: boolean;
}) {
  return (
    <span
      className={cn('relative block', className)}
      style={{ aspectRatio: String(SLAB_ASPECT) }}
    >
      {slabSrc ? (
        <Image
          src={slabSrc}
          alt={alt}
          fill
          sizes={sizes}
          priority={priority}
          className="object-contain"
        />
      ) : (
        <span
          className="absolute left-0 right-0 top-1/2 -translate-y-1/2 overflow-hidden"
          style={{
            aspectRatio: String(CARD_ASPECT_RAW),
            borderRadius: '4.8% / 3.4%',
          }}
        >
          <Image
            src={src}
            alt={alt}
            fill
            sizes={sizes}
            priority={priority}
            className="object-cover"
          />
        </span>
      )}
    </span>
  );
}
