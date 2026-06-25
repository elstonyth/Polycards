import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import PacksModuleService from '../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../modules/packs';
import {
  cardByHandle,
  makeRarityOf,
} from '../../../../modules/packs/card-view';
import { toMoney } from '../../../../modules/packs/money';

// GET /store/pulls/recent — the most recent pulls across all packs, for the
// "Recent Pulls" live feed on /claw/[slug]. A plain publishable-key-scoped store
// route (no customer auth): it is a PUBLIC feed, so it deliberately exposes only
// the won card + when it was rolled — NEVER customer_id (no PII leak). Each pull
// is joined to its Card by handle; orphaned rows (card removed) are dropped.
const RECENT_LIMIT = 12;

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);

  const pulls = await packs.listPulls(
    // ponytail: $ne filter mirrors the leaderboard SQL exclusion — reward prizes
    // are private vault items, not public feed entries.
    { source: { $ne: 'reward' } } as Parameters<typeof packs.listPulls>[0],
    { order: { rolled_at: 'DESC' }, take: RECENT_LIMIT },
  );

  const handles = [...new Set(pulls.map((p) => p.card_id))];
  const cards = handles.length
    ? await packs.listCards({ handle: handles }, { take: handles.length })
    : [];
  const byHandle = cardByHandle(cards);

  // Rarity is PER-PACK (PackOdds) — join each pull to its (pack, card) odds row.
  // Pulls whose odds row was since removed fall back to Common rather than
  // vanishing from the feed (the storefront drops unknown-rarity rows).
  const oddsRows = handles.length
    ? await packs.listPackOdds({ card_id: handles }, { take: 1000 })
    : [];
  const rarityOf = makeRarityOf(oddsRows);

  const recent = pulls
    .map((p) => {
      const card = byHandle.get(p.card_id);
      if (!card) return null;
      return {
        handle: card.handle,
        name: card.name,
        rarity: rarityOf(p.pack_id, p.card_id),
        // market_value is a BigNumber — normalize to a JSON number (USD decimal).
        market_value: toMoney(card.market_value),
        image: card.image,
        // pack the card came from (= Pack.slug) — for the feed's pack label.
        // Still NO customer_id: the feed stays PII-free.
        pack_id: p.pack_id,
        rolled_at: p.rolled_at,
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  res.json({ pulls: recent });
}
