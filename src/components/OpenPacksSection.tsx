'use client';

import { cn } from '@/lib/utils';

type PackCategory = {
  label: string;
  /** Graded slab shown peeking behind the pack. */
  slab: string;
  /** Ripped pack shown in the foreground. */
  pack: string;
  href: string;
};

// Each category card is a layered composition on the live site: a graded slab
// sitting BEHIND a ripped pack in the foreground (the card "comes out of" the pack).
//
// This section is intentionally curated/static (fixed categories + local art) to
// keep the home page a static server component. The tiles route into the
// backend-driven /claw listing via `?category=<key>`, where <key> matches the
// backend Pack `category` (and ClawClient's tab id), so each tile deep-links to
// the real, live pack catalog for that category. It is NOT content-driven by the
// backend — only the destination is.
const CATEGORIES: PackCategory[] = [
  {
    label: 'Pokémon',
    slab: '/home/hero/slabs/pokemon1.webp',
    pack: '/home/hero/ripped-packs/pokemon.webp',
    href: '/claw?category=pokemon',
  },
];

export default function OpenPacksSection() {
  return (
    <section className="mt-10 sm:mt-14">
      {/* Heading row */}
      <div className="mb-4 flex items-baseline justify-between sm:mb-5">
        <h2
          className={cn(
            'font-heading text-2xl font-bold tracking-tight',
            'bg-gradient-to-b from-white via-white/80 to-white/30 bg-clip-text text-transparent',
          )}
        >
          Open Packs
        </h2>
        <button
          type="button"
          className="text-[12px] font-medium text-white/45 transition-colors hover:text-white/60"
        >
          85-90% instant buyback →
        </button>
      </div>

      {/* Responsive grid (matches live site: 2 cols mobile -> 6 cols desktop) */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 md:grid-cols-6 lg:gap-4">
        {CATEGORIES.map((cat) => (
          <a
            key={cat.label}
            href={cat.href}
            className={cn(
              'group block overflow-hidden rounded-2xl border border-white/10 bg-white/5',
              'shadow-[0_4px_20px_rgba(0,0,0,0.25)] transition-[border-color] duration-300 hover:border-white/20',
            )}
          >
            {/* Layered composition (exact match to the live site markup): the graded
                SLAB is centered and fully visible (h-95%), and the ripped PACK sits
                in front but pushed down (bottom-[-45%], z-1) so only its torn top
                flanks the card — the card "emerges" out of the open pack. */}
            <div className="relative flex aspect-[3/4] items-center justify-center overflow-hidden bg-gradient-to-b from-white/[0.04] to-transparent">
              {/* Graded slab — centered, behind */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={cat.slab}
                alt={cat.label}
                width={400}
                height={670}
                loading="lazy"
                className="absolute h-[95%] w-auto max-w-full object-contain drop-shadow-[0_8px_20px_rgba(0,0,0,0.5)] transition-transform duration-300 ease-out group-hover:-translate-y-2"
              />
              {/* Ripped pack — in front (z-1), pushed down so the card emerges */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={cat.pack}
                alt=""
                aria-hidden="true"
                width={400}
                height={670}
                loading="lazy"
                className="absolute bottom-[-45%] left-1/2 z-[1] h-full w-auto -translate-x-1/2 object-contain transition-transform duration-300 ease-out group-hover:-translate-y-2"
              />
            </div>

            {/* Card body */}
            <div className="bg-white/5 p-3">
              <div className="mb-2 text-center text-[13px] font-semibold text-white">
                {cat.label}
              </div>
              <div className="flex h-9 w-full items-center justify-center rounded-xl bg-white/10 text-[13px] font-medium text-white/70 transition-colors group-hover:bg-white/15 group-hover:text-white">
                View Packs
              </div>
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}
