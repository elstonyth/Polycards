import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import PacksModuleService from '../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../modules/packs';
import {
  cardByHandle,
  makeRarityOf,
} from '../../../../modules/packs/card-view';
import { toMoney } from '../../../../modules/packs/money';
import {
  DEFAULT_MARKET_MULTIPLIER,
  displayMarketPrice,
  resolveFxRate,
} from '../../../../modules/packs/pricing';

// GET /store/pulls/recent — the most recent pulls across all packs, for the
// "Recent Pulls" live feed. A plain publishable-key-scoped store route (no
// customer auth). PUBLIC-feed PII policy (product decision, 2026-07-04): each
// row carries a MASKED puller display name ("Els***" — first_name only, first
// three characters; never email, never customer_id), the won card, the source
// pack's title/image, and when it was rolled. Each pull is joined to its Card
// by handle; orphaned rows (card removed) are dropped.
const RECENT_LIMIT = 12;

// "Elston" → "Els***"; blank/missing first_name → "Anonymous".
const maskName = (name: string | null | undefined): string => {
  const n = (name ?? '').trim();
  return n ? `${n.slice(0, 3)}***` : 'Anonymous';
};

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const fxRate = await resolveFxRate(packs);

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
  // Reward rows (card_id null) carry no card rarity — exclude before the lookup.
  const cardOdds = oddsRows.filter(
    (o): o is typeof o & { card_id: string } => o.card_id != null,
  );
  const rarityOf = makeRarityOf(cardOdds);

  // Pack labels — resolve title/image from the live catalog (backend is the
  // source of truth; a deleted pack degrades to nulls, not a wrong label).
  const packIds = [...new Set(pulls.map((p) => p.pack_id))];
  const packRows = packIds.length
    ? await packs.listPacks({ slug: packIds }, { take: packIds.length })
    : [];
  const packBySlug = new Map(packRows.map((p) => [p.slug, p]));

  // Masked puller names — first_name ONLY (leaderboard's PII rule), then
  // masked to 3 chars. Missing customer/first_name reads as "Anonymous".
  const customerService = req.scope.resolve(Modules.CUSTOMER);
  const customerIds = [
    ...new Set(pulls.map((p) => p.customer_id).filter((id): id is string => !!id)),
  ];
  const customers = customerIds.length
    ? await customerService.listCustomers(
        { id: customerIds },
        { take: customerIds.length },
      )
    : [];
  const firstNameById = new Map(customers.map((c) => [c.id, c.first_name]));

  const recent = pulls
    .map((p) => {
      const card = byHandle.get(p.card_id);
      if (!card) return null;
      const pack = packBySlug.get(p.pack_id);
      return {
        handle: card.handle,
        name: card.name,
        rarity: rarityOf(p.pack_id, p.card_id),
        // market_value is a BigNumber — normalize to a JSON number (USD decimal).
        market_value: toMoney(card.market_value),
        marketPriceMyr: displayMarketPrice(
          toMoney(card.market_value),
          fxRate,
          Number(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
        ),
        image: card.image,
        // pack the card came from (= Pack.slug) + live catalog label fields.
        pack_id: p.pack_id,
        pack_title: pack?.title ?? null,
        pack_image: pack?.image ?? null,
        // MASKED display name only — never customer_id/email (see header).
        who: maskName(p.customer_id ? firstNameById.get(p.customer_id) : null),
        rolled_at: p.rolled_at,
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  res.json({ pulls: recent });
}
