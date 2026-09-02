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

// POST /store/tasks/:id/claim — claim a completed task's reward. The
// pack-reward odds roll is injected here (the service must not import the
// workflow layer) and the card-stock take happens HERE, after the claim
// committed. Every non-throwing outcome is a 200 with a result object — the
// tab fires this from a button and renders the reason.
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
    rollPack: async (packId) => {
      // Same odds-set resolution as a paid open — a task rip is still THIS
      // customer's rip.
      const set = await resolveOddsSetForCustomer(req.scope, customerId);
      return rollOne(packs, packId, set);
    },
  });
  // The stock take runs AFTER the claim transaction committed: the inventory
  // module writes on its own connection and commits at once, so a take inside
  // the claim outlived a claim that then lost the unique-index race at flush —
  // a double-tap cost two units for one card (review 2026-09). Same shape as
  // settleChallengeWeek's reserveSettledStock. The counter is a fulfilment
  // counter, never a gate: a failed take leaves it reading high, which is an
  // operator concern, never a customer error — the card is already vaulted.
  if (result.claimed && result.reward.type === 'card') {
    try {
      await takeCardStock(req.scope)(result.reward.card_handle, 1);
    } catch (error) {
      req.scope
        .resolve<{ warn: (message: string) => void }>('logger')
        .warn(
          `[tasks] stock take for '${result.reward.card_handle}' failed AFTER claim ${result.claimId} committed — counter reads high, card already vaulted: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
    }
  }
  res.json(result);
}
