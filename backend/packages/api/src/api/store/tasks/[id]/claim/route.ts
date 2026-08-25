import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { takeCardStock } from '../../../../../modules/packs/card-stock';
import { rollOne } from '../../../../../workflows/steps/roll-pack';
import { resolveOddsSetForCustomer } from '../../../../../modules/packs/odds-sets';

// POST /store/tasks/:id/claim — claim a completed task's reward. The stock
// decrement and the pack-reward odds roll are injected here (the service must
// not import the workflow layer). Every non-throwing outcome is a 200 with a
// result object — the tab fires this from a button and renders the reason.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const result = await packs.claimTask({
    customerId,
    taskId: req.params.id,
    decrementStock: takeCardStock(req.scope),
    rollPack: async (packId) => {
      // Same odds-set resolution as a paid open — a task rip is still THIS
      // customer's rip.
      const set = await resolveOddsSetForCustomer(req.scope, customerId);
      return rollOne(packs, packId, set);
    },
  });
  res.json(result);
}
