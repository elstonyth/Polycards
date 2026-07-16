// src/app/slots/[slug]/ReelStrip.tsx
'use client';

// Flat HORIZONTAL reel strip (spec Spec-1): cells stream RIGHT→LEFT through a
// central winning line, the winner arriving from the right. rAF-driven, one
// CONTINUOUS position timeline: the idle drift and the spin share `pxRef`, so
// pressing spin ACCELERATES the strip from wherever it is drifting — never a
// teleport to a fresh offset. The spin's runway cells are randomized per spin
// (buildPressStrip) while everything visible at press time is preserved, and
// the winner index is picked dynamically so the tuned landing physics
// (pressSpinOffset — same phases/durations as the old spinOffset) always fits.
// Same settle contract as before: reports the landed cell rect and calls
// onSettled once, after this strip stops.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Rarity } from '@/lib/packs-data';
import { reelTarget } from '@/lib/reel';
import {
  pressSpinOffset,
  pressTravelPx,
  columnDurationMs,
  blurStretch,
  CARD_ASPECT,
} from '@/lib/vault-reel';
import {
  buildHReelStrip,
  buildPressStrip,
  DECOY_DEXES,
  HREEL_WIN_INDEX,
  HREEL_STRIP_LEN,
  HREEL_VISIBLE_CELLS,
  type HReelCell,
} from '@/lib/hreel';
import { rarityRgb } from '@/lib/rarity';
import { spriteGif } from '@/lib/mock/pokedex';
import { CardTile } from './CardTile';

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
  spinKey,
  cellSize = 96,
  decoyCards,
  onSettled,
  onCellCross,
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
  /** Spin identity: the numeric spin nonce, or 'idle' when no spin is active.
   *  Retriggers the engine per spin — the component itself must NOT remount,
   *  or the continuous position is lost — and seeds the per-spin decoy
   *  randomization (which is why a string nonce is not allowed: it would
   *  silently collapse every spin to the same seed). */
  spinKey: number | 'idle';
  cellSize?: number;
  /** The pack's own cards (dex + configured rarity, paired) the decoy cells
   *  flicker — so the reel shows only the pack's Pokémon in only the pack's
   *  rarity colors. Empty/omitted → curated fallback. */
  decoyCards?: readonly HReelCell[];
  onSettled?: () => void;
  /** Fired each time a cell centers on the winning line (once per Pokémon
   *  crossing), decelerating with the reel — the parent turns these into the
   *  synced tick track. The final fire is the winner landing on the line. */
  onCellCross?: () => void;
  onWinnerRect?: (rect: DOMRect) => void;
  hideWinner?: boolean;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [done, setDone] = useState(false);
  const settled = useRef(false);
  /** Live paint position (px of leftward travel) — persists across idle↔spin
   *  effect re-runs. THE seam-free handoff: the spin launches from this. */
  const pxRef = useRef<number | null>(null);
  /** Spin-time strip: randomized runway + dynamic winner index. null = idle. */
  const [view, setView] = useState<{
    cells: HReelCell[];
    winIdx: number;
  } | null>(null);
  const onSettledRef = useRef(onSettled);
  const onCellCrossRef = useRef(onCellCross);
  const onWinnerRectRef = useRef(onWinnerRect);
  useEffect(() => {
    onSettledRef.current = onSettled;
    onCellCrossRef.current = onCellCross;
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
  // Idle tiling — a PURE period-poolLen tiling (buildHReelStrip with no winner)
  // so the idle drift's wrap stays seamless.
  const idleStrip = useMemo(
    () =>
      buildHReelStrip(
        null,
        'Common',
        HREEL_STRIP_LEN,
        HREEL_WIN_INDEX,
        colIndex, // per-strip decoy seed → stacked strips look independent
        decoyCards,
      ),
    [colIndex, decoyCards],
  );
  const strip = view?.cells ?? idleStrip;
  const winIdx = view?.winIdx ?? null;

  const reportWinnerRect = (idx: number) => {
    const rect = cellRefs.current[idx]?.getBoundingClientRect();
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
    const basePx = Math.round(
      reelTarget(IDLE_BASE_INDEX, pitch, winW) - CELL_GAP / 2,
    );

    const paint = (px: number, velocity: number) => {
      pxRef.current = px;
      stripEl.style.transform = `translate3d(${-px}px, 0, 0)`;
      // One real motion blur on the whole moving strip — NO per-cell transforms
      // (the old vertical column warned 48 cells × N per frame cooked phone GPUs;
      // the strip-level filter reads as horizontal blur on its own).
      const { blurPx } = blurStretch(velocity);
      stripEl.style.filter =
        blurPx > 0.05 ? `blur(${blurPx.toFixed(2)}px)` : '';
    };

    // Idle: creep right→left forever (same travel direction as a spin) so the
    // machine never looks dead. The idle strip is a PURE tiling of the decoy
    // pool, so it repeats every `poolLen` cells and wrapping the drift at
    // exactly `poolLen * pitch` px is seamless. Rest sharp instead when motion
    // is reduced, or when one whole period + the visible window wouldn't fit on
    // the strip (the drift would run off its end).
    if (!isWin) {
      setView(null);
      stripEl.style.filter = '';
      const wrapPx = poolLen * pitch;
      if (
        reduced ||
        IDLE_BASE_INDEX + HREEL_VISIBLE_CELLS + poolLen > HREEL_STRIP_LEN
      ) {
        pxRef.current = basePx;
        stripEl.style.transform = `translate3d(${-basePx}px, 0, 0)`;
        return;
      }
      // Resume from wherever the strip was left; anything outside the idle
      // band (e.g. the landed position of the previous spin — the reveal
      // theater covers this cut, as it always has) restarts at base.
      let px =
        pxRef.current !== null &&
        pxRef.current >= basePx &&
        pxRef.current < basePx + wrapPx
          ? pxRef.current
          : basePx;
      let prev = performance.now();
      let raf = 0;
      const drift = (now: number) => {
        // Clamp dt so a backgrounded tab (rAF pauses) resumes where it left off
        // instead of teleporting a minute's worth of travel on the next frame.
        px += Math.min(50, now - prev) * IDLE_DRIFT_PX_PER_MS;
        prev = now;
        if (px - basePx >= wrapPx) px -= wrapPx;
        pxRef.current = px;
        stripEl.style.transform = `translate3d(${-px}px, 0, 0)`;
        raf = requestAnimationFrame(drift);
      };
      raf = requestAnimationFrame(drift);
      return () => cancelAnimationFrame(raf);
    }

    // Spin: launch from the CURRENT position (idle drift left it in pxRef) so
    // the press reads as the ongoing motion accelerating — no teleport. The
    // winner cell is whichever cell sits one ideal-travel ahead of here; cells
    // between the visible window and the winner are randomized per spin.
    const startPx = pxRef.current ?? basePx;
    const travel = pressTravelPx(colIndex, count, pitch);
    // Invert reelTarget: the cell whose center-target is nearest startPx+travel.
    const idx = Math.round(
      (startPx + travel + winW / 2 + CELL_GAP / 2 - pitch / 2) / pitch,
    );
    // Everything on screen (plus margin) at press time keeps its idle content.
    const keep = Math.min(Math.ceil((startPx + winW) / pitch) + 2, idx - 1);
    setView({
      cells: buildPressStrip({
        winnerDex,
        winnerRarity,
        winIndex: idx,
        keepCells: keep,
        seed: colIndex,
        rngSeed:
          (typeof spinKey === 'number' ? spinKey : 0) + colIndex * 0x1003,
        decoyCards,
      }),
      winIdx: idx,
    });
    const target = Math.round(reelTarget(idx, pitch, winW) - CELL_GAP / 2);

    const finish = () => {
      paint(target, 0);
      if (!settled.current) {
        settled.current = true;
        setDone(true);
        reportWinnerRect(idx);
        onSettledRef.current?.();
      }
    };
    if (reduced) {
      const id = setTimeout(finish, 0);
      return () => clearTimeout(id);
    }
    const dur = columnDurationMs(colIndex, count);
    const start = performance.now();
    let prevPx = startPx;
    let prevT = start;
    // Cells-until-the-winner-centers: falls to 0 as the winner lands on the line.
    // Each integer step down = one Pokémon crossing center → one tick, so the
    // ticks decelerate exactly with the reel and the last one IS the winner lock.
    // floor (not round) so each step happens AS a cell reaches center — the tick
    // lands on the crossing, not half a cell early. clamp at 0 so the settle
    // overshoot (px dips past target → value goes slightly negative) can't
    // floor to -1 and fire a phantom tick after the winner has already landed.
    let remaining = Math.max(0, Math.floor((target - startPx) / pitch));
    let raf = 0;
    const frame = (now: number) => {
      const t = now - start;
      const px = pressSpinOffset(t, startPx, target, colIndex, count, pitch);
      const dt = Math.max(1, now - prevT);
      paint(px, (px - prevPx) / dt);
      prevPx = px;
      prevT = now;
      const nextRemaining = Math.max(0, Math.floor((target - px) / pitch));
      if (nextRemaining < remaining) {
        remaining = nextRemaining;
        onCellCrossRef.current?.();
      }
      if (t >= dur) {
        finish();
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pitch/winW derive from cellSize; re-running on spin identity (spinKey/isWin) is intended
  }, [
    isWin,
    spinKey,
    reduced,
    colIndex,
    count,
    winnerDex,
    winnerRarity,
    cellSize,
    poolLen,
    decoyCards,
  ]);

  return (
    // Responsive frame: the strip's engine math runs on a fixed-width core
    // (winW, 9 visible cells), but the visible WINDOW clips to whatever width
    // the stage offers. flex + justify-center overflows the core evenly on
    // BOTH edges, so the winning line's center cell stays dead-center on any
    // viewport — a phone simply sees fewer cells through the window. The rim
    // tunnels live on the frame so they always hug the visible edges.
    <div
      className="relative flex max-w-full justify-center overflow-hidden rounded-2xl border border-white/10 bg-neutral-950/80 shadow-[inset_0_0_30px_rgba(0,0,0,0.8)]"
      style={{ height: `${cellSize + 16}px` }}
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
        className="flex h-full shrink-0 flex-row items-center will-change-transform"
        style={{ width: `${winW}px`, gap: `${CELL_GAP}px` }}
      >
        {strip.map((cell, i) => {
          const isWinnerCell = winIdx !== null && i === winIdx;
          // WYSIWYG (what you see is what you get): the winner cell shows the
          // reward's TRUE tier color the WHOLE time — it never flickers a decoy
          // tier and then "changes" hue on stop. The color that lands on the
          // line IS the reward (orange ⟹ Immortal, gray ⟹ Common), matching the
          // reveal; it only intensifies (bloom + scale) when it locks. Decoys
          // flicker their own tier while spinning, then fade neutral on settle.
          // Idle has no winner cell at all (winIdx is null), so the periodic
          // idle tiling never carries an off-pattern seam.
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
                // Spin: every cell streams through the window within seconds —
                // load them all. Idle: only the drift's early cells need to be
                // ready up front; the slow creep laziness-loads the rest.
                eager={
                  winIdx !== null
                    ? true
                    : i <= IDLE_BASE_INDEX + HREEL_VISIBLE_CELLS
                }
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
