import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import PacksModuleService from '../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../modules/packs';
import { isChallengePrizePack } from '../../../../modules/packs/challenge-prize';
import { isLuckyDrawPrizePack } from '../../../../modules/packs/lucky-draw';
import { bestLiveTierByHandle } from '../../../../modules/packs/card-tier';
import {
  cardByHandle,
  makeRarityOf,
  toCardView,
} from '../../../../modules/packs/card-view';
import { toMoney } from '../../../../modules/packs/money';
import {
  DEFAULT_MARKET_MULTIPLIER,
  displayMarketPrice,
  resolveFxRate,
} from '../../../../modules/packs/pricing';
import {
  paidPerOpen,
  pullPackTitle,
} from '../../../../modules/packs/pull-history';
import { parsePaginationParams } from '../../../../utils/pagination';
import { pageAll } from '../../../utils/page-all';

// GET /store/pulls/history — every card the customer ever pulled, whatever
// happened to it since (still vaulted, sold back, shipping, delivered), newest
// first, paged (?limit=&offset=, take limit + 1 → has_more without a count).
// The vault lists only what is still held, so before this a sold or shipped
// card vanished from every customer surface.
//
// Per row: the card, the pack it came from, what it cost (the open's charge
// split over its paid pulls — null where no charge links to it), its value
// when pulled, and the sale (buyback_amount / buyback_at are the credited
// snapshot, not a live quote).
//
// AUTH: matcher registered in src/api/middlewares.ts with authenticate(); the
// customer id comes ONLY from the verified token.
const PAGE_SIZE = 20;

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const customerId = req.auth_context.actor_id;
  const { limit, offset } = parsePaginationParams(req.query, {
    defaultLimit: PAGE_SIZE,
    maxLimit: 50,
  });

  const [rows, fx] = await Promise.all([
    // IDX_pull_customer_id_rolled_at. id tiebreaker: a batch open's pulls
    // share one rolled_at, and that alone gives no stable order across pages.
    packs.listPulls(
      { customer_id: customerId },
      {
        order: { rolled_at: 'DESC', id: 'DESC' },
        take: limit + 1,
        skip: offset,
      },
    ),
    resolveFxRate(packs),
  ]);
  const hasMore = rows.length > limit;
  const pulls = rows.slice(0, limit);

  const handles = [...new Set(pulls.map((p) => p.card_id))];
  const slugs = [...new Set(pulls.map((p) => p.pack_id))];
  const openIds = [
    ...new Set(pulls.map((p) => p.open_id).filter((id): id is string => !!id)),
  ];

  const [cards, packRows, oddsRows, charges, openPulls] = await Promise.all([
    handles.length
      ? packs.listCards({ handle: handles }, { take: handles.length })
      : Promise.resolve([]),
    slugs.length
      ? packs.listPacks({ slug: slugs }, { take: slugs.length })
      : Promise.resolve([]),
    handles.length
      ? packs.listPackOdds({ card_id: handles }, { take: 1000 })
      : Promise.resolve([]),
    openIds.length
      ? packs.listCreditTransactions(
          {
            customer_id: customerId,
            reason: 'pack_open',
            source_transaction_id: openIds,
          },
          { take: openIds.length * 2 },
        )
      : Promise.resolve([]),
    // Every pull of those opens, not just this page's: a batch open can
    // straddle a page boundary and the split needs its full paid-row count.
    openIds.length
      ? pageAll((opts) =>
          packs.listPulls(
            { customer_id: customerId, open_id: openIds },
            { ...opts, select: ['id', 'open_id', 'source'] },
          ),
        )
      : Promise.resolve([]),
  ]);

  const byHandle = cardByHandle(cards);
  const packBySlug = new Map(packRows.map((p) => [p.slug, p]));
  const paid = paidPerOpen(charges, openPulls);

  // Same tier rules as the vault: the (pack, card) odds row, except a reward
  // on a synthetic pack (no odds rows) takes the card's best live tier.
  const rarityOf = makeRarityOf(
    oddsRows.filter(
      (o): o is typeof o & { card_id: string } => o.card_id != null,
    ),
  );
  const isSyntheticReward = (p: { source?: string | null; pack_id: string }) =>
    p.source === 'reward' && !packBySlug.has(p.pack_id);
  const prizeTier = await bestLiveTierByHandle(
    packs,
    pulls
      .filter((p) => isSyntheticReward(p) && !isLuckyDrawPrizePack(p.pack_id))
      .map((p) => p.card_id),
  );

  const items = pulls.map((p) => {
    const card = byHandle.get(p.card_id);
    const multiplier = Number(
      card?.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER,
    );
    // Live price; null once the card is gone from the catalogue.
    const priceNow = card
      ? displayMarketPrice(toMoney(card.market_value), fx, multiplier)
      : null;
    return {
      pull_id: p.id,
      rolled_at: p.rolled_at,
      pack_id: p.pack_id,
      pack_title: pullPackTitle(p, packBySlug.get(p.pack_id)?.title),
      challenge_prize: isChallengePrizePack(p.pack_id),
      // No tier frame on a Lucky Draw card, as in the vault.
      lucky_draw_prize: isLuckyDrawPrizePack(p.pack_id),
      source: p.source ?? 'pack',
      status: p.status,
      // A card deleted after the pull (delete-card refuses only while copies
      // are held) keeps its row: the paid / sold-for trail outlives the
      // catalogue entry, so the history must not drop it.
      card: card
        ? {
            ...toCardView(
              card,
              isLuckyDrawPrizePack(p.pack_id)
                ? ''
                : isSyntheticReward(p)
                  ? (prizeTier.get(p.card_id) ?? '')
                  : rarityOf(p.pack_id, p.card_id),
            ),
            marketPriceMyr: priceNow,
          }
        : {
            handle: '',
            name: 'Retired card',
            image: '',
            slab_image: null,
            rarity: '',
            marketPriceMyr: null,
          },
      // RM per card from the open's charge; null = no charge links to it
      // (free, gift and reward pulls cost nothing; pre-2a opens are unknown).
      paid:
        (p.source === 'pack' || p.source === 'bonus') && p.open_id
          ? (paid.get(p.open_id) ?? null)
          : null,
      // Value when pulled: the draw-time snapshot (already × multiplier, as
      // the boards read it), else today's price — reward/free/gift pulls and
      // un-backfilled rows carry no snapshot.
      value:
        p.recorded_value_usd != null
          ? displayMarketPrice(toMoney(p.recorded_value_usd), fx, 1)
          : priceNow,
      sold_for: p.buyback_amount == null ? null : toMoney(p.buyback_amount),
      sold_at: p.buyback_at ?? null,
    };
  });

  res.json({ items, has_more: hasMore });
}
