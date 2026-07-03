import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Press_Start_2P } from 'next/font/google';
import { features } from '@/lib/features';

// Clone of the live custom 404 (wave-2 audit: captured on /lucky-draw, which
// 404s on live — shots in docs/research/audit/shots/lucky-draw/live-*.png):
// a graded-slab graphic ("VAULT / GRADE: NOT FOUND", giant metallic 404,
// "NO CARD ON FILE" / "SLOT EMPTY"), "Page not found." heading, green
// back-to-marketplace + dark go-home pills, then three suggested packs under
// "OPEN ONE OF THESE INSTEAD". Normal site chrome stays (live keeps it too).
const pixel = Press_Start_2P({ weight: '400', subsets: ['latin'] });

// Catalog is Pokémon-only — suggest three real Pokémon packs.
const SUGGESTIONS = [
  {
    label: 'Pokemon Elite',
    href: '/slots/pokemon-elite',
    image: '/images/claw/elite-pack-icon.webp',
  },
  {
    label: 'Pokemon Legend',
    href: '/slots/pokemon-legend',
    image: '/images/claw/legend-pack-icon.webp',
  },
  {
    label: 'Pokemon Platinum',
    href: '/slots/pokemon-platinum',
    image: '/images/claw/platinum-pack-icon.webp',
  },
];

export default function NotFound() {
  return (
    <div className="px-fluid mx-auto flex w-full max-w-2xl flex-col items-center py-10 sm:py-14">
      {/* Graded-slab 404 graphic */}
      <div className="w-full max-w-[360px] rounded-2xl border border-white/10 bg-neutral-900 p-3 shadow-2xl shadow-black/50">
        <div
          className={`${pixel.className} flex items-center justify-between rounded-lg bg-white/5 px-3 py-2 text-[8px] leading-none`}
        >
          <span className="text-emerald-300/90">✦ VAULT</span>
          <span className="text-neutral-400">GRADE: NOT FOUND</span>
        </div>
        <div className="mt-3 rounded-xl border border-white/5 bg-black/60 px-6 py-10 text-center">
          <p
            className={`${pixel.className} text-[8px] leading-none tracking-[0.25em] text-neutral-500`}
          >
            NO CARD ON FILE
          </p>
          <p className="font-heading my-4 bg-gradient-to-b from-white via-neutral-300 to-neutral-600 bg-clip-text text-8xl font-black leading-none text-transparent">
            404
          </p>
          <p
            className={`${pixel.className} text-[8px] leading-none tracking-[0.25em] text-neutral-500`}
          >
            SLOT EMPTY
          </p>
        </div>
        <div className="mt-3 flex items-center justify-between px-1 pb-1">
          <span
            className={`${pixel.className} text-[8px] leading-none text-neutral-500`}
          >
            CERT
          </span>
          <span className="font-mono text-[10px] leading-none tracking-[0.3em] text-neutral-600">
            ▮▮0000000
          </span>
        </div>
      </div>

      <h1 className="font-heading mt-8 text-center text-3xl font-black text-neutral-50 sm:text-4xl">
        Page not found.
      </h1>
      <p className="mt-3 max-w-md text-center text-sm leading-relaxed text-neutral-400">
        The page you&apos;re after has moved, been pulled, or never existed.
        Plenty of others are still waiting for their next mail day.
      </p>

      <div className="mt-7 flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row sm:justify-center">
        <Link
          href={features.marketplace ? '/marketplace' : '/slots'}
          className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-[#1aa87a] to-green-500 px-6 text-sm font-semibold text-white transition-opacity hover:opacity-90 sm:w-auto"
        >
          {features.marketplace ? 'Back to marketplace' : 'Back to packs'}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
        <Link
          href="/"
          className="inline-flex h-12 w-full items-center justify-center rounded-full border border-white/10 bg-white/5 px-6 text-sm font-medium text-neutral-200 transition-colors hover:bg-white/10 sm:w-auto"
        >
          Go home
        </Link>
      </div>

      <p className="mt-10 text-[10px] font-medium uppercase tracking-[0.25em] text-neutral-500">
        Open one of these instead
      </p>
      <div className="mt-4 grid w-full max-w-xl grid-cols-3 gap-3">
        {SUGGESTIONS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="group rounded-xl border border-white/10 bg-neutral-900 p-2 transition-colors hover:border-white/20"
          >
            <div className="flex h-24 items-center justify-center overflow-hidden rounded-lg bg-neutral-800/60 sm:h-28">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={s.image}
                alt={s.label}
                className="h-full w-auto object-contain transition-transform duration-300 group-hover:scale-105"
              />
            </div>
            <div className="mt-2 flex items-center justify-between gap-1 px-1">
              <span className="truncate text-xs font-medium text-neutral-200">
                {s.label}
              </span>
              <ArrowRight
                className="h-3 w-3 shrink-0 text-neutral-500 transition-transform duration-200 group-hover:translate-x-0.5"
                aria-hidden
              />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
