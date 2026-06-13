'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Sparkles, RotateCcw, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { usd } from '@/lib/format';
import {
  MOCK_CARDS,
  RARITY_RGB,
  type MockCard,
  type Rarity,
} from '@/lib/mock/cards';

const ITEM_W = 124;
const WIN_INDEX = 36;
const TIERS: { rarity: Rarity; chance: string }[] = [
  { rarity: 'Legendary', chance: '1%' },
  { rarity: 'Rare', chance: '9%' },
  { rarity: 'Uncommon', chance: '90%' },
];

function Thumb({ card, w }: { card: MockCard; w?: number }) {
  const ring = RARITY_RGB[card.rarity];
  return (
    <div className="shrink-0 px-1" style={w ? { width: w } : undefined}>
      <div
        className="overflow-hidden rounded-xl border bg-neutral-900 p-1.5"
        style={{
          borderColor: `rgba(${ring},0.55)`,
          boxShadow: `0 0 16px -8px rgba(${ring},0.6)`,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={card.image}
          alt={card.name}
          loading="lazy"
          className="aspect-[3/4] w-full rounded-md object-contain"
        />
      </div>
    </div>
  );
}

export default function RouletteClient() {
  const reduced = usePrefersReducedMotion();
  const [phase, setPhase] = useState<'idle' | 'spinning' | 'done'>('idle');
  const [offset, setOffset] = useState(0);
  const [won, setWon] = useState<MockCard | null>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const strip = useMemo(
    () =>
      Array.from(
        { length: 48 },
        (_, i) => MOCK_CARDS[(i * 5 + 2) % MOCK_CARDS.length],
      ),
    [],
  );

  function play() {
    if (phase === 'spinning') return;
    const winner = strip[WIN_INDEX];
    if (reduced) {
      setWon(winner);
      setPhase('done');
      return;
    }
    setWon(null);
    setOffset(0);
    setPhase('spinning');
    const win = windowRef.current?.clientWidth ?? 600;
    const target = WIN_INDEX * ITEM_W + ITEM_W / 2 - win / 2;
    const jitter = (WIN_INDEX % 2 === 0 ? 1 : -1) * (ITEM_W * 0.18);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => setOffset(-(target + jitter))),
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-fluid py-8 text-center">
      <h1 className="font-heading text-4xl font-bold tracking-tight text-white sm:text-5xl">
        Pokémon Card Roulette
      </h1>
      <p className="mx-auto mt-3 max-w-md text-sm text-white/60 sm:text-base">
        Test your luck and win exclusive cards!
      </p>

      {/* Rarity tiers */}
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {TIERS.map((t) => (
          <span
            key={t.rarity}
            className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-[12px] font-semibold"
            style={{
              color: `rgb(${RARITY_RGB[t.rarity]})`,
              backgroundColor: `rgba(${RARITY_RGB[t.rarity]},0.12)`,
            }}
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: `rgb(${RARITY_RGB[t.rarity]})` }}
            />
            {t.rarity} · {t.chance}
          </span>
        ))}
      </div>

      {/* Roulette window */}
      <div
        className="relative mt-8 overflow-hidden rounded-2xl border border-white/10 bg-neutral-950 p-5 sm:p-6"
        ref={windowRef}
      >
        <div className="pointer-events-none absolute left-1/2 top-0 z-10 h-full w-0.5 -translate-x-1/2 bg-white/70" />
        <div className="pointer-events-none absolute left-1/2 top-0 z-10 -translate-x-1/2 border-x-[6px] border-t-[8px] border-x-transparent border-t-white/70" />
        <div className="overflow-hidden">
          <div
            className={cn(
              'flex',
              phase === 'spinning' &&
                'transition-transform duration-[4200ms] ease-[cubic-bezier(0.12,0.8,0.18,1)]',
            )}
            style={{ transform: `translateX(${offset}px)` }}
            onTransitionEnd={() => {
              if (phase === 'spinning') {
                setWon(strip[WIN_INDEX]);
                setPhase('done');
              }
            }}
          >
            {strip.map((c, i) => (
              <Thumb key={i} card={c} w={ITEM_W} />
            ))}
          </div>
        </div>
      </div>

      {/* Result + CTA */}
      {phase === 'done' && won ? (
        <div className="mt-6 flex flex-col items-center gap-2 motion-safe:animate-[fadeIn_0.4s_ease-out]">
          <p className="text-[11px] font-medium uppercase tracking-widest text-white/40">
            You won
          </p>
          <p className="font-heading text-xl font-bold text-white">
            {won.name}
          </p>
          <p
            className="text-sm"
            style={{ color: `rgb(${RARITY_RGB[won.rarity]})` }}
          >
            {won.rarity} · {usd(won.price)}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={play}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-neutral-200 px-6 text-sm font-semibold text-neutral-950 transition-colors hover:bg-white"
            >
              <RotateCcw className="h-4 w-4" aria-hidden /> Spin again
            </button>
            <Link
              href={`/card/${won.id}`}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-5 text-sm font-medium text-white transition-colors hover:bg-white/10"
            >
              View card <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={play}
          disabled={phase === 'spinning'}
          className="mt-6 inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-fuchsia-500 to-violet-500 px-8 text-sm font-semibold text-white shadow-lg transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          <Sparkles className="h-4 w-4" aria-hidden />{' '}
          {phase === 'spinning' ? 'Spinning…' : 'Play Roulette'}
        </button>
      )}
      <p className="mt-4 text-[11px] text-white/35">
        Demo only — real roulette &amp; provably-fair odds arrive with the
        backend.
      </p>
    </div>
  );
}
