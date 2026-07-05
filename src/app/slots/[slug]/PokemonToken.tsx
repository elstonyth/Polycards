// src/app/slots/[slug]/PokemonToken.tsx
'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { spriteGif, spritePng } from '@/lib/mock/pokedex';
import { TIER_COLOR, type Tier } from '@/lib/price-tier';
import { cn } from '@/lib/utils';

type PokemonTokenProps = {
  dex: number;
  name: string;
  tier: Tier;
  /** Cell pixel size (square). Default 96. */
  size?: number;
  /** When true, the winner grows + glows (the reveal beat). */
  landed?: boolean;
  /** prefers-reduced-motion: no pulse/scale transition; static glow only. */
  reduced?: boolean;
  /** Eager-load this cell's image (winner + cells resting in the visible window). */
  eager?: boolean;
  /** Render this exact image instead of a dex sprite (non-Pokémon card fallback, §2/G5). */
  imageSrc?: string;
  /** Extra CSS filter applied to the sprite itself (e.g. a landed rarity glow
   *  drop-shadow that hugs the sprite's silhouette — spec decision #17). */
  filter?: string;
};

/** Opaque footprint of a sprite's figure, in natural image pixels. */
type FigureBox = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Centre of MASS of the opaque pixels (not the bbox centre): the dense body
   *  dominates, so a thin tail/limb shifts this only slightly — centring on it
   *  keeps the body centred and lets appendages trail off naturally. */
  cx: number;
  cy: number;
  w: number;
  h: number;
};

// Measure-once cache keyed by image src. A `null` value = measured but
// unreadable (cross-origin tainted canvas / decode error) → fall back to plain
// box centering. Module-level so it persists across cells and re-spins.
const figureCache = new Map<string, FigureBox | null>();

/** Fraction of the cell that the FIGURE's larger side fills. */
const FIGURE_FILL = 0.82;
/** Alpha above this counts as "figure" (ignores anti-aliased transparent fringe). */
const ALPHA_MIN = 12;

// Measure the opaque bounding box of `src` by drawing it to an offscreen canvas
// and scanning the alpha channel. Showdown gifs (and the PokeAPI png fallback)
// send `Access-Control-Allow-Origin: *`, so the canvas stays readable; a custom
// sprite whose host omits CORS taints the canvas and resolves null (→ fallback).
function measureFigure(src: string): Promise<FigureBox | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!w || !h) return resolve(null);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0);
        const { data } = ctx.getImageData(0, 0, w, h);
        let minX = w;
        let minY = h;
        let maxX = -1;
        let maxY = -1;
        let sumX = 0;
        let sumY = 0;
        let count = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if ((data[(y * w + x) * 4 + 3] ?? 0) > ALPHA_MIN) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
              sumX += x;
              sumY += y;
              count++;
            }
          }
        }
        resolve(
          count > 0
            ? {
                minX,
                minY,
                maxX,
                maxY,
                cx: sumX / count,
                cy: sumY / count,
                w,
                h,
              }
            : null,
        );
      } catch {
        resolve(null); // tainted canvas (no CORS) — caller falls back
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function useFigureBox(src: string): FigureBox | null {
  const [box, setBox] = useState<FigureBox | null>(
    () => figureCache.get(src) ?? null,
  );
  useEffect(() => {
    const cached = figureCache.get(src);
    if (cached !== undefined) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sync read from the measure-once cache
      setBox(cached);
      return;
    }
    let alive = true;
    void measureFigure(src).then((res) => {
      figureCache.set(src, res);
      if (alive) setBox(res);
    });
    return () => {
      alive = false;
    };
  }, [src]);
  return box;
}

/**
 * A single Pokémon reel cell (spec §2). Animated showdown sprite with a static
 * PNG fallback (same pattern as PokedexClient's PokeSprite). On `landed`, the
 * sprite scales up and gains a glow ring colored by the card's price tier (§3).
 * Under reduced motion the glow is shown statically with no scale/pulse.
 *
 * Centering is FIGURE-based, not image-based: showdown gifs (and custom uploads)
 * sit off-centre inside a padded/transparent canvas, so we measure the opaque
 * bounding box and translate the *figure's* centre to the cell centre, scaled to
 * a consistent size. Every cell then shows the actual Pokémon centred + same
 * size regardless of the source sprite's padding. If a sprite isn't readable
 * (cross-origin custom host with no CORS), it falls back to box-contain centring.
 */
export function PokemonToken({
  dex,
  name,
  tier,
  size = 96,
  landed = false,
  reduced = false,
  eager = false,
  imageSrc,
  filter,
}: PokemonTokenProps) {
  const [src, setSrc] = useState(imageSrc ?? spriteGif(dex));
  // Re-sync if a recycled cell receives a new dex or image override.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- v7 false positive: deriving src from props for recycled cells (same pattern as SlotReelColumn)
    setSrc(imageSrc ?? spriteGif(dex));
  }, [dex, imageSrc]);
  const rgb = TIER_COLOR[tier];
  const figure = useFigureBox(src);

  // Figure-centred transform (preferred) vs box-contain fallback. The fallback
  // uses a FIXED 80% square box (not max-only) so a small custom sprite scales
  // UP to the same footprint as everything else, not just large ones down.
  // pixelated (not auto): pixel Pokémon stay crisp when upscaled (desktop + the
  // #39 center bulge) instead of bilinear-blurring into mush (spec #40).
  let imgClassName =
    'h-[80%] w-[80%] object-contain object-center [image-rendering:pixelated]';
  let imgStyle: CSSProperties = {};
  if (figure) {
    const bw = figure.maxX - figure.minX + 1;
    const bh = figure.maxY - figure.minY + 1;
    const scale = (FIGURE_FILL * size) / Math.max(bw, bh);
    const half = size / 2;
    imgClassName =
      'absolute left-0 top-0 max-w-none [image-rendering:pixelated]';
    imgStyle = {
      width: `${figure.w}px`,
      height: `${figure.h}px`,
      transformOrigin: '0 0',
      // Map the figure's CENTRE OF MASS (figure.cx/cy) onto the cell centre, and
      // scale the opaque bbox to ~FIGURE_FILL of the cell. Mass-centring keeps the
      // body centred (a tail/limb barely moves the centroid) while the bbox scale
      // guarantees every sprite is the same size.
      transform: `translate(${half - scale * figure.cx}px, ${half - scale * figure.cy}px) scale(${scale})`,
    };
  }

  return (
    <div
      className={cn(
        'relative flex h-[var(--token-size)] w-[var(--token-size)] items-center justify-center rounded-2xl',
        !reduced && 'transition-transform duration-300 ease-out',
        landed && !reduced && 'scale-110',
      )}
      style={
        {
          '--token-size': `${size}px`,
          boxShadow: landed
            ? `0 0 18px 4px rgba(${rgb}, 0.85), 0 0 42px 10px rgba(${rgb}, 0.45)`
            : 'none',
        } as CSSProperties
      }
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={name}
        loading={eager ? 'eager' : 'lazy'}
        onError={() => {
          if (imageSrc) return; // no sprite fallback for a direct image override
          setSrc((s) => (s === spritePng(dex) ? s : spritePng(dex)));
        }}
        className={imgClassName}
        style={filter ? { ...imgStyle, filter } : imgStyle}
      />
    </div>
  );
}
