'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import { ChevronLeft, ChevronRight, LayoutGrid, X } from 'lucide-react';
import { ticketCount, type PackCard, type Rarity } from '@/lib/packs-data';
import { rarityRgb, RARITY_ORDER } from '@/lib/rarity';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { useLiquidGlass, GLASS_SUBTLE } from '@/lib/use-liquid-glass';
import { useDragScroll } from '@/lib/use-drag-scroll';
import { CardTile, rankLabel } from '@/components/cards/CardTile';
import { TicketArt } from '@/components/TicketArt';
import { cn } from '@/lib/utils';
import { SPRING, SectionHead } from '@/components/ui/soft';

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
 * Group headers carry the rarity dot + count and, when staff set Pull Odds,
 * that tier's pull chance (the same data the odds panel shows; nothing
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
  /** Pull Odds per-tier chances; null = this pack has no Pull Odds. */
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

/** A tier's own light behind its prize: plain gradient, no filter (Glow Is
 *  Earned: the colour is the card's rarity and nothing else). */
const tierLight = (rgb: string) =>
  `radial-gradient(60% 70% at 50% 45%, rgba(${rgb}, 0.22), transparent 72%)`;

/** Tiles rendered before the strip is reached: past a phone's first screen,
 *  and the rest are ~30 tiles of HTML and hydration on every pack page view. */
const RAIL_FIRST_TILES = 7;

type Edges = { prev: boolean; next: boolean };

/** How deep the row's edge fade runs at most (see edgeFade). The arrow step
 *  and the strip's scroll padding clear the same distance. */
const FADE_PX = 56;

/** Fades the side of the row that has more behind it, so a cut-off tile reads
 *  as "keeps going" and not as a clipped layout. */
const edgeFade = ({ prev, next }: Edges) => {
  if (!prev && !next) return undefined;
  const depth = `min(${FADE_PX}px, 8%)`;
  const mask = `linear-gradient(to right, transparent, #000 ${prev ? depth : '0px'}, #000 calc(100% - ${next ? depth : '0px'}), transparent)`;
  return { maskImage: mask, WebkitMaskImage: mask };
};

/**
 * The one row's scrolling: mouse drag (touch swipes natively), which sides
 * still have tiles behind them, and the arrow buttons' step.
 *
 * The row renders its first few tiles and grows on the first scroll, so a
 * fling never stops at a false end. A screen wide enough to show every tile
 * has nothing to scroll, so it grows at once.
 */
function useStrip(count: number) {
  const drag = useDragScroll<HTMLDivElement>();
  const { ref } = drag;
  const [grown, setGrown] = useState(false);
  const [edges, setEdges] = useState<Edges>({ prev: false, next: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 1) setGrown(true);
    const prev = el.scrollLeft > 1;
    const next = el.scrollLeft < max - 1;
    setEdges((e) => (e.prev === prev && e.next === next ? e : { prev, next }));
  }, [ref]);

  // Re-measured when the row grows and when the screen resizes or turns.
  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, measure, count, grown]);

  return {
    drag,
    grown,
    edges,
    onScroll: () => {
      setGrown(true);
      measure();
    },
    /**
     * A screen of tiles per press, landing on a tile's edge: the tile that was
     * cut off becomes the first whole one, clear of the fade. A fixed distance
     * would park a whole tile under the fade instead.
     */
    step: (dir: 1 | -1) => {
      const el = ref.current;
      if (!el) return;
      // Grow first: the jump is measured against the row's real length.
      if (!grown) flushSync(() => setGrown(true));
      const box = el.getBoundingClientRect();
      const tiles = Array.from(el.children, (tile) => {
        const r = tile.getBoundingClientRect();
        return {
          start: r.left - box.left + el.scrollLeft,
          end: r.right - box.left + el.scrollLeft,
        };
      });
      const clear = FADE_PX + 4;
      let from: (typeof tiles)[number] | undefined;
      if (dir === 1) {
        // Forward: the first tile the far edge cuts leads the next screen.
        from = tiles.find(
          (t) => t.end > el.scrollLeft + el.clientWidth - clear + 1,
        );
      } else {
        // Back: the nearest tile hidden (or cut) on the near side becomes the
        // last whole one, and the screen starts on the tile edge that allows.
        const last = tiles.findLast((t) => t.start < el.scrollLeft + clear - 1);
        if (!last) return;
        const earliest = last.end - el.clientWidth + clear;
        from = tiles.find((t) => t.start - clear >= earliest) ?? last;
        if (earliest <= 0) from = tiles[0];
      }
      if (!from) return;
      el.scrollTo({
        // The first tile sits flush: nothing is behind it to fade.
        left: from === tiles[0] ? 0 : from.start - clear,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
      });
    },
  };
}

/** Previous / next for the row. At an end it stays focusable but inert
 *  (`aria-disabled`), so a keyboard user's focus isn't dropped mid-row. */
function StripArrow({
  label,
  enabled,
  onClick,
  children,
}: {
  label: string;
  enabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={!enabled}
      onClick={enabled ? onClick : undefined}
      className={cn(
        'hidden h-11 w-11 items-center justify-center rounded-full bg-white/[0.06] text-white outline-none ring-1 ring-white/10 transition-[background-color,opacity,transform] duration-300 sm:flex',
        SPRING,
        'focus-visible:ring-2 focus-visible:ring-white/40 motion-reduce:transition-[background-color,opacity]',
        enabled
          ? 'hover:bg-white/10 active:scale-[0.96] motion-reduce:active:scale-100'
          : 'cursor-default opacity-40',
      )}
    >
      {children}
    </button>
  );
}

/** One ticket prize: its place, our ticket, its amount and its tier, in the
 *  card tile's tray. The tier's own light plays the slab halo's part. Not a
 *  button: an amount has no details to open. */
function TicketTile({ card, rank }: { card: PackCard; rank?: number }) {
  const rgb = rarityRgb(card.rarity);
  // Two lines on every tile, so a long amount can't make one taller than the rest.
  const [amount, unit] = ticketCount(card.tickets ?? 0).split(' ');
  return (
    <div className="h-full w-full rounded-[1.5rem] bg-white/[0.04] p-1 ring-1 ring-white/10">
      <div
        className="flex h-full flex-col items-center gap-2 rounded-[calc(1.5rem-0.25rem)] bg-neutral-950 p-3 text-center shadow-[inset_0_1px_1px_rgba(255,255,255,0.12)]"
        style={{ backgroundImage: tierLight(rgb) }}
      >
        <span className="flex w-full items-center justify-between gap-2">
          {rank != null && (
            <span className="font-heading text-xs font-bold tabular-nums text-neutral-400">
              {rankLabel(rank)}
            </span>
          )}
          {/* The tier's name stays neutral: Rare's blue is too dark to read
              as 11px text. */}
          <span
            className={cn(
              'flex items-center gap-1.5 text-[11px] font-medium text-neutral-300',
              rank == null && 'ml-auto',
            )}
          >
            <span
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{ background: `rgb(${rgb})` }}
            />
            {card.rarity}
          </span>
        </span>
        <TicketArt width={160} className="h-auto w-full" />
        <span className="flex flex-col items-center">
          <span className="font-heading text-lg font-bold leading-tight tracking-tight tabular-nums text-white">
            {amount}
          </span>{' '}
          <span className="text-[11px] leading-tight text-neutral-400">
            {unit}
          </span>
        </span>
      </div>
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
