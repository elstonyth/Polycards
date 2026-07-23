import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { parsePaginationParams } from '../../../../../utils/pagination';
import { toMoney } from '../../../../../modules/packs/money';
import {
  DEFAULT_MARKET_MULTIPLIER,
  resolveFxRateInfo,
  displayMarketPrice,
} from '../../../../../modules/packs/pricing';
import {
  buybackAmount,
  instantDeadlineMs,
  resolveBuybackRate,
} from '../../../../../modules/packs/buyback-rate';

// GET /admin/customers/:id/pulls — paginated pull history for the support
// view. Same row shape as the gacha route's `pulls` slice, PLUS the
// quote-vs-payable data the desk needs to adjudicate a buyback price dispute
// (sim finding P1-3):
//   - fx {rate, firm} at response level — firm:false means quotes shown to the
//     customer right now are on the display fallback and selling is refused.
//   - quote {percent, amount, rate_type, firm, instant_deadline_ms} on each
//     vaulted card pull — what selling THIS pull pays right now, computed with
//     the same helpers as the customer's vault so the numbers match exactly.
//   - buyback_amount + buyback_at on bought-back pulls — what was actually paid.
// A justified difference is settled with the existing credit-adjust action
// (POST /admin/customers/:id/credits), so no new money mutation is needed.
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
  const { rate: fx, firm: fxFirm } = await resolveFxRateInfo(packs);
  const [rows, total] = await packs.listAndCountPulls(
    { customer_id: id },
    { order: { rolled_at: 'DESC' }, skip: offset, take: limit },
  );
  const handles = [...new Set(rows.map((p: any) => p.card_id))];
  const cards = handles.length
    ? await packs.listCards({ handle: handles }, { take: handles.length })
    : [];
  const cardByHandle = new Map(cards.map((c: any) => [c.handle, c]));
  // Pack rows drive the instant rate for vaulted pulls' quotes.
  const packIds = [...new Set(rows.map((p: any) => p.pack_id))];
  const packRows = packIds.length
    ? await packs.listPacks({ slug: packIds }, { take: packIds.length })
    : [];
  const packBySlug = new Map(packRows.map((p: any) => [p.slug, p]));
  res.json({
    total,
    fx: { rate: fx, firm: fxFirm },
    items: rows.map((p: any) => {
      const card = cardByHandle.get(p.card_id);
      // Payable-now quote — vaulted card pulls only (reward pulls can't be
      // sold back; other statuses have nothing to pay). Uses the per-card
      // multiplier exactly like GET /store/vault, so this amount is the same
      // number the customer sees on their sell button.
      let quote: {
        percent: number;
        amount: number;
        rate_type: string;
        firm: boolean;
        instant_deadline_ms: number;
      } | null = null;
      if (p.status === 'vaulted' && p.source !== 'reward' && card) {
        const marketPriceMyr = displayMarketPrice(
          toMoney(card.market_value),
          fx,
          Number(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
        );
        const { percent, rate_type } = resolveBuybackRate(
          packBySlug.get(p.pack_id),
          {
            rolled_at: p.rolled_at,
            revealed_at: p.revealed_at,
            // Thread the close stamp too, or admin's "payable now" quote would
            // show the instant rate for a window the customer already closed
            // (vault + sell credit are flat) — the two must agree.
            instant_closed_at: p.instant_closed_at,
          },
        );
        quote = {
          percent,
          amount: buybackAmount(marketPriceMyr, percent),
          rate_type,
          firm: fxFirm,
          instant_deadline_ms: instantDeadlineMs(p.rolled_at, p.revealed_at),
        };
      }
      return {
        id: p.id,
        pack_id: p.pack_id,
        rolled_at: p.rolled_at,
        status: p.status,
        buyback_amount:
          p.buyback_amount === null ? null : Number(p.buyback_amount),
        buyback_at: p.buyback_at ?? null,
        quote,
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
