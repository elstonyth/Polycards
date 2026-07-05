'use client';

import { useCallback, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { VaultReelColumn } from './VaultReelColumn';

export type ColumnWinner = {
  dex: number | null;
  image?: string;
  name?: string;
  rarityRgb: string; // rarity color, applied only after settle
};

/**
 * N vertical reel columns, each with its own card-frame landing zone (spec
 * decision #34 — the shared amber payline bar is gone). Columns stop staggered
 * L→R (the rAF engine in VaultReelColumn owns per-column timing). `winners ===
 * null` = idle. `onAllSettled` fires once, after the LAST (slowest) column
 * settles — the win-after-stop guarantee (spec §4 bug #1). Remount columns via
 * `spinKey`.
 */
export function SlotReelStack({
  count,
  spinKey,
  winners,
  reduced,
  cellSize,
  onAllSettled,
  onWinnerRect,
  hideWinners,
}: {
  count: number;
  spinKey: string | number;
  winners: ColumnWinner[] | null;
  reduced: boolean;
  cellSize?: number;
  onAllSettled?: () => void;
  onWinnerRect?: (colIndex: number, rect: DOMRect) => void;
  hideWinners?: boolean;
}) {
  const settledRef = useRef(0);
  // Latest onAllSettled in a ref so handleColSettled stays stable across parent
  // re-renders — otherwise an unmemoized parent callback would churn the column
  // props (harmless in Phase B at count=1, but compounds for Phase D count>1).
  const onAllSettledRef = useRef(onAllSettled);
  useEffect(() => {
    onAllSettledRef.current = onAllSettled;
  }, [onAllSettled]);
  useEffect(() => {
    settledRef.current = 0;
  }, [spinKey]);

  const handleColSettled = useCallback(() => {
    settledRef.current += 1;
    if (settledRef.current >= count) onAllSettledRef.current?.();
  }, [count]);

  return (
    <div className="relative flex items-stretch justify-center gap-3 sm:gap-5">
      {/* Add/remove a reel animates (spec decision #21): a new column descends &
          settles in (the Presentation move); a removed column lifts up + fades
          out. The motion wrapper is keyed by COLUMN INDEX (`col-${i}`), NOT by
          spinKey — so a re-spin (spinKey change at the same count) never triggers
          an exit/enter, only an actual reel add/remove does. The inner
          VaultReelColumn keeps its `${spinKey}-${i}` key so it still remounts and
          re-runs its rAF timeline per spin. onAllSettled semantics are untouched:
          the settle counter keys off `count` and only spinning columns report. */}
      <AnimatePresence initial={false} mode="popLayout">
        {Array.from({ length: count }, (_, i) => {
          const w = winners ? winners[i] : null;
          return (
            <motion.div
              key={`col-${i}`}
              layout={!reduced}
              initial={
                reduced ? { opacity: 0 } : { opacity: 0, y: -60, scale: 0.96 }
              }
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={
                reduced ? { opacity: 0 } : { opacity: 0, y: -40, scale: 0.96 }
              }
              transition={
                reduced
                  ? { duration: 0 }
                  : { duration: 0.55, ease: [0.16, 1, 0.3, 1] }
              }
            >
              <VaultReelColumn
                key={`${spinKey}-${i}`}
                winnerDex={w ? w.dex : null}
                winnerImage={w?.image}
                winnerName={w?.name}
                // Idle (winners === null) → rarityRgb is irrelevant; the column
                // shows a looping decoy strip and never glows or settles.
                rarityRgb={w ? w.rarityRgb : '163, 163, 163'}
                reduced={reduced}
                colIndex={i}
                count={count}
                cellSize={cellSize}
                // Only spinning columns report settle — idle columns get no
                // callback so the settled counter can't advance while idle.
                onSettled={winners ? handleColSettled : undefined}
                onWinnerRect={
                  onWinnerRect ? (rect) => onWinnerRect(i, rect) : undefined
                }
                hideWinner={hideWinners}
              />
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
