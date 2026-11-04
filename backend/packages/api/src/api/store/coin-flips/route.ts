import type { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { publicCoinFlipRound, type CoinFlipRoundRecord } from '../../../modules/packs/coin-flip';
import { parsePaginationParams } from '../../../utils/pagination';

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const { limit, offset } = parsePaginationParams(req.query, { defaultLimit: 20, maxLimit: 100 });
  const customerId = req.auth_context.actor_id;
  // Settled rounds only. The won/lost filter left with its storefront tabs.
  const status = ['won', 'lost'];
  const [rounds, count] = await packs.listAndCountCoinFlipRounds({ customer_id: customerId, status },
    { take: limit, skip: offset, order: { settled_at: 'DESC', id: 'DESC' } });
  const totals = await packs.coinFlipLandedCounts(customerId);
  res.json({ rounds: rounds.map(row => publicCoinFlipRound(row as unknown as CoinFlipRoundRecord)), count, limit, offset, totals });
}
