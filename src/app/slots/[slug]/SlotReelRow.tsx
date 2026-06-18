// src/app/slots/[slug]/SlotReelRow.tsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  reelTarget,
  buildStrip,
  ITEM_W,
  STRIP_LEN,
  WIN_INDEX,
  REEL_EASE,
} from '@/lib/reel';
import { BallToken } from './BallToken';
import type { Rarity } from '@/app/claw/packs-data';

/**
 * A horizontal reel row that DISPLAYS a pre-decided winner. It never picks the
 * winner (PRD §8). Idle (`winnerRarity === null`) and reduced motion land
 * centered instantly; otherwise it spins once on mount. Remount (new `key`) to
 * re-spin.
 */
export function SlotReelRow({
  winnerRarity,
  pool,
  reduced,
  durationMs,
  onSettled,
}: {
  winnerRarity: Rarity | null;
  pool: Rarity[];
  reduced: boolean;
  durationMs: number;
  onSettled?: () => void;
}) {
  const windowRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const settled = useRef(false);

  const strip = useMemo(
    () => buildStrip(winnerRarity ?? pool[0], pool, STRIP_LEN, WIN_INDEX),
    [winnerRarity, pool],
  );

  useEffect(() => {
    settled.current = false;
    const winW = windowRef.current?.clientWidth ?? 600;
    const target = Math.round(reelTarget(WIN_INDEX, ITEM_W, winW));

    // Idle: rest centered, no spin, no settle callback.
    // setState inside an effect is intentional here — we're synchronizing a DOM
    // measurement (clientWidth) into visual state. The linter flag is a false
    // positive: this is the canonical "measure then position" pattern.
    if (winnerRarity === null) {
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
          onSettled?.();
        }
      }, 0);
      return () => clearTimeout(id);
    }
    // Real spin: origin → centered winner, settle on transition end.
    setOffset(0);
    setSpinning(true);
    // Two nested frames so the transition starts from the origin; cancel BOTH on
    // teardown — if only the outer is canceled, the inner can still setOffset
    // after unmount.
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setOffset(-target));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [winnerRarity, reduced, pool, onSettled]);

  return (
    <div
      ref={windowRef}
      className="relative overflow-hidden rounded-2xl border border-white/10 bg-neutral-950 p-4"
      aria-hidden
    >
      <div
        className={cn('flex', spinning && 'transition-transform')}
        style={{
          transform: `translateX(${offset}px)`,
          transitionDuration: spinning ? `${durationMs}ms` : undefined,
          transitionTimingFunction: spinning ? REEL_EASE : undefined,
        }}
        onTransitionEnd={() => {
          if (spinning && !settled.current) {
            settled.current = true;
            setSpinning(false);
            onSettled?.();
          }
        }}
      >
        {strip.map((r, i) => (
          <BallToken
            key={i}
            rarity={r}
            w={ITEM_W}
            highlight={i === WIN_INDEX && !spinning && winnerRarity !== null}
          />
        ))}
      </div>
    </div>
  );
}
