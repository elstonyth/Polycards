import type PacksModuleService from '../../../modules/packs/service';
import { packTheoreticalRtp } from '../../../modules/packs/economy';
import { pageAll } from '../../utils/page-all';
import { toMoney } from '../../../modules/packs/money';
import {
  displayMarketPrice,
  DEFAULT_MARKET_MULTIPLIER,
} from '../../../modules/packs/pricing';

export type EconomyPackRow = {
  slug: string;
  title: string;
  category: string;
  price: number;
  ev: number | null;
  rtp_pct: number | null;
};

// Per-pack theoretical RTP from the CURRENT odds, for GET /admin/economy and
// GET /admin/profit-report (one copy of the math). Active card packs only —
// drafts aren't sellable, so their RTP is operator-noise, and a ticket pack pays
// tickets, not card value, so it has none. EV uses each card's
// DISPLAY value (FMV × market_multiplier, default +20%) in MYR at the live
// FX rate, because that is the value buyback percents apply to (operator
// request 2026-07-23; issue #263). RTP stays like-for-like: MYR EV ÷ MYR
// pack price. Sorted highest RTP first.
export async function packRtpRows(
  packs: PacksModuleService,
  fx: number,
): Promise<EconomyPackRow[]> {
  const allCards = await pageAll((opts) => packs.listCards({}, opts));
  const valueByHandle = new Map(
    allCards.map((c) => [
      c.handle,
      displayMarketPrice(
        toMoney(c.market_value),
        fx,
        toMoney(c.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
      ),
    ]),
  );
  const allPacks = await pageAll((opts) =>
    packs.listPacks({ status: 'active' }, opts),
  );
  const allOdds = await pageAll((opts) => packs.listPackOdds({}, opts));
  const oddsByPack = new Map<
    string,
    { weight: number; market_value: number }[]
  >();
  for (const o of allOdds) {
    if (o.card_id == null) continue; // reward row — not a card, no FMV
    const value = valueByHandle.get(o.card_id);
    if (value === undefined) continue; // orphaned odds row
    const list = oddsByPack.get(o.pack_id) ?? [];
    list.push({ weight: o.weight, market_value: value });
    oddsByPack.set(o.pack_id, list);
  }
  return allPacks
    .filter((p) => p.prize_type !== 'tickets')
    .map((p) => {
      const rtp = packTheoreticalRtp(
        oddsByPack.get(p.slug) ?? [],
        toMoney(p.price),
      );
      return {
        slug: p.slug,
        title: p.title,
        category: p.category,
        price: toMoney(p.price),
        ev: rtp?.ev ?? null,
        rtp_pct: rtp?.rtp_pct ?? null,
      };
    })
    .sort((a, b) => (b.rtp_pct ?? -1) - (a.rtp_pct ?? -1));
}
