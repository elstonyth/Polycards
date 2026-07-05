// src/app/slots/[slug]/VaultReelColumn.tsx
'use client';

// rAF-driven reel column: spinOffset() physics + per-frame 3D barrel curvature
// written imperatively to DOM refs (no React state per frame — 60fps budget).
// Replaces the CSS-transition SlotReelColumn; same settle contract.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ITEM_H, STRIP_LEN, reelTargetY } from '@/lib/reel';
import {
  spinOffset,
  columnDurationMs,
  cellCurve,
  blurStretch,
  buildVaultStrip,
  CARD_ASPECT,
  VAULT_WIN_INDEX,
  VISIBLE_CELLS,
} from '@/lib/vault-reel';
import { spriteGif } from '@/lib/mock/pokedex';
import { CardTile } from './CardTile';
import { PokeCardBack } from './PokeCardBack';

const EAGER_RADIUS = 3;

export function VaultReelColumn({
  winnerDex,
  winnerImage,
  winnerName,
  rarityRgb,
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
  rarityRgb: string;
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

  // Report the landed tile's screen rect — the origin of the slab morph.
  const reportWinnerRect = () => {
    const rect = cellRefs.current[VAULT_WIN_INDEX]?.getBoundingClientRect();
    if (rect) onWinnerRectRef.current?.(rect);
  };

  const isWin = winnerDex !== null || winnerImage !== undefined;
  const strip = useMemo(
    () => buildVaultStrip(winnerDex, STRIP_LEN, VAULT_WIN_INDEX),
    [winnerDex],
  );

  // Warm the winner image cache during the spin (verbatim from old column).
  useEffect(() => {
    if (!isWin) return;
    const img = new Image();
    img.src = winnerImage ?? spriteGif(winnerDex ?? 1);
  }, [isWin, winnerImage, winnerDex]);

  useEffect(() => {
    settled.current = false;
    const winEl = windowRef.current;
    const stripEl = stripRef.current;
    if (!winEl || !stripEl) return;
    const winH = winEl.clientHeight || ITEM_H * VISIBLE_CELLS;
    const radius = winH / 2;
    const target = Math.round(reelTargetY(VAULT_WIN_INDEX, ITEM_H, winH));

    // Dirty-range tracking: only cells inside (or just leaving) the window get
    // style writes — not all STRIP_LEN cells every frame (spec #31 perf).
    // Start as "everything dirty" so the first paint sweeps the whole strip
    // once (cells default to opacity 1 before any paint).
    let prevFirst = 0;
    let prevLast = STRIP_LEN - 1;
    const paint = (offset: number, velocity: number) => {
      stripEl.style.transform = `translate3d(0, ${-offset}px, 0)`;
      const stretch = blurStretch(velocity);
      // Only style cells near the window (offset → visible index range).
      // ±2 extra rows vs the linear window: the cylinder projection (#37b)
      // pulls edge rows INWARD, so rows that are off-window in linear space
      // are visible once remapped.
      const first = Math.max(0, Math.floor(offset / ITEM_H) - 3);
      const last = Math.min(STRIP_LEN - 1, first + VISIBLE_CELLS + 6);
      for (let i = prevFirst; i <= prevLast; i++) {
        if (i >= first && i <= last) continue; // still visible, styled below
        const el = cellRefs.current[i];
        if (!el) continue;
        el.style.transform = '';
        el.style.opacity = '0';
      }
      for (let i = first; i <= last; i++) {
        const el = cellRefs.current[i];
        if (!el) continue;
        const cellCenter = i * ITEM_H + ITEM_H / 2 - offset;
        const dist = cellCenter - winH / 2;
        const c = cellCurve(dist, radius);
        // translateY FIRST: the cylinder-projection remap (#37b) positions the
        // row on the drum surface, then the 3D tilt happens at that position.
        // 520px perspective: tight vanishing point for real foreshortening.
        el.style.transform =
          `translateY(${c.translateYPx}px) ` +
          `perspective(520px) translateZ(${c.translateZPx}px) ` +
          `rotateX(${c.rotateXDeg}deg) scale(${c.scale}) scaleY(${stretch.scaleY})`;
        el.style.opacity = String(c.brightness * stretch.opacity);
      }
      prevFirst = first;
      prevLast = last;
    };

    // Idle: rest centered, static curve, no settle.
    if (!isWin) {
      paint(target, 0);
      return;
    }
    // Reduced motion: jump + settle next tick (same contract as before).
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
    // Real spin: rAF timeline.
    const dur = columnDurationMs(colIndex, count);
    const start = performance.now();
    let prevOffset = 0;
    let prevT = start;
    let raf = 0;
    const frame = (now: number) => {
      const t = now - start;
      const offset = spinOffset(t, target, colIndex, count, ITEM_H);
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
  }, [isWin, reduced, colIndex, count]);

  return (
    <div
      ref={windowRef}
      className="relative overflow-hidden rounded-2xl border border-white/10 bg-neutral-950/80 shadow-[inset_0_0_30px_rgba(0,0,0,0.8)]"
      style={{
        height: `clamp(200px, calc(100dvh - 320px), ${ITEM_H * VISIBLE_CELLS}px)`,
        width: `${cellSize + 24}px`,
      }}
      aria-hidden
    >
      {/* Drum lighting (#37a+c), one div, two gradient layers: cylindrical
          shadow rolling off the bulge into deep rim tunnels at both ends, plus
          a fixed glass sheen just above center (light falls from above). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-10 rounded-2xl"
        style={{
          background:
            'linear-gradient(180deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.5) 9%, rgba(0,0,0,0.12) 26%, rgba(0,0,0,0) 40%, rgba(0,0,0,0) 60%, rgba(0,0,0,0.12) 74%, rgba(0,0,0,0.5) 91%, rgba(0,0,0,0.85) 100%), ' +
            'linear-gradient(180deg, rgba(0,0,0,0) 32%, rgba(255,255,255,0.05) 41%, rgba(255,255,255,0.09) 45%, rgba(255,255,255,0.03) 52%, rgba(0,0,0,0) 60%)',
        }}
      />
      {/* Light sweep across the glass ONLY while spinning (#37d). */}
      {isWin && !done && !reduced && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-2xl"
        >
          <div
            className="absolute inset-y-0 w-2/3 animate-[vault-sheen_2.6s_ease-in-out_infinite]"
            style={{
              background:
                'linear-gradient(100deg, transparent 20%, rgba(255,255,255,0.09) 50%, transparent 80%)',
            }}
          />
        </div>
      )}
      {/* Card-frame landing zone (spec decision #34) — replaces the shared
          amber payline bar. Transparent line art, so the sprites scroll (and
          the winner rests) clearly visible through it. Neutral etch until THIS
          column settles; then the FRAME takes the rarity color — the sprite
          itself no longer glows. Color only after `done` = the spoiler guard. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2"
        style={{
          width: `${cellSize + 8}px`,
          height: `${Math.round((cellSize + 8) / CARD_ASPECT)}px`,
        }}
      >
        <PokeCardBack rgb={done && isWin ? rarityRgb : null} />
      </div>
      <div
        ref={stripRef}
        className="flex flex-col items-center will-change-transform"
      >
        {strip.map((dex, i) => {
          const isWinnerCell = i === VAULT_WIN_INDEX;
          return (
            <div
              key={i}
              ref={(el) => {
                cellRefs.current[i] = el;
              }}
              // No will-change here: promoting all 48 cells × N columns to
              // compositor layers cooked phone GPUs (spec #31); the strip layer
              // absorbs the per-frame transforms fine.
              className="flex shrink-0 items-center justify-center"
              style={{
                height: `${ITEM_H}px`,
                // The landed tile hides while its morph clone is on stage —
                // otherwise the player would see the card twice.
                visibility: hideWinner && isWinnerCell ? 'hidden' : undefined,
              }}
            >
              <CardTile
                dex={dex}
                name={isWinnerCell ? (winnerName ?? '') : ''}
                size={cellSize}
                eager={Math.abs(i - VAULT_WIN_INDEX) <= EAGER_RADIUS}
                imageSrc={isWinnerCell ? winnerImage : undefined}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
