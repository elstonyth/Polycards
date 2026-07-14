'use client';

import { useCallback, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { Rarity } from '@/lib/packs-data';
import type { HReelCell } from '@/lib/hreel';
import { ReelStrip } from './ReelStrip';
import { WinningLine } from './WinningLine';

export type ColumnWinner = {
  dex: number | null;
  image?: string;
  name?: string;
  rarity: Rarity; // real rarity — drives the gated near-miss tease + settle color
  rarityRgb: string; // real color, applied to the winner cell only after settle
};

/**
 * N stacked HORIZONTAL strips (spec Spec-1, D1), one shared vertical winning
 * line down the center. Strips scroll right→left and stop staggered (the rAF
 * engine in ReelStrip owns per-strip timing). `winners === null` = idle.
 * `onAllSettled` fires once, after the LAST strip settles.
 */
export function SlotReelStack({
  count,
  spinKey,
  winners,
  reduced,
  cellSize,
  decoyPools,
  onAllSettled,
  onWinnerRect,
  hideWinners,
}: {
  count: number;
  /** Numeric spin nonce, or 'idle' between spins — numeric because it also
   *  seeds ReelStrip's per-spin decoy randomization. */
  spinKey: number | 'idle';
  winners: ColumnWinner[] | null;
  reduced: boolean;
  cellSize?: number;
  /** Per-strip decoy pools — pool `i` feeds strip `i` (each reel tiles its own
   *  shuffled copy of the pack pool, reshuffled per idle cycle, so stacked
   *  reels read independently). Cells are the pack's own {dex, rarity}. */
  decoyPools?: readonly (readonly HReelCell[])[];
  onAllSettled?: () => void;
  onWinnerRect?: (colIndex: number, rect: DOMRect) => void;
  hideWinners?: boolean;
}) {
  const settledRef = useRef(0);
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
    // w-full (not fit-content): gives each strip's max-w-full clip frame a real
    // bound so the 9-cell window can't push the stage sideways on phones.
    <div className="relative flex w-full flex-col items-center justify-center gap-3 sm:gap-4">
      <AnimatePresence initial={false} mode="popLayout">
        {Array.from({ length: count }, (_, i) => {
          const w = winners ? winners[i] : null;
          return (
            <motion.div
              key={`strip-${i}`}
              className="flex w-full min-w-0 justify-center"
              layout={!reduced}
              initial={
                reduced ? { opacity: 0 } : { opacity: 0, x: 60, scale: 0.96 }
              }
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={
                reduced ? { opacity: 0 } : { opacity: 0, x: 40, scale: 0.96 }
              }
              transition={
                reduced
                  ? { duration: 0 }
                  : { duration: 0.5, ease: [0.16, 1, 0.3, 1] }
              }
            >
              {/* NO spin-keyed remount: ReelStrip carries its live position
                  across idle→spin so the press accelerates the ongoing drift
                  instead of teleporting a fresh strip. spinKey retriggers its
                  engine per spin as a prop. */}
              <ReelStrip
                winnerDex={w ? w.dex : null}
                winnerImage={w?.image}
                winnerName={w?.name}
                winnerRarity={w ? w.rarity : 'Common'}
                winnerRarityRgb={w ? w.rarityRgb : '163, 163, 163'}
                reduced={reduced}
                colIndex={i}
                count={count}
                spinKey={spinKey}
                cellSize={cellSize}
                decoyCards={decoyPools?.[i]}
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
      {/* one shared winning line crossing every strip */}
      <WinningLine />
    </div>
  );
}
