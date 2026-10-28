import type { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { publicCoinFlipRound, type CoinFlipRoundRecord } from '../../../modules/packs/coin-flip';
import { parsePaginationParams } from '../../../utils/pagination';

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const { limit, offset } = parsePaginationParams(req.query, { defaultLimit: 20, maxLimit: 100 });
  const [rounds, count] = await packs.listAndCountCoinFlipRounds({ customer_id: req.auth_context.actor_id, status: ['won', 'lost'] },
    { take: limit, skip: offset, order: { settled_at: 'DESC', id: 'DESC' } });
  res.json({ rounds: rounds.map(row => publicCoinFlipRound(row as unknown as CoinFlipRoundRecord)), count, limit, offset });
}
