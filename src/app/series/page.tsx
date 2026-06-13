import type { Metadata } from 'next';
import Link from 'next/link';
import { Library, ArrowUpRight } from 'lucide-react';
import Reveal from '@/components/Reveal';
import { features } from '@/lib/features';

export const metadata: Metadata = {
  title: 'Series — Pokenic',
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
    name: 'Romance Dawn',
    sub: 'One Piece',
    image: '/home/hero/slabs/onepiece2.webp',
    count: '121 cards',
  },
  {
    name: 'Wings of the Captain',
    sub: 'One Piece',
    image: '/home/hero/slabs/onepiece4.webp',
    count: '112 cards',
  },
  {
    name: 'Prizm Basketball',
    sub: 'Basketball',
    image: '/home/hero/slabs/basketball1.webp',
    count: '300 cards',
  },
  {
    name: 'Select Football',
    sub: 'Football',
    image: '/home/hero/slabs/football1.webp',
    count: '400 cards',
  },
  {
    name: 'Topps Chrome',
    sub: 'Baseball',
    image: '/home/hero/slabs/baseball1.webp',
    count: '220 cards',
  },
  {
    name: '25th Anniversary',
    sub: 'Yu-Gi-Oh!',
    image: '/home/hero/slabs/yugioh1.webp',
    count: '156 cards',
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
              href={features.marketplace ? '/marketplace' : '/claw'}
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
