import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { drawDailyBoxWorkflow } from '../../../../workflows/draw-daily-box';
import { rewardsRedemptionEnabled } from '../../../../modules/packs/rewards-gate';

// POST /store/daily/draw — open today's daily box (reward_box model). The whole
// daily-capped draw (tier resolve → cap COUNT → pick → payout → reward_draw
// INSERT) runs atomically in the service under the per-customer credit: lock.
// The result carries {status, prize?, draw_ordinal?}.
//
// FAIL-CLOSED GATE: the redemption gate is the FIRST line — a 403 returns BEFORE
// the workflow runs (no reward_draw row written) while REWARDS_REDEMPTION_ENABLED
// is unset (spec §13).
//
// AUTH + RATE LIMIT: registered in api/middlewares.ts. The customer id comes ONLY
// from the verified bearer token, never the body.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  if (!rewardsRedemptionEnabled()) {
    res.status(403).json({ message: 'Reward redemption is not enabled.' });
    return;
  }

  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }

  const { result } = await drawDailyBoxWorkflow(req.scope).run({
    input: { customer_id: customerId },
  });

  // A "nothing" prize is a normal drawn outcome, not a failure — say so in
  // human words (sim finding P3-7: the bare {kind:"nothing"} read like an
  // error to customers).
  res.json(
    result.status === 'drawn' && result.prize?.kind === 'nothing'
      ? {
          ...result,
          message: 'No prize this time — better luck on your next draw!',
        }
      : result,
  );
}
