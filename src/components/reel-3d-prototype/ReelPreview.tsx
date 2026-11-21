'use client';

// PROTOTYPE, throwaway: four looks for the reel on /reel-preview, switched with ?variant=
//
// `today` mounts the real DOM SlotReelStack with mock winners; `a` curved
// strip, `b` drum and `c` linked wheels run in one shared three.js renderer
// (engine.ts). Nothing is charged or fetched, and the page is silent: it sets
// the site mute flag on mount and plays no sound. Spin picks mock winners.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react';
import type { Rarity } from '@/lib/packs-data';
import { RARITY_RGB } from '@/lib/rarity';
import { writeMuted } from '@/lib/use-sound';
import { useChromeInert } from '@/lib/use-chrome-inert';
import {
  SlotReelStack,
  type ColumnWinner,
} from '@/app/slots/[slug]/SlotReelStack';
import {
  ReelEngine,
  todayCellPx,
  type EngineStats,
  type Phase,
} from './engine';
import { LOOK_LABEL, VARIANTS, type Variant } from './layouts';
import { MOCK_POOL, bestRarity, mulberry32, pickWinners } from './mock';

export type SeekProps = {
  t: number;
  seed: number;
  win: Rarity | null;
  reels: number;
};

/** Stage insets (px): the reel centres between the label and the controls. */
const INSET_TOP = 56;
const INSET_BOTTOM = 196;

const variantLabel = (v: Variant) =>
  v === 'today' ? 'Today' : `${v.toUpperCase()} (${LOOK_LABEL[v]})`;

