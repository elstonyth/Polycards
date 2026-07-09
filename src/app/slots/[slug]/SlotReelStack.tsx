'use client';

import { useCallback, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { Rarity } from '@/lib/packs-data';
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
  decoyDexes,
  onAllSettled,
  onWinnerRect,
  hideWinners,
}: {
  count: number;
  spinKey: string | number;
  winners: ColumnWinner[] | null;
  reduced: boolean;
  cellSize?: number;
  /** Pack's own card dexes for the decoy flicker (Pokémon tied to a reward). */
  decoyDexes?: readonly number[];
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
    <div className="relative flex flex-col items-center justify-center gap-3 sm:gap-4">
      <AnimatePresence initial={false} mode="popLayout">
        {Array.from({ length: count }, (_, i) => {
          const w = winners ? winners[i] : null;
          return (
            <motion.div
              key={`strip-${i}`}
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
              <ReelStrip
                key={`${spinKey}-${i}`}
                winnerDex={w ? w.dex : null}
                winnerImage={w?.image}
                winnerName={w?.name}
                winnerRarity={w ? w.rarity : 'Common'}
                winnerRarityRgb={w ? w.rarityRgb : '163, 163, 163'}
                reduced={reduced}
                colIndex={i}
                count={count}
                cellSize={cellSize}
                decoyDexes={decoyDexes}
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
