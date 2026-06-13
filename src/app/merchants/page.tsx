'use client';

// /merchants — "Trusted Merchants" directory matching live phygitals: centered hero
// (Global Network pill + heading + subtitle + search), centered category chips, and a
// grid of real, well-known TCG merchants with rating + region + shipping badges.

import { useState } from 'react';
import {
  Search,
  Star,
  SlidersHorizontal,
  Globe,
  BadgeCheck,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import Reveal from '@/components/Reveal';

type Merchant = {
  name: string;
  country: string;
  code: string;
  cat: string;
  rating: number;
  ago: string;
  blurb: string;
  badges: string[];
};

// Real, recognizable trading-card merchants (matching the live site's curated list).
const MERCHANTS: Merchant[] = [
  {
    name: 'Cardmarket EU',
    country: 'Germany',
    code: 'DE',
    cat: 'Pokémon',
    rating: 4.8,
    ago: '2h ago',
    blurb: "Europe's premier trading card marketplace with worldwide shipping.",
    badges: ['Free Shipping €50+', 'Express Available'],
  },
  {
    name: 'Card Kingdom',
    country: 'United States',
    code: 'US',
    cat: 'Magic',
    rating: 4.9,
    ago: '30m ago',
    blurb: "America's trusted source for trading cards and gaming supplies.",
    badges: ['Free Shipping $75+', 'Same Day Processing'],
  },
  {
    name: 'TCGPlayer',
    country: 'New York',
    code: 'US',
    cat: 'Magic',
    rating: 4.7,
    ago: '1h ago',
    blurb:
      'The largest online marketplace for collectible card games in North America.',
    badges: ['Free Shipping $35+', 'Express Available'],
  },
  {
    name: 'Troll and Toad',
    country: 'United States',
    code: 'US',
    cat: 'Yu-Gi-Oh!',
    rating: 4.6,
    ago: '3h ago',
    blurb:
      'One of the largest online card stores, serving collectors since 1991.',
    badges: ['Free Shipping $50+'],
  },
  {
    name: 'CoolStuffInc',
    country: 'Florida',
    code: 'US',
    cat: 'Magic',
    rating: 4.7,
    ago: '1h ago',
    blurb: 'Games, singles, and supplies with fast, reliable fulfillment.',
    badges: ['Free Shipping $99+', 'Same Day Processing'],
  },
  {
    name: '401 Games',
    country: 'Canada',
    code: 'CA',
    cat: 'Pokémon',
    rating: 4.6,
    ago: '5h ago',
    blurb: "Canada's largest game store with deep singles inventory.",
    badges: ['Free Shipping $75+'],
  },
  {
    name: "Dave & Adam's",
    country: 'United States',
    code: 'US',
    cat: 'Sports',
    rating: 4.7,
    ago: '2h ago',
    blurb:
      'Sports cards, boxes, and collectibles with a 100% satisfaction guarantee.',
    badges: ['Free Shipping $50+', 'Express Available'],
  },
  {
    name: 'Blowout Cards',
    country: 'United States',
    code: 'US',
    cat: 'Sports',
    rating: 4.5,
    ago: '4h ago',
    blurb: 'Sealed sports and TCG product at case-break-friendly prices.',
    badges: ['Free Shipping $99+'],
  },
  {
    name: 'Magic Madhouse',
    country: 'United Kingdom',
    code: 'GB',
    cat: 'Yu-Gi-Oh!',
    rating: 4.5,
    ago: '6h ago',
    blurb: 'UK retailer for TCG singles, sealed product, and accessories.',
    badges: ['Free Shipping £50+', 'Express Available'],
  },
];

const CATS = ['All', 'Pokémon', 'Magic', 'Yu-Gi-Oh!', 'Sports'];

export default function MerchantsPage() {
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
          Curated selection of verified trading card merchants worldwide
        </Reveal>
        <Reveal delay={180} className="relative mx-auto mt-7 max-w-xl">
          <Search
            className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35"
            aria-hidden
          />
          <input
            type="text"
            placeholder="Search merchants..."
            aria-label="Search merchants"
            className="h-12 w-full rounded-2xl border border-white/10 bg-white/[0.04] pl-11 pr-12 text-sm text-white placeholder:text-white/40 focus:border-white/25 focus:outline-none"
          />
          <SlidersHorizontal
            className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35"
            aria-hidden
          />
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
            <a
              href="#"
              className="group flex h-full flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-5 transition-all duration-300 hover:-translate-y-1 hover:border-white/20 hover:bg-white/[0.06]"
            >
              <div className="flex items-start justify-between">
                <span className="relative flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-fuchsia-500/30 via-violet-500/20 to-sky-500/20 font-heading text-lg font-bold text-white">
                  {m.name.charAt(0)}
                  <BadgeCheck
                    className="absolute -bottom-1 -right-1 h-4 w-4 rounded-full bg-neutral-900 text-sky-400"
                    aria-hidden
                  />
                </span>
                <div className="text-right">
                  <span className="inline-flex items-center gap-1 rounded-md bg-black/40 px-2 py-1 text-[12px] font-semibold text-white">
                    <Star
                      className="h-3 w-3 fill-amber-400 text-amber-400"
                      aria-hidden
                    />
                    {m.rating}
                  </span>
                  <div className="mt-1 flex items-center justify-end gap-1 text-[11px] text-white/40">
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-emerald-500/80"
                      aria-hidden
                    />
                    {m.ago}
                  </div>
                </div>
              </div>
              <h2 className="mt-3 font-heading text-base font-bold text-white">
                {m.name}
              </h2>
              <div className="mt-0.5 text-[12px] text-white/45">
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
                    className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400"
                  >
                    {b}
                  </span>
                ))}
              </div>
            </a>
          </Reveal>
        ))}
      </div>
    </div>
  );
}
