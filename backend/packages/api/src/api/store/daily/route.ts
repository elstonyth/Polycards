import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';

// GET /store/daily — the logged-in customer's VIP voucher/frame grant state.
// The box and shippable-prize halves went with the daily box (2026-08-25);
// what is left comes from vip_reward_grant.
//
// NOT gated (mirrors the old GET /store/rewards): the response carries
// redemption_enabled so the UI can pre-disable a claim before hitting a 403.
//
// AUTH + RATE LIMIT: registered in api/middlewares.ts (authenticate() then the
// store-read limiter). The customer id comes ONLY from the verified bearer token.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  res.json(await packs.getDailyState(customerId));
}
