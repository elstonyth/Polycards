'use client';

import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Maximize2, X } from 'lucide-react';
import type { PackCard, Rarity } from '@/lib/packs-data';
import { rarityRgb, RARITY_ORDER } from '@/lib/rarity';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { useLiquidGlass, GLASS_SUBTLE } from '@/lib/use-liquid-glass';
import { CardTile } from '@/components/cards/CardTile';

const TEASER_COUNT = 6;

/**
 * "Cards in this pack" — the caller pre-filters the pool to Rare+ (commons/
 * uncommons are catalogue noise there). The section itself is ONE horizontally-
 * swipeable teaser rail of the top TEASER_COUNT cards (pool arrives value-
 * sorted desc) — the catalog's rail idiom, per the 90scard reference. The
 * header's expand button and the "Show all N rare cards" button both open a
 * full-screen dialog listing the whole Rare+ pool grouped by canonical tier
 * (rarest first) as a grid. Group headers carry the rarity dot + count and,
 * when the admin published odds, that tier's pull chance (the same data the
 * odds panel shows; nothing invented).
 */
export function PoolByRarity({
  pool,
  tierChances,
  onOpen,
}: {
  /** Pre-filtered (Rare+) public prize pool, value-sorted. */
  pool: PackCard[];
  /** Admin-published per-tier chances; null = this pack has no published odds. */
  tierChances: Partial<Record<Rarity, number>> | null;
  onOpen: (card: PackCard) => void;
}) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="mb-1 flex items-center justify-between gap-3">
          <h2 className="font-heading text-lg font-bold tracking-tight text-white">
            Cards in this pack
          </h2>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            aria-haspopup="dialog"
            aria-label={`Show all ${pool.length} rare cards`}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Maximize2 className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <p className="text-[13px] text-white/70">
          The rarest cards in this pack and their current market price.
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
          halos overlap across the gap and blend into one smooth glow. */}
      <div className="-mx-4 -my-12 flex gap-2 overflow-x-auto px-10 py-12 sm:gap-3 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {pool.slice(0, TEASER_COUNT).map((c) => (
          <div key={c.id} className="w-[38%] shrink-0 sm:w-40">
            <CardTile
              card={c}
              sizes="(max-width: 640px) 38vw, 160px"
              onOpen={onOpen}
            />
          </div>
        ))}
      </div>
      {pool.length > TEASER_COUNT && (
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          aria-haspopup="dialog"
          className="mx-auto flex min-h-11 items-center gap-1 text-[13px] font-semibold text-white/70 transition-colors hover:text-white"
        >
          Show all {pool.length} rare cards
          <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
        </button>
      )}
      <PoolModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        pool={pool}
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
        aria-label="Cards in this pack"
        tabIndex={-1}
        className="glass-panel max-h-[85vh] w-full overflow-y-auto rounded-t-2xl border-t p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] outline-none sm:max-w-2xl sm:rounded-2xl sm:border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-heading text-lg font-bold tracking-tight text-white">
            Cards in this pack
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
