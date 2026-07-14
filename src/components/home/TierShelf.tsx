import Link from 'next/link';
import Image from 'next/image';
import { ArrowRight } from 'lucide-react';
import Reveal from '@/components/Reveal';
import { groupPacksByTier } from '@/lib/home-shelf';
import { TIER_COLOR, type Tier } from '@/lib/price-tier';
import type { Pack, PackCard } from '@/lib/packs-data';

/**
 * Board 02 — RIP A PACK, as a tier LADDER: one full-width row per pack,
 * highest tier first, so a one-pack-per-tier catalog reads as a price ladder
 * instead of five near-empty racks. The top row leads full-width on desktop;
 * the rest sit two-up. Every row → /slots (routing rule); sold out is inert.
 */
export default function TierShelf({
  packs,
  chaseByPack,
}: {
  packs: Pack[];
  chaseByPack: Map<string, PackCard | null>;
}) {
  // Ladder order: tier high→low, catalog order within a tier.
  const rows = groupPacksByTier(packs).flatMap((rack) =>
    rack.packs.map((pack) => ({ pack, tier: rack.tier })),
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
          {rows.map((row, i) => (
            <Reveal
              key={row.pack.id}
              delay={i * 70}
              // The top tier leads full-width on desktop — the ladder's crown.
              className={i === 0 ? 'lg:col-span-2' : undefined}
            >
              <LadderRow
                pack={row.pack}
                tier={row.tier}
                chase={chaseByPack.get(row.pack.id) ?? null}
                lead={i === 0}
              />
            </Reveal>
          ))}
        </div>
      )}
    </section>
  );
}

/** One ladder rung: art · tier chip + name + chase · price. */
function LadderRow({
  pack,
  tier,
  chase,
  lead,
}: {
  pack: Pack;
  tier: Tier;
  chase: PackCard | null;
  lead: boolean;
}) {
  const soldOut = pack.inStock === false;
  const rgb = TIER_COLOR[tier];

  const body = (
    <>
      {/* Pack art on its own tier-tinted pedestal */}
      <div
        className={`flex shrink-0 items-center justify-center rounded-xl ${
          lead ? 'h-24 w-24 lg:h-32 lg:w-32' : 'h-24 w-24'
        }`}
        style={{ backgroundColor: `rgba(${rgb}, 0.08)` }}
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
          className="h-[85%] w-auto object-contain"
        />
      </div>

      {/* Name + tier + chase */}
      <div className="min-w-0 flex-1">
        <span
          className="inline-block rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em]"
          style={{
            color: `rgb(${rgb})`,
            backgroundColor: `rgba(${rgb}, 0.12)`,
          }}
        >
          {tier}
        </span>
        <p
          className={`mt-1.5 truncate font-semibold text-white ${
            lead ? 'text-[15px] lg:text-lg' : 'text-[15px]'
          }`}
        >
          {pack.name}
        </p>
        {soldOut ? (
          <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
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

      {/* Price, right-aligned in Nekst — the ladder's rung value */}
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <span
          className={`font-heading whitespace-nowrap text-white ${
            lead ? 'text-2xl lg:text-3xl' : 'text-2xl'
          }`}
        >
          {pack.price}
        </span>
        {!soldOut && (
          <span className="flex items-center gap-1 text-[11px] font-semibold text-neutral-400">
            Rip it <ArrowRight className="h-3 w-3" aria-hidden />
          </span>
        )}
      </div>
    </>
  );

  const rowClass =
    'flex w-full items-center gap-4 rounded-2xl border bg-neutral-900 p-3';
  const rowStyle = { borderColor: `rgba(${rgb}, 0.4)` };

  if (soldOut) {
    return (
      <div className={`${rowClass} opacity-50`} style={rowStyle}>
        {body}
      </div>
    );
  }
  return (
    <Link
      href="/slots"
      className={`${rowClass} transition-[transform,border-color] hover:border-white/30 active:scale-[0.99] motion-reduce:transition-colors motion-reduce:active:scale-100`}
      style={rowStyle}
    >
      {body}
    </Link>
  );
}
