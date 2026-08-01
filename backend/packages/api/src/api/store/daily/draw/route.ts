import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { drawDailyBoxWorkflow } from '../../../../workflows/draw-daily-box';
import { rewardsRedemptionEnabled } from '../../../../modules/packs/rewards-gate';
import { notifyFeedNonfatal } from '../../../../modules/packs/notify-feed';
import {
  shouldNotifyRewardWon,
  rewardWonFeedKey,
} from '../../../../modules/packs/feed-events';

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

  // Feed record of the prize. reward_won has been in FeedTemplate since the
  // feed shipped with no producer at all — this is it. Toast policy is
  // 'never' on the storefront: PrizeReveal is already a full-screen
  // announcement on the tab that drew, so the row is the durable history
  // entry, not a second announcement.
  //
  // Non-fatal: the draw is already committed.
  if (shouldNotifyRewardWon(result)) {
    // Non-fatal — never fail a committed draw over a notification. The wrapper
    // logs a producer failure (PR #222) instead of swallowing silently.
    await notifyFeedNonfatal(req.scope, 'daily-draw', {
      receiverId: customerId,
      template: 'reward_won',
      data: {
        prize_kind: result.prize?.kind ?? '',
        title: result.prize?.title ?? '',
        amount_myr: result.prize?.amount_myr ?? 0,
        draw_ordinal: result.draw_ordinal ?? 0,
      },
      idempotencyKey: rewardWonFeedKey(
        customerId,
        result.draw_day as string,
        result.draw_ordinal as number,
      ),
    });
  }

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
