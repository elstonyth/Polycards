import type { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { levelForSpend } from '../../../modules/packs/vip-ladder';

// GET /store/vip — the logged-in customer's VIP level, cumulative spend, the
// next-rung reward teaser, and the full reward ladder (`levels`).
//
// Mirrors the VIP block in admin/customers/[id]/gacha/route.ts (lines 64-97)
// with two differences:
//   1. actor_id comes from the bearer token, not a route param.
//   2. The ladder select is widened to include the reward columns
//      (voucher_amount, box_tier, frame_unlock, direct_referral_pct) so both
//      the next-rung reward and the full `levels` ladder can be surfaced
//      without a second query.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  const [summary, ladderRows, stateRow] = await Promise.all([
    packs.creditSummary(customerId),
    packs.listVipLevels(
      {},
      {
        select: [
          'level',
          'spend_threshold',
          'voucher_amount',
          'box_tier',
          'frame_unlock',
          'direct_referral_pct',
        ],
        take: 1000,
      },
    ),
    packs.listVipMemberStates({ customer_id: customerId }, { take: 1 }).then(
      ([row]) => row ?? null,
    ),
  ]);

  const ladder = ladderRows
    .map((r) => ({
      level: r.level,
      spend_threshold: Number(r.spend_threshold),
      voucher_amount: Number(r.voucher_amount),
      box_tier: r.box_tier as string,
      frame_unlock: r.frame_unlock as boolean,
      direct_referral_pct: Number(r.direct_referral_pct),
    }))
    .sort((a, b) => a.level - b.level);

  const spend = summary.vipSpendTotal;

  // Prefer vip_member_state row (maintained by the settle-open saga) when
  // present; fall back to live levelForSpend when no row exists (e.g. customer
  // has never opened a pack).
  const liveLevel = ladder.length > 0 ? levelForSpend(spend, ladder) : 1;
  const level = stateRow ? Number(stateRow.current_level) : liveLevel;
  const highest = stateRow ? Number(stateRow.highest_level_ever) : liveLevel;

  // Next rung — null when the customer is at the top of the ladder.
  const nextRung = ladder.find((r) => r.level === level + 1) ?? null;
  const next = nextRung
    ? {
        level: nextRung.level,
        threshold: nextRung.spend_threshold,
        remaining: Math.max(0, nextRung.spend_threshold - spend),
        reward: {
          voucher_amount: nextRung.voucher_amount,
          box_tier: nextRung.box_tier,
          frame_unlock: Boolean(nextRung.frame_unlock),
        },
      }
    : null;

  const levels = ladder.map((r) => ({
    level: r.level,
    threshold: r.spend_threshold,
    reward: {
      voucher_amount: r.voucher_amount,
      box_tier: r.box_tier,
      frame_unlock: Boolean(r.frame_unlock),
      direct_referral_pct: r.direct_referral_pct,
    },
  }));

  res.json({ level, highest_level_ever: highest, spend, next, levels });
}
