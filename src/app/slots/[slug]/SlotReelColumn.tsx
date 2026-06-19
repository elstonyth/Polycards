// src/app/slots/[slug]/SlotReelColumn.tsx
'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { cn } from '@/lib/utils';
import {
  reelTargetY,
  buildDexStrip,
  ITEM_H,
  STRIP_LEN,
  WIN_INDEX,
  REEL_EASE,
} from '@/lib/reel';
import { spriteGif } from '@/lib/mock/pokedex';
import type { Tier } from '@/lib/price-tier';
import { PokemonToken } from './PokemonToken';

/** Window shows 5 cells; cells within this radius of WIN_INDEX eager-load. */
const VISIBLE_CELLS = 5;
const EAGER_RADIUS = 3;

/**
 * A vertical reel column that DISPLAYS a pre-decided winner (it never picks one,
 * spec §8). Idle and reduced motion land centered instantly; otherwise it
 * scrolls ↓ once on mount — remount (new key) to re-spin. The winner cell shows
 * the won Pokémon sprite, or `winnerImage` (card art) when the card has no
 * resolvable Pokémon (§2/G5). Win grow+glow only after settle.
 */
export function SlotReelColumn({
  winnerDex,
  winnerImage,
  winnerName,
  tier,
  reduced,
  durationMs,
  cellSize = 96,
  onSettled,
}: {
  winnerDex: number | null;
  winnerImage?: string;
  winnerName?: string;
  tier: Tier;
  reduced: boolean;
  durationMs: number;
  cellSize?: number;
  onSettled?: () => void;
}) {
  const windowRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const settled = useRef(false);

  // Keep the latest onSettled in a ref so it isn't an effect dependency — an
  // inline-arrow parent gets a new reference each render, and depending on it
  // would reset/restart the spin mid-scroll. Re-spin happens via remount (key).
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onSettledRef.current = onSettled;
  });

  const isWin = winnerDex !== null || winnerImage !== undefined;

  const strip = useMemo(
    () => buildDexStrip(winnerDex ?? 1, STRIP_LEN, WIN_INDEX),
    [winnerDex],
  );

  // Warm the landed image/sprite cache the moment a spin starts (≥ BASE_SPIN_MS
  // of scroll = ample fetch time) so the winner cell paints on settle.
  useEffect(() => {
    if (!isWin) return;
    const img = new Image();
    img.src = winnerImage ?? spriteGif(winnerDex ?? 1);
  }, [isWin, winnerImage, winnerDex]);

  useEffect(() => {
    settled.current = false;
    const winH = windowRef.current?.clientHeight ?? ITEM_H * VISIBLE_CELLS;
    const target = Math.round(reelTargetY(WIN_INDEX, ITEM_H, winH));

    // Idle: rest centered, no scroll, no settle callback.
    if (!isWin) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSpinning(false);
      setOffset(-target);
      return;
    }
    // Reduced motion: jump centered, fire settle next tick.
    if (reduced) {
      setSpinning(false);
      setOffset(-target);
      const id = setTimeout(() => {
        if (!settled.current) {
          settled.current = true;
          onSettledRef.current?.();
        }
      }, 0);
      return () => clearTimeout(id);
    }
    // Real spin: origin → centered winner, settle on transition end. Two nested
    // frames so the transition starts from the origin; cancel BOTH on teardown.
    setOffset(0);
    setSpinning(true);
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setOffset(-target));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [isWin, reduced]);

  return (
    <div
      ref={windowRef}
      className="relative overflow-hidden rounded-2xl border border-white/10 bg-neutral-950"
      style={{
        height: `${ITEM_H * VISIBLE_CELLS}px`,
        width: `${cellSize + 24}px`,
      }}
      aria-hidden
    >
      <div
        className={cn(
          'flex flex-col items-center [transform:translateY(var(--reel-y))]',
          spinning && '[transition:transform_var(--reel-dur)_var(--reel-ease)]',
        )}
        style={
          {
            '--reel-y': `${offset}px`,
            '--reel-dur': spinning ? `${durationMs}ms` : '0ms',
            '--reel-ease': REEL_EASE,
          } as CSSProperties
        }
        onTransitionEnd={() => {
          if (spinning && !settled.current) {
            settled.current = true;
            setSpinning(false);
            onSettledRef.current?.();
          }
        }}
      >
        {strip.map((dex, i) => {
          const isWinnerCell = i === WIN_INDEX;
          const landed = isWinnerCell && !spinning && isWin;
          return (
            <div
              key={i}
              className="flex shrink-0 items-center justify-center"
              style={{ height: `${ITEM_H}px` }}
            >
              <PokemonToken
                dex={dex}
                name={isWinnerCell ? (winnerName ?? '') : ''}
                tier={tier}
                size={cellSize}
                landed={landed}
                reduced={reduced}
                eager={Math.abs(i - WIN_INDEX) <= EAGER_RADIUS}
                imageSrc={isWinnerCell ? winnerImage : undefined}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
