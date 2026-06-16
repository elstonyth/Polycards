import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import PacksModuleService from '../../../modules/packs/service';
import { PACKS_MODULE } from '../../../modules/packs';
import {
  buybackAmount,
  resolveBuybackRate,
} from '../../../modules/packs/buyback-rate';
import {
  cardByHandle,
  makeRarityOf,
  toCardView,
} from '../../../modules/packs/card-view';
import { toMoney } from '../../../modules/packs/money';

// GET /store/vault — the authenticated customer's vault: every pull still held
// (status "vaulted"), newest first, with a LIVE buyback offer per item: current
// FMV × the rate that would apply RIGHT NOW (instant inside the post-pull
// window, the flat rate after — resolveBuybackRate, the same logic the
// buyback workflow runs, so the quote always matches the credit).
//
// AUTH: matcher registered in src/api/middlewares.ts with authenticate(); the
// customer id comes ONLY from the verified token, so a caller can never read
// another customer's vault.
const VAULT_LIMIT = 500;

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const customerId = req.auth_context.actor_id;

  const pulls = await packs.listPulls(
    { customer_id: customerId, status: 'vaulted' },
    { order: { rolled_at: 'DESC' }, take: VAULT_LIMIT },
  );

  const handles = [...new Set(pulls.map((p) => p.card_id))];
  const packIds = [...new Set(pulls.map((p) => p.pack_id))];

  const [cards, packRows, oddsRows] = await Promise.all([
    handles.length
      ? packs.listCards({ handle: handles }, { take: handles.length })
      : Promise.resolve([]),
    packIds.length
      ? packs.listPacks({ slug: packIds }, { take: packIds.length })
      : Promise.resolve([]),
    handles.length
      ? packs.listPackOdds({ card_id: handles }, { take: 1000 })
      : Promise.resolve([]),
  ]);

  const byHandle = cardByHandle(cards);
  const packBySlug = new Map(packRows.map((p) => [p.slug, p]));
  const rarityOf = makeRarityOf(oddsRows);

  const items = pulls
    .map((p) => {
      const card = byHandle.get(p.card_id);
      if (!card) return null;
      const marketValue = toMoney(card.market_value);
      if (!Number.isFinite(marketValue)) return null;
      const pack = packBySlug.get(p.pack_id);
      const { percent, rate_type } = resolveBuybackRate(pack, {
        rolled_at: p.rolled_at,
        revealed_at: p.revealed_at,
      });
      return {
        pull_id: p.id,
        rolled_at: p.rolled_at,
        pack_id: p.pack_id,
        pack_title: pack?.title ?? p.pack_id,
        showcased: (p as unknown as { showcased: boolean }).showcased ?? false,
        card: toCardView(card, rarityOf(p.pack_id, p.card_id)),
        buyback: {
          percent,
          amount: buybackAmount(marketValue, percent),
          rate_type,
        },
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  res.json({ items });
}
