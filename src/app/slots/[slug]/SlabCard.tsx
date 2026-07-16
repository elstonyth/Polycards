// src/app/slots/[slug]/SlabCard.tsx
'use client';

// The prize as a REAL graded slab (spec decisions #6-7): back = plastic case
// seen from behind with a rainbow-holo Polycards monogram; front = the actual
// slab photo (card.image). Flip = "The Whip": lift → fast rotateY with a glare
// sweep → settle; top rarities get a pre-flip hover + shimmer after.
// Entrance (spec #16): SHAPE-SYNCED MORPH — the card animates from the landed
// reel tile's rect (same aspect ratio) to its on-stage box, reading as one
// object growing; the tile's pixel sprite rides along and fades mid-growth.
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { motion } from 'motion/react';
import type { WonCard } from '@/lib/actions/packs';
import { rm } from '@/lib/format';
import { isTopRarity } from '@/lib/rarity';
import { SlabImage, SLAB_ASPECT } from '@/components/SlabImage';
import { cn } from '@/lib/utils';

export function SlabCard({
  card,
  rarityRgb,
  flipped,
  onFlip,
  reduced,
  entering,
  enterDelayMs = 0,
  fromRect = null,
  spriteSrc,
}: {
  card: WonCard;
  rarityRgb: string;
  flipped: boolean;
  onFlip?: () => void;
  reduced: boolean;
  entering: boolean;
  enterDelayMs?: number;
  fromRect?: DOMRect | null;
  spriteSrc?: string;
}) {
  const top = isTopRarity(card.rarity);
  const value =
    card.marketPriceMyr != null ? rm(card.marketPriceMyr) : card.value;

  // Shape-synced morph (spec #16): delta from the landed tile's rect to this
  // card's natural box. Computed in a layout effect (before paint) so the
  // first painted frame already sits at the tile's position; until then the
  // card is hidden to avoid a one-frame flash at the destination. No rect /
  // reduced motion → plain fade fallback.
  const boxRef = useRef<HTMLDivElement>(null);
  const [delta, setDelta] = useState<{
    x: number;
    y: number;
    s: number;
  } | null>(null);
  const wantsMorph = entering && !reduced && fromRect !== null;
  useLayoutEffect(() => {
    if (!wantsMorph || !fromRect) return;
    const to = boxRef.current?.getBoundingClientRect();
    if (!to || to.width === 0) return;
    // One-time pre-paint layout measurement (not a sync-with-external-store
    // loop) — this IS the useLayoutEffect measure-then-setState pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDelta({
      x: fromRect.left + fromRect.width / 2 - (to.left + to.width / 2),
      y: fromRect.top + fromRect.height / 2 - (to.top + to.height / 2),
      s: fromRect.width / to.width,
    });
  }, [wantsMorph, fromRect]);

  return (
    <motion.div
      ref={boxRef}
      initial={wantsMorph ? false : { opacity: 0 }}
      animate={
        delta
          ? {
              opacity: 1,
              x: [delta.x, 0],
              y: [delta.y, 0],
              scale: [delta.s, 1],
            }
          : { opacity: 1, x: 0, y: 0, scale: 1 }
      }
      transition={{
        duration: reduced ? 0.2 : 0.6,
        delay: enterDelayMs / 1000,
        ease: [0.16, 1, 0.3, 1],
      }}
      style={{ visibility: wantsMorph && !delta ? 'hidden' : undefined }}
      className="flex w-full flex-col items-center gap-3"
    >
      <motion.button
        type="button"
        onClick={flipped ? undefined : onFlip} // flip is one-way; guard mid-flight re-taps
        disabled={!onFlip || flipped}
        aria-label={flipped ? card.name : 'Flip to reveal your card'}
        className="relative block [transform-style:preserve-3d]"
        style={
          {
            // Card width is owned by RevealStage (--slab-w: width- AND
            // height-aware so the reveal always fits the stage) and shared
            // with GalleryRail's item step. Fallback covers any future
            // standalone mount.
            width: 'var(--slab-w, min(64vw, 300px))',
            // Slab proportions since the frame overlay shipped: the reel tile
            // is still CARD_ASPECT, so the shape-synced morph (spec #16) is a
            // uniform-scale grow with a slight height drift — invisible at
            // 0.6s; the flip reveal (the stare moment) stays exact.
            aspectRatio: String(SLAB_ASPECT),
            perspective: '1200px',
          } as CSSProperties
        }
        animate={
          reduced
            ? undefined
            : flipped
              ? { rotateY: 180 }
              : {
                  rotateY: 0,
                  y: [0, -4, 0],
                  transition: {
                    y: { duration: 4, repeat: Infinity, ease: 'easeInOut' },
                  },
                }
        }
        transition={{
          rotateY: {
            duration: 0.38,
            delay: top && flipped && !reduced ? 0.5 : 0.12, // top-tier knowing hover
            ease: [0.45, 0, 0.2, 1],
          },
        }}
      >
        {/* BACK — the Polycards holo-foil card back (supersedes #34's etched
            line art; asset: docs/research/polycards-card-back-v2.png cropped).
            Opaque raster, so rarity color rides on the outer glow only. */}
        <span
          className={cn(
            'absolute inset-0 overflow-hidden rounded-xl [backface-visibility:hidden]',
            reduced && flipped && 'hidden',
          )}
          style={
            {
              boxShadow: '0 18px 50px rgba(0,0,0,0.6)',
            } as CSSProperties
          }
        >
          <img
            src="/images/app/polycards-card-back.webp"
            alt=""
            aria-hidden
            className="absolute inset-0 h-full w-full object-fill transition-[filter] duration-300"
            style={
              {
                filter: `drop-shadow(0 0 8px rgba(${rarityRgb}, 0.65)) drop-shadow(0 0 24px rgba(${rarityRgb}, 0.35))`,
              } as CSSProperties
            }
          />
          {/* the tile's pixel Pokémon rides the morph, fading out mid-growth */}
          {spriteSrc && entering && !reduced && (
            <motion.img
              src={spriteSrc}
              alt=""
              aria-hidden
              initial={{ opacity: 1 }}
              animate={{ opacity: 0 }}
              transition={{ duration: 0.3, delay: enterDelayMs / 1000 + 0.25 }}
              className="absolute inset-0 m-auto h-1/2 w-1/2 object-contain [image-rendering:pixelated]"
            />
          )}
        </span>
        {/* FRONT — the pull as a graded slab: raw card photo inside the
            admin-configurable case overlay. drop-shadow (not box-shadow)
            follows the slab's alpha silhouette instead of drawing a rectangle
            behind the transparent frame margins. */}
        <span
          className={cn(
            'absolute inset-0 [backface-visibility:hidden] [transform:rotateY(180deg)]',
            reduced && !flipped && 'hidden',
          )}
          style={
            {
              filter: `drop-shadow(0 18px 30px rgba(0,0,0,0.6)) drop-shadow(0 0 26px rgba(${rarityRgb}, 0.35))`,
            } as CSSProperties
          }
        >
          <SlabImage
            src={card.image}
            slabSrc={card.slab_image}
            alt={card.name}
            sizes="(max-width: 640px) 64vw, 300px"
            className="absolute inset-0"
          />
          {/* Glare sweep removed (decision #24): it parked at x:110% off the
              card's right edge and read as a weird persistent "glass" streak. */}
        </span>
      </motion.button>
      {/* info stamp — appears after the flip. Its space is ALWAYS reserved
          (fixed min-height) so stamping in the name + ribbon never pushes the
          card up (spec decision #23 — the card stays put on flip). Opacity/fade
          only; no y-translate that would move the card's center. */}
      <div className="flex min-h-[3.25rem] flex-col items-center justify-start gap-1 text-center">
        {flipped && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2, delay: reduced ? 0 : 0.45 }}
            className="flex flex-col items-center gap-1"
          >
            <p className="max-w-[64vw] truncate text-base font-bold text-white sm:max-w-[300px]">
              {card.name}
            </p>
            <p
              className="rounded-full px-3 py-0.5 text-[12px] font-bold uppercase tracking-wide"
              style={{
                color: `rgb(${rarityRgb})`,
                backgroundColor: `rgba(${rarityRgb}, 0.12)`,
              }}
            >
              {card.rarity} · {value}
            </p>
          </motion.div>
        )}
      </div>
    </motion.div>
  );
}
