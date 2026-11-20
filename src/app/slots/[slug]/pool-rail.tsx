'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { ticketCount, type PackCard } from '@/lib/packs-data';
import { rarityRgb } from '@/lib/rarity';
import { useDragScroll } from '@/lib/use-drag-scroll';
import { rankLabel } from '@/components/cards/CardTile';
import { TicketArt } from '@/components/TicketArt';
import { cn } from '@/lib/utils';
import { SPRING } from '@/components/ui/soft';

/**
 * The swipeable row's parts, shared by the pack page's Top Hits rail
 * (PoolByRarity) and the homepage flow's tier walk (PackTierWalk): the row's
 * scrolling (`useStrip`), its edge fade, the previous / next buttons and the
 * ticket prize tile. Moved here unchanged from PoolByRarity, where they were
 * private.
 */

/** A tier's own light behind its prize: plain gradient, no filter (Glow Is
 *  Earned: the colour is the card's rarity and nothing else). */
export const tierLight = (rgb: string) =>
  `radial-gradient(60% 70% at 50% 45%, rgba(${rgb}, 0.22), transparent 72%)`;

/** Tiles rendered before the strip is reached: past a phone's first screen,
 *  and the rest are ~30 tiles of HTML and hydration on every pack page view. */
export const RAIL_FIRST_TILES = 7;

export type Edges = { prev: boolean; next: boolean };

/** How deep the row's edge fade runs at most (see edgeFade). The arrow step
 *  and the strip's scroll padding clear the same distance. */
export const FADE_PX = 56;

/** Fades the side of the row that has more behind it, so a cut-off tile reads
 *  as "keeps going" and not as a clipped layout. */
export const edgeFade = ({ prev, next }: Edges) => {
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
export function useStrip<T extends HTMLElement = HTMLDivElement>(
  count: number,
) {
  const drag = useDragScroll<T>();
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
export function StripArrow({
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
export function TicketTile({
  card,
  rank,
}: {
  card: Pick<PackCard, 'rarity' | 'tickets'>;
  rank?: number;
}) {
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
