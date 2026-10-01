import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { toMoney } from '../../../../modules/packs/money';
import {
  DEFAULT_MARKET_MULTIPLIER,
  displayMarketPrice,
  resolveFxRate,
} from '../../../../modules/packs/pricing';
import { getCardStockByHandle } from '../../../../modules/packs/card-stock';
import { pageAll } from '../../../utils/page-all';
import { computePackListBody } from '../../../admin/packs/route';

const RARITY_ORDER = [
  'Immortal',
  'Legendary',
  'Mythical',
  'Rare',
  'Uncommon',
  'Common',
];

// GET /reports/store/pack?slug=: one pack for the Store desk, drafts included:
// the safe numbers from the admin pack list (as in /reports/store/packs), its
// pool per rarity (cards, average display price, cards with no stock left,
// untracked cards) and its top hits with their stock. Never per-card weights
// or win chances.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const slug = typeof req.query.slug === 'string' ? req.query.slug.trim() : '';
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'slug must be a pack slug, like silver-pack.',
    );
  }
  const p = (await computePackListBody(req)).packs.find((x) => x.slug === slug);
  if (!p) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, `No pack ${slug}.`);
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const odds = (
    await pageAll((opts) => packs.listPackOdds({ pack_id: slug }, opts))
  ).filter((o): o is typeof o & { card_id: string } => o.card_id != null);
  const handles = [...new Set(odds.map((o) => o.card_id))];
  const cards = handles.length
    ? await packs.listCards({ handle: handles }, { take: handles.length })
    : [];
  const fx = await resolveFxRate(packs);
  const card = new Map(
    cards.map((c) => [
      c.handle,
      {
        name: c.name,
        price: displayMarketPrice(
          toMoney(c.market_value),
          fx,
          toMoney(c.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
        ),
      },
    ]),
  );
  const stock = await getCardStockByHandle(req.scope, handles);

  const tiers = new Map<
    string,
    { cards: number; sum: number; none_left: number; untracked: number }
  >();
  for (const o of odds) {
    const c = card.get(o.card_id);
    if (!c) continue; // orphaned odds row: not in the pool
    const rarity = o.rarity ?? 'Common';
    const t = tiers.get(rarity) ?? {
      cards: 0,
      sum: 0,
      none_left: 0,
      untracked: 0,
    };
    const units = stock.get(o.card_id);
    t.cards += 1;
    t.sum += c.price;
    if (units === null || units === undefined) t.untracked += 1;
    else if (units <= 0) t.none_left += 1;
    tiers.set(rarity, t);
  }
  res.json({
    currency: 'MYR',
    pack: {
      slug: p.slug,
      title: p.title,
      category: p.category,
      status: p.status,
      sold_out_badge: !p.in_stock,
      price: Number(p.price),
      buyback_percent: p.buyback_percent,
      pool: p.group,
      published_odds: p.published_odds?.tiers ?? null,
      published_ev: p.pub_ev,
      published_rtp_pct: p.pub_rtp,
      ev: p.ev.s1,
      rtp_pct: p.rtp.s1,
    },
    by_rarity: [...tiers]
      .sort(([a], [b]) => RARITY_ORDER.indexOf(a) - RARITY_ORDER.indexOf(b))
      .map(([rarity, t]) => ({
        rarity,
        cards: t.cards,
        average_display_price: Math.round((t.sum / t.cards) * 100) / 100,
        cards_with_no_stock_left: t.none_left,
        cards_with_untracked_stock: t.untracked,
      })),
    top_hits: odds
      .filter((o) => o.top_hit_order != null && card.has(o.card_id))
      .sort((a, b) => a.top_hit_order! - b.top_hit_order!)
      .map((o) => ({
        card: card.get(o.card_id)!.name,
        handle: o.card_id,
        rarity: o.rarity ?? 'Common',
        display_price: card.get(o.card_id)!.price,
        on_hand: stock.get(o.card_id) ?? null,
      })),
    note: "Prices are display prices at today's rate. on_hand null = untracked stock; at 0 or below a card can still be drawn and buyback covers it. ev and rtp_pct are odds set 1 (what the DEFAULT group plays); the sold-out badge is display only.",
  });
}
