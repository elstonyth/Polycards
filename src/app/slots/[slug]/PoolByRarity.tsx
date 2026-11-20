'use client';

import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, LayoutGrid, X } from 'lucide-react';
import type { PackCard, Rarity } from '@/lib/packs-data';
import { rarityRgb, RARITY_ORDER } from '@/lib/rarity';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { useLiquidGlass, GLASS_SUBTLE } from '@/lib/use-liquid-glass';
import { CardTile } from '@/components/cards/CardTile';
import { cn } from '@/lib/utils';
import { SPRING, SectionHead } from '@/components/ui/soft';
import {
  RAIL_FIRST_TILES,
  StripArrow,
  TicketTile,
  edgeFade,
  useStrip,
} from './pool-rail';

/**
 * The default header (`view.title` below) — the caller pre-filters the RAIL
 * to the top three tiers (Immortal/Legendary/Mythical — lower tiers are
 * catalogue noise there). The subset is value-sorted desc and shown as ONE
 * horizontally-swipeable row of ranked tiles (01, 02, …): every top hit is on
 * the page, the most valuable first. Where the row runs past the screen its far
 * side fades and, from tablet up, the header gains previous / next buttons (owner
 * decision 2026-11-18: one row, no card set apart above it). A row short enough
 * to fit shares the width out instead. The header's "By rarity" button opens a
 * full-screen dialog listing the SAME top-tier subset grouped by canonical
 * tier (rarest first) as a grid — operator decision 2026-08-08: the expanded
 * view is the rail's "see everything in this tier band" companion, and lower
 * tiers are catalogue noise there too. (This deliberately re-opens the gap
 * the round-8 display-truth pass closed: the odds panel below still quotes
 * value ranges over the FULL pool, including tiers the dialog doesn't list.
 * Operator preference wins; don't "fix" one side without asking.)
 * Group headers carry the rarity dot + count and, when the admin published
 * odds, that tier's pull chance (the same data the odds panel shows; nothing
 * invented).
 *
 * A pack with no top-tier cards has an EMPTY rail but a non-empty `full`
 * pool — the caller still renders this component (gated on `pool`, not
 * `topPool`; see PackDetailClient's note). With no top-tier subset to show,
 * the rail strip is skipped and BOTH the header and the dialog fall back to
 * the full pool ("All cards" / "Every card in this pack.") so the pool keeps
 * an entry point on the page.
 *
 * On a ticket pack the rows are ticket amounts (ticketTopHits picks the rail), so
 * a tile is a TicketTile and every string says "prize", not "card".
 */
