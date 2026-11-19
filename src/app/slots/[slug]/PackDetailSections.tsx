'use client';

import { useMemo, useState } from 'react';
import Reveal from '@/components/Reveal';
import { PullHistory } from '@/components/PullHistory';
import {
  CardDetailOverlay,
  type CardSeed,
} from '@/components/cards/CardDetailOverlay';
import { SectionHead } from '@/components/ui/soft';
import type { PackDetail, RecentFeed } from '@/lib/data/packs';
import {
  FLAT_BUYBACK_PERCENT,
  isTicketPack,
  type Pack,
  type ResolvedPack,
  type Rarity,
} from '@/lib/packs-data';
import {
  publishedOddsRows,
  ticketTopHits,
  type PoolValueRange,
} from '@/lib/packs-format';
import { pullOddsOf, type PackTierRows } from '@/lib/pack-tiers';
import { isTopRarity } from '@/lib/rarity';
import { isPokemonPack } from '@/lib/resolve-card-pokemon';
import { hasPublishedOddsContent } from './OddsSheet';
import { OddsBoard } from './OddsBoard';
import { PoolByRarity } from './PoolByRarity';

/**
 * The pack page's sections below the buy controls, lifted out of
 * PackDetailClient unchanged so the homepage flow can show the same ones:
 * Top Hits, Pull Odds and Recent Pulls, each with today's gate, plus the one
 * card overlay they all open.
 *
 * `bare` drops the scroll-reveal wrapper (the flow's pinned chapters animate
 * themselves); the pack page leaves it on.
 */

type OpenCard = (card: CardSeed) => void;

function Section({
  bare,
  delay,
  className,
  children,
}: {
  bare?: boolean;
  delay?: number;
  className?: string;
  children: React.ReactNode;
}) {
  if (bare) return <section className={className}>{children}</section>;
  return (
    <Reveal as="section" delay={delay} className={className}>
      {children}
    </Reveal>
  );
}

/**
 * Top Hits, the pack page's single rail: Immortal / Legendary / Mythical (on a
 * capsule its biggest prizes), whose "By rarity" button opens the same cards
 * grouped by tier. Gated on the whole pool, not the top subset: a pack with no
 * top-tier cards still gets an entry point ("All cards"), see PoolByRarity.
 */
export function PackTopHits({
  pack,
  detail,
  onOpenCard,
  bare,
}: {
  pack: ResolvedPack;
  detail: PackDetail | null;
  onOpenCard: OpenCard;
  bare?: boolean;
}) {
  const ticketPack = isTicketPack(pack);
  // Memoized so the `?? []` fallback keeps one identity across renders.
  const pool = useMemo(() => detail?.pool ?? [], [detail?.pool]);
  // Order inherited (the pool is value-sorted, desc).
  const topPool = useMemo(
    () =>
      ticketPack
        ? ticketTopHits(pool)
        : pool.filter((c) => isTopRarity(c.rarity)),
    [ticketPack, pool],
  );
  // Read into a local: see the note on `expectedValue` in PackDetailClient's
  // history (the React Compiler and property dependencies).
  const pullOdds = detail?.publishedOdds?.tiers ?? null;
  if (pool.length === 0) return null;
  return (
    <Section bare={bare}>
      <PoolByRarity
        // A new pack's row starts at its first card, dialog closed.
        key={pack.id}
        rail={topPool}
        full={pool}
        tierChances={pullOdds}
        onOpen={(card) => onOpenCard(card)}
        pokemon={isPokemonPack(pack.categoryId)}
      />
    </Section>
  );
}

/**
 * Pull Odds (by rarity): the board of staff-entered rates, from the tier
 * projection (lib/pack-tiers). A pack without pull odds shows no board, nor
 * does one whose odds carry no tier rows AND nothing priced (a bare heading
 * over an empty box): `hasPublishedOddsContent`. The projection leaves the
 * pack's range null without pull odds, which is what keeps that rule here.
 *
 * `counts` adds each tier's card count (the homepage flow's summary rows);
 * the pack page leaves it off.
 */