const floodBg = (rgb: string) =>
  `radial-gradient(85% 70% at 50% 46%, rgba(${rgb}, 0.26) 0%, rgba(${rgb}, 0.15) 28%, rgba(${rgb}, 0.07) 48%, rgba(${rgb}, 0.02) 64%, transparent 80%)`;

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';
function subscribeReduced(cb: () => void) {
  const mq = window.matchMedia(REDUCED_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
function subscribeResize(cb: () => void) {
  window.addEventListener('resize', cb);
  return () => window.removeEventListener('resize', cb);
}

function shuffledPool(seed: number) {
  const rand = mulberry32(seed);
  const out = [...MOCK_POOL];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export default function ReelPreview({
  initialVariant,
  debug,
  seek,
  initialReels,
}: {
  initialVariant: Variant;
  debug: boolean;
  seek: SeekProps | null;
  initialReels: number;
}) {
  const router = useRouter();
  const hostRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<ReelEngine | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);
  const [variant, setVariant] = useState<Variant>(initialVariant);
  const [reels, setReels] = useState(initialReels);
  const [forceTop, setForceTop] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [stats, setStats] = useState<EngineStats | null>(null);
  // today variant
  const [todayWinners, setTodayWinners] = useState<ColumnWinner[] | null>(null);
  const [spinKey, setSpinKey] = useState<number | 'idle'>('idle');
  const [todayFlood, setTodayFlood] = useState<string | null>(null);
  const timers = useRef<number[]>([]);

  const reduced = useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia(REDUCED_QUERY).matches,
    () => false,
  );
  const viewport = useSyncExternalStore(
    subscribeResize,
    () => `${window.innerWidth}x${window.innerHeight}`,
    () => '390x844',
  );
  const effective: Variant = webglFailed ? 'today' : variant;

  useChromeInert(true);

  // Silence: the root SoundProvider starts music on the first gesture unless
  // the stored mute flag is on. Set it, then make the provider re-read it.
  useEffect(() => {
    writeMuted(true);
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
  }, []);

  // One renderer for the page's life; looks swap scene objects only.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const e = ReelEngine.create({ host, reduced, onPhase: setPhase });
    if (!e) {
      setWebglFailed(true);
      return;
    }
    e.setInsets(INSET_TOP, INSET_BOTTOM);
    setEngine(e);
    return () => {
      e.dispose();
      setEngine(null);
    };
  }, [reduced]);

  useEffect(() => {
    if (!engine) return;
    engine.setReels(reels);
    engine.setLook(effective === 'today' ? null : effective);
    if (seek && effective !== 'today') engine.seek({ ...seek, reels });
  }, [engine, effective, reels, seek]);

  useEffect(() => {
    if (!debug || !engine) return;
    const id = window.setInterval(() => setStats(engine.stats()), 250);
    return () => window.clearInterval(id);
  }, [debug, engine]);

  useEffect(
    () => () => {
      for (const id of timers.current) window.clearTimeout(id);
    },
    [],
  );

  const todayBusy = spinKey !== 'idle';
  const busy = effective === 'today' ? todayBusy : phase !== 'idle';

  const resetToday = useCallback(() => {
    for (const id of timers.current) window.clearTimeout(id);
    timers.current = [];
    setTodayWinners(null);
    setSpinKey('idle');
    setTodayFlood(null);
  }, []);

  const cycle = useCallback(
    (dir: 1 | -1) => {
      const i = VARIANTS.indexOf(variant);
      const next = VARIANTS[(i + dir + VARIANTS.length) % VARIANTS.length]!;
      setVariant(next);
      resetToday();
      const params = new URLSearchParams(window.location.search);
      params.set('variant', next);
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [variant, router, resetToday],
  );

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      const t = ev.target as HTMLElement | null;
      if (
        t &&
        (t.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))
      )
        return;
      ev.preventDefault();
      cycle(ev.key === 'ArrowLeft' ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cycle]);

  const spin = () => {
    if (busy) return;
    const winners = pickWinners(reels, Math.random, forceTop);
    setForceTop(false);
    if (effective === 'today') {
      setTodayWinners(
        winners.map((w) => ({
          dex: w.dex,
          rarity: w.rarity,
          rarityRgb: RARITY_RGB[w.rarity],
        })),
      );
      setSpinKey((k) => (typeof k === 'number' ? k + 1 : 1));
      return;
    }
    engine?.spinNow(winners);
  };

  const onTodaySettled = useCallback(() => {
    if (!todayWinners) return;
    setTodayFlood(RARITY_RGB[bestRarity(todayWinners)]);
    timers.current.push(
      window.setTimeout(() => setTodayFlood(null), 1600),
      window.setTimeout(() => {
        setTodayWinners(null);
        setSpinKey('idle');
      }, 2000),
    );
  }, [todayWinners]);

  const [vw, vh] = viewport.split('x').map(Number) as [number, number];
  const cellSize = todayCellPx(vw, vh, reels);
  const decoyPools = useMemo(
    () => [0, 1, 2].map((i) => shuffledPool(11 + i * 5)),
    [],
  );

  const iconBtn =
    'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30';

  return (
    <div
      data-sound="off"
      className="fixed inset-0 z-[100] select-none overflow-hidden bg-neutral-950 text-neutral-50"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(130% 95% at 50% -5%, rgba(203,213,225,0.15) 0%, rgba(203,213,225,0.09) 16%, rgba(203,213,225,0.05) 30%, rgba(203,213,225,0.02) 46%, transparent 68%)',
        }}
      />
      <div ref={hostRef} aria-hidden className="absolute inset-0" />

      {effective === 'today' && (
        <>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 transition-opacity duration-300"
            style={{
              opacity: todayFlood ? 1 : 0,
              background: todayFlood ? floodBg(todayFlood) : undefined,
            }}
          />
          <div
            className="absolute inset-x-0 flex items-center justify-center px-4"
            style={{ top: INSET_TOP, bottom: INSET_BOTTOM }}
          >
            <SlotReelStack
              count={reels}
              spinKey={spinKey}
              winners={todayWinners}
              reduced={reduced}
              cellSize={cellSize}
              decoyPools={decoyPools}
              onAllSettled={onTodaySettled}
            />
          </div>
        </>
      )}

      {/* Keeps a big look (the wheels on a phone) from running under the
          controls. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0"
        style={{
          height: INSET_BOTTOM + 20,
          background:
            'linear-gradient(to top, rgb(10 10 10) 0%, rgba(10,10,10,0.92) 55%, transparent 100%)',
        }}
      />

      <div className="absolute left-4 top-4 text-[12px] font-medium text-white/45">
        Reel preview · prototype · nothing is charged
      </div>

      <div
        className="absolute inset-x-0 flex flex-col items-center gap-3 px-4"
        style={{ bottom: 76 }}
      >
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
            disabled={busy || (effective !== 'today' && !engine)}
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

      {/* The look switcher: deliberately not part of the design. */}
      <div className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-dashed border-white/30 bg-neutral-900/90 p-1 font-mono text-xs text-white/85 shadow-[0_8px_24px_rgba(0,0,0,0.6)]">
        <button
          type="button"
          aria-label="Previous look"
          className="inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/10"
          onClick={() => cycle(-1)}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <span data-testid="variant-label" className="min-w-[150px] text-center">
          {variantLabel(effective)}
          {webglFailed ? ' · no WebGL' : ''}
        </span>
        <button
          type="button"
          aria-label="Next look"
          className="inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/10"
          onClick={() => cycle(1)}
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {debug && (
        <pre
          data-testid="debug"
          className="absolute right-3 top-3 rounded-lg bg-black/70 px-3 py-2 font-mono text-[11px] leading-4 text-white/80"
        >
          {[
            `variant  ${effective}`,
            `phase    ${effective === 'today' ? (todayBusy ? 'spinning' : 'idle') : (stats?.phase ?? phase)}`,
            `speed    ${stats ? stats.speed.toFixed(3) : '-'} vpx/ms`,
            `draws    ${stats?.calls ?? '-'}`,
            `cells    ${stats?.cells ?? '-'}`,
            `texture  ${stats ? (stats.textureBytes / 1024).toFixed(0) : '-'} KiB`,
          ].join('\n')}
        </pre>
      )}
    </div>
  );
}
