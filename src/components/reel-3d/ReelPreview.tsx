'use client';

// /reel-preview: the 3D reel (Reel3dStack, the same component the spin page
// uses) with mock pools and mock winners. Nothing is charged or fetched, and
// the page is silent: it sets the site mute flag on mount and plays no sound.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { ColumnWinner } from '@/app/slots/[slug]/SlotReelStack';
import { shuffleCells } from '@/lib/hreel';
import { RARITY_RGB } from '@/lib/rarity';
import { writeMuted } from '@/lib/use-sound';
import { useChromeInert } from '@/lib/use-chrome-inert';
import { useMediaQuery, usePrefersReducedMotion } from '@/lib/use-reveal';
import { Reel3dStack } from './Reel3dStack';
import { MOCK_POOL, bestRarity, pickWinners } from './mock';

const floodBg = (rgb: string) =>
  `radial-gradient(85% 70% at 50% 46%, rgba(${rgb}, 0.13) 0%, rgba(${rgb}, 0.07) 28%, rgba(${rgb}, 0.03) 48%, rgba(${rgb}, 0.01) 64%, transparent 80%)`;

export default function ReelPreview() {
  const [reels, setReels] = useState(1);
  const [forceTop, setForceTop] = useState(false);
  const [winners, setWinners] = useState<ColumnWinner[] | null>(null);
  const [spinKey, setSpinKey] = useState<number | 'idle'>('idle');
  const [flood, setFlood] = useState<string | null>(null);
  const timers = useRef<number[]>([]);
  const reduced = usePrefersReducedMotion();
  const roomy = useMediaQuery('(min-width: 768px) and (min-height: 720px)');
  const cellSize = reels > 1 ? (roomy ? 116 : 76) : roomy ? 152 : 96;
  const [pools, setPools] = useState(() => [0, 1, 2].map(() => [...MOCK_POOL]));

  useChromeInert(true);

  // Silence: the root SoundProvider starts music on the first gesture unless
  // the stored mute flag is on. Set it, then make the provider re-read it.
  useEffect(() => {
    writeMuted(true);
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
  }, []);

  useEffect(
    () => () => {
      for (const id of timers.current) window.clearTimeout(id);
    },
    [],
  );

  const busy = winners !== null;
  const spin = () => {
    if (busy) return;
    const picks = pickWinners(reels, Math.random, forceTop);
    setForceTop(false);
    setWinners(
      picks.map((w) => ({
        dex: w.dex,
        rarity: w.rarity,
        rarityRgb: RARITY_RGB[w.rarity],
      })),
    );
    setSpinKey((k) => (typeof k === 'number' ? k + 1 : 1));
  };

  // As the spin page does: flood on land, then back to idle with fresh pools.
  const onAllSettled = useCallback(() => {
    if (!winners) return;
    setFlood(RARITY_RGB[bestRarity(winners)]);
    timers.current.push(
      window.setTimeout(() => setFlood(null), 1600),
      window.setTimeout(() => {
        setWinners(null);
        setSpinKey('idle');
        setPools([0, 1, 2].map(() => shuffleCells(MOCK_POOL)));
      }, 2000),
    );
  }, [winners]);

  const decoyPools = useMemo(() => pools.slice(0, reels), [pools, reels]);
  const iconBtn =
    'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30';

  return (
    <div
      data-sound="off"
      className="fixed inset-0 z-[100] flex select-none flex-col overflow-hidden bg-neutral-950 text-neutral-50"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 transition-opacity duration-300"
        style={{
          opacity: flood ? 1 : 0,
          background: flood ? floodBg(flood) : undefined,
        }}
      />
      <div className="p-4 text-[12px] font-medium text-white/45">
        Reel preview · nothing is charged
      </div>
      <div className="flex flex-1 items-center">
        <Reel3dStack
          count={reels}
          spinKey={spinKey}
          winners={winners}
          reduced={reduced}
          cellSize={cellSize}
          decoyPools={decoyPools}
          onAllSettled={onAllSettled}
        />
      </div>
      <div className="flex flex-col items-center gap-3 px-4 pb-7">
        <div className="flex w-full max-w-[420px] items-center gap-2 sm:gap-3">
          <button
            type="button"
            aria-label="One reel fewer"
            className={iconBtn}
            disabled={busy || reels <= 1}
            onClick={() => setReels((n) => Math.max(1, n - 1))}
          >
            <Minus className="h-5 w-5" aria-hidden />
          </button>
          <span className="w-14 shrink-0 text-center text-sm font-semibold tabular-nums text-white/80">
            {reels} {reels === 1 ? 'reel' : 'reels'}
          </span>
          <button
            type="button"
            aria-label="One reel more"
            className={iconBtn}
            disabled={busy || reels >= 3}
            onClick={() => setReels((n) => Math.min(3, n + 1))}
          >
            <Plus className="h-5 w-5" aria-hidden />
          </button>
          <button
            type="button"
            data-testid="spin"
            className="inline-flex h-14 flex-1 items-center justify-center rounded-full bg-white text-base font-bold text-neutral-950 transition-colors hover:bg-white/90 disabled:opacity-50"
            disabled={busy}
            onClick={spin}
          >
            {busy ? 'Spinning…' : 'Spin'}
          </button>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-white/55">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-white"
            checked={forceTop}
            onChange={(e) => setForceTop(e.target.checked)}
          />
          Force top rarity on the next spin
        </label>
      </div>
    </div>
  );
}
