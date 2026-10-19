import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { GET as readLeaderboard } from '../../../store/leaderboard/route';

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  if (
    req.query.period !== undefined &&
    req.query.period !== 'weekly' &&
    req.query.period !== 'alltime'
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Period must be weekly or alltime.',
    );
  }
  await readLeaderboard(req, res);
}
