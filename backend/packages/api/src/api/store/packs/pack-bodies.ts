import PacksModuleService from '../../../modules/packs/service';
import {
  cardByHandle,
  compositionGroup,
  toCardView,
} from '../../../modules/packs/card-view';
import { normalizePublishedOdds } from '../../../workflows/steps/create-pack';
import { toMoney } from '../../../modules/packs/money';
import { pageAll } from '../../utils/page-all';
import { demoTierSplit } from '../../../modules/packs/odds-sets';
import { ticketOddsRows } from '../../../modules/packs/ticket-spin';
import {
  DEFAULT_MARKET_MULTIPLIER,
  displayMarketPrice,
  resolveFxRate,
} from '../../../modules/packs/pricing';

// What a catalog row and a pack page say about a pack. Shared by the public
// routes (GET /store/packs[/:slug], which only ever read active packs and cache
// the result) and the draft preview (GET /store/customers/me/draft-packs[/:slug],
// per customer and never cached), so a draft a tester sees is the page a customer
// gets once it goes live. These bodies hold no draw weight either way.

type PackRow = Awaited<ReturnType<PacksModuleService['listPacks']>>[number];

export async function catalogRows(
  packsModuleService: PacksModuleService,
  packs: PackRow[],
) {
  // §2.4.8 composition — ONE grouped scan (packPoolComposition) rather than
  // paging every odds row and every card in to fold in Node; it applies the
  // same reward-row + orphan skip-set and the same isGraded/isPsa10 the admin
  // list's poolComposition does, so the two can never disagree.
  // `psa10` is the stricter guarantee gate: the storefront's "Guaranteed
  // PSA 10" section requires EVERY pooled card to be a PSA 10 — an all-graded
  // pack holding a PSA 9 or a BGS slab is GRADED but NOT psa10, so the
  // heading can never overclaim.
  const comp = await packsModuleService.packPoolComposition();
  const groupOf = (slug: string): 'GRADED' | 'RAW' | 'MIX' | null => {
    const t = comp.get(slug);
    return compositionGroup(t?.graded ?? 0, t?.total ?? 0);
  };
  const psa10Of = (slug: string): boolean => {
    const t = comp.get(slug);
    return t !== undefined && t.total > 0 && t.psa10 === t.total;
  };
  // Explicit public shape — `price` is bigNumber now, so a raw spread would
  // leak the internal `raw_price` jsonb sidecar (and id/timestamps) into a
  // public payload. `price` serializes as a JSON number (RM — all pack
  // prices and ledger money are Ringgit).
  return packs.map((p) => ({
    slug: p.slug,
    title: p.title,
    category: p.category,
    prize_type: p.prize_type,
    price: p.price,
    image: p.image,
    display_image: p.display_image ?? null,
    boost: p.boost,
    buyback_percent: p.buyback_percent,
    in_stock: p.in_stock,
    group: groupOf(p.slug),
    psa10: psa10Of(p.slug),
    rank: p.rank,
    status: p.status,
  }));
}

