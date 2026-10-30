import Link from 'next/link';
import Image from 'next/image';
import { ArrowRight } from 'lucide-react';
import Reveal from '@/components/Reveal';
import ShelfTabs, { ShelfHeader } from '@/components/home/ShelfTabs';
import {
  packTabs,
  packHref,
  type Pack,
  type PackCard,
  type PackCategory,
} from '@/lib/packs-data';
import { rm, rm0 } from '@/lib/format';
import { isOptimizableImage } from '@/lib/optimizable-image';

/** Display ladder: rounded price high→low; ties retain catalog order. */
export const ladderOrder = (packs: Pack[]): Pack[] =>
  [...packs].sort((a, b) => Math.round(b.priceMyr) - Math.round(a.priceMyr));

/**
 * Board 02 — RIP A PACK: one ladder per franchise (Pokémon, One Piece, …)
 * behind a category switch, so adding a franchise adds a tab, not a longer
 * list. Each ladder is one full-width row per pack, most expensive first.
 * Packs carry no rarity/tier label — just art, name, top chase, and price. The
 * top row leads full-width on desktop; the rest sit two-up. Every row → that
 * pack's own detail page (the "All packs" link is what goes to the /slots
 * index); sold out is inert.
 */
export default function TierShelf({
  categories,
  chaseByPack,
}: {
  categories: PackCategory[];
  chaseByPack: Map<string, PackCard | null>;
}) {
  const shelves = categories.filter((c) => c.packs.length > 0);

  return (
    <section
      aria-labelledby="shelf-heading"
      className="px-fluid mt-10 w-full lg:mt-14"
    >
      {shelves.length === 0 ? (
        <>
          <ShelfHeader href="/slots" />
          <p className="mt-4 rounded-2xl border border-white/10 bg-neutral-900 px-4 py-10 text-center text-[13px] text-neutral-400">
            No packs available right now — check back soon.
          </p>
        </>
      ) : (
        <ShelfTabs
          // Tab chrome only — the packs travel inside the server-rendered panels.
          categories={packTabs(categories)}
          panels={Object.fromEntries(
            shelves.map((c) => [
              c.id,
              <Ladder key={c.id} packs={c.packs} chaseByPack={chaseByPack} />,
            ]),
          )}
        />
      )}
    </section>
  );
}

/** One franchise's price ladder. */
function Ladder({
  packs,
  chaseByPack,
}: {
  packs: Pack[];
  chaseByPack: Map<string, PackCard | null>;
}) {
  return (
    <div className="mt-4 flex flex-col gap-3 lg:grid lg:grid-cols-2">
      {ladderOrder(packs).map((pack, i) => (
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
        className={`flex shrink-0 items-center justify-center rounded-xl bg-white/[0.04] ${
          lead ? 'h-24 w-24 lg:h-32 lg:w-32' : 'h-24 w-24'
        } ${soldOut ? 'opacity-50' : ''}`}
      >
        <Image
          src={pack.image}
          alt={pack.name}
          width={64}
          height={115}
          // Pack art is operator-entered and can live on any host (not in
          // next.config remotePatterns) — bypass the optimizer for remote art
          // like the detail hero does, else /_next/image 400s and the
          // thumbnail breaks. Local and own-media-host art is optimized at its
          // drawn size (~45×82 CSS px): raw 925×1666 decoded to ~6 MB each.
          unoptimized={!isOptimizableImage(pack.image)}
          className="h-[85%] w-auto object-contain"
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
              <span className="text-chase font-semibold">
                {/* getPackHighlights only ever hands over a PRICED card. */}
                {chase.priceMyr != null ? rm(chase.priceMyr) : '—'}
              </span>
            </p>
          )
        )}
      </div>

      {/* Price, right-aligned in Nekst — the ladder's rung value. The price
          steps down on phones so the pack name stops truncating to
          "Diamond Pa…" at 390px; the `Rip it →` affordance is spec'd
          (DESIGN.md §5 "Tier ladder") and stays at every width. */}
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <span
          className={`font-heading whitespace-nowrap text-white ${
            lead ? 'text-xl lg:text-3xl' : 'text-lg lg:text-2xl'
          } ${soldOut ? 'opacity-50' : ''}`}
        >
          {rm0(pack.priceMyr)}
        </span>
        {!soldOut && (
          <span className="flex items-center gap-1 text-[11px] font-semibold text-neutral-400">
            Rip it <ArrowRight className="h-3 w-3" aria-hidden />
          </span>
        )}
      </div>
    </>
  );

  // h-full: grid cells stretch equal-height; the row must fill its cell so
  // 2-up card bottoms stay aligned if one card ever gains an extra line.
  // The crown rung reads as the ladder's top through a brighter hairline, not a
  // tinted surface: in-flow cards stay matte charcoal (DESIGN.md §6).
  const rowClass = `flex h-full w-full items-center gap-4 rounded-2xl border bg-neutral-900 p-3 ${
    lead ? 'border-white/15' : 'border-white/10'
  }`;

  if (soldOut) {
    return <div className={rowClass}>{body}</div>;
  }
  return (
    // Tailwind v4 emits `translate`/`scale`, not `transform` — naming
    // `transform` here would transition the border and snap the lift.
    <Link
      // Straight to the pack the row shows, ready to rip one — same helper the
      // /slots catalog links with, so shape and slug encoding can't drift.
      href={packHref(pack.id, 1)}
      className={`${rowClass} transition-[translate,scale,border-color] hover:-translate-y-0.5 hover:border-white/30 active:scale-[0.99] motion-reduce:transition-colors motion-reduce:hover:translate-y-0 motion-reduce:active:scale-100`}
    >
      {body}
    </Link>
  );
}