export function PoolByRarity({
  rail,
  full,
  tierChances,
  onOpen,
  pokemon,
}: {
  /** Top-tier subset for the teaser rail, value-sorted. */
  rail: PackCard[];
  /** FULL pack pool (every tier) — the dialog's zero-top-hit fallback only; with
   *  a non-empty `rail` the dialog shows `rail` (operator decision, header note). */
  full: PackCard[];
  /** Admin-published per-tier chances; null = this pack has no published odds. */
  tierChances: Partial<Record<Rarity, number>> | null;
  onOpen: (card: PackCard) => void;
  /** false in a non-Pokémon pack: badges show only the cards' own sprites. */
  pokemon?: boolean;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const hasRail = rail.length > 0;
  const tickets = full.some((c) => c.tickets != null);
  // One derivation for every rendered string keyed on hasRail (h2, aria-label,
  // blurb, and the dialog's cards/title) -- the QA scripts key on these exact
  // strings (scripts/qa-pool-modal.mjs, qa-mobile-cards.mjs); change together.
  // Dialog shows the top-tier subset whenever one exists (operator decision,
  // see the header comment); the full pool only backs the zero-top-hit edge.
  const view = hasRail
    ? {
        title: 'Top Hits',
        blurb: tickets
          ? 'The biggest ticket prizes in this capsule.'
          : 'The top-tier cards available in this pack.',
        cards: rail,
      }
    : {
        title: tickets ? 'All prizes' : 'All cards',
        blurb: tickets
          ? 'Every ticket prize in this capsule.'
          : 'Every card in this pack.',
        cards: full,
      };
  const expandLabel = tickets
    ? `Show the ${view.cards.length} ${hasRail ? 'top ' : ''}ticket prizes grouped by rarity`
    : hasRail
      ? `Show the ${view.cards.length} top-tier cards grouped by rarity`
      : `Show all ${view.cards.length} cards grouped by rarity`;

  const noun = tickets ? 'prize' : 'card';
  const strip = useStrip(rail.length);
  const { edges } = strip;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="flex flex-col gap-2">
          <SectionHead
            eyebrow={`${view.cards.length} ${view.cards.length === 1 ? noun : `${noun}s`}`}
            title={view.title}
          />
          <p className="text-sm text-neutral-400">{view.blurb}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Only where the row runs past the screen, and not on a phone: a
              thumb swipes it, and the peeking tile already says so. */}
          {(edges.prev || edges.next) && (
            <>
              <StripArrow
                label={`Previous ${noun}s`}
                enabled={edges.prev}
                onClick={() => strip.step(-1)}
              >
                <ChevronLeft
                  className="h-4 w-4"
                  strokeWidth={1.5}
                  aria-hidden
                />
              </StripArrow>
              <StripArrow
                label={`Next ${noun}s`}
                enabled={edges.next}
                onClick={() => strip.step(1)}
              >
                <ChevronRight
                  className="h-4 w-4"
                  strokeWidth={1.5}
                  aria-hidden
                />
              </StripArrow>
            </>
          )}
          {/* Opens the same subset grouped by tier. The visible words are part
              of the label ("…grouped by rarity"), so voice control can name it. */}
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            aria-haspopup="dialog"
            aria-label={expandLabel}
            className={cn(
              'flex min-h-11 shrink-0 items-center gap-2 rounded-full bg-white/[0.06] pl-4 pr-3.5 text-[13px] font-semibold text-white outline-none ring-1 ring-white/10 transition-[background-color,transform] duration-300',
              SPRING,
              'hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/40 active:scale-[0.98] motion-reduce:transition-[background-color] motion-reduce:active:scale-100',
            )}
          >
            By rarity
            <LayoutGrid className="h-4 w-4" strokeWidth={1.5} aria-hidden />
          </button>
        </div>
      </div>
      {/* Skipped entirely when the pack has no top-tier cards: the header and
          its dialog are then the pool's whole entry point. */}
      {hasRail && (
        // The fade lives on this wrapper, not the strip: a mask on the strip
        // itself would also erase its own focus ring. 6px of room (cancelled by
        // the margin) keeps that ring inside the mask.
        <div className="-m-1.5 p-1.5" style={edgeFade(edges)}>
          <div
            {...strip.drag}
            onScroll={strip.onScroll}
            // Ticket tiles are not controls, so nothing inside the strip can
            // take focus: the strip does, and the arrow keys then scroll it.
            {...(tickets
              ? { tabIndex: 0, role: 'group', 'aria-label': 'Ticket prizes' }
              : null)}
            // A peeking partial tile signals the sideways swipe. overflow-x-auto
            // makes overflow-y compute to auto as well, which would clip a
            // tile's hover lift and its focus ring: the 4px of padding
            // (cancelled by the margin) is their room.
            // The scroll padding keeps a tile reached by Tab clear of the fade.
            className="-m-1 flex cursor-grab scroll-px-[3.75rem] gap-3 overflow-x-auto rounded-[1.75rem] p-1 outline-none focus-visible:ring-2 focus-visible:ring-white/40 active:cursor-grabbing [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {(strip.grown ? rail : rail.slice(0, RAIL_FIRST_TILES)).map(
              (c, i) => (
                // A row that fits the screen shares it out (up to a cap); a
                // longer one keeps its tile width and scrolls.
                <div
                  key={c.handle}
                  className="max-w-[60%] flex-[1_0_44%] sm:max-w-[16rem] sm:flex-[1_0_13rem]"
                >
                  {tickets ? (
                    <TicketTile card={c} rank={i + 1} />
                  ) : (
                    <CardTile
                      card={c}
                      sizes="(max-width: 640px) 45vw, 256px"
                      onOpen={onOpen}
                      pokemon={pokemon}
                      rank={i + 1}
                    />
                  )}
                </div>
              ),
            )}
          </div>
        </div>
      )}
      <PoolModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        pool={view.cards}
        title={view.title}
        tierChances={tierChances}
        onOpen={onOpen}
        pokemon={pokemon}
        tickets={tickets}
      />
    </div>
  );
}

