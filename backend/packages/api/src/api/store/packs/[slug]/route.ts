import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import PacksModuleService from '../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../modules/packs';
import { cardByHandle, toCardView } from '../../../../modules/packs/card-view';
import { toMoney } from '../../../../modules/packs/money';
import {
  DEFAULT_MARKET_MULTIPLIER,
  displayMarketPrice,
  resolveFxRate,
} from '../../../../modules/packs/pricing';

// GET /store/packs/:slug — one active pack plus its prize pool (each odds row
// joined to the referenced Card), behind /claw/[slug]'s Top Hits. A plain Medusa
// store route (publishable-key scoped, NOT subject to Mercur's seller-visibility
// product middleware), so no house-seller link is needed. 404 when the slug is
// unknown or inactive. The join is in-module by stable business keys (Pack.slug,
// Card.handle).
//
// 🔒 SECRET ODDS (Phase 6): the per-card `weight` is the real, admin-tuned win
// rate and is DELIBERATELY OMITTED from this public response — it must never
// reach the customer (visible in the network tab under the publishable key).
// Customers see a separate, static published-odds display. Only non-secret card
// display fields (incl. market_value, which drives Top Hits) are exposed here.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packsModuleService: PacksModuleService =
    req.scope.resolve(PACKS_MODULE);
  const { slug } = req.params;

  const [pack] = await packsModuleService.listPacks(
    { slug, status: 'active' },
    { take: 1 },
  );
  // reward_box packs are internal draw pools — excluded from the public catalog (B2).
  if (!pack || pack.category === 'reward_box') {
    res.status(404).json({ message: `Pack '${slug}' not found` });
    return;
  }

  const allOdds = await packsModuleService.listPackOdds(
    { pack_id: slug },
    // Explicit take so a framework default can't silently cap the prize pool.
    { take: 1000 },
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
  // the daily PriceCharting sync reaches Top Hits without any cache to bust.
  const fxRate = await resolveFxRate(packsModuleService);
  const entries = odds
    .map((o) => {
      const card = byHandle.get(o.card_id);
      return card
        ? {
            ...toCardView(card, o.rarity ?? 'Common'),
            // Admin-picked Top Hit flag (display only — not draw data).
            top_hit: o.top_hit === true,
            marketPriceMyr: displayMarketPrice(
              toMoney(card.market_value),
              fxRate,
              Number(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
            ),
          }
        : null;
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  // Explicit public shape — `price` is bigNumber now, so a raw `pack` spread
  // would leak the internal `raw_price` jsonb sidecar into a public payload.
  res.json({
    pack: {
      slug: pack.slug,
      title: pack.title,
      category: pack.category,
      price: toMoney(pack.price),
      image: pack.image,
      boost: pack.boost,
      buyback_percent: pack.buyback_percent,
      in_stock: pack.in_stock,
      rank: pack.rank,
      status: pack.status,
    },
    odds: entries,
    // The PUBLIC odds display ({ overall, tiers } percentages, admin-authored).
    // This is the ONLY odds data customers ever see — deliberately decoupled
    // from the secret per-card weights above. Null = not set (panel hidden).
    published_odds: pack.published_odds ?? null,
  });
}
