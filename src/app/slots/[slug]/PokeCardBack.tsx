// src/app/slots/[slug]/PokeCardBack.tsx
'use client';

// The etched card-back line art (spec decision #34): rounded card frame,
// arched "POKÉMON" wordmark top + mirrored bottom, line-art Poké Ball center.
// Fill is fully TRANSPARENT — on the reel the winning sprite must stay clearly
// visible through it. One component serves both surfaces: the reel landing
// zone (small, neutral → rarity on settle) and the reveal card back (large).
// `rgb = null` renders the neutral silver etch; a rarity rgb string colors the
// etch and blooms an outer glow. Colors snap; only the glow filter transitions.
import { useId, type CSSProperties } from 'react';
import { cn } from '@/lib/utils';

export function PokeCardBack({
  rgb,
  className,
}: {
  /** Rarity color "r, g, b" — null = neutral (pre-settle / idle). */
  rgb: string | null;
  className?: string;
}) {
  // Several instances mount at once (one per reel + the reveal card) — the
  // textPath arc id must be unique per mount or hrefs resolve cross-SVG.
  const arcId = `pcb-arc-${useId().replace(/:/g, '')}`;
  const etch = rgb ? `rgba(${rgb}, 0.95)` : 'rgba(255, 255, 255, 0.38)';
  const etchSoft = rgb ? `rgba(${rgb}, 0.45)` : 'rgba(255, 255, 255, 0.16)';
  return (
    <svg
      viewBox="0 0 300 420"
      preserveAspectRatio="none"
      aria-hidden
      className={cn(
        'h-full w-full transition-[filter] duration-300',
        className,
      )}
      style={
        {
          filter: rgb
            ? `drop-shadow(0 0 8px rgba(${rgb}, 0.65)) drop-shadow(0 0 24px rgba(${rgb}, 0.35))`
            : undefined,
        } as CSSProperties
      }
    >
      {/* card frame: outer bright line + inner soft line */}
      <rect
        x="6"
        y="6"
        width="288"
        height="408"
        rx="26"
        fill="none"
        stroke={etch}
        strokeWidth="4"
      />
      <rect
        x="16"
        y="16"
        width="268"
        height="388"
        rx="19"
        fill="none"
        stroke={etchSoft}
        strokeWidth="2"
      />
      {/* arched wordmarks (top + mirrored bottom) */}
      <path id={arcId} d="M 42 92 Q 150 56 258 92" fill="none" />
      <text
        fill={etch}
        fontSize="34"
        fontWeight="900"
        letterSpacing="3"
        fontFamily="var(--font-nekst), sans-serif"
      >
        <textPath href={`#${arcId}`} startOffset="50%" textAnchor="middle">
          POKÉMON
        </textPath>
      </text>
      <g transform="rotate(180 150 210)">
        <text
          fill={etch}
          fontSize="34"
          fontWeight="900"
          letterSpacing="3"
          fontFamily="var(--font-nekst), sans-serif"
        >
          <textPath href={`#${arcId}`} startOffset="50%" textAnchor="middle">
            POKÉMON
          </textPath>
        </text>
      </g>
      {/* Poké Ball — the landing target. r 128 (was 122) so the bulged center
          sprite (#39, ~0.96 · cell) still frames inside the ring. */}
      <circle
        cx="150"
        cy="210"
        r="128"
        fill="none"
        stroke={etch}
        strokeWidth="4"
      />
      {/* band, drawn only OUTSIDE the center ring so it never crosses the
          landed sprite's face */}
      <line x1="22" y1="210" x2="112" y2="210" stroke={etch} strokeWidth="4" />
      <line x1="188" y1="210" x2="278" y2="210" stroke={etch} strokeWidth="4" />
      {/* center button: double ring */}
      <circle
        cx="150"
        cy="210"
        r="38"
        fill="none"
        stroke={etch}
        strokeWidth="4"
      />
      <circle
        cx="150"
        cy="210"
        r="22"
        fill="none"
        stroke={etchSoft}
        strokeWidth="2.5"
      />
    </svg>
  );
}
