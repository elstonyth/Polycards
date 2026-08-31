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
import {
  SlabImage,
  SLAB_ASPECT,
  FRAME_BAND,
  isGraded,
  slabAmbient,
} from '@/components/SlabImage';
import { cn } from '@/lib/utils';
import { useCardTilt } from '@/lib/use-card-tilt';

/** The card back raster. Exported so the machine can warm it during the spin —
 *  it is the FIRST thing the reveal shows, and mounting this component was also
 *  the first thing that requested it (a fetch + decode landing right on the
 *  transform beat, which stuttered the morph and popped the art in late). */
export const CARD_BACK_SRC = '/images/app/polycards-slab-back.webp';

/** RAW back: bare 5:7 card stock, no acrylic case. An ungraded pull is not in a
 *  slab, so it must not flip out of one — the case-back raster above would be
 *  the only slab on screen for a RAW pack. Rendered THROUGH SlabImage (same
 *  component the front uses) rather than by hand, so both faces resolve to the
 *  identical card rect and the flip has no size jump. NOT exported: it goes out
 *  through next/image, so the machine's plain-path preload can't warm it (the
 *  `priority` prop on that SlabImage is what preloads it). */
const RAW_CARD_BACK_SRC = '/images/app/polycards-card-back.webp';

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
  // Literally the predicate the FRONT branches on — SlabImage exports it, so
  // the back can never end up on the other side of that decision (why it is
  // not `pack.group === 'RAW'` is documented there).
  const raw = !isGraded(card.slab_image);

  // The slab turns under the pointer and catches a highlight as it turns, so
  // the hold before the flip is something to handle rather than sit through.
  const tilt = useCardTilt(!reduced && !flipped);

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
      // The perspective here projects the button's TILT; the button's own
      // perspective (same viewing distance) only reaches its faces, never its
      // own rotation.
      className="flex w-full flex-col items-center gap-3 perspective-[1200px]"
    >
      <motion.button
        ref={tilt}
        // Tilt rides OUTSIDE motion's generated transform, so the flip, the
        // idle float and the morph all keep animating untouched.
        transformTemplate={(_, generated) =>
          `rotateX(var(--tilt-x, 0deg)) rotateY(var(--tilt-y, 0deg)) ${generated}`
        }
        type="button"
        onClick={flipped ? undefined : onFlip} // flip is one-way; guard mid-flight re-taps
        disabled={!onFlip || flipped}
        aria-label={flipped ? card.name : 'Flip to reveal your card'}
        className={cn(
          'relative block [transform-style:preserve-3d]',
          // Images are draggable by default: a mouse press on the card art
          // starts a native HTML5 drag, which cancels the pointer stream and
          // strands the card mid-turn. Letting the button own every pointer
          // inside it kills that at the source.
          '[&_img]:pointer-events-none select-none',
          // Face-down, a finger dragging ACROSS the card turns it instead of
          // scrolling the page — the card is the thing you are handling.
          // Scoped to the card itself (the rest of the stage still scrolls)
          // and dropped on flip, when there is nothing left to turn.
          !reduced && !flipped && 'touch-none',
        )}
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
        {/* BACK — GRADED: the Polycards slab seen from behind (acrylic case,
            branded label + QR, matte black card with the flat white monogram
            inside; asset baked to SLAB_ASPECT from the SnapGen render). Opaque
            raster, so rarity color rides on the outer glow only.
            RAW: the bare card back, drawn by SlabImage so it lands on the exact
            rect the front's card art occupies — same size through the flip, and
            no acrylic case around a card that was never in one. */}
        <span
          aria-hidden
          className={cn(
            'absolute inset-0 [backface-visibility:hidden]',
            reduced && flipped && 'hidden',
          )}
          style={
            raw
              ? // Raw has no opaque case to cast a box-shadow, so depth comes
                // from the same alpha-following drop-shadow the front uses.
                ({
                  filter: `drop-shadow(0 18px 30px rgba(0,0,0,0.6))`,
                } as CSSProperties)
              : undefined
          }
        >
          {raw ? (
            <SlabImage
              src={RAW_CARD_BACK_SRC}
              slabSrc={null}
              rarity={card.rarity}
              alt=""
              sizes="(max-width: 640px) 64vw, 300px"
              className="absolute inset-0"
              priority
            />
          ) : (
            // NOT inset-0: the FRONT draws the case at FRAME_BAND% (SlabImage's
            // own slab inset), so a full-box case back flipped ~11% smaller.
            // Same inset here = the case overlays itself exactly through the
            // flip, and the box stays 0.9W x 0.9H — SLAB_ASPECT preserved, so
            // the object-fill raster below lands undistorted. The tier band
            // (which sits OUTSIDE this box) growing in on flip is the reveal.
            <span
              className="absolute overflow-hidden rounded-xl"
              style={
                {
                  inset: `${FRAME_BAND}%`,
                  boxShadow: '0 18px 50px rgba(0,0,0,0.6)',
                } as CSSProperties
              }
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- decorative
                  fixed local asset (one shared card back, already webp) layered
                  inside the flip/morph surface; next/image adds a wrapper + loader
                  to a purely presentational fill with no LCP or bandwidth win. */}
              <img
                src={CARD_BACK_SRC}
                alt=""
                className="absolute inset-0 h-full w-full object-fill transition-[filter] duration-300"
                style={
                  {
                    filter: `drop-shadow(0 0 8px rgba(${rarityRgb}, 0.65)) drop-shadow(0 0 24px rgba(${rarityRgb}, 0.35))`,
                  } as CSSProperties
                }
              />
            </span>
          )}
          {/* Specular highlight — a real acrylic slab catches the light where
              you are looking at it, so the hotspot tracks the pointer and dies
              when the pointer leaves (useCardTilt owns the CSS vars). inset-0
              covers case AND card: the whole object is glossy, not just the
              art inside it. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-xl mix-blend-screen"
            style={
              {
                opacity: 'var(--glare-o, 0)',
                background:
                  'radial-gradient(120% 90% at var(--glare-x, 50%) var(--glare-y, 50%), rgba(255,255,255,0.34), rgba(255,255,255,0.09) 38%, rgba(255,255,255,0) 62%)',
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
            admin-configurable case overlay. The ambient bloom is SlabImage's
            `reveal` tuning: a drop-shadow (not box-shadow) that follows the
            slab's alpha silhouette instead of drawing a rectangle behind the
            transparent frame margins. It sits OUTSIDE the component's own halo
            on purpose — at this size the halo alone does not carry the depth,
            and the two are tuned together in SlabImage rather than here. */}
        <span
          className={cn(
            'absolute inset-0 [backface-visibility:hidden] [transform:rotateY(180deg)]',
            reduced && !flipped && 'hidden',
          )}
          style={{ filter: slabAmbient('reveal', rarityRgb) } as CSSProperties}
        >
          <SlabImage
            src={card.image}
            slabSrc={card.slab_image}
            rarity={card.rarity}
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