export async function packDetailBody(
  packsModuleService: PacksModuleService,
  pack: PackRow,
) {
  const slug = pack.slug;
  // Explicit public shape — `price` is bigNumber now, so a raw `pack` spread
  // would leak the internal `raw_price` jsonb sidecar into a public payload.
  const publicPack = {
    slug: pack.slug,
    title: pack.title,
    category: pack.category,
    prize_type: pack.prize_type,
    price: toMoney(pack.price),
    image: pack.image,
    boost: pack.boost,
    buyback_percent: pack.buyback_percent,
    in_stock: pack.in_stock,
    rank: pack.rank,
    status: pack.status,
  };

  // A ticket pack's pool is one row per amount, with no card join and, as below,
  // no weight. The published odds work as on a card pack. No demo_odds: with one
  // row per tier, set 3's tier split would be the real rate of each amount, so the
  // guest demo falls back to the published odds.
  if (pack.prize_type === 'tickets') {
    const prizes = await pageAll((opts) =>
      packsModuleService.listTicketPrizes({ pack_id: slug }, opts),
    );
    return {
      prize_type: pack.prize_type,
      pack: publicPack,
      odds: ticketOddsRows(prizes),
      published_odds: normalizePublishedOdds(pack.published_odds),
      demo_odds: null,
    };
  }

  // PAGED so the public prize pool renders in full for a 2000+ card pack (the
  // rarity-odds summary counts every row; a cap would skew the displayed mix).
  const allOdds = await pageAll((opts) =>
    packsModuleService.listPackOdds({ pack_id: slug }, opts),
  );
  // Public card-odds view — reward rows (card_id null) are not cards and must
  // not appear. Narrows card_id to string for the card join below.
  const odds = allOdds.filter(
    (o): o is typeof o & { card_id: string } => o.card_id != null,
  );

  const cardHandles = odds.map((o) => o.card_id);
  const cards = cardHandles.length
    ? await packsModuleService.listCards(
        { handle: cardHandles },
        { take: cardHandles.length },
      )
    : [];
  const byHandle = cardByHandle(cards);

  // Join each odds row to its card; drop orphaned odds whose card is missing.
  // rarity comes from the odds row — the card's tier IN THIS PACK. o.weight
  // (the secret win rate) is intentionally NOT included.
  //
  // marketPriceMyr = raw USD FMV × FX × the card's own multiplier, computed at
  // request time — the same live display seam as open/vault/recent-pulls, so
  // the daily PriceCharting sync reaches Top Hits within one cache window
  // (≤30s, per the public route's packCache), no explicit bust needed.
  const fxRate = await resolveFxRate(packsModuleService);
  const entries = odds
    .map((o) => {
      const card = byHandle.get(o.card_id);
      return card
        ? {
            ...toCardView(card, o.rarity ?? 'Common'),
            // Admin-picked Top Hit order (display only — not draw data).
            // 1-based; null = not a Top Hit.
            top_hit_order: o.top_hit_order ?? null,
            // The card's CONFIGURED pixel-Pokémon (mirror of its linked library
            // entry) — non-secret display data, so the slot reel can flicker the
            // pack's ACTUAL configured Pokémon (e.g. a card linked to Mewtwo)
            // rather than a name-derived guess or a hardcoded decoy set.
            pokemon_dex: card.pokemon_dex ?? null,
            sprite_image: card.sprite_image ?? null,
            marketPriceMyr: displayMarketPrice(
              toMoney(card.market_value),
              fxRate,
              Number(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
            ),
          }
        : null;
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  // GUEST DEMO ODDS — odds SET 3, aggregated per rarity tier.
  //
  // The logged-out demo spin (/slots/:slug/spin?demo=1) samples client-side and
  // used to roll the PUBLISHED display odds, which are marketing copy, not a
  // real distribution. The operator wants the demo to feel like the real thing,
  // so it rolls set 3's actual weights (weight_3 → weight_2 → weight, the same
  // fallback a set-3 player's spin resolves).
  //
  // 🔒 Aggregated on purpose: only the TIER split leaves the backend, the same
  // GRAIN as published_odds — true numbers instead of authored ones. The exact
  // bound (single-card tiers, and why a pack with no set-3 overrides publishes
  // NOTHING rather than set 1) is documented on demoTierSplit; docs/adr/
  // 0001-demo-spin-set-3-odds.md records the decision. Normalized over the CARD
  // rows this response already exposes, so it describes the demo's pool exactly
  // (reward rows can't be drawn in a demo).
  const demoTiers = demoTierSplit(
    odds.filter((o) => byHandle.has(o.card_id)), // same rows as `entries` above
  );
  // Same { tiers } shape as published_odds so the storefront reuses one parser.
  // null when nothing is pullable, or when set 3 is indistinguishable from what
  // default players roll — the demo then falls back to the published odds.
  const demoOdds = demoTiers ? { tiers: demoTiers } : null;

  return {
    prize_type: pack.prize_type,
    pack: publicPack,
    odds: entries,
    // The PUBLIC odds display ({ overall, tiers } percentages, admin-authored).
    // This is the ONLY odds data customers ever see — deliberately decoupled
    // from the secret per-card weights above. Null = not set (panel hidden).
    // Normalized: storage null-fills the tiers (json-merge guard) and the
    // public payload must not carry those nulls.
    published_odds: normalizePublishedOdds(pack.published_odds),
    // Set-3 tier split for the guest demo spin only (see above).
    demo_odds: demoOdds,
  };
}
