import Link from 'next/link';
import Image from 'next/image';
import { ArrowRight } from 'lucide-react';
import Reveal from '@/components/Reveal';
import { priceNumber, type Pack, type PackCard } from '@/lib/packs-data';

/**
 * Board 02 — RIP A PACK: one full-width row per pack, most expensive first, so
 * the catalog reads as a price ladder. Packs carry no rarity/tier label — just
 * art, name, top chase, and price. The top row leads full-width on desktop; the
 * rest sit two-up. Every row → /slots (routing rule); sold out is inert.
 */
export default function TierShelf({
  packs,
  chaseByPack,
}: {
  packs: Pack[];
  chaseByPack: Map<string, PackCard | null>;
}) {
  // Ladder order: price high→low (unparseable prices sink to the bottom).
  const rows = [...packs].sort(
    (a, b) => priceNumber(b.price) - priceNumber(a.price),
  );

  return (
    <section aria-labelledby="shelf-heading" className="px-fluid mt-4 w-full">
      <div className="flex items-baseline justify-between">
        <h1 id="shelf-heading" className="font-heading text-3xl text-white">
          RIP A PACK
        </h1>
        <Link
          href="/slots"
          className="flex min-h-11 items-center gap-1 text-[13px] font-semibold text-neutral-400 transition-colors hover:text-white"
        >
          All packs
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>

      {rows.length === 0 ? (
        <p className="mt-4 rounded-2xl border border-white/10 bg-neutral-900 px-4 py-10 text-center text-[13px] text-neutral-400">
          No packs available right now — check back soon.
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-3 lg:grid lg:grid-cols-2">
          {rows.map((pack, i) => (
            <Reveal
              key={pack.id}
              delay={i * 70}
              // The top rung leads full-width on desktop — the ladder's crown.
              className={i === 0 ? 'lg:col-span-2' : undefined}
            >
              <LadderRow
                pack={pack}
                chase={chaseByPack.get(pack.id) ?? null}
                lead={i === 0}
              />
            </Reveal>
          ))}
        </div>
      )}
    </section>
  );
}

/** One ladder rung: art · name + chase · price. */
function LadderRow({
  pack,
  chase,
  lead,
}: {
  pack: Pack;
  chase: PackCard | null;
  lead: boolean;
}) {
  const soldOut = pack.inStock === false;

  const body = (
    <>
      {/* Pack art on a neutral pedestal. Sold out dims art/name/price
          individually — never the status label, which must stay legible
          (DESIGN.md contrast floor) since it's what explains the inert row. */}
      <div
        className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white/[0.04] before:absolute before:inset-0 before:bg-[radial-gradient(circle_at_50%_38%,rgba(255,255,255,0.14),transparent_68%)] ${
          lead ? 'h-24 w-24 lg:h-32 lg:w-32' : 'h-24 w-24'
        } ${soldOut ? 'opacity-50' : ''}`}
      >
        <Image
          src={pack.image}
          alt={pack.name}
          width={128}
          height={128}
          // Pack art is operator-entered and can live on any host (not in
          // next.config remotePatterns) — bypass the optimizer like the detail
          // hero does, else /_next/image 400s and the thumbnail breaks.
          unoptimized
          className="relative h-[85%] w-auto object-contain"
        />
      </div>

      {/* Name + chase */}
      <div className="min-w-0 flex-1">
        <p
          className={`truncate font-semibold text-white ${
            lead ? 'text-base lg:text-xl' : 'text-base lg:text-lg'
          } ${soldOut ? 'opacity-50' : ''}`}
        >
          {pack.name}
        </p>
        {soldOut ? (
          <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
            Sold out
          </p>
        ) : (
          chase && (
            <p className="mt-0.5 truncate text-[11px] uppercase tracking-wide text-neutral-400">
              Top chase{' '}
              <span className="text-chase font-semibold">{chase.value}</span>
            </p>
          )
        )}
      </div>

      {/* Price, right-aligned in Nekst — the ladder's rung value. The arrow is
          the row's only affordance now: "Rip it" repeated once per rung was
          seven identical low-contrast labels down the ladder. */}
      <div className="flex shrink-0 items-center gap-3">
        <span
          className={`font-heading whitespace-nowrap text-white ${
            lead ? 'text-xl lg:text-4xl' : 'text-lg lg:text-2xl'
          } ${soldOut ? 'opacity-50' : ''}`}
        >
          {pack.price}
        </span>
        {!soldOut && (
          <ArrowRight
            // Phone rows are tap targets end to end; the arrow only costs the
            // pack name the width it needs to stop truncating.
            className="hidden h-4 w-4 shrink-0 text-neutral-600 transition-colors group-hover:text-white lg:block"
            aria-hidden
          />
        )}
      </div>
    </>
  );

  // h-full: grid cells stretch equal-height; the row must fill its cell so
  // 2-up card bottoms stay aligned if one card ever gains an extra line.
  // The crown rung gets a lit left edge so the ladder has a visible top, not
  // just a wider box: at 7 near-identical dark rows, width alone read as noise.
  const rowClass = `group flex h-full w-full items-center gap-4 rounded-2xl border p-3 ${
    lead
      ? 'border-white/15 bg-gradient-to-r from-neutral-800 via-neutral-900 to-neutral-900'
      : 'border-white/10 bg-neutral-900'
  }`;

  if (soldOut) {
    return <div className={rowClass}>{body}</div>;
  }
  return (
    <Link
      href="/slots"
      className={`${rowClass} transition-[transform,border-color] hover:border-white/30 hover:-translate-y-0.5 active:scale-[0.99] motion-reduce:transition-colors motion-reduce:hover:translate-y-0 motion-reduce:active:scale-100`}
    >
      {body}
    </Link>
  );
}
