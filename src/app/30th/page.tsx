import type { Metadata } from 'next';
import Link from 'next/link';
import { Trophy, PartyPopper } from 'lucide-react';
import Reveal from '@/components/Reveal';

export const metadata: Metadata = {
  title: '30th Edition',
  description: 'The 30th Edition celebration has concluded — see the winners.',
};

const PRIZES = [
  '/images/claw/mythic-pack-icon.webp',
  '/home/hero/slabs/pokemon1.webp',
  '/images/claw/legend-pack-icon.webp',
  '/home/hero/slabs/pokemon3.webp',
  '/images/claw/platinum-pack-icon.webp',
];

export default function ThirtiethPage() {
  return (
    <div className="mx-auto w-full px-fluid py-4">
      <section className="relative mb-10 overflow-hidden rounded-2xl border border-white/10 bg-neutral-950 px-6 py-16 text-center sm:py-24">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/home/hero/ripped-packs/pokemon.webp"
          alt=""
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-40 blur-[48px] saturate-[1.7] animate-[heroBlob_18s_ease-in-out_infinite] motion-reduce:animate-none"
        />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-neutral-950/80 via-neutral-950/70 to-neutral-950/95" />
        <div className="relative">
          <span className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400/30 to-amber-500/10 text-amber-300">
            <Trophy className="h-8 w-8" aria-hidden />
          </span>
          <p className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.25em] text-amber-300/80">
            <PartyPopper className="h-3.5 w-3.5" aria-hidden /> 30th Edition
          </p>
          <h1 className="mx-auto max-w-2xl font-heading text-4xl font-bold leading-[1.05] tracking-tight text-white sm:text-5xl lg:text-6xl">
            Prizes Have Been Picked!
          </h1>
          <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-white/65 sm:text-base">
            The 30th Edition celebration has wrapped. Head to our announcement
            channel for the full breakdown of winners and prizes.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              href="/leaderboard"
              className="inline-flex h-12 items-center justify-center rounded-2xl border border-white/15 bg-white/5 px-7 text-sm font-medium text-white transition-colors hover:bg-white/10"
            >
              View Leaderboard
            </Link>
          </div>
        </div>
      </section>

      {/* Prize fan */}
      <Reveal as="section" className="text-center">
        <p className="mb-5 text-[13px] font-medium text-white/50">
          This edition&apos;s prize pool
        </p>
        <div className="flex items-end justify-center gap-2 sm:gap-4">
          {PRIZES.map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={src}
              src={src}
              alt=""
              aria-hidden
              loading="lazy"
              className="h-24 w-auto object-contain drop-shadow-[0_16px_40px_rgba(0,0,0,0.5)] sm:h-36"
              style={{
                transform: `translateY(${Math.abs(i - 2) * 10}px) rotate(${(i - 2) * 5}deg)`,
              }}
            />
          ))}
        </div>
      </Reveal>
    </div>
  );
}
