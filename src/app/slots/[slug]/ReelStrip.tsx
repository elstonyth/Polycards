// src/app/slots/[slug]/ReelStrip.tsx
'use client';

// Flat HORIZONTAL reel strip (spec Spec-1): cells stream RIGHT→LEFT through a
// central winning line, the winner arriving from the right. rAF-driven, reusing
// the tuned physics (spinOffset/blur/timing) unchanged; the right→left travel is
// reelPaintX's reflection of the vertical easing. No 3D barrel. Same settle
// contract as the old VaultReelColumn: reports the landed cell rect and calls
// onSettled once, after this strip stops.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Rarity } from '@/lib/packs-data';
import { ITEM_W, reelTarget, reelPaintX } from '@/lib/reel';
import {
  spinOffset,
  columnDurationMs,
  blurStretch,
  CARD_ASPECT,
} from '@/lib/vault-reel';
import {
  buildHReelStrip,
  HREEL_WIN_INDEX,
  HREEL_STRIP_LEN,
  HREEL_VISIBLE_CELLS,
} from '@/lib/hreel';
import { rarityRgb } from '@/lib/rarity';
import { spriteGif } from '@/lib/mock/pokedex';
import { CardTile } from './CardTile';

const EAGER_RADIUS = 3;
const CELL_GAP = 10;

export function ReelStrip({
  winnerDex,
  winnerImage,
  winnerName,
  winnerRarity,
  winnerRarityRgb,
  reduced,
  colIndex,
  count,
  cellSize = 96,
  onSettled,
  onWinnerRect,
  hideWinner = false,
}: {
  winnerDex: number | null;
  winnerImage?: string;
  winnerName?: string;
  winnerRarity: Rarity;
  winnerRarityRgb: string;
  reduced: boolean;
  colIndex: number;
  count: number;
  cellSize?: number;
  onSettled?: () => void;
  onWinnerRect?: (rect: DOMRect) => void;
  hideWinner?: boolean;
}) {
  const windowRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [done, setDone] = useState(false);
  const settled = useRef(false);
  const onSettledRef = useRef(onSettled);
  const onWinnerRectRef = useRef(onWinnerRect);
  useEffect(() => {
    onSettledRef.current = onSettled;
    onWinnerRectRef.current = onWinnerRect;
  });

  const cellW = Math.round(cellSize * CARD_ASPECT);
  const pitch = cellW + CELL_GAP; // per-cell horizontal stride
  const winW = pitch * HREEL_VISIBLE_CELLS;

  const isWin = winnerDex !== null || winnerImage !== undefined;
  const strip = useMemo(
    () =>
      buildHReelStrip(
        winnerDex,
        winnerRarity,
        HREEL_STRIP_LEN,
        HREEL_WIN_INDEX,
      ),
    [winnerDex, winnerRarity],
  );

  const reportWinnerRect = () => {
    const rect = cellRefs.current[HREEL_WIN_INDEX]?.getBoundingClientRect();
    if (rect) onWinnerRectRef.current?.(rect);
  };

  // Warm the winner image cache during the spin.
  useEffect(() => {
    if (!isWin) return;
    const img = new Image();
    img.src = winnerImage ?? spriteGif(winnerDex ?? 1);
  }, [isWin, winnerImage, winnerDex]);

  useEffect(() => {
    settled.current = false;
    setDone(false);
    const stripEl = stripRef.current;
    if (!stripEl) return;
    const target = Math.round(reelTarget(HREEL_WIN_INDEX, pitch, winW));

    const paint = (offset: number, velocity: number) => {
      const px = reelPaintX(offset, target);
      stripEl.style.transform = `translate3d(${-px}px, 0, 0)`;
      // One real motion blur on the whole moving strip — NO per-cell transforms
      // (the old vertical column warned 48 cells × N per frame cooked phone GPUs;
      // the strip-level filter reads as horizontal blur on its own).
      const { blurPx } = blurStretch(velocity);
      stripEl.style.filter =
        blurPx > 0.05 ? `blur(${blurPx.toFixed(2)}px)` : '';
    };

    // Idle: rest centered, sharp.
    if (!isWin) {
      paint(target, 0);
      return;
    }
    if (reduced) {
      paint(target, 0);
      const id = setTimeout(() => {
        if (!settled.current) {
          settled.current = true;
          setDone(true);
          reportWinnerRect();
          onSettledRef.current?.();
        }
      }, 0);
      return () => clearTimeout(id);
    }
    const dur = columnDurationMs(colIndex, count);
    const start = performance.now();
    let prevOffset = spinOffset(0, target, colIndex, count, pitch);
    let prevT = start;
    let raf = 0;
    const frame = (now: number) => {
      const t = now - start;
      const offset = spinOffset(t, target, colIndex, count, pitch);
      const dt = Math.max(1, now - prevT);
      paint(offset, (offset - prevOffset) / dt);
      prevOffset = offset;
      prevT = now;
      if (t >= dur) {
        paint(target, 0);
        if (!settled.current) {
          settled.current = true;
          setDone(true);
          reportWinnerRect();
          onSettledRef.current?.();
        }
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pitch/winW derive from cellSize; re-running on spin identity is intended
  }, [isWin, reduced, colIndex, count, winnerDex, winnerRarity, cellSize]);

  return (
    <div
      ref={windowRef}
      className="relative overflow-hidden rounded-2xl border border-white/10 bg-neutral-950/80 shadow-[inset_0_0_30px_rgba(0,0,0,0.8)]"
      style={{ width: `${winW}px`, height: `${cellSize + 16}px` }}
      aria-hidden
    >
      {/* rim shading at the left/right edges (drum tunnels, flat version) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-10 rounded-2xl"
        style={{
          background:
            'linear-gradient(90deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.25) 10%, rgba(0,0,0,0) 26%, rgba(0,0,0,0) 74%, rgba(0,0,0,0.25) 90%, rgba(0,0,0,0.85) 100%)',
        }}
      />
      <div
        ref={stripRef}
        className="flex h-full flex-row items-center will-change-transform"
        style={{ gap: `${CELL_GAP}px` }}
      >
        {strip.map((cell, i) => {
          const isWinnerCell = i === HREEL_WIN_INDEX;
          const litColor = done
            ? isWinnerCell
              ? winnerRarityRgb
              : undefined
            : rarityRgb(cell.rarity);
          return (
            <div
              key={i}
              ref={(el) => {
                cellRefs.current[i] = el;
              }}
              className="flex shrink-0 items-center justify-center"
              style={{
                width: `${cellW}px`,
                visibility: hideWinner && isWinnerCell ? 'hidden' : undefined,
              }}
            >
              <CardTile
                dex={cell.dex}
                name={isWinnerCell ? (winnerName ?? '') : ''}
                size={cellSize}
                eager={Math.abs(i - HREEL_WIN_INDEX) <= EAGER_RADIUS}
                imageSrc={isWinnerCell ? winnerImage : undefined}
                glowRgb={litColor}
                lit={done ? isWinnerCell : true}
                landed={done && isWinnerCell}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
