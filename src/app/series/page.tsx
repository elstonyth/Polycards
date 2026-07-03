import type { Metadata } from 'next';
import Link from 'next/link';
import { Library, ArrowUpRight } from 'lucide-react';
import Reveal from '@/components/Reveal';
import { features } from '@/lib/features';

export const metadata: Metadata = {
  title: 'Series',
  description: 'Browse collectible card series and sets available on Pokenic.',
};

// Mock series tiles (layout only — real set catalog comes from the backend).
type Series = { name: string; sub: string; image: string; count: string };
const SERIES: Series[] = [
  {
    name: 'Scarlet & Violet 151',
    sub: 'Pokémon',
    image: '/home/hero/slabs/pokemon1.webp',
    count: '207 cards',
  },
  {
    name: 'Crown Zenith',
    sub: 'Pokémon',
    image: '/home/hero/slabs/pokemon3.webp',
    count: '159 cards',
  },
  {
    name: 'Obsidian Flames',
    sub: 'Pokémon',
    image: '/home/hero/slabs/pokemon1.webp',
    count: '230 cards',
  },
  {
    name: 'Paradox Rift',
    sub: 'Pokémon',
    image: '/home/hero/slabs/pokemon3.webp',
    count: '266 cards',
  },
  {
    name: 'Paldea Evolved',
    sub: 'Pokémon',
    image: '/home/hero/slabs/pokemon1.webp',
    count: '279 cards',
  },
  {
    name: 'Temporal Forces',
    sub: 'Pokémon',
    image: '/home/hero/slabs/pokemon3.webp',
    count: '218 cards',
  },
  {
    name: 'Twilight Masquerade',
    sub: 'Pokémon',
    image: '/home/hero/slabs/pokemon1.webp',
    count: '226 cards',
  },
  {
    name: 'Surging Sparks',
    sub: 'Pokémon',
    image: '/home/hero/slabs/pokemon3.webp',
    count: '252 cards',
  },
];

export default function SeriesPage() {
  return (
    <div className="mx-auto w-full px-fluid py-6">
      <Reveal as="header" className="mb-6">
        <div className="flex items-center gap-2.5">
          <Library className="h-5 w-5 text-sky-400" aria-hidden />
          <h1 className="font-heading text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Series
          </h1>
        </div>
        <p className="mt-2 text-sm text-white/55">
          Explore every card series and set available across the platform.
        </p>
      </Reveal>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {SERIES.map((s, i) => (
          <Reveal key={s.name} delay={Math.min(i, 8) * 60} className="h-full">
            <Link
              href={features.marketplace ? '/marketplace' : '/slots'}
              aria-label={`${s.name} — ${s.count}`}
              className="group relative flex h-full items-center gap-4 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-4 transition-all duration-300 hover:-translate-y-1 hover:border-white/20 hover:bg-white/[0.06]"
            >
              <div className="flex h-24 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-neutral-950">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={s.image}
                  alt={s.name}
                  loading="lazy"
                  className="h-full w-full object-contain p-1.5 transition-transform duration-300 group-hover:scale-105"
                />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium uppercase tracking-wide text-white/40">
                  {s.sub}
                </p>
                <h2
                  className="mt-0.5 truncate font-heading text-base font-bold text-white"
                  title={s.name}
                >
                  {s.name}
                </h2>
                <p className="mt-1 text-[13px] text-white/50">{s.count}</p>
              </div>
              <ArrowUpRight
                className="h-4 w-4 shrink-0 text-white/30 transition-colors group-hover:text-white/60"
                aria-hidden
              />
            </Link>
          </Reveal>
        ))}
      </div>
      <p className="mt-4 text-center text-[11px] text-white/35">
        Demo catalog — the full set index is served by the backend.
      </p>
    </div>
  );
}
