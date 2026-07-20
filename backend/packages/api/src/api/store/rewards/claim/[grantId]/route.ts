import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import {
  ContainerRegistrationKeys,
  MedusaError,
} from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { rewardsRedemptionEnabled } from '../../../../../modules/packs/rewards-gate';
import { notifyFeed } from '../../../../../modules/packs/notify-feed';

// POST /store/rewards/claim/:grantId — claim an earned VIP reward grant (voucher
// credits site credit; frame flips status only). Idempotent under the per-customer
// credit: lock inside claimReward, so a double-click can't double-credit.
//
// FAIL-CLOSED GATE: the redemption gate is the FIRST line — a 403 returns BEFORE
// any read/write while REWARDS_REDEMPTION_ENABLED is unset (spec §13).
//
// AUTH + RATE LIMIT: registered in api/middlewares.ts. The customer id comes ONLY
// from the verified bearer token (never the body/params); ownership is enforced
// inside claimReward (a grant not owned by the caller is a no-op).
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
  const { grantId } = req.params;
  if (!grantId) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      '`grantId` is required.',
    );
  }

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const result = await packs.claimReward(customerId, grantId);

  // Emit voucher_claimed feed notification after a successful voucher claim.
  // Non-fatal: a notification failure must never roll back a committed claim.
  if (result.claimed && result.kind === 'voucher') {
    try {
      await notifyFeed(req.scope, {
        receiverId: customerId,
        template: 'voucher_claimed',
        data: {
          amount_myr: result.amount_myr ?? 0,
          level: result.level ?? 0,
        },
        idempotencyKey: `voucher_claimed:${grantId}`,
      });
    } catch (err) {
      // Notification failure is non-fatal — the claim is already committed and the
      // response is unchanged. Log it so a broken notification producer on this
      // money-adjacent path is discoverable instead of silently dropped.
      try {
        req.scope
          .resolve(ContainerRegistrationKeys.LOGGER)
          .warn(
            `[store/rewards/claim] notifyFeed('voucher_claimed') failed for receiver ${customerId} (grant ${grantId}) — claim committed, notification dropped: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
      } catch {
        // logger not available in test container — silently ignore
      }
    }
  }

  res.json(result);
}
