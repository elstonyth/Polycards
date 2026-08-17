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

/**
 * Ring thickness of the tier frame, % of width — and therefore the inset of the
 * SLAB itself inside a framed tile. Exported because anything that has to line
 * up with a framed slab's CASE (the reveal's card back, which flips into one)
 * must sit on this box: it is 0.9W x 0.9H, so it preserves SLAB_ASPECT and an
 * object-fill raster lands undistorted. FRAME_INSET below is the BAND's outer
 * silhouette, which is a different (and wider) box — don't confuse them.
 */
export const FRAME_BAND = 5;

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
 * RAW-card geometry — measured so an ungraded card renders at the EXACT
 * card-art size a graded tile shows, instead of filling the box (which made
 * raw cards read ~30% bigger than their slabbed neighbours):
 *
 *   slab window width = 1 − 0.1094 − 0.1087 (bake-slab SLAB_WINDOW), minus
 *   composeSlab's px-rounded recess (8px each side at 1600) ⇒ card = 1235px
 *   = 0.7719 of slab width; a FRAMED tile then insets the slab 5% ⇒ card =
 *   0.7719 × 0.9 of the box. On the 1600×2700 box: 1112×1557, corner r 53.
 *
 * The tier band (public/images/raw-frames/<tier>.webp — the "glass border"
 * pick, hue-tinted per rarity like the slab band; built by
 * scripts/compose-rawframe-tiers.mjs) pads the card by 64px, outer radius
 * 117, and the asset is cropped to that band box — placed here by inset.
 */
const RAW_BOX_W = 1600;
const RAW_BOX_H = 2700;
const RAW_CARD_W = 1112;
const RAW_CARD_H = 1557;
const RAW_PAD = 64; // band thickness around the card
const RAW_OUTER_R = 117; // band outer corner radius (card r 53 + pad)
/**
 * Vertical anchor: the graded card art is NOT vertically centered in the slab
 * (the label bar sits on top) — composeSlab top-aligns the card at
 * round(2700 × SLAB_WINDOW.top) + 8px recess, putting a 5:7 card's CENTER at
 * (739 + 1729/2) / 2700 ≈ 59.39% of the composite height. Raw cards anchor to
 * the SAME center, scaled through the frame inset where applicable, so mixed
 * graded/raw rows are aligned — not just size-matched.
 */
const ART_CENTER_Y = 0.5939;
/** 3-value CSS inset (top, left/right, bottom) for a w×h box whose vertical
 *  CENTER sits at `centerY` (fraction of box height), horizontally centered.
 *  Top/bottom % resolve against height, left/right % against width. */
const rawInset = (w: number, h: number, centerY: number): string => {
  const top = centerY * RAW_BOX_H - h / 2;
  const pctH = (n: number): string => `${((n / RAW_BOX_H) * 100).toFixed(4)}%`;
  const pctW = (n: number): string => `${((n / RAW_BOX_W) * 100).toFixed(4)}%`;
  return `${pctH(top)} ${pctW((RAW_BOX_W - w) / 2)} ${pctH(RAW_BOX_H - top - h)}`;
};
/** FRAMED raw card center — the graded center seen through the 5% slab inset. */
const RAW_FRAMED_CENTER_Y = 0.05 + 0.9 * ART_CENTER_Y;
const RAW_CARD_INSET = rawInset(RAW_CARD_W, RAW_CARD_H, RAW_FRAMED_CENTER_Y);
const RAW_BAND_INSET = rawInset(
  RAW_CARD_W + 2 * RAW_PAD,
  RAW_CARD_H + 2 * RAW_PAD,
  RAW_FRAMED_CENTER_Y,
);
const RAW_BAND_RADIUS = `${((RAW_OUTER_R / (RAW_CARD_W + 2 * RAW_PAD)) * 100).toFixed(2)}% / ${((RAW_OUTER_R / (RAW_CARD_H + 2 * RAW_PAD)) * 100).toFixed(2)}%`;
/** UNFRAMED raw card — the card art inside an UNframed slab: 0.7719 of the
 *  box width (px-rounded bake: 1235/1600), anchored to the same art center. */
const RAW_BARE_W = 0.7719;
const RAW_BARE_INSET = rawInset(
  RAW_BARE_W * RAW_BOX_W,
  (RAW_BARE_W * RAW_BOX_W) / CARD_ASPECT_RAW,
  ART_CENTER_Y,
);
function rawFrameSrc(rarity: string): string {
  const key = rarity.toLowerCase();
  return `/images/raw-frames/${FRAME_TIERS.has(key) ? key : 'common'}.webp`;
}

/**
 * Cosmetic frames that are NOT rarity tiers — chosen by the surface, not by the
 * card. `prism` is cut from the same dark-glass master as the six tiers but
 * spectrally tinted (see the prism recipe); it marks Weekly Pulled Value
 * Challenge reward cards on /leaderboard. A variant overrides BOTH the band art
 * and the halo colour, since `rarityRgb` has no entry for it and would fall
 * back to Common gray.
 */
export type FrameVariant = 'prism';
export const VARIANT_RGB: Record<FrameVariant, string> = {
  prism: '255, 255, 255', // white — the gradient's own endpoints
};