export function PackPullOdds({
  pack,
  tiers,
  counts = false,
  bare,
}: {
  pack: Pick<Pack, 'prizeType'>;
  tiers: PackTierRows | null;
  counts?: boolean;
  bare?: boolean;
}) {
  if (!tiers) return null;
  const tickets = isTicketPack(pack);
  const rows = publishedOddsRows({ tiers: pullOddsOf(tiers.tiers) });
  if (!hasPublishedOddsContent(rows, tiers.range)) return null;
  const tierRanges: Partial<Record<Rarity, PoolValueRange>> = {};
  const tierCounts: Partial<Record<Rarity, number>> = {};
  for (const t of tiers.tiers) {
    if (t.range) tierRanges[t.rarity] = t.range;
    tierCounts[t.rarity] = t.count;
  }
  return (
    <Section bare={bare} className="min-w-0">
      <OddsBoard
        heading={
          <SectionHead
            eyebrow={
              rows.length > 0
                ? `${rows.length} ${rows.length === 1 ? 'tier' : 'tiers'}`
                : undefined
            }
            title="Pull Odds (by rarity)"
          />
        }
        odds={rows}
        range={tiers.range}
        expectedValue={tiers.ev}
        tierRanges={tierRanges}
        tickets={tickets}
        tierCounts={counts ? tierCounts : undefined}
      />
    </Section>
  );
}

/**
 * THIS pack's pull history, seeded from the server snapshot, then polled so
 * anyone's pull shows up without a reload. Not on a Draft: its ledger isn't
 * public, and the feed proxy answers an unlisted slug with the global feed.
 */
export function PackRecentPulls({
  pack,
  initial,
  onOpenCard,
  bare,
}: {
  pack: Pick<Pack, 'id' | 'draft' | 'prizeType'>;
  initial: RecentFeed;
  onOpenCard?: OpenCard;
  bare?: boolean;
}) {
  if (pack.draft) return null;
  return (
    <Section bare={bare} delay={90} className="min-w-0">
      <PullHistory
        // A new pack's history: its own seed, the tier filter back on All.
        key={pack.id}
        variant="board"
        heading={
          <SectionHead
            eyebrow={
              <>
                {/* White dot: live is not a money signal, so no green
                    (Signal Rule). The home feed's LIVE pill, same dot. */}
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 animate-pulse rounded-full bg-white motion-reduce:animate-none"
                />
                Live
              </>
            }
            title="Recent Pulls"
          />
        }
        initial={initial}
        packSlug={pack.id}
        // A feed row IS a card seed (one view). Its pokemonDex/spriteImage are
        // null: /store/pulls/recent doesn't send them.
        onSelect={onOpenCard}
        noun={isTicketPack(pack) ? 'capsule' : 'pack'}
      />
    </Section>
  );
}

/** The card open over the page, cleared when the page moves to another pack
 *  (the pack page switches packs in place). */
export function usePackCardOverlay(packId: string) {
  const [card, setCard] = useState<CardSeed | null>(null);
  const [cardFor, setCardFor] = useState(packId);
  if (cardFor !== packId) {
    setCardFor(packId);
    setCard(null);
  }
  return { card, open: setCard as OpenCard, close: () => setCard(null) };
}

export type PackCardOverlayState = ReturnType<typeof usePackCardOverlay>;

/** The one CardDetailOverlay every section opens. */
export function PackCardOverlay({
  pack,
  overlay,
}: {
  pack: Pick<Pack, 'buybackPercent'> & { categoryId: string };
  overlay: PackCardOverlayState;
}) {
  return (
    <CardDetailOverlay
      seed={overlay.card}
      buybackPercent={pack.buybackPercent ?? FLAT_BUYBACK_PERCENT}
      onClose={overlay.close}
      pokemon={isPokemonPack(pack.categoryId)}
    />
  );
}
