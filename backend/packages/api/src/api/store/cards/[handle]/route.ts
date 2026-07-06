import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import PacksModuleService from '../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../modules/packs';
import { toMoney } from '../../../../modules/packs/money';
import {
  DEFAULT_MARKET_MULTIPLIER,
  displayMarketPrice,
  resolveFxRate,
} from '../../../../modules/packs/pricing';

const HISTORY_DAYS = 30;
const HISTORY_MAX_ROWS = 60;

// GET /store/cards/:handle — public display fields for ONE card, powering the
// storefront card-detail view (deep links + the 60s price refresh).
//
// Same live display seam as /store/packs/:slug: marketPriceMyr = raw USD FMV ×
// FX × the card's own admin markup, computed at request time. History rows
// store raw USD only, so each point is converted with the CURRENT fx/markup —
// the sparkline shows FMV movement in today's RM terms and its last point
// matches marketPriceMyr.
//
// 🔒 SECRET ODDS: the odds row is read ONLY for its display rarity (rarity is
// a pack-level property; the card's tier in its pack). `weight` never leaves.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const { handle } = req.params;

  const [card] = await packs.listCards({ handle }, { take: 1 });
  if (!card) {
    res.status(404).json({ message: `Card '${handle}' not found` });
    return;
  }

  const fxRate = await resolveFxRate(packs);
  const multiplier = Number(
    card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER,
  );
  const toMyr = (usd: unknown) =>
    displayMarketPrice(toMoney(usd), fxRate, multiplier);

  // Rarity fallback for deep links — the first pack this card appears in
  // (created_at ASC pins "first" deterministically; unordered, the displayed
  // rarity could vary between requests when a card sits in multiple packs).
  // When the view is opened FROM a pack/vault/feed, that context's rarity wins
  // client-side; this value only covers direct /card/<handle> visits.
  const [oddsRow] = await packs.listPackOdds(
    { card_id: handle },
    { take: 1, order: { created_at: 'ASC' } },
  );

  const since = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const history = await packs.listCardPriceHistories(
    { card_id: card.id, created_at: { $gte: since } },
    { take: HISTORY_MAX_ROWS, order: { created_at: 'ASC' } },
  );

  res.json({
    card: {
      handle: card.handle,
      name: card.name,
      set: card.set,
      grader: card.grader,
      grade: card.grade,
      image: card.image,
      rarity: oddsRow?.rarity ?? null,
      marketPriceMyr: toMyr(card.market_value),
      pcSyncedAt: card.pc_synced_at ?? null,
      priceHistory: history.map((h) => ({
        date: h.created_at,
        valueMyr: toMyr(h.value),
      })),
    },
  });
}
