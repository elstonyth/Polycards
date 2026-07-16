'use client';

// /merchants — "Trusted Merchants" directory: centered hero
// (Global Network pill + heading + subtitle), centered category chips, and a
// grid of well-known TCG merchants with region + shipping badges. Demo-only
// directory (no live partnerships) — disclosed in-page.

import { useState } from 'react';
import { Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import Reveal from '@/components/Reveal';

type Merchant = {
  name: string;
  country: string;
  code: string;
  cat: string;
  blurb: string;
  badges: string[];
};

// Real, recognizable Pokémon trading-card merchants (Pokémon-only catalog).
const MERCHANTS: Merchant[] = [
  {
    name: 'Cardmarket EU',
    country: 'Germany',
    code: 'DE',
    cat: 'Pokémon',
    blurb: "Europe's premier Pokémon card marketplace with worldwide shipping.",
    badges: ['Free Shipping €50+', 'Express Available'],
  },
  {
    name: 'Card Kingdom',
    country: 'United States',
    code: 'US',
    cat: 'Pokémon',
    blurb: "America's trusted source for Pokémon cards and gaming supplies.",
    badges: ['Free Shipping RM 75+', 'Same Day Processing'],
  },
  {
    name: 'TCGPlayer',
    country: 'New York',
    code: 'US',
    cat: 'Pokémon',
    blurb:
      'The largest online marketplace for Pokémon singles in North America.',
    badges: ['Free Shipping RM 35+', 'Express Available'],
  },
  {
    name: 'Troll and Toad',
    country: 'United States',
    code: 'US',
    cat: 'Pokémon',
    blurb:
      'One of the largest online card stores, serving collectors since 1991.',
    badges: ['Free Shipping RM 50+'],
  },
  {
    name: 'CoolStuffInc',
    country: 'Florida',
    code: 'US',
    cat: 'Pokémon',
    blurb: 'Pokémon singles and supplies with fast, reliable fulfillment.',
    badges: ['Free Shipping RM 99+', 'Same Day Processing'],
  },
  {
    name: '401 Games',
    country: 'Canada',
    code: 'CA',
    cat: 'Pokémon',
    blurb: "Canada's largest game store with deep Pokémon singles inventory.",
    badges: ['Free Shipping RM 75+'],
  },
  {
    name: "Dave & Adam's",
    country: 'United States',
    code: 'US',
    cat: 'Pokémon',
    blurb:
      'Pokémon singles, boxes, and collectibles with a 100% satisfaction guarantee.',
    badges: ['Free Shipping RM 50+', 'Express Available'],
  },
  {
    name: 'Blowout Cards',
    country: 'United States',
    code: 'US',
    cat: 'Pokémon',
    blurb: 'Sealed Pokémon product at case-break-friendly prices.',
    badges: ['Free Shipping RM 99+'],
  },
  {
    name: 'Chaos Cards',
    country: 'United Kingdom',
    code: 'GB',
    cat: 'Pokémon',
    blurb: 'UK retailer for Pokémon singles, sealed product, and accessories.',
    badges: ['Free Shipping £50+', 'Express Available'],
  },
];

const CATS = ['All', 'Pokémon'];

export default function MerchantsClient() {
  const [cat, setCat] = useState('All');
  const list =
    cat === 'All' ? MERCHANTS : MERCHANTS.filter((m) => m.cat === cat);

  return (
    <div className="mx-auto w-full px-fluid py-10">
      {/* Centered hero */}
      <div className="mx-auto max-w-2xl text-center">
        <Reveal className="mb-5 flex justify-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[12px] font-medium text-white/70">
            <Globe className="h-3.5 w-3.5 text-white/55" aria-hidden /> Global
            Network
          </span>
        </Reveal>
        <Reveal
          as="h1"
          delay={60}
          className="font-heading text-4xl font-bold tracking-tight text-white sm:text-5xl"
        >
          Trusted Merchants
        </Reveal>
        <Reveal
          as="p"
          delay={120}
          className="mx-auto mt-3 max-w-md text-sm text-white/55 sm:text-base"
        >
          Curated selection of trading card merchants worldwide
        </Reveal>
      </div>

      {/* Centered category chips */}
      <div className="mb-8 mt-8 flex flex-wrap justify-center gap-2">
        {CATS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCat(c)}
            aria-pressed={cat === c}
            className={cn(
              'rounded-full px-4 py-2 text-[13px] font-medium transition-colors',
              cat === c
                ? 'bg-white text-neutral-950'
                : 'border border-white/10 bg-white/5 text-white/60 hover:bg-white/10 hover:text-white',
            )}
          >
            {c}
          </button>
        ))}
      </div>

      {/* Merchant grid */}
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((m, i) => (
          <Reveal key={m.name} delay={Math.min(i, 8) * 50} className="h-full">
            <div className="group flex h-full flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-5 transition-[transform,border-color,background-color] duration-300 hover:-translate-y-1 hover:border-white/20 hover:bg-white/[0.06]">
              <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-fuchsia-500/30 via-violet-500/20 to-sky-500/20 font-heading text-lg font-bold text-white">
                {m.name.charAt(0)}
              </span>
              <h2 className="mt-3 font-heading text-base font-bold text-white">
                {m.name}
              </h2>
              <div className="mt-0.5 text-[12px] text-white/50">
                <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-white/35">
                  {m.code}
                </span>
                {m.country}
              </div>
              <p className="mt-2 flex-1 text-[13px] leading-relaxed text-white/55">
                {m.blurb}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {m.badges.map((b) => (
                  <span
                    key={b}
                    className="rounded bg-buyback/10 px-1.5 py-0.5 text-[10px] font-medium text-buyback-fg"
                  >
                    {b}
                  </span>
                ))}
              </div>
            </div>
          </Reveal>
        ))}
      </div>

      <p className="mt-8 text-center text-[11px] text-white/55">
        Demo directory — merchant partnerships aren&apos;t live yet; listings
        are illustrative.
      </p>
    </div>
  );
}
