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
import { reelTarget, reelPaintX } from '@/lib/reel';
import {
  spinOffset,
  columnDurationMs,
  blurStretch,
  CARD_ASPECT,
} from '@/lib/vault-reel';
import {
  buildHReelStrip,
  DECOY_DEXES,
  HREEL_WIN_INDEX,
  HREEL_STRIP_LEN,
  HREEL_VISIBLE_CELLS,
  type HReelCell,
} from '@/lib/hreel';
import { rarityRgb } from '@/lib/rarity';
import { spriteGif } from '@/lib/mock/pokedex';
import { CardTile } from './CardTile';

const EAGER_RADIUS = 3;
const CELL_GAP = 10;
/** Idle creep speed (px/ms) — ~20px/s, roughly one cell every 4s. Slow enough to
 *  read every Pokémon, fast enough that the machine never looks dead. Below
 *  blurStretch's 0.05px threshold, so the idle strip stays sharp. */
const IDLE_DRIFT_PX_PER_MS = 0.02;
/** Cell the idle drift starts centered on. Must clear the left half-window
 *  (HREEL_VISIBLE_CELLS/2), and leaves the rest of the strip as drift runway. */
const IDLE_BASE_INDEX = 5;

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
  decoyCards,
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
  /** The pack's own cards (dex + configured rarity, paired) the decoy cells
   *  flicker — so the reel shows only the pack's Pokémon in only the pack's
   *  rarity colors. Empty/omitted → curated fallback. */
  decoyCards?: readonly HReelCell[];
  onSettled?: () => void;
  onWinnerRect?: (rect: DOMRect) => void;
  hideWinner?: boolean;
}) {
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
  // Cells repeat every `poolLen` — mirrors buildHReelStrip's pool fallback.
  const poolLen =
    decoyCards && decoyCards.length > 0
      ? decoyCards.length
      : DECOY_DEXES.length;
  const strip = useMemo(
    () =>
      buildHReelStrip(
        winnerDex,
        winnerRarity,
        HREEL_STRIP_LEN,
        HREEL_WIN_INDEX,
        colIndex, // per-strip decoy seed → stacked strips look independent
        decoyCards, // pack's own cards {dex, rarity} (empty → curated fallback)
      ),
    [winnerDex, winnerRarity, colIndex, decoyCards],
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
    // reelTarget centers the pitch-midpoint; cells render at their cell-center,
    // and the flex `gap: CELL_GAP` offsets those by CELL_GAP/2. Subtract it so the
    // winner cell's center lands exactly on the winning line (window center).
    const target = Math.round(
      reelTarget(HREEL_WIN_INDEX, pitch, winW) - CELL_GAP / 2,
    );

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

    // Idle: creep right→left forever (same travel direction as a spin) so the
    // machine never looks dead. buildHReelStrip leaves the idle strip a PURE
    // tiling of the decoy pool, so it repeats every `poolLen` cells and wrapping
    // the drift at exactly `poolLen * pitch` px is seamless. Rest sharp instead
    // when motion is reduced, or when one whole period + the visible window
    // wouldn't fit on the strip (the drift would run off its end).
    if (!isWin) {
      const basePx = Math.round(
        reelTarget(IDLE_BASE_INDEX, pitch, winW) - CELL_GAP / 2,
      );
      stripEl.style.filter = '';
      if (
        reduced ||
        IDLE_BASE_INDEX + HREEL_VISIBLE_CELLS + poolLen > HREEL_STRIP_LEN
      ) {
        stripEl.style.transform = `translate3d(${-basePx}px, 0, 0)`;
        return;
      }
      const wrapPx = poolLen * pitch;
      let px = basePx;
      let prev = performance.now();
      let raf = 0;
      const drift = (now: number) => {
        // Clamp dt so a backgrounded tab (rAF pauses) resumes where it left off
        // instead of teleporting a minute's worth of travel on the next frame.
        px += Math.min(50, now - prev) * IDLE_DRIFT_PX_PER_MS;
        prev = now;
        if (px - basePx >= wrapPx) px -= wrapPx;
        stripEl.style.transform = `translate3d(${-px}px, 0, 0)`;
        raf = requestAnimationFrame(drift);
      };
      raf = requestAnimationFrame(drift);
      return () => cancelAnimationFrame(raf);
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
  }, [
    isWin,
    reduced,
    colIndex,
    count,
    winnerDex,
    winnerRarity,
    cellSize,
    poolLen,
  ]);

  return (
    <div
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
          // WYSIWYG (what you see is what you get): the winner cell shows the
          // reward's TRUE tier color the WHOLE time — it never flickers a decoy
          // tier and then "changes" hue on stop. The color that lands on the
          // line IS the reward (orange ⟹ Immortal, gray ⟹ Common), matching the
          // reveal; it only intensifies (bloom + scale) when it locks. Decoys
          // flicker their own tier while spinning, then fade neutral on settle.
          // Idle has no winner, so the winner CELL must not wear the winner's
          // color either — it would be the one off-pattern tile on an otherwise
          // periodic strip, i.e. a seam the moment the idle drift reaches it.
          const litColor =
            isWinnerCell && isWin
              ? winnerRarityRgb
              : done
                ? undefined
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
