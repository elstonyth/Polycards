'use client';

import Image from 'next/image';
import { cn } from '@/lib/utils';
import { rarityRgb } from '@/lib/rarity';

/**
 * Aspect ratio of the baked slab composite (= the frame asset it's baked
 * from — scripts/process-slabframe-v2.mjs prints it). Real PSA cases ≈ 0.62.
 */
export const SLAB_ASPECT = 1600 / 2700;

/** Bare trading-card stock (63×88mm ≈ 5:7) — the raw-card fallback. */
const CARD_ASPECT_RAW = 5 / 7;

/** Ring thickness of the tier frame, % of width. */
const FRAME_BAND = 5;

/**
 * Tier frame LOCKED IN 2026-07-17, made STATIC 2026-07-17 (operator change):
 * the band itself is pre-rendered art — public/images/slab-frames/<tier>.webp,
 * one per gacha rarity (SnapGen dark-glass master, geometry-guided via
 * scripts/compose-frame-variant.mjs --guide, hue-tinted per tier from ONE
 * master so lighting is identical across tiers). The webp already carries
 * the transparent window cut to the measured slab geometry, so no runtime
 * masking of the band is needed; CSS adds only a static breathing-halo glow
 * (box-shadow, no animation — the traveling light sweep was removed).
 * Deliberately NO refraction/displacement — an earlier liquid-glass rim
 * (src/lib/liquid-glass.ts) magnified the case edge and was rejected.
 *
 * Uniform-thickness band: the outer box shares the slab's aspect, so a
 * frame at inset 0 would get 1/aspect≈1.67× thicker top/bottom bands. The
 * frame's outer edge is pulled inward vertically by BAND·(1−aspect) (of
 * height) instead; the slab itself never moves.
 *
 * FRAME_VB_W/H + OUTER_R (2026-07-17, Task 2R geometry, re-derived after the
 * operator's case swap to slabframe-user-1600 via
 * scripts/measure-slab-margins.mjs + a diagonal alpha=128 corner-radius fit)
 * size the glow's outer corner radius to match the frame art's outer rounded
 * rect. The hole inset/radius that used to bound the sweep mask are gone
 * along with the sweep — see scripts/compose-frame-variant.mjs for the band
 * cut geometry (HOLE_INSET 79 / HOLE_R 55 / OUTER_R 147), which still governs
 * how the pre-rendered tier webps are cut.
 */
const FRAME_VB_W = 1600; // frame asset px, for the border-radius % below
const FRAME_VB_H = Math.round(
  (FRAME_VB_W / SLAB_ASPECT) * (1 - 2 * (FRAME_BAND / 100) * (1 - SLAB_ASPECT)),
);
const OUTER_R = 147;

/** Vertical inset that keeps the band uniform (see block comment above). */
const FRAME_INSET = `${(FRAME_BAND * (1 - SLAB_ASPECT)).toFixed(4)}% 0`;
/** Outer corner radius, matched to the frame art's outer rounded rect. */
const FRAME_RADIUS = `${((OUTER_R / FRAME_VB_W) * 100).toFixed(2)}% / ${((OUTER_R / FRAME_VB_H) * 100).toFixed(2)}%`;

/** Tiers with a baked frame asset; anything unknown falls back to common. */
const FRAME_TIERS = new Set([
  'immortal',
  'legendary',
  'mythical',
  'rare',
  'uncommon',
  'common',
]);
function frameSrc(rarity: string): string {
  const key = rarity.toLowerCase();
  return `/images/slab-frames/${FRAME_TIERS.has(key) ? key : 'common'}.webp`;
}

/**
 * Static outer halo (box-shadow only — no animation, operator 2026-07-17).
 *
 * GEOMETRY CONTRACT: this glow reaches ~44px past the slab edge (the primary
 * shadow). Any surface that clips its overflow around a SlabImage must reserve
 * at least that much padding or the halo gets cut — see the rail padding in
 * src/app/slots/[slug]/PoolByRarity.tsx (py-12/px-10). Retune this radius and
 * that padding together.
 */
function glowStyle(rgb: string): React.CSSProperties {
  return {
    inset: FRAME_INSET,
    borderRadius: FRAME_RADIUS,
    boxShadow: `0 0 44px -2px rgba(${rgb},0.8), 0 0 90px -20px rgba(${rgb},0.6)`,
  };
}

/**
 * One card image. Graded cards pass `slabSrc` — the backend-baked
 * frame+photo composite — rendered as a single <Image>. Raw cards (and
 * graded cards whose bake failed) render the bare photo, letterboxed inside
 * the SAME SLAB_ASPECT box so mixed grids stay row-uniform and call sites
 * never branch on aspect. The corner rounding matches what the old runtime
 * clip applied (4.8% / 3.4%).
 *
 * Pass `rarity` (the admin-set gacha tier) to surround the slab with the
 * tier-colored glass frame (rarity.ts colors: Immortal orange, Legendary
 * pink, …). Graded (slabSrc) renders only — it's the slab's outer layer,
 * not a raw-card treatment.
 */
export function SlabImage({
  src,
  slabSrc,
  alt,
  sizes,
  className,
  priority = false,
  rarity,
}: {
  src: string;
  slabSrc?: string | null;
  alt: string;
  sizes?: string;
  className?: string;
  priority?: boolean;
  rarity?: string | null;
}) {
  return (
    <span
      className={cn('relative block', className)}
      style={{ aspectRatio: String(SLAB_ASPECT) }}
    >
      {slabSrc ? (
        rarity ? (
          <>
            <span
              aria-hidden
              className="pointer-events-none absolute"
              style={glowStyle(rarityRgb(rarity))}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute"
              style={{ inset: FRAME_INSET }}
            >
              <Image
                src={frameSrc(rarity)}
                alt=""
                fill
                sizes={sizes}
                priority={priority}
                className="object-fill"
              />
            </span>
            <span className="absolute" style={{ inset: `${FRAME_BAND}%` }}>
              <Image
                src={slabSrc}
                alt={alt}
                fill
                sizes={sizes}
                priority={priority}
                className="object-contain"
              />
            </span>
          </>
        ) : (
          <Image
            src={slabSrc}
            alt={alt}
            fill
            sizes={sizes}
            priority={priority}
            className="object-contain"
          />
        )
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