/**
 * Static outer halo (box-shadow only — no animation, operator 2026-07-17).
 *
 * GEOMETRY CONTRACT: this glow reaches ~44px past the slab edge (the primary
 * shadow). Any surface that clips its overflow around a SlabImage must reserve
 * at least that much padding or the halo gets cut — see the rail padding in
 * src/app/slots/[slug]/PoolByRarity.tsx (py-12/px-10). Retune this radius and
 * that padding together.
 *
 * `scale` shrinks the halo for thumbnail-sized slabs (the /me showcase strip
 * renders 80px slabs — a full 44px halo there is wider than the slab and
 * bleeds into its neighbours). Default 1 = the tuned full-size halo.
 */
const glowShadow = (rgb: string, scale: number): string =>
  `0 0 ${44 * scale}px ${-2 * scale}px rgba(${rgb},0.8), 0 0 ${90 * scale}px ${-20 * scale}px rgba(${rgb},0.6)`;

function glowStyle(rgb: string, scale: number): React.CSSProperties {
  return {
    inset: FRAME_INSET,
    borderRadius: FRAME_RADIUS,
    boxShadow: glowShadow(rgb, scale),
  };
}

/** Same halo, hugging the raw-card band box instead of the slab frame. */
function rawGlowStyle(rgb: string, scale: number): React.CSSProperties {
  return {
    inset: RAW_BAND_INSET,
    borderRadius: RAW_BAND_RADIUS,
    boxShadow: glowShadow(rgb, scale),
  };
}

/**
 * One card image. Graded cards pass `slabSrc` — the backend-baked
 * frame+photo composite — rendered as a single <Image>. Raw cards (and
 * graded cards whose bake failed) render the bare photo inside the SAME
 * SLAB_ASPECT box at the measured graded card-art size (RAW_* geometry
 * above), so mixed grids stay row-uniform, cards read the same physical
 * size slabbed or not, and call sites never branch on aspect. The corner
 * rounding matches what the old runtime clip applied (4.8% / 3.4%).
 *
 * Pass `rarity` (the admin-set gacha tier) to add the tier-colored glass
 * frame + halo (rarity.ts colors: Immortal orange, Legendary pink, …).
 * Graded gets the slab band (public/images/slab-frames); raw gets the
 * card-hugging glass border (public/images/raw-frames).
 */
export function SlabImage({
  src,
  slabSrc,
  alt,
  sizes,
  className,
  priority = false,
  rarity,
  frameVariant,
  glowScale = 1,
}: {
  src: string;
  slabSrc?: string | null;
  alt: string;
  sizes?: string;
  className?: string;
  priority?: boolean;
  rarity?: string | null;
  /** Cosmetic frame that overrides the rarity tier (band art + halo colour). */
  frameVariant?: FrameVariant;
  /** Halo size multiplier — drop below 1 on thumbnail-sized slabs. */
  glowScale?: number;
}) {
  // A variant frames the slab on its own — no `rarity` needed at the call site.
  const framed = frameVariant ?? rarity;
  const bandSrc = frameVariant
    ? `/images/slab-frames/${frameVariant}.webp`
    : rarity
      ? frameSrc(rarity)
      : null;
  const glowRgb = frameVariant
    ? VARIANT_RGB[frameVariant]
    : rarityRgb(rarity ?? '');
  return (
    <span
      // Stable hook for the QA scripts, which assert this box still measures
      // SLAB_ASPECT. The ratio only holds while ONE dimension is auto: a caller
      // that pins BOTH (e.g. a height class plus `w-full`) makes it inert and
      // the frame band stretches around a correctly-proportioned card photo.
      data-slab=""
      className={cn('relative block', className)}
      style={{ aspectRatio: String(SLAB_ASPECT) }}
    >
      {slabSrc ? (
        framed && bandSrc ? (
          <>
            <span
              aria-hidden
              className="pointer-events-none absolute"
              style={glowStyle(glowRgb, glowScale)}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute"
              style={{ inset: FRAME_INSET }}
            >
              <Image
                src={bandSrc}
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
      ) : framed ? (
        // RAW + tier/variant frame — card at the measured graded card-art
        // size, wrapped by the raw-card glass band + the same rarity halo.
        <>
          <span
            aria-hidden
            className="pointer-events-none absolute"
            style={rawGlowStyle(glowRgb, glowScale)}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute"
            style={{ inset: RAW_BAND_INSET }}
          >
            <Image
              src={
                frameVariant
                  ? `/images/raw-frames/${frameVariant}.webp`
                  : rawFrameSrc(rarity ?? '')
              }
              alt=""
              fill
              sizes={sizes}
              priority={priority}
              className="object-fill"
            />
          </span>
          <span
            className="absolute overflow-hidden"
            style={{ inset: RAW_CARD_INSET, borderRadius: '4.8% / 3.4%' }}
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
        </>
      ) : (
        // RAW, unframed — bare card at the unframed slab's card-art size.
        <span
          className="absolute overflow-hidden"
          style={{ inset: RAW_BARE_INSET, borderRadius: '4.8% / 3.4%' }}
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