/** The expanded pool dialog: bottom sheet on mobile, centered panel on sm+
 *  (OddsSheet's idiom). Cards tapped here open CardDetailOverlay, which sits
 *  at z-[100] — above this z-50 dialog — so the dialog stays put beneath. */
function PoolModal({
  open,
  onClose,
  pool,
  title,
  tierChances,
  onOpen,
  pokemon,
  tickets,
}: {
  open: boolean;
  onClose: () => void;
  pool: PackCard[];
  /** Dialog heading + aria-label — names what `pool` holds (the caller's `view.title`). */
  title: string;
  tierChances: Partial<Record<Rarity, number>> | null;
  onOpen: (card: PackCard) => void;
  pokemon?: boolean;
  tickets: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, open, onClose);

  // Liquid-glass rim on the sheet panel (frosted fallback on Safari/Firefox).
  useLiquidGlass(panelRef, open, GLASS_SUBTLE);

  if (!open) return null;

  // Bucket by canonical tier, rarest first. No unknown-rarity fallback is
  // needed: the store route's OddsEntrySchema refines `rarity` through
  // isRarity, and PackDetailPageSchema's droppableArray drops the rows that
  // fail (src/lib/data/schemas/packs.ts), so every card reaching here is already
  // typed to a known tier.
  const noun = tickets ? 'prize' : 'card';
  const groups = RARITY_ORDER.map((rarity) => ({
    rarity,
    cards: pool.filter((c) => c.rarity === rarity),
  })).filter((g) => g.cards.length > 0);

  // Portal to <body>: this dialog mounts inside a <Reveal> section whose
  // transform would otherwise trap position:fixed and pin the sheet to the
  // section instead of the viewport (AuthModal's pattern; `open` only flips
  // true via a client event, so createPortal is SSR-safe).
  return createPortal(
    <div
      className="glass-stage fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="glass-panel max-h-[85vh] w-full overflow-y-auto rounded-t-2xl border-t p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] outline-none sm:max-w-2xl sm:rounded-2xl sm:border [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-heading text-lg font-bold tracking-tight text-white">
            {title}
            <span className="ml-2 text-[13px] font-normal tabular-nums text-white/50">
              {pool.length} {noun}s
            </span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${noun} list`}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <div className="flex flex-col gap-6">
          {groups.map(({ rarity, cards }) => {
            const rgb = rarityRgb(rarity);
            return (
              <section key={rarity} aria-label={`${rarity} ${noun}s`}>
                <div className="mb-2 flex items-baseline gap-2">
                  <span
                    aria-hidden
                    className="h-2.5 w-2.5 self-center rounded-full"
                    style={{ background: `rgb(${rgb})` }}
                  />
                  <h3 className="text-[13px] font-semibold text-white">
                    {rarity}
                  </h3>
                  <span className="text-[12px] tabular-nums text-white/50">
                    {cards.length} {cards.length === 1 ? noun : `${noun}s`}
                  </span>
                  {typeof tierChances?.[rarity] === 'number' && (
                    <span className="ml-auto text-[12px] tabular-nums text-white/60">
                      {tierChances[rarity]}% pull chance
                    </span>
                  )}
                </div>
                {/* Each tile's plate clips its own slab halo, so nothing
                    bleeds across the gaps or past the panel's edge. */}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {cards.map((c) =>
                    tickets ? (
                      <TicketTile key={c.handle} card={c} />
                    ) : (
                      <CardTile
                        key={c.handle}
                        card={c}
                        sizes="(max-width: 640px) 45vw, 200px"
                        onOpen={onOpen}
                        pokemon={pokemon}
                      />
                    ),
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
