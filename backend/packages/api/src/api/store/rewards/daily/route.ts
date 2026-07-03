import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';

// GET /store/rewards/daily — the logged-in customer's daily check-in state:
// enabled flag, MYT day, claimed-today, streak position, and the 7-day amounts.
// Registered in middlewares.ts (bearer auth + store read budget).
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  res.json(await packs.dailyStatus(customerId));
}
