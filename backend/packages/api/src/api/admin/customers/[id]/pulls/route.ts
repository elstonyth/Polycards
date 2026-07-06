import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { parsePaginationParams } from '../../../../../utils/pagination';
import { toMoney } from '../../../../../modules/packs/money';
import {
  resolveFxRate,
  displayMarketPrice,
} from '../../../../../modules/packs/pricing';

// GET /admin/customers/:id/pulls — paginated pull history for the support
// view. Same row shape as the gacha route's `pulls` slice.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id } = req.params;
  const { limit, offset } = parsePaginationParams(
    { limit: req.query.limit, offset: req.query.offset },
    { defaultLimit: 25, maxLimit: 100 },
  );
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const fx = await resolveFxRate(packs);
  const [rows, total] = await packs.listAndCountPulls(
    { customer_id: id },
    { order: { rolled_at: 'DESC' }, skip: offset, take: limit },
  );
  const handles = [...new Set(rows.map((p: any) => p.card_id))];
  const cards = handles.length
    ? await packs.listCards({ handle: handles }, { take: handles.length })
    : [];
  const cardByHandle = new Map(cards.map((c: any) => [c.handle, c]));
  res.json({
    total,
    items: rows.map((p: any) => {
      const card = cardByHandle.get(p.card_id);
      return {
        id: p.id,
        pack_id: p.pack_id,
        rolled_at: p.rolled_at,
        status: p.status,
        buyback_amount:
          p.buyback_amount === null ? null : Number(p.buyback_amount),
        card: card
          ? {
              handle: card.handle,
              name: card.name,
              market_value: displayMarketPrice(toMoney(card.market_value), fx, 1),
              image: card.image,
            }
          : null,
      };
    }),
  });
}
