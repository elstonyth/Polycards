'use client';

import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, X } from 'lucide-react';
import type { PackCard, Rarity } from '@/lib/packs-data';
import { rarityRgb, RARITY_ORDER } from '@/lib/rarity';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { useLiquidGlass, GLASS_SUBTLE } from '@/lib/use-liquid-glass';
import { useDragScroll } from '@/lib/use-drag-scroll';
import { CardTile } from '@/components/cards/CardTile';

/**
 * "Rare & above" — the caller pre-filters the RAIL to Rare+ (commons/uncommons
 * are catalogue noise there). The rail is ONE horizontally-swipeable strip of
 * the Rare+ subset (value-sorted desc, so the top hits lead) — the catalog's
 * rail idiom, per the 90scard reference. The header's expand button opens a
 * full-screen dialog listing the FULL pack pool (every tier, including
 * Common/Uncommon) grouped by canonical tier (rarest first) as a grid — this
 * is the only surface on the page that lists the whole pool, so its "show all
 * N" count and value range must match the full pool, not the Rare+ rail.
 * Group headers carry the rarity dot + count and, when the admin published
 * odds, that tier's pull chance (the same data the odds panel shows; nothing
 * invented).
 *
 * A save-only Common/Uncommon pack has an EMPTY Rare+ rail but a non-empty
 * `full` pool — the caller still renders this component (gated on `pool`,
 * not `topPool`; see PackDetailClient's note) so the odds panel's full-pool
 * value ranges have something to point at. When `rail` is empty there is
 * nothing to tease, so the rail strip is skipped entirely and the header
 * relabels to "All cards" / "Every card in this pack." — the expand button
 * (and everything it opens) stays exactly as-is either way.
 */
export function PoolByRarity({
  rail,
  full,
  tierChances,
  onOpen,
}: {
  /** Rare+ subset for the teaser rail, value-sorted. */
  rail: PackCard[];
  /** FULL pack pool (every tier) for the expand dialog. */
  full: PackCard[];
  /** Admin-published per-tier chances; null = this pack has no published odds. */
  tierChances: Partial<Record<Rarity, number>> | null;
  onOpen: (card: PackCard) => void;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  // Mouse drag-to-scroll on the rail (touch swipes natively).
  const drag = useDragScroll<HTMLDivElement>();
  const hasRail = rail.length > 0;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="mb-1 flex items-center justify-between gap-3">
          <h2 className="font-heading text-lg font-bold tracking-tight text-white">
            {hasRail ? 'Rare & above' : 'All cards'}
          </h2>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            aria-haspopup="dialog"
            aria-label={`Show all ${full.length} cards grouped by rarity`}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Maximize2 className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <p className="text-[13px] text-white/70">
          {hasRail
            ? 'The Rare-and-up cards available in this pack.'
            : 'Every card in this pack.'}
        </p>
      </div>
      {/* Teaser rail — a peeking partial card signals the sideways swipe;
          hidden scrollbar matches the catalog rails. overflow-x-auto forces
          overflow-y to compute to `auto` (CSS coupling), which clips each
          slab's tier halo (box-shadow) on ALL four sides (the glow is an
          offset-0 shadow, ~44px each way — the radius lives in glowStyle() in
          src/components/SlabImage.tsx; keep this padding in sync with it).
          overflow clips at the PADDING edge, so the halo room lives in the
          padding: py-12/px-10 give it. -my-12 fully cancels the vertical
          padding (no layout shift). -mx-4 is capped at the px-fluid gutter so
          the rail never triggers page x-scroll on narrow viewports; it only
          partly cancels px-10, leaving a small leading indent — the trade for
          a fully-lit first card without horizontal overflow. Adjacent cards'
          halos overlap across the gap and blend into one smooth glow.
          Skipped entirely when the pack has no Rare+ cards — an empty strip
          would still eat the halo padding for nothing to tease. */}
      {hasRail && (
        <div
          {...drag}
          className="-mx-4 -my-12 flex cursor-grab gap-2 overflow-x-auto px-10 py-12 active:cursor-grabbing sm:gap-3 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {rail.map((c) => (
            <div key={c.id} className="w-[38%] shrink-0 sm:w-40">
              <CardTile
                card={c}
                sizes="(max-width: 640px) 38vw, 160px"
                onOpen={onOpen}
              />
            </div>
          ))}
        </div>
      )}
      <PoolModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        pool={full}
        tierChances={tierChances}
        onOpen={onOpen}
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
  tierChances,
  onOpen,
}: {
  open: boolean;
  onClose: () => void;
  pool: PackCard[];
  tierChances: Partial<Record<Rarity, number>> | null;
  onOpen: (card: PackCard) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, open, onClose);

  // Liquid-glass rim on the sheet panel (frosted fallback on Safari/Firefox).
  useLiquidGlass(panelRef, open, GLASS_SUBTLE);

  if (!open) return null;

  // Bucket by canonical tier, rarest first. No unknown-rarity fallback is
  // needed: the store route's OddsEntrySchema refines `rarity` through
  // isRarity and parseList drops the rows that fail (src/lib/data/schemas.ts),
  // so every card reaching here is already typed to a known tier.
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
        aria-label="All cards"
        tabIndex={-1}
        className="glass-panel max-h-[85vh] w-full overflow-y-auto rounded-t-2xl border-t p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] outline-none sm:max-w-2xl sm:rounded-2xl sm:border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-heading text-lg font-bold tracking-tight text-white">
            All cards
            <span className="ml-2 text-[13px] font-normal tabular-nums text-white/50">
              {pool.length} cards
            </span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close card list"
            className="flex h-11 w-11 items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <div className="flex flex-col gap-6">
          {groups.map(({ rarity, cards }) => {
            const rgb = rarityRgb(rarity);
            return (
              <section key={rarity} aria-label={`${rarity} cards`}>
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
                    {cards.length} {cards.length === 1 ? 'card' : 'cards'}
                  </span>
                  {typeof tierChances?.[rarity] === 'number' && (
                    <span className="ml-auto text-[12px] tabular-nums text-white/60">
                      {tierChances[rarity]}% pull chance
                    </span>
                  )}
                </div>
                {/* The slab halo (offset-0 box-shadow) bleeds past each tile;
                    inside this scroll container it clips at the panel's p-5
                    edge. Adjacent halos blend across the gaps, and the soft
                    edge loss at the panel border is an accepted trade — the
                    rail's padding hack doesn't compose with a wrapping grid. */}
                <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3">
                  {cards.map((c) => (
                    <CardTile
                      key={c.id}
                      card={c}
                      sizes="(max-width: 640px) 45vw, 200px"
                      onOpen={onOpen}
                    />
                  ))}
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
